"use client";

export const dynamic = "force-dynamic";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { BadgeCheck, Bot, Shield, Sparkles, Users } from "lucide-react";

import { useAuth } from "@/auth/clerk";
import { useNodeScope } from "@/components/providers/NodeScopeProvider";
import { DashboardPageLayout } from "@/components/templates/DashboardPageLayout";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/api/mutator";
import {
  type listAgentsApiV1AgentsGetResponse,
  useListAgentsApiV1AgentsGet,
} from "@/api/generated/agents/agents";
import {
  type listBoardsApiV1BoardsGetResponse,
  useListBoardsApiV1BoardsGet,
} from "@/api/generated/boards/boards";
import {
  type listGatewaysApiV1GatewaysGetResponse,
  useListGatewaysApiV1GatewaysGet,
} from "@/api/generated/gateways/gateways";
import { formatRelativeTimestamp, formatTimestamp } from "@/lib/formatters";

const statusTone = (status: string | null | undefined) => {
  const normalized = (status ?? "").toLowerCase();
  if (normalized === "online") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
  if (normalized === "standby") return "border-amber-500/30 bg-amber-500/10 text-amber-100";
  if (normalized === "offline") return "border-rose-500/30 bg-rose-500/10 text-rose-100";
  return "border-[color:var(--border)] bg-[color:var(--surface-muted)] text-muted";
};

