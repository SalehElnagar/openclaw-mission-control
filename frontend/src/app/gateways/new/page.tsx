"use client";

export const dynamic = "force-dynamic";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/auth/clerk";

import { ApiError } from "@/api/mutator";
import { useCreateGatewayApiV1GatewaysPost } from "@/api/generated/gateways/gateways";
import { getToolchainCatalog } from "@/api/toolchain";
import { useOrganizationMembership } from "@/lib/use-organization-membership";
import { GatewayForm } from "@/components/gateways/GatewayForm";
import { DashboardPageLayout } from "@/components/templates/DashboardPageLayout";
import type {
  GatewayProviderAuthConfig,
  GatewayModelDefinition,
  GatewayModelProfiles,
  GatewayProviderConfig,
  GatewayProviderSecretInput,
  GatewayProviderSecretRef,
} from "@/api/generated/model";
import {
  DEFAULT_WORKSPACE_ROOT,
  checkGatewayConnection,
  type GatewayCheckStatus,
  validateGatewayUrl,
} from "@/lib/gateway-form";
import {
  buildGatewayConnectRedirectPath,
  findPendingInteractiveProviderIds,
} from "@/lib/gateway-interactive-auth";
import type { NodeClass } from "@/lib/node-scope";

function sanitizeProviderConfigs(
  providerConfigs: GatewayProviderConfig[],
): GatewayProviderConfig[] | null {
  const sanitized = providerConfigs
    .map((provider) => ({
      id: provider.id.trim(),
      preset_id: provider.preset_id?.trim() || null,
      managed_by_catalog: provider.managed_by_catalog ?? null,
      provider_type: provider.provider_type?.trim() || null,
      label: provider.label?.trim() || null,
      base_url: provider.base_url?.trim() || null,
      api_mode: provider.api_mode?.trim() || null,
      auth_header: Boolean(provider.auth_header),
      headers: provider.headers ?? null,
    }))
    .filter((provider) => provider.id.length > 0);
  return sanitized.length > 0 ? sanitized : null;
}

function sanitizeProviderAuthConfigs(
  providerAuthConfigs: GatewayProviderAuthConfig[],
): GatewayProviderAuthConfig[] | null {
  const sanitized = providerAuthConfigs
    .map((config) => ({
      provider_id: config.provider_id.trim(),
      auth_mode: config.auth_mode,
      preset_id: config.preset_id?.trim() || null,
      managed_by_catalog: config.managed_by_catalog ?? null,
      profile_id: config.profile_id?.trim() || null,
      display_label: config.display_label?.trim() || null,
      secret_refs: (config.secret_refs ?? [])
        .map((secretRef) => ({
          provider_id: secretRef.provider_id.trim(),
          purpose: secretRef.purpose.trim(),
          ref: secretRef.ref.trim(),
        }))
        .filter(
          (secretRef) =>
            secretRef.provider_id.length > 0 &&
            secretRef.purpose.length > 0 &&
            secretRef.ref.length > 0,
        ),
      token_header_name: config.token_header_name?.trim() || null,
      token_header_prefix: config.token_header_prefix?.trim() || null,
    }))
    .filter(
      (config) =>
        config.provider_id.length > 0 &&
        (config.auth_mode === "api-key" ||
          config.auth_mode === "token" ||
          config.auth_mode === "oauth" ||
          config.auth_mode === "login"),
    );
  return sanitized.length > 0 ? sanitized : null;
}

function sanitizeModelDefinitions(
  modelDefinitions: GatewayModelDefinition[],
): GatewayModelDefinition[] | null {
  const sanitized = modelDefinitions
    .map((definition) => ({
      ...definition,
      provider_id: definition.provider_id.trim(),
      model_id: definition.model_id.trim(),
      preset_id: definition.preset_id?.trim() || null,
      managed_by_catalog: definition.managed_by_catalog ?? null,
      label: definition.label?.trim() || null,
      api_mode: definition.api_mode?.trim() || null,
      input_modalities: (definition.input_modalities ?? [])
        .map((value) => value.trim())
        .filter(Boolean),
      cost: definition.cost
        ? {
            input: definition.cost.input ?? null,
            output: definition.cost.output ?? null,
            cache_read: definition.cost.cache_read ?? null,
            cache_write: definition.cost.cache_write ?? null,
          }
        : null,
    }))
    .filter(
      (definition) =>
        definition.provider_id.length > 0 && definition.model_id.length > 0,
    );
  return sanitized.length > 0 ? sanitized : null;
}

function sanitizeProviderSecretRefs(
  providerSecretRefs: GatewayProviderSecretRef[],
): GatewayProviderSecretRef[] | null {
  const sanitized = providerSecretRefs
    .map((secretRef) => ({
      provider_id: secretRef.provider_id.trim(),
      purpose: secretRef.purpose.trim(),
      ref: secretRef.ref.trim(),
      alias: secretRef.alias?.trim() || null,
      storage_backend: secretRef.storage_backend?.trim() || null,
      configured: secretRef.configured ?? null,
      updated_at: secretRef.updated_at ?? null,
      managed_by_catalog: secretRef.managed_by_catalog ?? null,
    }))
    .filter(
      (secretRef) =>
        secretRef.provider_id.length > 0 &&
        secretRef.purpose.length > 0 &&
        secretRef.ref.length > 0,
    );
  return sanitized.length > 0 ? sanitized : null;
}

