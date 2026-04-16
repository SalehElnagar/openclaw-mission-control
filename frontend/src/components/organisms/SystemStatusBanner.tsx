"use client";

import { useMemo } from "react";
import Link from "next/link";
import { AlertTriangle, WifiOff } from "lucide-react";

import { useAuth } from "@/auth/clerk";
import {
  type healthHealthGetResponse,
  useHealthHealthGet,
} from "@/api/generated/health/health";
import {
  type listAgentsApiV1AgentsGetResponse,
  useListAgentsApiV1AgentsGet,
} from "@/api/generated/agents/agents";

type SystemHealth = "operational" | "degraded" | "checking" | "unavailable";

export function SystemStatusBanner() {
  const { isSignedIn } = useAuth();

  const healthQuery = useHealthHealthGet<healthHealthGetResponse>({
    query: {
      refetchInterval: 30_000,
      retry: false,
    },
    request: { cache: "no-store" },
  });

  const agentsQuery = useListAgentsApiV1AgentsGet<listAgentsApiV1AgentsGetResponse>(
    { limit: 200 },
    {
      query: {
        enabled: Boolean(isSignedIn),
        refetchInterval: 30_000,
        retry: false,
      },
    },
  );

  const agents = useMemo(
    () =>
      agentsQuery.data?.status === 200
        ? agentsQuery.data.data.items ?? []
        : [],
    [agentsQuery.data],
  );

  const onlineAgents = agents.filter((a) => (a.status ?? "").toLowerCase() === "online").length;
  const totalAgents = agents.length;

  const backendDown = healthQuery.isError || (healthQuery.data?.status === 200 && !healthQuery.data.data.ok);

  const status: SystemHealth = healthQuery.isLoading
    ? "checking"
    : backendDown
      ? "unavailable"
      : onlineAgents === 0 && totalAgents > 0
        ? "degraded"
        : "operational";

  // Don't show banner when everything is fine
  if (status === "operational" || status === "checking") return null;

  return (
    <div
      role="status"
      className={`flex items-center gap-3 px-4 py-2 text-sm ${
        status === "unavailable"
          ? "bg-rose-500/10 text-rose-700 dark:text-rose-400"
          : "bg-amber-500/10 text-amber-700 dark:text-amber-400"
      }`}
    >
      {status === "unavailable" ? (
        <>
          <WifiOff className="h-4 w-4 shrink-0" />
          <span>
            <strong>System degraded</strong> &mdash; Backend API is not responding.
            Check your Docker services.
          </span>
        </>
      ) : (
        <>
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            <strong>All agents standby</strong> &mdash; {totalAgents} agent{totalAgents !== 1 ? "s" : ""} registered, none online.{" "}
            <Link href="/agents" className="underline hover:no-underline">
              View agents
            </Link>
          </span>
        </>
      )}
    </div>
  );
}
