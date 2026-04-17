"use client";

export const dynamic = "force-dynamic";

import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import { useAuth } from "@/auth/clerk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AgentsTable } from "@/components/agents/AgentsTable";
import { DashboardPageLayout } from "@/components/templates/DashboardPageLayout";
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
  type GatewayRuntimeCatalogEntry,
  listGatewayAudit,
  pullGatewayTelemetry,
  reconcileGatewayRuntime,
} from "@/api/runtime-control";
import { formatTimestamp } from "@/lib/formatters";
import { createOptimisticListDeleteMutation } from "@/lib/list-delete";
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

const catalogEntryStatusClassName = (entry: GatewayRuntimeCatalogEntry): string =>
  entry.selectable !== false
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
    : "border-amber-500/30 bg-amber-500/10 text-amber-300";

export default function GatewayDetailPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const params = useParams();
  const { isSignedIn } = useAuth();
  const gatewayIdParam = params?.gatewayId;
  const gatewayId = Array.isArray(gatewayIdParam)
    ? gatewayIdParam[0]
    : gatewayIdParam;

  const { isAdmin } = useOrganizationMembership(isSignedIn);
  const [deleteTarget, setDeleteTarget] = useState<AgentRead | null>(null);
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
    () => (skillPacksQuery.data?.status === 200 ? skillPacksQuery.data.data : []),
    [skillPacksQuery.data],
  );
  const isConnected = status?.connected ?? false;

  const title = useMemo(
    () => (gateway?.name ? gateway.name : "Node"),
    [gateway?.name],
  );
  const roleLabels = useMemo(
    () =>
      [...new Set(
        agents
          .map((agent) =>
            typeof agent.identity_profile?.role === "string"
              ? agent.identity_profile.role
              : agent.is_gateway_main
                ? "Gateway Agent"
                : null,
          )
          .filter(Boolean),
      )] as string[],
    [agents],
  );
  const runtimeCatalog = useMemo(
    () => (runtime?.catalog ?? []).filter((entry) => (entry.kind ?? "model") === "model"),
    [runtime?.catalog],
  );
  const liveCatalogEntries = useMemo(
    () => runtimeCatalog.filter((entry) => entry.selectable !== false),
    [runtimeCatalog],
  );
  const enabledModelRefSet = useMemo(
    () => new Set(runtime?.enabled_model_refs ?? []),
    [runtime?.enabled_model_refs],
  );
  const configuredOnlyCatalogEntries = useMemo(
    () => runtimeCatalog.filter((entry) => entry.selectable === false),
    [runtimeCatalog],
  );
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
                    <p className="text-xs uppercase text-quiet">
                      Gateway URL
                    </p>
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
                    <p className="text-xs uppercase text-quiet">
                      TLS policy
                    </p>
                    <p className="mt-1 text-sm font-medium text-strong">
                      {gateway.allow_insecure_tls ? "Allow self-signed certificates" : "Strict certificate validation"}
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
                      Prompt {(usage?.total_prompt_tokens ?? 0).toLocaleString("en-US")} ·
                      Completion{" "}
                      {(usage?.total_completion_tokens ?? 0).toLocaleString("en-US")}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-quiet">Top model usage</p>
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
                          No telemetry samples yet. Use pull telemetry to ingest.
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
                    {roleLabels.length} role{roleLabels.length === 1 ? "" : "s"} enabled
                  </span>
                </div>
                <div className="mt-4 space-y-4 text-sm text-muted">
                  <div>
                    <p className="text-xs uppercase text-quiet">Starter pack roles</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {roleLabels.length > 0 ? roleLabels.map((role) => (
                        <span
                          key={role}
                          className="rounded-full border border-[color:var(--border)] bg-[color:var(--surface-muted)] px-3 py-1 text-xs font-medium text-strong"
                        >
                          {role}
                        </span>
                      )) : (
                        <span className="text-sm text-muted">No node inventory roles provisioned yet.</span>
                      )}
                    </div>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-quiet">Supported verified models</p>
                    <p className="mt-1 text-sm font-medium text-strong">
                      {liveCatalogEntries.length}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted">
                      This node has {liveCatalogEntries.length} verified runtime model
                      {liveCatalogEntries.length === 1 ? "" : "s"} and{" "}
                      {runtime?.enabled_model_refs.length ?? 0} enabled for agents.
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-quiet">Modules</p>
                    <div className="mt-2 space-y-3">
                      <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-xs uppercase text-quiet">Installed marketplace skills</p>
                          <span className="text-xs text-muted">
                            {marketplaceSkillsQuery.isFetching ? "Refreshing…" : `${installedSkills.length} installed`}
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
                                  <p className="text-sm font-medium text-strong">{skill.name}</p>
                                  <p className="mt-1 text-xs text-muted">
                                    {skill.category ?? "General"} · {skill.source ?? "Marketplace"}
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
                              No marketplace skills are installed on this node yet.
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-xs uppercase text-quiet">Available to install</p>
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
                                <p className="text-sm font-medium text-strong">{skill.name}</p>
                                <p className="mt-1 text-xs text-muted">
                                  {skill.category ?? "General"} · {skill.source ?? "Marketplace"}
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
                              Everything in the marketplace for this node is already installed.
                            </p>
                          ) : null}
                        </div>
                      </div>
                      <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-3">
                        <p className="text-xs uppercase text-quiet">Skill packs in the org</p>
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
                        {modelSelectionLabel(runtime?.model_profiles?.[profile])}
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
                      Mission Control separates live runtime models from configured placeholders.
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
                        {liveCatalogEntries.length}
                      </span>
                    </div>
                    <div className="mt-3 space-y-2">
                      {liveCatalogEntries.length === 0 ? (
                        <p className="rounded-md border border-[color:var(--border)] bg-[color:var(--surface)] px-3 py-2 text-xs text-muted">
                          No runtime-verified models are available yet.
                        </p>
                      ) : (
                        liveCatalogEntries.map((entry) => (
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
                        {configuredOnlyCatalogEntries.length}
                      </span>
                    </div>
                    <div className="mt-3 space-y-2">
                      {configuredOnlyCatalogEntries.length === 0 ? (
                        <p className="rounded-md border border-[color:var(--border)] bg-[color:var(--surface)] px-3 py-2 text-xs text-muted">
                          No configured-only placeholders right now.
                        </p>
                      ) : (
                        configuredOnlyCatalogEntries.map((entry) => (
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
                              Provider details or runtime validation are still missing, so this
                              entry stays hidden from agent model selection.
                            </p>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Runtime audit
                </p>
                <span className="text-xs text-muted">
                  {auditQuery.isLoading ? "Loading…" : `${auditRecords.length} events`}
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
                  <span className="text-xs text-muted">{agents.length} total</span>
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
