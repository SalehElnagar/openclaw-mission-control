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
import { useOrganizationMembership } from "@/lib/use-organization-membership";
import type { GatewayUpdate } from "@/api/generated/model";
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
  const normalizedEnabledModelRefsForSave =
    verifiedModelRefs.length > 0
      ? resolvedEnabledModelRefs.length < verifiedModelRefs.length
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
    if (verifiedModelRefs.length > 0 && resolvedEnabledModelRefs.length === 0) {
      setError("Enable at least one verified node model for agents.");
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
        verifiedModelRefs={verifiedModelRefs}
        enabledModelRefs={resolvedEnabledModelRefs}
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
