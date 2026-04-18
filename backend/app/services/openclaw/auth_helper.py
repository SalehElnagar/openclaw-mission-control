"""Unix-socket client for the VM-side OpenClaw interactive auth helper."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any


class OpenClawAuthHelperError(RuntimeError):
    """Raised when the VM auth helper returns an error or invalid payload."""


def _coerce_text(value: object) -> str | None:
    if isinstance(value, str):
        normalized = value.strip()
        return normalized or None
    return None


def _coerce_bool(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes"}:
            return True
        if normalized in {"false", "0", "no"}:
            return False
    return False


def _coerce_int(value: object) -> int | None:
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        normalized = value.strip()
        if normalized.isdigit():
            return int(normalized)
    return None


@dataclass(slots=True)
class OpenClawAuthHelperChallengeSnapshot:
    """Normalized auth helper challenge payload."""

    session_id: str | None = None
    kind: str | None = None
    title: str | None = None
    message: str | None = None
    instructions: list[str] = field(default_factory=list)
    action_label: str | None = None
    action_url: str | None = None
    code: str | None = None
    needs_input: bool = False
    input_label: str | None = None
    poll_after_ms: int | None = None

    @classmethod
    def from_payload(
        cls,
        payload: object,
        *,
        session_id: str | None = None,
    ) -> OpenClawAuthHelperChallengeSnapshot | None:
        if not isinstance(payload, dict):
            return None
        instructions = payload.get("instructions")
        return cls(
            session_id=_coerce_text(payload.get("session_id")) or session_id,
            kind=_coerce_text(payload.get("kind")),
            title=_coerce_text(payload.get("title")),
            message=_coerce_text(payload.get("message")),
            instructions=[
                item.strip()
                for item in instructions
                if isinstance(item, str) and item.strip()
            ]
            if isinstance(instructions, list)
            else [],
            action_label=_coerce_text(payload.get("action_label")),
            action_url=_coerce_text(payload.get("action_url")),
            code=_coerce_text(payload.get("code")),
            needs_input=_coerce_bool(payload.get("needs_input")),
            input_label=_coerce_text(payload.get("input_label")),
            poll_after_ms=_coerce_int(payload.get("poll_after_ms")),
        )


@dataclass(slots=True)
class OpenClawAuthHelperSessionSnapshot:
    """Current helper session state for one provider login flow."""

    session_id: str
    provider_id: str
    status: str
    message: str | None = None
    challenge: OpenClawAuthHelperChallengeSnapshot | None = None
    warnings: list[str] = field(default_factory=list)

    @classmethod
    def from_payload(cls, payload: object) -> OpenClawAuthHelperSessionSnapshot:
        if not isinstance(payload, dict):
            raise OpenClawAuthHelperError("Auth helper returned an invalid session payload.")
        session_id = _coerce_text(payload.get("session_id"))
        provider_id = _coerce_text(payload.get("provider_id"))
        status_value = _coerce_text(payload.get("status"))
        if session_id is None or provider_id is None or status_value is None:
            raise OpenClawAuthHelperError("Auth helper session payload was missing required fields.")
        warnings = payload.get("warnings")
        return cls(
            session_id=session_id,
            provider_id=provider_id,
            status=status_value,
            message=_coerce_text(payload.get("message")),
            challenge=OpenClawAuthHelperChallengeSnapshot.from_payload(
                payload.get("challenge"),
                session_id=session_id,
            ),
            warnings=[
                item.strip()
                for item in warnings
                if isinstance(item, str) and item.strip()
            ]
            if isinstance(warnings, list)
            else [],
        )


class OpenClawAuthHelperClient:
    """Line-delimited JSON client for the local-only auth helper socket."""

    def __init__(self, *, socket_path: str) -> None:
        normalized = socket_path.strip()
        if not normalized:
            raise OpenClawAuthHelperError("OPENCLAW_AUTH_HELPER_SOCKET_PATH is not configured.")
        self.socket_path = normalized

    async def _request(self, payload: dict[str, Any]) -> dict[str, Any]:
        writer: asyncio.StreamWriter | None = None
        try:
            reader, writer = await asyncio.open_unix_connection(self.socket_path)
            writer.write((json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8"))
            await writer.drain()
            raw = await reader.readline()
        except FileNotFoundError as exc:
            raise OpenClawAuthHelperError(
                f"Auth helper socket not found at {self.socket_path}."
            ) from exc
        except OSError as exc:
            raise OpenClawAuthHelperError(f"Auth helper request failed: {exc}") from exc
        finally:
            if writer is not None:
                writer.close()
                await writer.wait_closed()

        if not raw:
            raise OpenClawAuthHelperError("Auth helper closed the socket without a response.")
        try:
            response = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise OpenClawAuthHelperError("Auth helper returned invalid JSON.") from exc
        if not isinstance(response, dict):
            raise OpenClawAuthHelperError("Auth helper returned an invalid response envelope.")
        if response.get("ok") is False:
            message = _coerce_text(response.get("error")) or "Auth helper request failed."
            raise OpenClawAuthHelperError(message)
        return response

    async def start_session(
        self,
        *,
        gateway_id: str,
        provider_id: str,
        provider_label: str | None = None,
        session_id: str | None = None,
    ) -> OpenClawAuthHelperSessionSnapshot:
        response = await self._request(
            {
                "action": "start",
                "gateway_id": gateway_id,
                "provider_id": provider_id,
                "provider_label": provider_label,
                "session_id": session_id,
            }
        )
        return OpenClawAuthHelperSessionSnapshot.from_payload(response.get("session"))

    async def refresh_session(self, *, session_id: str) -> OpenClawAuthHelperSessionSnapshot:
        response = await self._request({"action": "refresh", "session_id": session_id})
        return OpenClawAuthHelperSessionSnapshot.from_payload(response.get("session"))

    async def submit_challenge_input(
        self,
        *,
        session_id: str,
        input_text: str,
    ) -> OpenClawAuthHelperSessionSnapshot:
        response = await self._request(
            {
                "action": "submit_input",
                "session_id": session_id,
                "input_text": input_text,
            }
        )
        return OpenClawAuthHelperSessionSnapshot.from_payload(response.get("session"))

    async def disconnect_provider(
        self,
        *,
        gateway_id: str,
        provider_id: str,
        session_id: str | None = None,
    ) -> OpenClawAuthHelperSessionSnapshot:
        response = await self._request(
            {
                "action": "disconnect",
                "gateway_id": gateway_id,
                "provider_id": provider_id,
                "session_id": session_id,
            }
        )
        return OpenClawAuthHelperSessionSnapshot.from_payload(response.get("session"))