function sanitizeProviderSecretInputs(
  providerSecretInputs: GatewayProviderSecretInput[],
): GatewayProviderSecretInput[] | null {
  const sanitized = providerSecretInputs
    .map((secretInput) => ({
      provider_id: secretInput.provider_id.trim(),
      purpose: secretInput.purpose.trim(),
      mode: "paste-once" as const,
      value: secretInput.value,
      alias: secretInput.alias?.trim() || null,
      preset_id: secretInput.preset_id?.trim() || null,
    }))
    .filter(
      (secretInput) =>
        secretInput.provider_id.length > 0 &&
        secretInput.purpose.length > 0 &&
        secretInput.value.trim().length > 0,
    );
  return sanitized.length > 0 ? sanitized : null;
}

export default function NewGatewayPage() {
  const { isSignedIn } = useAuth();
  const router = useRouter();

  const { isAdmin } = useOrganizationMembership(isSignedIn);

  const [name, setName] = useState("");
  const [nodeClass, setNodeClass] = useState<NodeClass>("cloud");
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [gatewayToken, setGatewayToken] = useState("");
  const [disableDevicePairing, setDisableDevicePairing] = useState(false);
  const [workspaceRoot, setWorkspaceRoot] = useState(DEFAULT_WORKSPACE_ROOT);
  const [allowInsecureTls, setAllowInsecureTls] = useState(false);
  const [defaultModelProfile, setDefaultModelProfile] = useState<
    "general" | "coder" | "budget"
  >("general");
  const [modelProfiles, setModelProfiles] = useState<GatewayModelProfiles>({});
  const [enabledModelRefs, setEnabledModelRefs] = useState<string[]>([]);
  const [providerConfigs, setProviderConfigs] = useState<
    GatewayProviderConfig[]
  >([]);
  const [providerAuthConfigs, setProviderAuthConfigs] = useState<
    GatewayProviderAuthConfig[]
  >([]);
  const [modelDefinitions, setModelDefinitions] = useState<
    GatewayModelDefinition[]
  >([]);
  const [providerSecretRefs, setProviderSecretRefs] = useState<
    GatewayProviderSecretRef[]
  >([]);
  const [providerSecretInputs, setProviderSecretInputs] = useState<
    GatewayProviderSecretInput[]
  >([]);
  const [toolProfile, setToolProfile] = useState<
    "restricted" | "coding" | "research" | "browser-assisted"
  >("coding");

  const [gatewayUrlError, setGatewayUrlError] = useState<string | null>(null);
  const [gatewayCheckStatus, setGatewayCheckStatus] =
    useState<GatewayCheckStatus>("idle");
  const [gatewayCheckMessage, setGatewayCheckMessage] = useState<string | null>(
    null,
  );

  const [error, setError] = useState<string | null>(null);
  const pendingInteractiveProviderIdsRef = useRef<string[]>([]);

  const toolchainCatalogQuery = useQuery({
    queryKey: ["toolchain-catalog"],
    queryFn: () => getToolchainCatalog(),
    enabled: Boolean(isSignedIn && isAdmin),
    staleTime: 60_000,
  });

  const createMutation = useCreateGatewayApiV1GatewaysPost<ApiError>({
    mutation: {
      onSuccess: (result) => {
        if (result.status === 200) {
          router.push(
            buildGatewayConnectRedirectPath(
              result.data.id,
              pendingInteractiveProviderIdsRef.current,
            ),
          );
        }
      },
      onError: (err) => {
        setError(err.message || "Something went wrong.");
      },
    },
  });

  const isLoading =
    createMutation.isPending || gatewayCheckStatus === "checking";

  const canSubmit =
    Boolean(name.trim()) &&
    Boolean(gatewayUrl.trim()) &&
    Boolean(workspaceRoot.trim());
  const pendingInteractiveProviderIds = useMemo(
    () =>
      findPendingInteractiveProviderIds({
        nextAuthConfigs: sanitizeProviderAuthConfigs(providerAuthConfigs) ?? [],
      }),
    [providerAuthConfigs],
  );

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isSignedIn) return;

    if (!name.trim()) {
      setError("Gateway name is required.");
      return;
    }
    const gatewayValidation = validateGatewayUrl(gatewayUrl);
    setGatewayUrlError(gatewayValidation);
    if (gatewayValidation) {
      setGatewayCheckStatus("error");
      setGatewayCheckMessage(gatewayValidation);
      return;
    }
    if (!workspaceRoot.trim()) {
      setError("Workspace root is required.");
      return;
    }

    setGatewayCheckStatus("checking");
    setGatewayCheckMessage(null);
    const { ok, message } = await checkGatewayConnection({
      gatewayUrl,
      gatewayToken,
      gatewayDisableDevicePairing: disableDevicePairing,
      gatewayAllowInsecureTls: allowInsecureTls,
    });
    setGatewayCheckStatus(ok ? "success" : "error");
    setGatewayCheckMessage(message);
    if (!ok) {
      return;
    }

    setError(null);
    pendingInteractiveProviderIdsRef.current = pendingInteractiveProviderIds;
    createMutation.mutate({
      data: {
        name: name.trim(),
        node_class: nodeClass,
        url: gatewayUrl.trim(),
        token: gatewayToken.trim() || null,
        disable_device_pairing: disableDevicePairing,
        workspace_root: workspaceRoot.trim(),
        allow_insecure_tls: allowInsecureTls,
        default_model_profile: defaultModelProfile,
        model_profiles: modelProfiles,
        enabled_model_refs:
          enabledModelRefs.length > 0 ? enabledModelRefs : null,
        tool_profile: toolProfile,
        provider_configs: sanitizeProviderConfigs(providerConfigs),
        provider_auth_configs: sanitizeProviderAuthConfigs(providerAuthConfigs),
        model_definitions: sanitizeModelDefinitions(modelDefinitions),
        provider_secret_refs: sanitizeProviderSecretRefs(providerSecretRefs),
        provider_secret_inputs:
          sanitizeProviderSecretInputs(providerSecretInputs),
      },
    });
  };

  return (
    <DashboardPageLayout
      signedOut={{
        message: "Sign in to create a gateway.",
        forceRedirectUrl: "/gateways/new",
      }}
      title="Create node"
      description="Configure an OpenClaw runtime node for Mission Control."
      isAdmin={isAdmin}
      adminOnlyMessage="Only organization owners and admins can create nodes."
    >
      <GatewayForm
        name={name}
        nodeClass={nodeClass}
        gatewayUrl={gatewayUrl}
        gatewayToken={gatewayToken}
        disableDevicePairing={disableDevicePairing}
        workspaceRoot={workspaceRoot}
        allowInsecureTls={allowInsecureTls}
        defaultModelProfile={defaultModelProfile}
        modelProfiles={modelProfiles}
        providerConfigs={providerConfigs}
        providerAuthConfigs={providerAuthConfigs}
        modelDefinitions={modelDefinitions}
        providerSecretRefs={providerSecretRefs}
        providerSecretInputs={providerSecretInputs}
        toolchainCatalog={toolchainCatalogQuery.data?.data.providers ?? []}
        toolProfile={toolProfile}
        verifiedModelRefs={[]}
        enabledModelRefs={enabledModelRefs}
        gatewayUrlError={gatewayUrlError}
        gatewayCheckStatus={gatewayCheckStatus}
        gatewayCheckMessage={gatewayCheckMessage}
        errorMessage={error}
        isLoading={isLoading}
        canSubmit={canSubmit}
        workspaceRootPlaceholder={DEFAULT_WORKSPACE_ROOT}
        cancelLabel="Cancel"
        submitLabel={
          pendingInteractiveProviderIds.length > 0
            ? "Create node and connect"
            : "Create gateway"
        }
        submitBusyLabel={
          pendingInteractiveProviderIds.length > 0
            ? "Creating and connecting…"
            : "Creating…"
        }
        onSubmit={handleSubmit}
        onCancel={() => router.push("/gateways")}
        onNameChange={setName}
        onNodeClassChange={setNodeClass}
        onGatewayUrlChange={(next) => {
          setGatewayUrl(next);
          setGatewayUrlError(null);
          setGatewayCheckStatus("idle");
          setGatewayCheckMessage(null);
        }}
        onGatewayTokenChange={(next) => {
          setGatewayToken(next);
          setGatewayCheckStatus("idle");
          setGatewayCheckMessage(null);
        }}
        onDisableDevicePairingChange={(next) => {
          setDisableDevicePairing(next);
          setGatewayCheckStatus("idle");
          setGatewayCheckMessage(null);
        }}
        onWorkspaceRootChange={setWorkspaceRoot}
        onAllowInsecureTlsChange={(next) => {
          setAllowInsecureTls(next);
          setGatewayCheckStatus("idle");
          setGatewayCheckMessage(null);
        }}
        onDefaultModelProfileChange={setDefaultModelProfile}
        onEnabledModelRefsChange={setEnabledModelRefs}
        onModelProfilePrimaryChange={(profile, value) => {
          setModelProfiles((current) => ({
            ...current,
            [profile]: {
              primary_model: value,
              fallback_models: current?.[profile]?.fallback_models ?? [],
            },
          }));
        }}
        onProviderConfigsChange={setProviderConfigs}
        onProviderAuthConfigsChange={setProviderAuthConfigs}
        onModelDefinitionsChange={setModelDefinitions}
        onProviderSecretRefsChange={setProviderSecretRefs}
        onProviderSecretInputsChange={setProviderSecretInputs}
        onToolProfileChange={setToolProfile}
      />
    </DashboardPageLayout>
  );
}