export default function TeamPage() {
  const { isSignedIn } = useAuth();
  const router = useRouter();
  const { scopedGateways, selectedGatewayId, selectedNodeClass } = useNodeScope();

  const boardsQuery = useListBoardsApiV1BoardsGet<listBoardsApiV1BoardsGetResponse, ApiError>(
    { limit: 200 },
    {
      query: {
        enabled: Boolean(isSignedIn),
        refetchInterval: 30_000,
        refetchOnMount: "always",
      },
    },
  );

  const agentsQuery = useListAgentsApiV1AgentsGet<listAgentsApiV1AgentsGetResponse, ApiError>(
    { limit: 200, gateway_id: selectedGatewayId ?? undefined },
    {
      query: {
        enabled: Boolean(isSignedIn),
        refetchInterval: 15_000,
        refetchOnMount: "always",
      },
    },
  );
  const gatewaysQuery = useListGatewaysApiV1GatewaysGet<
    listGatewaysApiV1GatewaysGetResponse,
    ApiError
  >(
    { limit: 200 },
    {
      query: {
        enabled: Boolean(isSignedIn),
        refetchInterval: 30_000,
        refetchOnMount: "always",
      },
    },
  );

  const boards = useMemo(
    () => (boardsQuery.data?.status === 200 ? boardsQuery.data.data.items ?? [] : []),
    [boardsQuery.data],
  );
  const boardNameById = useMemo(
    () => new Map(boards.map((board) => [board.id, board.name])),
    [boards],
  );
  const agents = useMemo(
    () =>
      agentsQuery.data?.status === 200
        ? [...(agentsQuery.data.data.items ?? [])].sort((a, b) => a.name.localeCompare(b.name))
        : [],
    [agentsQuery.data],
  );
  const gateways = useMemo(
    () =>
      gatewaysQuery.data?.status === 200
        ? [...(gatewaysQuery.data.data.items ?? [])].sort((a, b) =>
            a.name.localeCompare(b.name),
          )
        : [],
    [gatewaysQuery.data],
  );
  const scopedGatewayIds = useMemo(
    () => new Set(scopedGateways.map((gateway) => gateway.id)),
    [scopedGateways],
  );
  const visibleAgents = useMemo(
    () =>
      selectedGatewayId || selectedNodeClass
        ? agents.filter((agent) => scopedGatewayIds.has(agent.gateway_id))
        : agents,
    [agents, scopedGatewayIds, selectedGatewayId, selectedNodeClass],
  );
  const gatewayNameById = useMemo(
    () => new Map(gateways.map((gateway) => [gateway.id, gateway.name])),
    [gateways],
  );
  const groupedAgents = useMemo(() => {
    const groups = new Map<string, typeof visibleAgents>();
    visibleAgents.forEach((agent) => {
      const bucket = groups.get(agent.gateway_id) ?? [];
      bucket.push(agent);
      groups.set(agent.gateway_id, bucket);
    });
    return [...groups.entries()]
      .map(([gatewayId, nodeAgents]) => ({
        gatewayId,
        gatewayName: gatewayNameById.get(gatewayId) ?? "Unknown node",
        agents: [...nodeAgents].sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.gatewayName.localeCompare(b.gatewayName));
  }, [gatewayNameById, visibleAgents]);

  const stats = useMemo(() => {
    return {
      total: visibleAgents.length,
      online: visibleAgents.filter((agent) => (agent.status ?? "").toLowerCase() === "online").length,
      standby: visibleAgents.filter((agent) => (agent.status ?? "").toLowerCase() === "standby").length,
      leads: visibleAgents.filter((agent) => agent.is_board_lead).length,
    };
  }, [visibleAgents]);

  return (
    <DashboardPageLayout
      signedOut={{
        message: "Sign in to view your agent team.",
        forceRedirectUrl: "/team",
        signUpForceRedirectUrl: "/team",
      }}
      title="Team"
      description="A more visual agent roster, inspired by the mission-control team view style."
      headerActions={
        <Button onClick={() => router.push("/agents")}>Open full agents table</Button>
      }
      stickyHeader
    >
      <div className="space-y-6">
        <section className="grid gap-4 md:grid-cols-4">
          <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface)] p-4 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Agents</p>
            <p className="mt-3 text-3xl font-semibold text-strong">{stats.total}</p>
          </div>
          <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface)] p-4 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Online now</p>
            <p className="mt-3 text-3xl font-semibold text-emerald-300">{stats.online}</p>
          </div>
          <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface)] p-4 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Standby</p>
            <p className="mt-3 text-3xl font-semibold text-amber-100">{stats.standby}</p>
          </div>
          <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface)] p-4 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Lead roles</p>
            <p className="mt-3 text-3xl font-semibold text-cyan-200">{stats.leads}</p>
          </div>
        </section>

        {!visibleAgents.length ? (
          <section className="rounded-[26px] border border-dashed border-[color:var(--border)] bg-[color:var(--surface)] p-8 text-center shadow-sm">
            <Users className="mx-auto h-10 w-10 text-cyan-200" />
            <h2 className="mt-4 text-2xl font-semibold text-strong">No agents yet</h2>
            <p className="mt-2 text-sm leading-6 text-muted">
              Create your first agent and Mission Control will start visualizing the team here.
            </p>
            <Button className="mt-5" onClick={() => router.push("/agents/new")}>
              Create an agent
            </Button>
          </section>
        ) : (
          <div className="space-y-6">
            {groupedAgents.map((group) => (
              <section key={group.gatewayId} className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                      Node
                    </p>
                    <h2 className="mt-1 text-xl font-semibold text-strong">
                      {group.gatewayName}
                    </h2>
                  </div>
                  <Button
                    variant="outline"
                    onClick={() => router.push(`/gateways/${group.gatewayId}`)}
                  >
                    Open node
                  </Button>
                </div>
                <section className="grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
                  {group.agents.map((agent) => {
              const boardName =
                agent.board_id ? boardNameById.get(agent.board_id) ?? "Unknown board" : "Global scope";
              const modelLabel = agent.model_primary ?? agent.model_profile ?? "Default policy";
              return (
                <article
                  key={agent.id}
                  className="rounded-[26px] border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ${statusTone(agent.status)}`}
                        >
                          {agent.status ?? "unknown"}
                        </span>
                        {agent.is_board_lead ? (
                          <span className="rounded-full border border-cyan-500/20 bg-cyan-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-200">
                            Lead
                          </span>
                        ) : null}
                        {agent.is_gateway_main ? (
                          <span className="rounded-full border border-violet-500/20 bg-violet-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-200">
                            Gateway main
                          </span>
                        ) : null}
                      </div>
                      <div>
                        <h2 className="text-2xl font-semibold text-strong">{agent.name}</h2>
                        <p className="mt-2 text-sm text-muted">{boardName}</p>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      className="shrink-0"
                      onClick={() => router.push(`/agents/${agent.id}`)}
                    >
                      Open
                    </Button>
                  </div>

                  <div className="mt-5 grid gap-4 sm:grid-cols-2">
                    <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
                      <div className="flex items-center gap-2 text-sm font-semibold text-strong">
                        <Bot className="h-4 w-4 text-cyan-200" />
                        Model
                      </div>
                      <p className="mt-3 text-sm leading-6 text-strong">{modelLabel}</p>
                    </div>
                    <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
                      <div className="flex items-center gap-2 text-sm font-semibold text-strong">
                        <Sparkles className="h-4 w-4 text-cyan-200" />
                        Heartbeat
                      </div>
                      <p className="mt-3 text-sm leading-6 text-strong">
                        {typeof agent.heartbeat_config?.every === "string"
                          ? `${agent.heartbeat_config.every} · ${String(agent.heartbeat_config?.target ?? "default")}`
                          : "Default policy"}
                      </p>
                    </div>
                  </div>

                  <div className="mt-5 space-y-3">
                    <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
                      <div className="flex items-center gap-2 text-sm font-semibold text-strong">
                        <BadgeCheck className="h-4 w-4 text-cyan-200" />
                        Status reason
                      </div>
                      <p className="mt-3 text-sm leading-6 text-muted">
                        {agent.status_reason ?? "Mission Control has not provided a richer reason yet."}
                      </p>
                    </div>

                    <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
                      <div className="flex items-center gap-2 text-sm font-semibold text-strong">
                        <Shield className="h-4 w-4 text-cyan-200" />
                        Last seen
                      </div>
                      <p className="mt-3 text-sm leading-6 text-strong">
                        {agent.last_seen_at
                          ? `${formatRelativeTimestamp(agent.last_seen_at)} · ${formatTimestamp(agent.last_seen_at)}`
                          : "No heartbeat or session activity recorded yet."}
                      </p>
                    </div>
                  </div>
                </article>
              );
                  })}
                </section>
              </section>
            ))}
          </div>
        )}
      </div>
    </DashboardPageLayout>
  );
}
