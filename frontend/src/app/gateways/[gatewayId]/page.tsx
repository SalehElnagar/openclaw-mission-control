"use client";

export const dynamic = "force-dynamic";

import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import {
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
} from "next/navigation";

import { useAuth } from "@/auth/clerk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AgentsTable } from "@/components/agents/AgentsTable";
import { DashboardPageLayout } from "@/components/templates/DashboardPageLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";

import { ApiError } from "@/api/mutator";
import {
  type listBoardsApiV1BoardsGetResponse,
  useListBoardsApiV1BoardsGet,
} from "@/api/generated/boards/boards";
import {
  type gatewaysStatusApiV1GatewaysStatusGetResponse,
  type getGatewayApiV1GatewaysGatewayIdGetResponse,
  getGetGatewayApiV1GatewaysGatewayIdGetQueryKey,
  useGatewaysStatusApiV1GatewaysStatusGet,
  useGetGatewayApiV1GatewaysGatewayIdGet,
  useSyncGatewayTemplatesApiV1GatewaysGatewayIdTemplatesSyncPost,
} from "@/api/generated/gateways/gateways";
import {
  type listAgentsApiV1AgentsGetResponse,
  getListAgentsApiV1AgentsGetQueryKey,
  useDeleteAgentApiV1AgentsAgentIdDelete,
  useListAgentsApiV1AgentsGet,
} from "@/api/generated/agents/agents";
import {
  type AgentRead,
  type GatewayProviderAuthConfig,
  type MarketplaceSkillCardRead,
  type SkillPackRead,
} from "@/api/generated/model";
import {
  type listMarketplaceSkillsApiV1SkillsMarketplaceGetResponse,
  type listSkillPacksApiV1SkillsPacksGetResponse,
  useInstallMarketplaceSkillApiV1SkillsMarketplaceSkillIdInstallPost,
  useListMarketplaceSkillsApiV1SkillsMarketplaceGet,
  useListSkillPacksApiV1SkillsPacksGet,
  useUninstallMarketplaceSkillApiV1SkillsMarketplaceSkillIdUninstallPost,
} from "@/api/generated/skills/skills";
import {
  aggregateUsage,
  getGatewayRuntime,
  type GatewayProviderAuthChallenge,
  type GatewayRuntimeCatalogEntry,
  type GatewayRuntimeProviderSummary,
  mutateGatewayProviderAuth,
  listGatewayAudit,
  pullGatewayTelemetry,
  reconcileGatewayRuntime,
} from "@/api/runtime-control";
import { formatTimestamp } from "@/lib/formatters";
import {
  isInteractiveProviderAuthMode,
  readPendingInteractiveProviderIds,
} from "@/lib/gateway-interactive-auth";
import { buildGatewayRuntimeView } from "@/lib/gateway-runtime-view";
import { createOptimisticListDeleteMutation } from "@/lib/list-delete";
import {
  providerAuthAllowsInteractiveActions,
  providerAuthModeLabel,
  providerAuthStateLabel,
} from "@/lib/provider-auth";
import { useOrganizationMembership } from "@/lib/use-organization-membership";

const maskToken = (value?: string | null) => {
  if (!value) return "—";
  if (value.length <= 8) return "••••";
  return `••••${value.slice(-4)}`;
};

const formatUsd = (value: number): string =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);

const modelSelectionLabel = (
  value?: { primary_model?: string | null; fallback_models?: string[] } | null,
) => {
  if (!value || !value.primary_model) return "Not configured";
  const fallbackCount = value.fallback_models?.length ?? 0;
  return fallbackCount > 0
    ? `${value.primary_model} (+${fallbackCount} fallback)`
    : value.primary_model;
};

const catalogEntryProviderLabel = (entry: GatewayRuntimeCatalogEntry): string =>
  entry.provider_label || entry.provider;

const catalogEntryStatusLabel = (entry: GatewayRuntimeCatalogEntry): string =>
  entry.selectable !== false ? "Verified live" : "Configured only";

const catalogEntryStatusClassName = (
  entry: GatewayRuntimeCatalogEntry,
): string =>
  entry.selectable !== false
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
    : "border-amber-500/30 bg-amber-500/10 text-amber-300";

const toolProfileLabel = (
  value?: "restricted" | "coding" | "research" | "browser-assisted" | null,
): string => {
  switch (value) {
    case "restricted":
      return "Restricted";
    case "research":
      return "Research";
    case "browser-assisted":
      return "Browser-assisted";
    case "coding":
    default:
      return "Coding";
  }
};

const providerAuthStateVariant = (
  state?:
    | "verified"
    | "configured"
    | "requires-login"
    | "expired"
    | "disconnected"
    | null,
  requiresLogin?: boolean | null,
): "success" | "warning" | "danger" | "outline" => {
  if (requiresLogin || state === "requires-login") {
    return "warning";
  }
  if (state === "verified") {
    return "success";
  }
  if (state === "expired" || state === "disconnected") {
    return "danger";
  }
  return "outline";
};

const interactiveProgressLabel = (
  status: InteractiveConnectProgress["status"],
): string => {
  switch (status) {
    case "queued":
      return "Queued";
    case "starting":
      return "Starting sign-in";
    case "pending":
      return "Action needed";
    case "verified":
      return "Verified";
    case "error":
      return "Needs attention";
  }
};

const interactiveProgressVariant = (
  status: InteractiveConnectProgress["status"],
): "outline" | "warning" | "success" | "danger" => {
  switch (status) {
    case "queued":
    case "starting":
      return "outline";
    case "pending":
      return "warning";
    case "verified":
      return "success";
    case "error":
      return "danger";
  }
};

type ProviderAuthRecord = {
  providerId: string;
  authConfig: GatewayProviderAuthConfig | null;
  runtime: GatewayRuntimeProviderSummary | null;
};

type InteractiveConnectProgress = {
  providerId: string;
  status: "queued" | "starting" | "pending" | "verified" | "error";
  message?: string | null;
  challenge?: GatewayProviderAuthChallenge | null;
};

