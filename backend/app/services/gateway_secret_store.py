"""Managed write-only provider secret storage for node toolchains."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import re
from uuid import UUID

from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from cryptography.fernet import Fernet
from fastapi import HTTPException, status

from app.core.config import settings
from app.core.time import utcnow
from app.models.gateway_provider_secrets import GatewayProviderSecret
from app.models.gateways import Gateway
from app.schemas.gateway_runtime import GatewayProviderSecretRef


def _default_alias(provider_id: str, purpose: str) -> str:
    purpose_label = purpose.replace(":", "-")
    return f"{provider_id}-{purpose_label}"


def _sanitize_keyvault_name(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9-]+", "-", value.lower()).strip("-")
    normalized = re.sub(r"-{2,}", "-", normalized)
    return normalized[:127] or "mc-secret"


class GatewaySecretStoreService:
    """Store and resolve managed provider secrets without exposing plaintext over APIs."""

    def __init__(self, session) -> None:
        self.session = session
        self._credential: DefaultAzureCredential | None = None
        self._secret_client: SecretClient | None = None

    async def upsert_secret(
        self,
        *,
        gateway: Gateway,
        provider_id: str,
        purpose: str,
        value: str,
        alias: str | None = None,
    ) -> GatewayProviderSecretRef:
        record = await GatewayProviderSecret.objects.filter_by(
            gateway_id=gateway.id,
            provider_id=provider_id,
            purpose=purpose,
        ).first(self.session)
        if record is None:
            record = GatewayProviderSecret(
                gateway_id=gateway.id,
                provider_id=provider_id,
                purpose=purpose,
                alias=alias or _default_alias(provider_id, purpose),
                storage_backend=self._storage_backend_for_gateway(gateway),
            )
        else:
            record.alias = alias or record.alias or _default_alias(provider_id, purpose)
            record.storage_backend = self._storage_backend_for_gateway(gateway)
        if record.storage_backend == "azure-keyvault":
            record.external_key = self._keyvault_secret_name(record)
            record.encrypted_value = None
            await asyncio.to_thread(self._set_keyvault_secret, record.external_key, value)
        else:
            record.external_key = None
            record.encrypted_value = (
                self._database_fernet()
                .encrypt(value.encode("utf-8"))
                .decode(
                    "utf-8",
                )
            )
        record.updated_at = utcnow()
        self.session.add(record)
        await self.session.flush()
        return GatewayProviderSecretRef(
            provider_id=provider_id,
            purpose=purpose,
            ref=f"managed:{record.id}",
            alias=record.alias,
            storage_backend=record.storage_backend,
            configured=True,
            updated_at=record.updated_at,
            managed_by_catalog=True,
        )

    async def metadata_for_managed_ref(
        self,
        *,
        gateway: Gateway,
        ref: str,
        provider_id: str,
        purpose: str,
    ) -> GatewayProviderSecretRef | None:
        record = await self._record_for_ref(gateway=gateway, ref=ref)
        if record is None:
            return None
        return GatewayProviderSecretRef(
            provider_id=provider_id,
            purpose=purpose,
            ref=ref,
            alias=record.alias,
            storage_backend=record.storage_backend,
            configured=True,
            updated_at=record.updated_at,
            managed_by_catalog=True,
        )

    async def resolve_managed_ref(
        self,
        *,
        gateway: Gateway,
        ref: str,
    ) -> tuple[str | None, str | None]:
        record = await self._record_for_ref(gateway=gateway, ref=ref)
        if record is None:
            return None, f"Managed secret {ref} is not configured on this node."
        if record.storage_backend == "azure-keyvault":
            if not record.external_key:
                return None, f"Managed secret {ref} is missing its Key Vault secret name."
            try:
                value = await asyncio.to_thread(self._get_keyvault_secret, record.external_key)
            except Exception as exc:  # pragma: no cover - network/credential errors
                return None, f"Unable to read {record.alias} from Azure Key Vault: {exc}"
            return value, None
        if not record.encrypted_value:
            return None, f"Managed secret {ref} has no stored value."
        try:
            value = (
                self._database_fernet()
                .decrypt(record.encrypted_value.encode("utf-8"))
                .decode(
                    "utf-8",
                )
            )
        except Exception as exc:  # pragma: no cover - corrupted ciphertext
            return None, f"Unable to decrypt managed secret {record.alias}: {exc}"
        return value, None

    async def list_metadata_for_gateway(
        self, *, gateway: Gateway
    ) -> dict[tuple[str, str], GatewayProviderSecretRef]:
        records = await GatewayProviderSecret.objects.filter_by(gateway_id=gateway.id).all(
            self.session
        )
        metadata: dict[tuple[str, str], GatewayProviderSecretRef] = {}
        for record in records:
            metadata[(record.provider_id, record.purpose)] = GatewayProviderSecretRef(
                provider_id=record.provider_id,
                purpose=record.purpose,
                ref=f"managed:{record.id}",
                alias=record.alias,
                storage_backend=record.storage_backend,
                configured=True,
                updated_at=record.updated_at,
                managed_by_catalog=True,
            )
        return metadata

    async def _record_for_ref(
        self,
        *,
        gateway: Gateway,
        ref: str,
    ) -> GatewayProviderSecret | None:
        prefix, separator, secret_id = ref.partition(":")
        if prefix != "managed" or not separator or not secret_id.strip():
            return None
        try:
            parsed_id = UUID(secret_id.strip())
        except ValueError:
            return None
        record = await GatewayProviderSecret.objects.get(parsed_id, self.session)
        if record is None or record.gateway_id != gateway.id:
            return None
        return record

    def _storage_backend_for_gateway(self, gateway: Gateway) -> str:
        if gateway.node_class == "cloud" and settings.managed_secret_backend == "azure-keyvault":
            return "azure-keyvault"
        return "database"

    def _database_fernet(self) -> Fernet:
        seed = (
            settings.managed_secret_encryption_key.strip()
            or settings.local_auth_token.strip()
            or settings.clerk_secret_key.strip()
            or settings.base_url
        )
        digest = hashlib.sha256(seed.encode("utf-8")).digest()
        return Fernet(base64.urlsafe_b64encode(digest))

    def _secret_client(self) -> SecretClient:
        if self._secret_client is None:
            if not settings.azure_key_vault_url.strip():
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="Azure Key Vault is not configured for managed secret storage.",
                )
            if self._credential is None:
                self._credential = DefaultAzureCredential()
            self._secret_client = SecretClient(
                vault_url=settings.azure_key_vault_url,
                credential=self._credential,
            )
        return self._secret_client

    def _keyvault_secret_name(self, record: GatewayProviderSecret) -> str:
        return _sanitize_keyvault_name(
            f"mc-{record.provider_id}-{record.purpose}-{str(record.id).split('-')[0]}",
        )

    def _set_keyvault_secret(self, secret_name: str, value: str) -> None:
        self._secret_client().set_secret(secret_name, value)

    def _get_keyvault_secret(self, secret_name: str) -> str:
        return self._secret_client().get_secret(secret_name).value
