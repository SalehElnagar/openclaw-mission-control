"use client";

export const dynamic = "force-dynamic";

import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import { useAuth } from "@/auth/clerk";

import { ApiError } from "@/api/mutator";
import {
  type getGatewayApiV1GatewaysGatewayIdGetResponse,
  useGetGatewayApiV1GatewaysGatewayIdGet,
  useUpdateGatewayApiV1GatewaysGatewayIdPatch,
} from "@/api/generated/gateways/gateways";
import { useQuery } from "@tanstack/react-query";
import { getToolchainCatalog } from "@/api/toolchain";
import { useOrganizationMembership } from "@/lib/use-organization-membership";
import type {
  GatewayProviderAuthConfig,
  GatewayModelDefinition,
  GatewayProviderConfig,
  GatewayProviderSecretInput,
  GatewayProviderSecretRef,
  GatewayUpdate,
} from "@/api/generated/model";
import { GatewayForm } from "@/components/gateways/GatewayForm";
import { DashboardPageLayout } from "@/components/templates/DashboardPageLayout";
import {
  DEFAULT_WORKSPACE_ROOT,
  checkGatewayConnection,
  type GatewayCheckStatus,
  validateGatewayUrl,
} from "@/lib/gateway-form";
import { getGatewayRuntime } from "@/api/runtime-control";
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

function pickManagedList<T>(saved: T[] | null | undefined, observed: T[] | null | undefined): T[] {
  if ((saved?.length ?? 0) > 0) {
    return saved ?? [];
  }
  if ((observed?.length ?? 0) > 0) {
    return observed ?? [];
  }
  return [];
}