export default function GatewayDetailPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const params = useParams();
  const { isSignedIn } = useAuth();
  const gatewayIdParam = params?.gatewayId;
  const gatewayId = Array.isArray(gatewayIdParam)
    ? gatewayIdParam[0]
    : gatewayIdParam;

  const { isAdmin } = useOrganizationMembership(isSignedIn);
  const [deleteTarget, setDeleteTarget] = useState<AgentRead | null>(null);
  const [pendingConnectProviderIds, setPendingConnectProviderIds] = useState<
    string[]
  >([]);
  const [interactiveConnectProgress, setInteractiveConnectProgress] = useState<
    Record<string, InteractiveConnectProgress>
  >({});
  const hydratedQueueSignatureRef = useRef<string>("");
  const agentsKey = getListAgentsApiV1AgentsGetQueryKey(
    gatewayId ? { gateway_id: gatewayId } : undefined,
  );

  const gatewayQuery = useGetGatewayApiV1GatewaysGatewayIdGet<
    getGatewayApiV1GatewaysGatewayIdGetResponse,
    ApiError
  >(gatewayId ?? "", {
    query: {
      enabled: Boolean(isSignedIn && isAdmin && gatewayId),
      refetchInterval: 30_000,
    },
  });

  const gateway =
    gatewayQuery.data?.status === 200 ? gatewayQuery.data.data : null;

  const boardsQuery = useListBoardsApiV1BoardsGet<
    listBoardsApiV1BoardsGetResponse,
    ApiError
  >(undefined, {
    query: {
      enabled: Boolean(isSignedIn && isAdmin),
      refetchInterval: 30_000,
    },
  });

  const agentsQuery = useListAgentsApiV1AgentsGet<
    listAgentsApiV1AgentsGetResponse,
    ApiError
  >(gatewayId ? { gateway_id: gatewayId } : undefined, {
    query: {
      enabled: Boolean(isSignedIn && isAdmin && gatewayId),
      refetchInterval: 15_000,
    },
  });
  const deleteMutation = useDeleteAgentApiV1AgentsAgentIdDelete<
    ApiError,
    { previous?: listAgentsApiV1AgentsGetResponse }
  >(
    {
      mutation: createOptimisticListDeleteMutation<
        AgentRead,
        listAgentsApiV1AgentsGetResponse,
        { agentId: string }
      >({
        queryClient,
        queryKey: agentsKey,
        getItemId: (agent) => agent.id,
        getDeleteId: ({ agentId }) => agentId,
        onSuccess: () => {
          setDeleteTarget(null);
        },
        invalidateQueryKeys: [agentsKey],
      }),
    },
    queryClient,
  );

  const statusParams = gateway
    ? {
        gateway_url: gateway.url,
        gateway_token: gateway.token ?? undefined,
        gateway_disable_device_pairing: gateway.disable_device_pairing,
        gateway_allow_insecure_tls: gateway.allow_insecure_tls,
      }
    : {};

  const statusQuery = useGatewaysStatusApiV1GatewaysStatusGet<
    gatewaysStatusApiV1GatewaysStatusGetResponse,
    ApiError
  >(statusParams, {
    query: {
      enabled: Boolean(isSignedIn && isAdmin && gateway),
      refetchInterval: 15_000,
    },
  });
  const [controlMessage, setControlMessage] = useState<string | null>(null);
  const runtimeQuery = useQuery({
    queryKey: ["gateway-runtime", gatewayId],
    enabled: Boolean(isSignedIn && isAdmin && gatewayId),
    refetchInterval: 30_000,
    queryFn: () => getGatewayRuntime(gatewayId ?? ""),
  });
  const usageQuery = useQuery({
    queryKey: ["gateway-usage", gatewayId],
    enabled: Boolean(isSignedIn && isAdmin && gatewayId),
    refetchInterval: 45_000,
    queryFn: () => aggregateUsage({ gateway_id: gatewayId }),
  });
  const auditQuery = useQuery({
    queryKey: ["gateway-audit", gatewayId],
    enabled: Boolean(isSignedIn && isAdmin && gatewayId),
    refetchInterval: 45_000,
    queryFn: () => listGatewayAudit(gatewayId ?? "", { limit: 6 }),
  });
  const marketplaceSkillsQuery =
    useListMarketplaceSkillsApiV1SkillsMarketplaceGet<
      listMarketplaceSkillsApiV1SkillsMarketplaceGetResponse,
      ApiError
    >(
      { gateway_id: gatewayId ?? "" },
      {
        query: {
          enabled: Boolean(isSignedIn && isAdmin && gatewayId),
          refetchInterval: 30_000,
        },
      },
    );
  const skillPacksQuery = useListSkillPacksApiV1SkillsPacksGet<
    listSkillPacksApiV1SkillsPacksGetResponse,
    ApiError
  >({
    query: {
      enabled: Boolean(isSignedIn && isAdmin),
      refetchOnMount: "always",
    },
  });
  const syncTemplatesMutation =
    useSyncGatewayTemplatesApiV1GatewaysGatewayIdTemplatesSyncPost<ApiError>(
      {
        mutation: {
          onSuccess: (result) => {
            if (result.status !== 200) return;
            setControlMessage(
              `Synced templates: ${result.data.agents_updated} updated, ${result.data.agents_skipped} skipped.`,
            );
            queryClient.invalidateQueries({
              queryKey: ["/api/v1/agents"],
            });
            queryClient.invalidateQueries({
              queryKey: ["gateway-runtime", gatewayId],
            });
            queryClient.invalidateQueries({
              queryKey: ["gateway-audit", gatewayId],
            });
          },
        },
      },
      queryClient,
    );
  const reconcileMutation = useMutation({
    mutationFn: () =>
      reconcileGatewayRuntime(gatewayId ?? "", {
        repair_stuck_agents: true,
        sync_models: true,
        wake_agents: true,
      }),
    onSuccess: (result) => {
      if (result.status !== 200) return;
      const repaired = result.data.repaired_agents.length;
      setControlMessage(
        `Runtime reconciled. ${repaired} repaired, generation ${result.data.sync_generation}.`,
      );
      queryClient.invalidateQueries({
        queryKey: ["gateway-runtime", gatewayId],
      });
      queryClient.invalidateQueries({
        queryKey: ["gateway-audit", gatewayId],
      });
      queryClient.invalidateQueries({
        queryKey: ["/api/v1/gateways/status"],
      });
      queryClient.invalidateQueries({
        queryKey: ["/api/v1/agents"],
      });
    },
  });
  const pullTelemetryMutation = useMutation({
    mutationFn: () => pullGatewayTelemetry(gatewayId ?? ""),
    onSuccess: (result) => {
      if (result.status !== 200) return;
      setControlMessage(
        `Telemetry pulled. ${result.data.ingested_samples} sample(s) ingested.`,
      );
      queryClient.invalidateQueries({
        queryKey: ["gateway-usage", gatewayId],
      });
      queryClient.invalidateQueries({
        queryKey: ["gateway-runtime", gatewayId],
      });
      queryClient.invalidateQueries({
        queryKey: ["gateway-audit", gatewayId],
      });
    },
  });
  const providerAuthMutation = useMutation({
    mutationFn: (variables?: {
      providerId: string;
      action: "connect" | "refresh" | "disconnect";
      source?: "manual" | "auto-queue";
    }) => {
      if (!variables) {
        throw new Error("Provider auth action payload is required.");
      }
      return mutateGatewayProviderAuth(
        gatewayId ?? "",
        variables.providerId,
        variables.action,
      );
    },
    onSuccess: (
      result,
      variables?: {
        providerId: string;
        action: "connect" | "refresh" | "disconnect";
        source?: "manual" | "auto-queue";
      },
    ) => {
      if (result.status !== 200) return;
      const responseMessage =
        result.data.message ??
        `Provider ${result.data.provider_id} ${result.data.auth_state ?? "updated"}.`;
      const progressStatus: InteractiveConnectProgress["status"] =
        result.data.auth_state === "verified" &&
        result.data.requires_login !== true
          ? "verified"
          : result.data.challenge ||
              result.data.requires_login ||
              result.data.auth_state === "requires-login"
            ? "pending"
            : "pending";

      if (variables?.action === "connect" && variables.providerId) {
        setInteractiveConnectProgress((current) => ({
          ...current,
          [variables.providerId]: {
            providerId: variables.providerId,
            status: progressStatus,
            message: responseMessage,
            challenge: result.data.challenge ?? null,
          },
        }));
        setPendingConnectProviderIds((current) =>
          current.filter((providerId) => providerId !== variables.providerId),
        );
      }
      setControlMessage(responseMessage);
      queryClient.invalidateQueries({
        queryKey: ["gateway-runtime", gatewayId],
      });
      queryClient.invalidateQueries({
        queryKey: getGetGatewayApiV1GatewaysGatewayIdGetQueryKey(
          gatewayId ?? "",
        ),
      });
    },
    onError: (
      err: Error,
      variables?: {
        providerId: string;
        action: "connect" | "refresh" | "disconnect";
        source?: "manual" | "auto-queue";
      },
    ) => {
      if (variables?.action === "connect" && variables.providerId) {
        setInteractiveConnectProgress((current) => ({
          ...current,
          [variables.providerId]: {
            providerId: variables.providerId,
            status: "error",
            message: err.message || "Provider auth action failed.",
            challenge: null,
          },
        }));
        setPendingConnectProviderIds((current) =>
          current.filter((providerId) => providerId !== variables.providerId),
        );
      }
      setControlMessage(err.message || "Provider auth action failed.");
    },
  });
  const installSkillMutation =
    useInstallMarketplaceSkillApiV1SkillsMarketplaceSkillIdInstallPost<ApiError>(
      {
        mutation: {
          onSuccess: async () => {
            setControlMessage("Installed marketplace skill on this node.");
            await queryClient.invalidateQueries({
              queryKey: ["/api/v1/skills/marketplace"],
            });
          },
        },
      },
      queryClient,
    );
  const uninstallSkillMutation =
    useUninstallMarketplaceSkillApiV1SkillsMarketplaceSkillIdUninstallPost<ApiError>(
      {
        mutation: {
          onSuccess: async () => {
            setControlMessage("Removed marketplace skill from this node.");
            await queryClient.invalidateQueries({
              queryKey: ["/api/v1/skills/marketplace"],
            });
          },
        },
      },
      queryClient,
    );

  const agents = useMemo(
    () =>
      agentsQuery.data?.status === 200
        ? (agentsQuery.data.data.items ?? [])
        : [],
    [agentsQuery.data],
  );
  const boards = useMemo(
    () =>
      boardsQuery.data?.status === 200
        ? (boardsQuery.data.data.items ?? [])
        : [],
    [boardsQuery.data],
  );

  const status =
    statusQuery.data?.status === 200 ? statusQuery.data.data : null;
  const runtime =
    runtimeQuery.data?.status === 200 ? runtimeQuery.data.data : null;
  const usage = usageQuery.data?.status === 200 ? usageQuery.data.data : null;
  const auditRecords =
    auditQuery.data?.status === 200 ? (auditQuery.data.data.items ?? []) : [];
  const marketplaceSkills = useMemo<MarketplaceSkillCardRead[]>(
    () =>
      marketplaceSkillsQuery.data?.status === 200
        ? marketplaceSkillsQuery.data.data
        : [],
    [marketplaceSkillsQuery.data],
  );
  const installedSkills = useMemo(
    () => marketplaceSkills.filter((skill) => skill.installed),
    [marketplaceSkills],
  );
  const availableSkills = useMemo(
    () => marketplaceSkills.filter((skill) => !skill.installed),
    [marketplaceSkills],
  );
  const skillPacks = useMemo<SkillPackRead[]>(
    () =>
      skillPacksQuery.data?.status === 200 ? skillPacksQuery.data.data : [],
    [skillPacksQuery.data],
  );
  const isConnected = status?.connected ?? false;

  const title = useMemo(
    () => (gateway?.name ? gateway.name : "Node"),
    [gateway?.name],
  );
  const roleLabels = useMemo(
    () =>
      [
        ...new Set(
          agents
            .map((agent) =>
              typeof agent.identity_profile?.role === "string"
                ? agent.identity_profile.role
                : agent.is_gateway_main
                  ? "Gateway Agent"
                  : null,
            )
            .filter(Boolean),
        ),
      ] as string[],
    [agents],
  );
  const runtimeCatalog = useMemo(
    () =>
      (runtime?.catalog ?? []).filter(
        (entry) => (entry.kind ?? "model") === "model",
      ),
    [runtime?.catalog],
  );
  const enabledModelRefSet = useMemo(
    () => new Set(runtime?.enabled_model_refs ?? []),
    [runtime?.enabled_model_refs],
  );
  const runtimeProviders = useMemo(
    () => runtime?.providers ?? [],
    [runtime?.providers],
  );
  const configuredProviderConfigs = useMemo(
    () => runtime?.configured_provider_configs ?? [],
    [runtime?.configured_provider_configs],
  );
  const configuredProviderAuthConfigs = useMemo(
    () =>
      runtime?.configured_provider_auth_configs ??
      gateway?.provider_auth_configs ??
      [],
    [gateway?.provider_auth_configs, runtime?.configured_provider_auth_configs],
  );
  const configuredModelDefinitions = useMemo(
    () => runtime?.configured_model_definitions ?? [],
    [runtime?.configured_model_definitions],
  );
  const configuredProviderSecretRefs = useMemo(
    () => runtime?.configured_provider_secret_refs ?? [],
    [runtime?.configured_provider_secret_refs],
  );
  const gatewayNodeClass = gateway?.node_class ?? "cloud";
  const runtimeView = useMemo(
    () =>
      buildGatewayRuntimeView({
        runtimeCatalog,
        runtimeProviders,
        configuredProviderConfigs,
        configuredProviderAuthConfigs,
        configuredModelDefinitions,
        configuredProviderSecretRefs,
      }),
    [
      configuredModelDefinitions,
      configuredProviderAuthConfigs,
      configuredProviderConfigs,
      configuredProviderSecretRefs,
      runtimeCatalog,
      runtimeProviders,
    ],
  );
  const providerAuthRecords = useMemo<ProviderAuthRecord[]>(() => {
    const runtimeById = new Map(
      runtimeProviders.map((provider) => [provider.id, provider]),
    );
    const configById = new Map(
      configuredProviderAuthConfigs.map((config) => [
        config.provider_id,
        config,
      ]),
    );
    const ids = new Set([
      ...runtimeById.keys(),
      ...configById.keys(),
      ...configuredProviderConfigs.map((provider) => provider.id),
    ]);
    return Array.from(ids).map((providerId) => ({
      providerId,
      authConfig: configById.get(providerId) ?? null,
      runtime: runtimeById.get(providerId) ?? null,
    }));
  }, [
    configuredProviderAuthConfigs,
    configuredProviderConfigs,
    runtimeProviders,
  ]);
  const managedProviderAuthRecords = useMemo(() => {
    const managedProviderIds = new Set(runtimeView.managedProviderIds);
    return providerAuthRecords.filter((record) =>
      managedProviderIds.has(record.providerId),
    );
  }, [providerAuthRecords, runtimeView.managedProviderIds]);
  const providerAuthRecordById = useMemo(
    () =>
      new Map(providerAuthRecords.map((record) => [record.providerId, record])),
    [providerAuthRecords],
  );
  const pendingConnectProviderIdsFromUrl = useMemo(
    () => readPendingInteractiveProviderIds(searchParams),
    [searchParams],
  );
  const interactiveProvidersNeedingLogin = useMemo(
    () =>
      managedProviderAuthRecords
        .filter((record) =>
          isInteractiveProviderAuthMode(
            record.authConfig?.auth_mode ?? record.runtime?.auth_mode ?? null,
          ),
        )
        .filter(
          (record) =>
            record.runtime?.requires_login ||
            record.runtime?.auth_state === "requires-login",
        )
        .map((record) => record.providerId),
    [managedProviderAuthRecords],
  );
  const interactivePanelProviderIds = useMemo(
    () =>
      Array.from(
        new Set([
          ...pendingConnectProviderIds,
          ...interactiveProvidersNeedingLogin,
          ...Object.keys(interactiveConnectProgress),
        ]),
      ),
    [
      interactiveConnectProgress,
      interactiveProvidersNeedingLogin,
      pendingConnectProviderIds,
    ],
  );
  const shouldShowInteractivePanel = useMemo(
    () =>
      pendingConnectProviderIds.length > 0 ||
      interactiveProvidersNeedingLogin.length > 0 ||
      Object.values(interactiveConnectProgress).some(
        (progress) => progress.status !== "verified",
      ),
    [
      interactiveConnectProgress,
      interactiveProvidersNeedingLogin.length,
      pendingConnectProviderIds.length,
    ],
  );

  useEffect(() => {
    if (!pendingConnectProviderIdsFromUrl.length) {
      return;
    }
    const signature = pendingConnectProviderIdsFromUrl.join(",");
    if (hydratedQueueSignatureRef.current === signature) {
      return;
    }
    hydratedQueueSignatureRef.current = signature;
    startTransition(() => {
      setPendingConnectProviderIds((current) =>
        Array.from(new Set([...current, ...pendingConnectProviderIdsFromUrl])),
      );
      setInteractiveConnectProgress((current) => {
        const next = { ...current };
        pendingConnectProviderIdsFromUrl.forEach((providerId) => {
          next[providerId] = next[providerId] ?? {
            providerId,
            status: "queued",
          };
        });
        return next;
      });
    });

    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.delete("connectProvider");
    const nextQuery = nextParams.toString();
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname);
  }, [pathname, pendingConnectProviderIdsFromUrl, router, searchParams]);

  useEffect(() => {
    const nextProviderId = pendingConnectProviderIds[0];
    if (
      !gatewayId ||
      !isSignedIn ||
      !isAdmin ||
      !nextProviderId ||
      providerAuthMutation.isPending
    ) {
      return;
    }

    const nextRecord = providerAuthRecordById.get(nextProviderId) ?? null;
    const authMode =
      nextRecord?.authConfig?.auth_mode ??
      nextRecord?.runtime?.auth_mode ??
      null;
    if (authMode && !isInteractiveProviderAuthMode(authMode)) {
      startTransition(() => {
        setPendingConnectProviderIds((current) =>
          current.filter((providerId) => providerId !== nextProviderId),
        );
      });
      return;
    }
    if (
      nextRecord?.runtime?.auth_state === "verified" &&
      nextRecord.runtime.requires_login !== true
    ) {
      startTransition(() => {
        setInteractiveConnectProgress((current) => ({
          ...current,
          [nextProviderId]: {
            providerId: nextProviderId,
            status: "verified",
            message: "Sign-in is already verified on this node.",
            challenge: null,
          },
        }));
        setPendingConnectProviderIds((current) =>
          current.filter((providerId) => providerId !== nextProviderId),
        );
      });
      return;
    }
    if (interactiveConnectProgress[nextProviderId]?.status === "starting") {
      return;
    }

    startTransition(() => {
      setInteractiveConnectProgress((current) => ({
        ...current,
        [nextProviderId]: {
          providerId: nextProviderId,
          status: "starting",
          message: "Starting provider sign-in on the node runtime…",
          challenge: current[nextProviderId]?.challenge ?? null,
        },
      }));
    });
    providerAuthMutation.mutate({
      providerId: nextProviderId,
      action: "connect",
      source: "auto-queue",
    });
  }, [
    gatewayId,
    interactiveConnectProgress,
    isAdmin,
    isSignedIn,
    pendingConnectProviderIds,
    providerAuthMutation,
    providerAuthRecordById,
  ]);
  const handleDelete = () => {
    if (!deleteTarget) return;
    deleteMutation.mutate({ agentId: deleteTarget.id });
  };

  return (
    <>
      <DashboardPageLayout
        signedOut={{
          message: "Sign in to view a node.",
          forceRedirectUrl: `/gateways/${gatewayId}`,
        }}
        title={title}
        description="Node configuration, model policy, and runtime health."
        headerActions={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => router.push("/gateways")}>
              Back to nodes
            </Button>
            {isAdmin && gatewayId ? (
              <Button
                onClick={() => router.push(`/gateways/${gatewayId}/edit`)}
              >
                Edit node
              </Button>
            ) : null}
          </div>
        }
        isAdmin={isAdmin}
        adminOnlyMessage="Only organization owners and admins can access nodes."
      >
        {gatewayQuery.isLoading ? (
          <div className="rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] p-6 text-sm text-muted shadow-sm">
            Loading node…
          </div>
        ) : gatewayQuery.error ? (
          <div className="rounded-xl border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/10 p-6 text-sm text-[color:var(--danger)]">
            {gatewayQuery.error.message}
          </div>
        ) : gateway ? (
          <div className="space-y-6">
            <div className="grid gap-6 xl:grid-cols-3">
              <div className="rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                    Connection
                  </p>
                  <div className="flex items-center gap-2 text-xs text-muted">
                    <span
                      className={`h-2 w-2 rounded-full ${
                        statusQuery.isLoading
                          ? "bg-[color:var(--text-quiet)]"
                          : isConnected
                            ? "bg-emerald-500"
                            : "bg-rose-500"
                      }`}
                    />
                    <span>
                      {statusQuery.isLoading
                        ? "Checking"
                        : isConnected
                          ? "Online"
                          : "Offline"}
                    </span>
                  </div>
                </div>
                <div className="mt-4 space-y-3 text-sm text-muted">
                  <div>
                    <p className="text-xs uppercase text-quiet">Gateway URL</p>
                    <p className="mt-1 text-sm font-medium text-strong">
                      {gateway.url}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-quiet">Node class</p>
                    <p className="mt-1 text-sm font-medium capitalize text-strong">
                      {gateway.node_class ?? "cloud"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-quiet">Token</p>
                    <p className="mt-1 text-sm font-medium text-strong">
                      {maskToken(gateway.token)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-quiet">
                      Device pairing
                    </p>
                    <p className="mt-1 text-sm font-medium text-strong">
                      {gateway.disable_device_pairing ? "Disabled" : "Required"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-quiet">TLS policy</p>
                    <p className="mt-1 text-sm font-medium text-strong">
                      {gateway.allow_insecure_tls
                        ? "Allow self-signed certificates"
                        : "Strict certificate validation"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-quiet">
                      Workspace root
                    </p>
                    <p className="mt-1 text-sm font-medium text-strong">
                      {gateway.workspace_root}
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                    Runtime control
                  </p>
                  {runtimeQuery.isFetching ? (
                    <span className="text-xs text-muted">Syncing…</span>
                  ) : null}
                </div>
                <div className="mt-4 space-y-3 text-sm text-muted">
                  <div>
                    <p className="text-xs uppercase text-quiet">
                      Runtime generation
                    </p>
                    <p className="mt-1 text-sm font-medium text-strong">
                      {runtime?.runtime_sync_generation ?? "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-quiet">
                      Last runtime sync
                    </p>
                    <p className="mt-1 text-sm font-medium text-strong">
                      {formatTimestamp(runtime?.last_runtime_sync_at ?? null)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-quiet">Tool profile</p>
                    <p className="mt-1 text-sm font-medium text-strong">
                      {toolProfileLabel(runtime?.effective_tool_profile)}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      {runtime?.effective_tool_policy?.summary ??
                        "Managed runtime safety profile ready to apply."}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-quiet">
                      Desired toolchain
                    </p>
                    <p className="mt-1 text-sm font-medium text-strong">
                      {configuredProviderConfigs.length} providers ·{" "}
                      {configuredModelDefinitions.length} models ·{" "}
                      {configuredProviderSecretRefs.length} secret refs
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      {runtime?.drift_detected
                        ? "Runtime drift detected. Reconcile will re-apply the Mission Control managed fragment."
                        : "Runtime matches the current Mission Control managed fragment."}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => reconcileMutation.mutate()}
                      disabled={reconcileMutation.isPending}
                    >
                      {reconcileMutation.isPending
                        ? "Reconciling…"
                        : "Reconcile runtime"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        syncTemplatesMutation.mutate({
                          gatewayId: gateway.id,
                          params: {
                            include_main: true,
                            reset_sessions: false,
                            rotate_tokens: false,
                            overwrite: false,
                          },
                        })
                      }
                      disabled={syncTemplatesMutation.isPending}
                    >
                      {syncTemplatesMutation.isPending
                        ? "Syncing…"
                        : "Sync templates"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => pullTelemetryMutation.mutate()}
                      disabled={pullTelemetryMutation.isPending}
                    >
                      {pullTelemetryMutation.isPending
                        ? "Pulling…"
                        : "Pull telemetry"}
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <span className="rounded-full border border-[color:var(--border)] bg-[color:var(--surface-muted)] px-3 py-1 text-xs font-medium text-strong">
                      Browser{" "}
                      {runtime?.effective_tool_policy?.browser_enabled
                        ? "enabled"
                        : "disabled"}
                    </span>
                    <span className="rounded-full border border-[color:var(--border)] bg-[color:var(--surface-muted)] px-3 py-1 text-xs font-medium text-strong">
                      FS{" "}
                      {runtime?.effective_tool_policy?.workspace_only_fs
                        ? "workspace-only"
                        : "broader access"}
                    </span>
                    {runtime?.drift_detected ? (
                      <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-200">
                        Drift detected
                      </span>
                    ) : null}
                  </div>
                  {controlMessage ? (
                    <p className="rounded-md border border-[color:var(--border)] bg-[color:var(--surface-muted)] px-3 py-2 text-xs text-muted">
                      {controlMessage}
                    </p>
                  ) : null}
                  {runtime?.last_runtime_sync_error ? (
                    <p className="rounded-md border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/10 px-3 py-2 text-xs text-[color:var(--danger)]">
                      {runtime.last_runtime_sync_error}
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                    Token & cost analytics
                  </p>
                  {usageQuery.isFetching ? (
                    <span className="text-xs text-muted">Refreshing…</span>
                  ) : null}
                </div>
                <div className="mt-4 grid gap-3 text-sm">
                  <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-3">
                    <p className="text-xs uppercase text-quiet">Total cost</p>
                    <p className="mt-1 text-base font-semibold text-strong">
                      {formatUsd(usage?.total_cost_usd ?? 0)}
                    </p>
                  </div>
                  <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-3">
                    <p className="text-xs uppercase text-quiet">Total tokens</p>
                    <p className="mt-1 text-base font-semibold text-strong">
                      {(usage?.total_tokens ?? 0).toLocaleString("en-US")}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      Prompt{" "}
                      {(usage?.total_prompt_tokens ?? 0).toLocaleString(
                        "en-US",
                      )}{" "}
                      · Completion{" "}
                      {(usage?.total_completion_tokens ?? 0).toLocaleString(
                        "en-US",
                      )}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-quiet">
                      Top model usage
                    </p>
                    <div className="mt-2 space-y-1.5">
                      {Object.entries(usage?.models ?? {})
                        .sort(([, left], [, right]) => right - left)
                        .slice(0, 3)
                        .map(([model, cost]) => (
                          <div
                            key={model}
                            className="flex items-center justify-between rounded-md border border-[color:var(--border)] bg-[color:var(--surface-muted)] px-2.5 py-1.5 text-xs"
                          >
                            <span className="truncate text-muted">{model}</span>
                            <span className="font-semibold text-strong">
                              {formatUsd(cost)}
                            </span>
                          </div>
                        ))}
                      {Object.keys(usage?.models ?? {}).length === 0 ? (
                        <p className="text-xs text-muted">
                          No telemetry samples yet. Use pull telemetry to
                          ingest.
                        </p>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                    Capabilities
                  </p>
                  <span className="text-xs text-muted">
                    {roleLabels.length} role{roleLabels.length === 1 ? "" : "s"}{" "}
                    enabled
                  </span>
                </div>
                <div className="mt-4 space-y-4 text-sm text-muted">
                  <div>
                    <p className="text-xs uppercase text-quiet">
                      Starter pack roles
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {roleLabels.length > 0 ? (
                        roleLabels.map((role) => (
                          <span
                            key={role}
                            className="rounded-full border border-[color:var(--border)] bg-[color:var(--surface-muted)] px-3 py-1 text-xs font-medium text-strong"
                          >
                            {role}
                          </span>
                        ))
                      ) : (
                        <span className="text-sm text-muted">
                          No node inventory roles provisioned yet.
                        </span>
                      )}
                    </div>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-quiet">
                      Supported verified models
                    </p>
                    <p className="mt-1 text-sm font-medium text-strong">
                      {runtimeView.managedLiveCatalogEntries.length}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted">
                      Mission Control currently manages{" "}
                      {runtimeView.managedLiveCatalogEntries.length} verified
                      runtime model
                      {runtimeView.managedLiveCatalogEntries.length === 1
                        ? ""
                        : "s"}{" "}
                      on this node and {runtime?.enabled_model_refs.length ?? 0}{" "}
                      enabled for agents.
                      {runtimeView.unmanagedLiveCatalogEntries.length
                        ? ` ${runtimeView.unmanagedLiveCatalogEntries.length} other runtime-discovered model${
                            runtimeView.unmanagedLiveCatalogEntries.length === 1
                              ? ""
                              : "s"
                          } stay outside the managed flow.`
                        : ""}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-quiet">Modules</p>
                    <div className="mt-2 space-y-3">
                      {shouldShowInteractivePanel ? (
                        <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-3">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <p className="text-xs uppercase text-quiet">
                                Interactive sign-in
                              </p>
                              <p className="mt-1 text-xs text-muted">
                                {gatewayNodeClass === "cloud"
                                  ? "Mission Control starts sign-in against the remote node session after save, then keeps each provider profile here for refresh or disconnect."
                                  : "Mission Control starts sign-in against this local node session after save, then keeps each provider profile here for refresh or disconnect."}
                              </p>
                            </div>
                            <span className="text-xs text-muted">
                              {pendingConnectProviderIds.length > 0
                                ? `${pendingConnectProviderIds.length} queued`
                                : "Monitoring provider auth"}
                            </span>
                          </div>
                          <div className="mt-3 space-y-2">
                            {interactivePanelProviderIds.map((providerId) => {
                              const record =
                                providerAuthRecordById.get(providerId) ?? null;
                              const progress =
                                interactiveConnectProgress[providerId] ?? null;
                              const label =
                                record?.authConfig?.display_label?.trim() ||
                                record?.runtime?.label ||
                                providerId;
                              const fallbackProgressStatus:
                                | InteractiveConnectProgress["status"]
                                | null =
                                record?.runtime?.auth_state === "verified" &&
                                record.runtime.requires_login !== true
                                  ? "verified"
                                  : record?.runtime?.requires_login ||
                                      record?.runtime?.auth_state ===
                                        "requires-login"
                                    ? "pending"
                                    : null;
                              const progressStatus =
                                progress?.status ??
                                fallbackProgressStatus ??
                                "queued";
                              const progressMessage =
                                progress?.message ??
                                (fallbackProgressStatus === "verified"
                                  ? "Sign-in is already verified on this node."
                                  : fallbackProgressStatus === "pending"
                                    ? "This provider still needs an interactive sign-in on the node."
                                    : "Queued to start from this page.");
                              const challenge = progress?.challenge ?? null;

                              return (
                                <div
                                  key={providerId}
                                  className="rounded-md border border-[color:var(--border)] bg-[color:var(--surface)] px-3 py-3"
                                >
                                  <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <p className="text-sm font-medium text-strong">
                                        {label}
                                      </p>
                                      <p className="mt-1 text-xs text-muted">
                                        {providerId}
                                        {record?.authConfig?.profile_id
                                          ? ` · profile ${record.authConfig.profile_id}`
                                          : ""}
                                      </p>
                                    </div>
                                    <Badge
                                      variant={interactiveProgressVariant(
                                        progressStatus,
                                      )}
                                    >
                                      {interactiveProgressLabel(progressStatus)}
                                    </Badge>
                                  </div>
                                  <p className="mt-2 text-xs text-muted">
                                    {progressMessage}
                                  </p>
                                  {challenge?.title ? (
                                    <p className="mt-2 text-xs font-medium text-strong">
                                      {challenge.title}
                                    </p>
                                  ) : null}
                                  {challenge?.message ? (
                                    <p className="mt-2 text-xs text-muted">
                                      {challenge.message}
                                    </p>
                                  ) : null}
                                  {challenge?.instructions?.length ? (
                                    <div className="mt-2 space-y-1 text-xs text-muted">
                                      {challenge.instructions.map(
                                        (instruction) => (
                                          <p
                                            key={`${providerId}-${instruction}`}
                                          >
                                            {instruction}
                                          </p>
                                        ),
                                      )}
                                    </div>
                                  ) : null}
                                  {challenge?.code ? (
                                    <div className="mt-2 rounded-md border border-[color:var(--border)] bg-[color:var(--surface-muted)] px-3 py-2">
                                      <p className="text-[11px] uppercase tracking-wide text-quiet">
                                        Verification code
                                      </p>
                                      <p className="mt-1 font-mono text-sm text-strong">
                                        {challenge.code}
                                      </p>
                                    </div>
                                  ) : null}
                                  {challenge?.action_url ? (
                                    <div className="mt-2">
                                      <a
                                        href={challenge.action_url}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-xs font-medium text-[color:var(--accent)] underline underline-offset-4"
                                      >
                                        {challenge.action_label ??
                                          "Open sign-in link"}
                                      </a>
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ) : null}
                      <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-xs uppercase text-quiet">
                            Provider auth
                          </p>
                          <span className="text-xs text-muted">
                            {managedProviderAuthRecords.length} managed
                          </span>
                        </div>
                        <div className="mt-2 space-y-2">
                          {managedProviderAuthRecords.length > 0 ? (
                            managedProviderAuthRecords.map((record) => {
                              const authMode =
                                record.authConfig?.auth_mode ??
                                record.runtime?.auth_mode ??
                                null;
                              const authState =
                                record.runtime?.auth_state ??
                                (record.runtime?.requires_login
                                  ? "requires-login"
                                  : record.runtime?.verification_state ===
                                      "runtime"
                                    ? "verified"
                                    : "configured");
                              const interactiveAllowed =
                                providerAuthAllowsInteractiveActions(
                                  gatewayNodeClass,
                                  authMode,
                                );

                              return (
                                <div
                                  key={record.providerId}
                                  className="rounded-md border border-[color:var(--border)] bg-[color:var(--surface)] px-3 py-2"
                                >
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <p className="text-sm font-medium text-strong">
                                        {record.authConfig?.display_label?.trim() ||
                                          record.runtime?.label ||
                                          record.providerId}
                                      </p>
                                      <p className="mt-1 text-xs text-muted">
                                        {record.providerId}
                                        {record.authConfig?.profile_id
                                          ? ` · profile ${record.authConfig.profile_id}`
                                          : ""}
                                      </p>
                                    </div>
                                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                                      {authMode ? (
                                        <Badge variant="outline">
                                          {providerAuthModeLabel(authMode)}
                                        </Badge>
                                      ) : null}
                                      <Badge
                                        variant={providerAuthStateVariant(
                                          authState,
                                          record.runtime?.requires_login,
                                        )}
                                      >
                                        {providerAuthStateLabel(
                                          authState,
                                          record.runtime?.requires_login,
                                        )}
                                      </Badge>
                                      {record.runtime?.connected_profile ? (
                                        <Badge variant="accent">
                                          {record.runtime.connected_profile}
                                        </Badge>
                                      ) : null}
                                    </div>
                                  </div>
                                  <p className="mt-2 text-xs text-muted">
                                    {record.runtime?.verification_state ===
                                    "runtime"
                                      ? "Runtime verified auth is available for agent selection."
                                      : "Auth is configured but still needs runtime verification."}
                                  </p>
                                  {record.runtime?.unresolved_secret_refs
                                    ?.length ? (
                                    <p className="mt-2 text-xs text-amber-200">
                                      Unresolved secret refs:{" "}
                                      {record.runtime.unresolved_secret_refs.join(
                                        ", ",
                                      )}
                                    </p>
                                  ) : null}
                                  {interactiveAllowed ? (
                                    <div className="mt-3 flex flex-wrap gap-2">
                                      <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        disabled={
                                          providerAuthMutation.isPending
                                        }
                                        onClick={() =>
                                          providerAuthMutation.mutate({
                                            providerId: record.providerId,
                                            action: "connect",
                                            source: "manual",
                                          })
                                        }
                                      >
                                        Connect
                                      </Button>
                                      <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        disabled={
                                          providerAuthMutation.isPending
                                        }
                                        onClick={() =>
                                          providerAuthMutation.mutate({
                                            providerId: record.providerId,
                                            action: "refresh",
                                            source: "manual",
                                          })
                                        }
                                      >
                                        Refresh
                                      </Button>
                                      <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        disabled={
                                          providerAuthMutation.isPending
                                        }
                                        onClick={() =>
                                          providerAuthMutation.mutate({
                                            providerId: record.providerId,
                                            action: "disconnect",
                                            source: "manual",
                                          })
                                        }
                                      >
                                        Disconnect
                                      </Button>
                                    </div>
                                  ) : authMode === "oauth" ||
                                    authMode === "login" ? (
                                    <p className="mt-3 text-xs text-muted">
                                      {gatewayNodeClass === "cloud"
                                        ? "Interactive sign-in runs on the remote node session. Use Connect, Refresh, or Disconnect here to manage the saved provider profile."
                                        : "Interactive sign-in runs on the local node session. Use Connect, Refresh, or Disconnect here to manage the saved provider profile."}
                                    </p>
                                  ) : null}
                                </div>
                              );
                            })
                          ) : (
                            <p className="text-xs text-muted">
                              No managed integrations observed yet. Save the
                              guided toolchain from Edit node to make one show
                              up here.
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-xs uppercase text-quiet">
                            Other runtime-detected providers
                          </p>
                          <span className="text-xs text-muted">
                            {runtimeView.unmanagedProviders.length} observed
                          </span>
                        </div>
                        <div className="mt-2 space-y-2">
                          {runtimeView.unmanagedProviders.length > 0 ? (
                            runtimeView.unmanagedProviders.map((provider) => (
                              <div
                                key={provider.id}
                                className="rounded-md border border-[color:var(--border)] bg-[color:var(--surface)] px-3 py-2"
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <div className="min-w-0">
                                    <p className="text-sm font-medium text-strong">
                                      {provider.label}
                                    </p>
                                    <p className="mt-1 text-xs text-muted">
                                      {provider.provider_type}
                                    </p>
                                  </div>
                                  <span
                                    className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                                      provider.verification_state === "runtime"
                                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                                        : "border-amber-500/30 bg-amber-500/10 text-amber-200"
                                    }`}
                                  >
                                    {provider.verification_state === "runtime"
                                      ? "Verified"
                                      : "Configured"}
                                  </span>
                                </div>
                                <p className="mt-2 text-xs text-muted">
                                  Detected directly on the node runtime. Add it
                                  from Edit node before expecting it in the
                                  guided Mission Control flow.
                                </p>
                                <p className="mt-2 text-xs text-muted">
                                  {provider.verified_model_count ?? 0} verified
                                  / {provider.configured_model_count ?? 0}{" "}
                                  configured models
                                  {provider.secret_ref_count
                                    ? ` · ${provider.secret_ref_count} secret ref${
                                        provider.secret_ref_count === 1
                                          ? ""
                                          : "s"
                                      }`
                                    : ""}
                                </p>
                                {provider.unresolved_secret_refs?.length ? (
                                  <p className="mt-2 text-xs text-amber-200">
                                    Missing refs:{" "}
                                    {provider.unresolved_secret_refs.join(", ")}
                                  </p>
                                ) : null}
                              </div>
                            ))
                          ) : (
                            <p className="text-xs text-muted">
                              No extra runtime providers observed beyond the
                              managed Mission Control toolchain.
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-xs uppercase text-quiet">
                            Installed marketplace skills
                          </p>
                          <span className="text-xs text-muted">
                            {marketplaceSkillsQuery.isFetching
                              ? "Refreshing…"
                              : `${installedSkills.length} installed`}
                          </span>
                        </div>
                        <div className="mt-2 space-y-2">
                          {installedSkills.length > 0 ? (
                            installedSkills.map((skill) => (
                              <div
                                key={skill.id}
                                className="flex items-center justify-between gap-3 rounded-md border border-[color:var(--border)] bg-[color:var(--surface)] px-3 py-2"
                              >
                                <div className="min-w-0">
                                  <p className="text-sm font-medium text-strong">
                                    {skill.name}
                                  </p>
                                  <p className="mt-1 text-xs text-muted">
                                    {skill.category ?? "General"} ·{" "}
                                    {skill.source ?? "Marketplace"}
                                  </p>
                                </div>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  disabled={uninstallSkillMutation.isPending}
                                  onClick={() =>
                                    uninstallSkillMutation.mutate({
                                      skillId: skill.id,
                                      params: { gateway_id: gateway.id },
                                    })
                                  }
                                >
                                  Remove
                                </Button>
                              </div>
                            ))
                          ) : (
                            <p className="text-xs text-muted">
                              No marketplace skills are installed on this node
                              yet.
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-xs uppercase text-quiet">
                            Available to install
                          </p>
                          <span className="text-xs text-muted">
                            {availableSkills.length} ready
                          </span>
                        </div>
                        <div className="mt-2 space-y-2">
                          {availableSkills.slice(0, 4).map((skill) => (
                            <div
                              key={skill.id}
                              className="flex items-center justify-between gap-3 rounded-md border border-[color:var(--border)] bg-[color:var(--surface)] px-3 py-2"
                            >
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-strong">
                                  {skill.name}
                                </p>
                                <p className="mt-1 text-xs text-muted">
                                  {skill.category ?? "General"} ·{" "}
                                  {skill.source ?? "Marketplace"}
                                </p>
                              </div>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={installSkillMutation.isPending}
                                onClick={() =>
                                  installSkillMutation.mutate({
                                    skillId: skill.id,
                                    params: { gateway_id: gateway.id },
                                  })
                                }
                              >
                                Install
                              </Button>
                            </div>
                          ))}
                          {availableSkills.length === 0 ? (
                            <p className="text-xs text-muted">
                              Everything in the marketplace for this node is
                              already installed.
                            </p>
                          ) : null}
                        </div>
                      </div>
                      <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-3">
                        <p className="text-xs uppercase text-quiet">
                          Skill packs in the org
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {skillPacks.length > 0 ? (
                            skillPacks.map((pack) => (
                              <span
                                key={pack.id}
                                className="rounded-full border border-[color:var(--border)] bg-[color:var(--surface)] px-3 py-1 text-xs font-medium text-strong"
                              >
                                {pack.name}
                                {typeof pack.skill_count === "number"
                                  ? ` · ${pack.skill_count} skills`
                                  : ""}
                              </span>
                            ))
                          ) : (
                            <span className="text-xs text-muted">
                              No shared skill packs have been configured yet.
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="grid gap-6 xl:grid-cols-2">
              <div className="rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Model profiles
                </p>
                <p className="mt-1 text-xs text-muted">
                  Default profile:{" "}
                  <span className="font-semibold text-strong">
                    {runtime?.default_model_profile ?? "general"}
                  </span>
                </p>
                <p className="mt-1 text-xs text-muted">
                  Effective default model:{" "}
                  <span className="font-semibold text-strong">
                    {runtime?.default_model_ref ?? "Not resolved"}
                  </span>
                </p>
                <div className="mt-4 grid gap-2">
                  {(["general", "coder", "budget"] as const).map((profile) => (
                    <div
                      key={profile}
                      className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface-muted)] px-3 py-2"
                    >
                      <p className="text-xs uppercase tracking-wide text-quiet">
                        {profile}
                      </p>
                      <p className="mt-1 text-sm font-medium text-strong">
                        {modelSelectionLabel(
                          runtime?.model_profiles?.[profile],
                        )}
                      </p>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-xs text-muted">
                  Enabled for agents:{" "}
                  <span className="font-semibold text-strong">
                    {runtime?.enabled_model_refs.length ?? 0}
                  </span>
                </p>
              </div>

              <div className="rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                      Runtime catalog
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      Mission Control keeps managed live models separate from
                      configured placeholders and raw runtime discovery.
                    </p>
                  </div>
                  <span className="text-xs text-muted">
                    {runtimeCatalog.length} total
                  </span>
                </div>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                        Verified on runtime
                      </p>
                      <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
                        {runtimeView.managedLiveCatalogEntries.length}
                      </span>
                    </div>
                    <div className="mt-3 space-y-2">
                      {runtimeView.managedLiveCatalogEntries.length === 0 ? (
                        <p className="rounded-md border border-[color:var(--border)] bg-[color:var(--surface)] px-3 py-2 text-xs text-muted">
                          No managed runtime-verified models are available yet.
                        </p>
                      ) : (
                        runtimeView.managedLiveCatalogEntries.map((entry) => (
                          <div
                            key={entry.ref}
                            className="rounded-md border border-[color:var(--border)] bg-[color:var(--surface)] px-3 py-2"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-strong">
                                  {entry.label}
                                </p>
                                <p className="mt-1 text-xs text-muted">
                                  {catalogEntryProviderLabel(entry)}
                                </p>
                              </div>
                              <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                                {entry.is_default ? (
                                  <span className="rounded-full border border-[color:var(--accent-soft)] bg-[color:var(--accent-soft)]/30 px-2 py-0.5 text-[11px] font-semibold text-[color:var(--accent)]">
                                    Default
                                  </span>
                                ) : null}
                                <span
                                  className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                                    enabledModelRefSet.has(entry.ref)
                                      ? "border-sky-500/30 bg-sky-500/10 text-sky-300"
                                      : "border-zinc-500/30 bg-zinc-500/10 text-zinc-300"
                                  }`}
                                >
                                  {enabledModelRefSet.has(entry.ref)
                                    ? "Enabled for agents"
                                    : "Hidden from agents"}
                                </span>
                                <span
                                  className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${catalogEntryStatusClassName(entry)}`}
                                >
                                  {catalogEntryStatusLabel(entry)}
                                </span>
                              </div>
                            </div>
                            <p className="mt-2 truncate font-mono text-[11px] text-quiet">
                              {entry.ref}
                            </p>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                        Configured for later
                      </p>
                      <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-300">
                        {runtimeView.configuredOnlyCatalogEntries.length}
                      </span>
                    </div>
                    <div className="mt-3 space-y-2">
                      {runtimeView.configuredOnlyCatalogEntries.length === 0 ? (
                        <p className="rounded-md border border-[color:var(--border)] bg-[color:var(--surface)] px-3 py-2 text-xs text-muted">
                          No configured-only placeholders right now.
                        </p>
                      ) : (
                        runtimeView.configuredOnlyCatalogEntries.map(
                          (entry) => (
                            <div
                              key={entry.ref}
                              className="rounded-md border border-[color:var(--border)] bg-[color:var(--surface)] px-3 py-2"
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="text-sm font-medium text-strong">
                                    {entry.label}
                                  </p>
                                  <p className="mt-1 text-xs text-muted">
                                    {catalogEntryProviderLabel(entry)}
                                  </p>
                                </div>
                                <span
                                  className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${catalogEntryStatusClassName(entry)}`}
                                >
                                  {catalogEntryStatusLabel(entry)}
                                </span>
                              </div>
                              <p className="mt-2 truncate font-mono text-[11px] text-quiet">
                                {entry.ref}
                              </p>
                              <p className="mt-2 text-xs text-muted">
                                Provider details or runtime validation are still
                                missing, so this entry stays hidden from agent
                                model selection.
                              </p>
                            </div>
                          ),
                        )
                      )}
                    </div>
                  </div>
                </div>
                {runtimeView.unmanagedLiveCatalogEntries.length > 0 ? (
                  <div className="mt-4 rounded-lg border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                          Other runtime-detected models
                        </p>
                        <p className="mt-1 text-xs text-muted">
                          These were observed directly on the node runtime and
                          are not currently part of the managed Mission Control
                          toolchain.
                        </p>
                      </div>
                      <span className="rounded-full border border-[color:var(--border)] px-2 py-0.5 text-[11px] font-semibold text-muted">
                        {runtimeView.unmanagedLiveCatalogEntries.length}
                      </span>
                    </div>
                    <div className="mt-3 space-y-2">
                      {runtimeView.unmanagedLiveCatalogEntries.map((entry) => (
                        <div
                          key={entry.ref}
                          className="rounded-md border border-[color:var(--border)] bg-[color:var(--surface)] px-3 py-2"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-strong">
                                {entry.label}
                              </p>
                              <p className="mt-1 text-xs text-muted">
                                {catalogEntryProviderLabel(entry)}
                              </p>
                            </div>
                            <span
                              className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${catalogEntryStatusClassName(entry)}`}
                            >
                              {catalogEntryStatusLabel(entry)}
                            </span>
                          </div>
                          <p className="mt-2 truncate font-mono text-[11px] text-quiet">
                            {entry.ref}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Runtime audit
                </p>
                <span className="text-xs text-muted">
                  {auditQuery.isLoading
                    ? "Loading…"
                    : `${auditRecords.length} events`}
                </span>
              </div>
              <div className="mt-3 space-y-2">
                {auditRecords.length === 0 ? (
                  <p className="rounded-md border border-[color:var(--border)] bg-[color:var(--surface-muted)] px-3 py-2 text-xs text-muted">
                    No runtime audit entries yet.
                  </p>
                ) : (
                  auditRecords.map((record) => (
                    <div
                      key={record.id}
                      className="rounded-md border border-[color:var(--border)] bg-[color:var(--surface-muted)] px-3 py-2"
                    >
                      <p className="text-xs font-semibold uppercase tracking-wide text-quiet">
                        {record.event_type}
                      </p>
                      <p className="mt-1 text-sm text-strong">
                        {record.message ?? "No message provided"}
                      </p>
                      <p className="mt-1 text-xs text-muted">
                        {formatTimestamp(record.created_at)}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Agents
                </p>
                {agentsQuery.isLoading ? (
                  <span className="text-xs text-muted">Loading…</span>
                ) : (
                  <span className="text-xs text-muted">
                    {agents.length} total
                  </span>
                )}
              </div>
              <div className="mt-4">
                <AgentsTable
                  agents={agents}
                  boards={boards}
                  gateways={gateway ? [gateway] : []}
                  isLoading={agentsQuery.isLoading}
                  onDelete={setDeleteTarget}
                  emptyMessage="No agents assigned to this node."
                />
              </div>
            </div>
          </div>
        ) : null}
      </DashboardPageLayout>

      <ConfirmActionDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
          }
        }}
        ariaLabel="Delete agent"
        title="Delete agent"
        description={
          <>
            This will remove {deleteTarget?.name}. This action cannot be undone.
          </>
        }
        errorMessage={deleteMutation.error?.message}
        onConfirm={handleDelete}
        isConfirming={deleteMutation.isPending}
      />
    </>
  );
}