export default function EditGatewayPage() {
  const { isSignedIn } = useAuth();
  const router = useRouter();
  const params = useParams();
  const gatewayIdParam = params?.gatewayId;
  const gatewayId = Array.isArray(gatewayIdParam)
    ? gatewayIdParam[0]
    : gatewayIdParam;

  const { isAdmin } = useOrganizationMembership(isSignedIn);

  const [name, setName] = useState<string | undefined>(undefined);
  const [nodeClass, setNodeClass] = useState<NodeClass | undefined>(undefined);
  const [gatewayUrl, setGatewayUrl] = useState<string | undefined>(undefined);
  const [gatewayToken, setGatewayToken] = useState<string | undefined>(
    undefined,
  );
  const [disableDevicePairing, setDisableDevicePairing] = useState<
    boolean | undefined
  >(undefined);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | undefined>(
    undefined,
  );
  const [allowInsecureTls, setAllowInsecureTls] = useState<boolean | undefined>(
    undefined,
  );
  const [defaultModelProfile, setDefaultModelProfile] = useState<
    "general" | "coder" | "budget" | undefined
  >(undefined);
  const [modelProfiles, setModelProfiles] = useState<
    GatewayUpdate["model_profiles"] | undefined
  >(undefined);
  const [enabledModelRefs, setEnabledModelRefs] = useState<string[] | undefined>(
    undefined,
  );
  const [providerConfigs, setProviderConfigs] = useState<
    GatewayProviderConfig[] | undefined
  >(undefined);
  const [providerAuthConfigs, setProviderAuthConfigs] = useState<
    GatewayProviderAuthConfig[] | undefined
  >(undefined);
  const [modelDefinitions, setModelDefinitions] = useState<
    GatewayModelDefinition[] | undefined
  >(undefined);
  const [providerSecretRefs, setProviderSecretRefs] = useState<
    GatewayProviderSecretRef[] | undefined
  >(undefined);
  const [providerSecretInputs, setProviderSecretInputs] = useState<
    GatewayProviderSecretInput[] | undefined
  >(undefined);
  const [toolProfile, setToolProfile] = useState<
    "restricted" | "coding" | "research" | "browser-assisted" | undefined
  >(undefined);

  const [gatewayUrlError, setGatewayUrlError] = useState<string | null>(null);
  const [gatewayCheckStatus, setGatewayCheckStatus] =
    useState<GatewayCheckStatus>("idle");
  const [gatewayCheckMessage, setGatewayCheckMessage] = useState<string | null>(
    null,
  );

  const [error, setError] = useState<string | null>(null);

  const gatewayQuery = useGetGatewayApiV1GatewaysGatewayIdGet<
    getGatewayApiV1GatewaysGatewayIdGetResponse,
    ApiError
  >(gatewayId ?? "", {
    query: {
      enabled: Boolean(isSignedIn && isAdmin && gatewayId),
      refetchOnMount: "always",
      retry: false,
    },
  });

  const updateMutation = useUpdateGatewayApiV1GatewaysGatewayIdPatch<ApiError>({
    mutation: {
      onSuccess: (result) => {
        if (result.status === 200) {
          router.push(`/gateways/${result.data.id}`);
        }
      },
      onError: (err) => {
        setError(err.message || "Something went wrong.");
      },
    },
  });

  const loadedGateway =
    gatewayQuery.data?.status === 200 ? gatewayQuery.data.data : null;
  const resolvedName = name ?? loadedGateway?.name ?? "";
  const resolvedNodeClass = nodeClass ?? loadedGateway?.node_class ?? "cloud";
  const resolvedGatewayUrl = gatewayUrl ?? loadedGateway?.url ?? "";
  const resolvedGatewayToken = gatewayToken ?? loadedGateway?.token ?? "";
  const resolvedDisableDevicePairing =
    disableDevicePairing ?? loadedGateway?.disable_device_pairing ?? false;
  const resolvedWorkspaceRoot =
    workspaceRoot ?? loadedGateway?.workspace_root ?? DEFAULT_WORKSPACE_ROOT;
  const resolvedAllowInsecureTls =
    allowInsecureTls ?? loadedGateway?.allow_insecure_tls ?? false;
  const resolvedDefaultModelProfile =
    defaultModelProfile ?? loadedGateway?.default_model_profile ?? "general";
  const resolvedModelProfiles =
    modelProfiles ?? loadedGateway?.model_profiles ?? {};

  const runtimeQuery = useQuery({
    queryKey: ["gateway-runtime", gatewayId],
    queryFn: () => getGatewayRuntime(gatewayId ?? ""),
    enabled: Boolean(isSignedIn && isAdmin && gatewayId),
    refetchInterval: 30_000,
  });
  const toolchainCatalogQuery = useQuery({
    queryKey: ["toolchain-catalog"],
    queryFn: () => getToolchainCatalog(),
    enabled: Boolean(isSignedIn && isAdmin),
    staleTime: 60_000,
  });
  const verifiedModelRefs = useMemo(
    () =>
      runtimeQuery.data?.status === 200
        ? (runtimeQuery.data.data.catalog ?? [])
            .filter((entry) => entry.selectable !== false)
            .map((entry) => ({
              ref: entry.ref,
              label: entry.label || entry.ref,
            }))
        : [],
    [runtimeQuery.data],
  );
  const resolvedEnabledModelRefs =
    enabledModelRefs ??
    loadedGateway?.enabled_model_refs ??
    runtimeQuery.data?.data.enabled_model_refs ??
    verifiedModelRefs.map((entry) => entry.ref);
  const runtimeSummary =
    runtimeQuery.data?.status === 200 ? runtimeQuery.data.data : null;
  const resolvedProviderConfigs =
    providerConfigs ??
    pickManagedList(
      loadedGateway?.provider_configs,
      runtimeSummary?.configured_provider_configs,
    );
  const resolvedProviderAuthConfigs =
    providerAuthConfigs ??
    pickManagedList(
      loadedGateway?.provider_auth_configs,
      runtimeSummary?.configured_provider_auth_configs,
    );
  const resolvedModelDefinitions =
    modelDefinitions ??
    pickManagedList(
      loadedGateway?.model_definitions,
      runtimeSummary?.configured_model_definitions,
    );
  const configuredModelRefs = useMemo(
    () =>
      Array.from(
        new Set(
          resolvedModelDefinitions.map(
            (definition) => `${definition.provider_id}/${definition.model_id}`,
          ),
        ),
      ),
    [resolvedModelDefinitions],
  );
  const availableModelRefs = configuredModelRefs.length > 0
    ? configuredModelRefs
    : verifiedModelRefs.map((entry) => entry.ref);
  const resolvedProviderSecretRefs =
    providerSecretRefs ??
    pickManagedList(
      loadedGateway?.provider_secret_refs,
      runtimeSummary?.configured_provider_secret_refs,
    );
  const resolvedToolProfile =
    toolProfile ??
    loadedGateway?.tool_profile ??
    runtimeSummary?.effective_tool_profile ??
    "coding";
  const normalizedEnabledModelRefsForSave =
    availableModelRefs.length > 0
      ? resolvedEnabledModelRefs.length < availableModelRefs.length
        ? resolvedEnabledModelRefs
        : null
      : loadedGateway?.enabled_model_refs ?? null;

  const isLoading =
    gatewayQuery.isLoading ||
    updateMutation.isPending ||
    gatewayCheckStatus === "checking";
  const errorMessage = error ?? gatewayQuery.error?.message ?? null;

  const canSubmit =
    Boolean(resolvedName.trim()) &&
    Boolean(resolvedGatewayUrl.trim()) &&
    Boolean(resolvedWorkspaceRoot.trim());

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isSignedIn || !gatewayId) return;

    if (!resolvedName.trim()) {
      setError("Gateway name is required.");
      return;
    }
    const gatewayValidation = validateGatewayUrl(resolvedGatewayUrl);
    setGatewayUrlError(gatewayValidation);
    if (gatewayValidation) {
      setGatewayCheckStatus("error");
      setGatewayCheckMessage(gatewayValidation);
      return;
    }
    if (!resolvedWorkspaceRoot.trim()) {
      setError("Workspace root is required.");
      return;
    }
    if (availableModelRefs.length > 0 && resolvedEnabledModelRefs.length === 0) {
      setError("Enable at least one node model for agents.");
      return;
    }

    setGatewayCheckStatus("checking");
    setGatewayCheckMessage(null);
    const { ok, message } = await checkGatewayConnection({
      gatewayUrl: resolvedGatewayUrl,
      gatewayToken: resolvedGatewayToken,
      gatewayDisableDevicePairing: resolvedDisableDevicePairing,
      gatewayAllowInsecureTls: resolvedAllowInsecureTls,
    });
    setGatewayCheckStatus(ok ? "success" : "error");
    setGatewayCheckMessage(message);
    if (!ok) {
      return;
    }

    setError(null);

    const payload: GatewayUpdate = {
      name: resolvedName.trim(),
      node_class: resolvedNodeClass,
      url: resolvedGatewayUrl.trim(),
      token: resolvedGatewayToken.trim() || null,
      disable_device_pairing: resolvedDisableDevicePairing,
      workspace_root: resolvedWorkspaceRoot.trim(),
      allow_insecure_tls: resolvedAllowInsecureTls,
      default_model_profile: resolvedDefaultModelProfile,
      model_profiles: resolvedModelProfiles,
      enabled_model_refs: normalizedEnabledModelRefsForSave,
      tool_profile: resolvedToolProfile,
      provider_configs: sanitizeProviderConfigs(resolvedProviderConfigs),
      provider_auth_configs: sanitizeProviderAuthConfigs(
        resolvedProviderAuthConfigs,
      ),
      model_definitions: sanitizeModelDefinitions(resolvedModelDefinitions),
      provider_secret_refs: sanitizeProviderSecretRefs(
        resolvedProviderSecretRefs,
      ),
      provider_secret_inputs: sanitizeProviderSecretInputs(
        providerSecretInputs ?? [],
      ),
    };

    updateMutation.mutate({ gatewayId, data: payload });
  };

  return (
    <DashboardPageLayout
      signedOut={{
        message: "Sign in to edit a gateway.",
        forceRedirectUrl: `/gateways/${gatewayId}/edit`,
      }}
      title={
        resolvedName.trim()
          ? `Edit node — ${resolvedName.trim()}`
          : "Edit node"
      }
      description="Update connection, model policy, and capability defaults for this node."
      isAdmin={isAdmin}
      adminOnlyMessage="Only organization owners and admins can edit nodes."
    >
      <GatewayForm
        name={resolvedName}
        nodeClass={resolvedNodeClass}
        gatewayUrl={resolvedGatewayUrl}
        gatewayToken={resolvedGatewayToken}
        disableDevicePairing={resolvedDisableDevicePairing}
        workspaceRoot={resolvedWorkspaceRoot}
        allowInsecureTls={resolvedAllowInsecureTls}
        defaultModelProfile={resolvedDefaultModelProfile}
        modelProfiles={resolvedModelProfiles}
        verifiedModelRefs={
          configuredModelRefs.length > 0
            ? resolvedModelDefinitions.map((definition) => ({
                ref: `${definition.provider_id}/${definition.model_id}`,
                label:
                  definition.label?.trim() ||
                  `${definition.provider_id}/${definition.model_id}`,
              }))
            : verifiedModelRefs
        }
        enabledModelRefs={resolvedEnabledModelRefs}
        providerConfigs={resolvedProviderConfigs}
        providerAuthConfigs={resolvedProviderAuthConfigs}
        modelDefinitions={resolvedModelDefinitions}
        providerSecretRefs={resolvedProviderSecretRefs}
        providerSecretInputs={providerSecretInputs ?? []}
        toolchainCatalog={toolchainCatalogQuery.data?.data.providers ?? []}
        toolProfile={resolvedToolProfile}
        effectiveToolPolicy={runtimeSummary?.effective_tool_policy ?? null}
        runtimeProviderSummaries={runtimeSummary?.providers ?? []}
        driftDetected={runtimeSummary?.drift_detected ?? false}
        gatewayUrlError={gatewayUrlError}
        gatewayCheckStatus={gatewayCheckStatus}
        gatewayCheckMessage={gatewayCheckMessage}
        errorMessage={errorMessage}
        isLoading={isLoading}
        canSubmit={canSubmit}
        workspaceRootPlaceholder={DEFAULT_WORKSPACE_ROOT}
        cancelLabel="Back"
        submitLabel="Save changes"
        submitBusyLabel="Saving…"
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
        onProviderConfigsChange={setProviderConfigs}
        onProviderAuthConfigsChange={setProviderAuthConfigs}
        onModelDefinitionsChange={setModelDefinitions}
        onProviderSecretRefsChange={setProviderSecretRefs}
        onProviderSecretInputsChange={setProviderSecretInputs}
        onToolProfileChange={setToolProfile}
        onEnabledModelRefsChange={(next) => {
          setEnabledModelRefs(next);
          const nextRefs = new Set(next);
          setModelProfiles((current) => {
            const source = current ?? loadedGateway?.model_profiles ?? {};
            let changed = false;
            const patched = { ...source };
            (["general", "coder", "budget"] as const).forEach((profile) => {
              const selection = source?.[profile];
              if (!selection?.primary_model || nextRefs.has(selection.primary_model)) {
                return;
              }
              patched[profile] = {
                ...selection,
                primary_model: null,
              };
              changed = true;
            });
            return changed ? patched : current;
          });
          setError(null);
        }}
        onModelProfilePrimaryChange={(profile, value) => {
          setModelProfiles((current) => ({
            ...(current ?? loadedGateway?.model_profiles ?? {}),
            [profile]: {
              primary_model: value,
              fallback_models:
                (current ?? loadedGateway?.model_profiles ?? {})?.[profile]
                  ?.fallback_models ?? [],
            },
          }));
        }}
      />
    </DashboardPageLayout>
  );
}
