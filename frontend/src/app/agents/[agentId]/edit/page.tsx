"use client";

export const dynamic = "force-dynamic";

import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/auth/clerk";

import { ApiError } from "@/api/mutator";
import {
  type getAgentApiV1AgentsAgentIdGetResponse,
  useGetAgentApiV1AgentsAgentIdGet,
  useUpdateAgentApiV1AgentsAgentIdPatch,
} from "@/api/generated/agents/agents";
import {
  type listBoardsApiV1BoardsGetResponse,
  useListBoardsApiV1BoardsGet,
} from "@/api/generated/boards/boards";
import type { AgentRead, AgentUpdate, BoardRead } from "@/api/generated/model";
import { getGatewayRuntime } from "@/api/runtime-control";
import { DashboardPageLayout } from "@/components/templates/DashboardPageLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import SearchableSelect, {
  type SearchableSelectOption,
} from "@/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AGENT_EMOJI_OPTIONS } from "@/lib/agent-emoji";
import { DEFAULT_IDENTITY_PROFILE } from "@/lib/agent-templates";
import {
  getConfiguredRuntimeModelLabels,
  getDefaultRuntimeModelLabel,
  getProviderChoicesSummary,
  getRuntimeModelOptions,
} from "@/lib/agent-model-catalog";

type IdentityProfile = {
  role: string;
  communication_style: string;
  emoji: string;
  model_profile: "general" | "coder" | "budget";
  primary_model: string;
  fallback_models: string[];
  fallback_policy: "profile" | "explicit-only" | "none";
  max_tokens_per_run: string;
};

const MODEL_PROFILE_OPTIONS: Array<IdentityProfile["model_profile"]> = [
  "general",
  "coder",
  "budget",
];
const FALLBACK_POLICY_OPTIONS: Array<IdentityProfile["fallback_policy"]> = [
  "profile",
  "explicit-only",
  "none",
];
const STANDBY_VALUES = new Set(["0", "0m", "0s", "0h", "0d"]);

const getBoardOptions = (boards: BoardRead[]): SearchableSelectOption[] =>
  boards.map((board) => ({
    value: board.id,
    label: board.name,
  }));

const mergeIdentityProfile = (
  existing: unknown,
  patch: IdentityProfile,
): Record<string, unknown> | null => {
  const resolved: Record<string, unknown> =
    existing && typeof existing === "object"
      ? { ...(existing as Record<string, unknown>) }
      : {};
  const updates: Record<string, string> = {
    role: patch.role.trim(),
    communication_style: patch.communication_style.trim(),
    emoji: patch.emoji.trim(),
  };
  for (const [key, value] of Object.entries(updates)) {
    if (value) {
      resolved[key] = value;
    } else {
      delete resolved[key];
    }
  }
  const maxTokens = Number.parseInt(patch.max_tokens_per_run.trim(), 10);
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    resolved.max_tokens_per_run = maxTokens;
  } else {
    delete resolved.max_tokens_per_run;
  }
  return Object.keys(resolved).length > 0 ? resolved : null;
};

const withIdentityDefaults = (
  profile: Partial<IdentityProfile> | null | undefined,
): IdentityProfile => ({
  role: profile?.role ?? DEFAULT_IDENTITY_PROFILE.role,
  communication_style:
    profile?.communication_style ??
    DEFAULT_IDENTITY_PROFILE.communication_style,
  emoji: profile?.emoji ?? DEFAULT_IDENTITY_PROFILE.emoji,
  model_profile: profile?.model_profile ?? "coder",
  primary_model: profile?.primary_model ?? "",
  fallback_models: profile?.fallback_models ?? [],
  fallback_policy: profile?.fallback_policy ?? "profile",
  max_tokens_per_run: profile?.max_tokens_per_run ?? "",
});

const normalizedTargetForEvery = (every: string): "none" | "last" =>
  STANDBY_VALUES.has(every.trim().toLowerCase()) ? "none" : "last";

export default function EditAgentPage() {
  const { isSignedIn } = useAuth();
  const router = useRouter();
  const params = useParams();
  const agentIdParam = params?.agentId;
  const agentId = Array.isArray(agentIdParam) ? agentIdParam[0] : agentIdParam;

  const [name, setName] = useState<string | undefined>(undefined);
  const [boardId, setBoardId] = useState<string | undefined>(undefined);
  const [isGatewayMain, setIsGatewayMain] = useState<boolean | undefined>(
    undefined,
  );
  const [heartbeatEvery, setHeartbeatEvery] = useState<string | undefined>(
    undefined,
  );
  const [identityProfile, setIdentityProfile] = useState<
    IdentityProfile | undefined
  >(undefined);
  const [error, setError] = useState<string | null>(null);

  const boardsQuery = useListBoardsApiV1BoardsGet<
    listBoardsApiV1BoardsGetResponse,
    ApiError
  >(undefined, {
    query: {
      enabled: Boolean(isSignedIn),
      refetchOnMount: "always",
      retry: false,
    },
  });

  const agentQuery = useGetAgentApiV1AgentsAgentIdGet<
    getAgentApiV1AgentsAgentIdGetResponse,
    ApiError
  >(agentId ?? "", {
    query: {
      enabled: Boolean(isSignedIn && agentId),
      refetchOnMount: "always",
      retry: false,
    },
  });

  const updateMutation = useUpdateAgentApiV1AgentsAgentIdPatch<ApiError>({
    mutation: {
      onSuccess: () => {
        if (agentId) {
          router.push(`/agents/${agentId}`);
        }
      },
      onError: (err) => {
        setError(err.message || "Something went wrong.");
      },
    },
  });

  const boards = useMemo<BoardRead[]>(() => {
    if (boardsQuery.data?.status !== 200) return [];
    return boardsQuery.data.data.items ?? [];
  }, [boardsQuery.data]);
  const loadedAgent: AgentRead | null =
    agentQuery.data?.status === 200 ? agentQuery.data.data : null;

  const loadedHeartbeat = useMemo(() => {
    const heartbeat = loadedAgent?.heartbeat_config;
    if (heartbeat && typeof heartbeat === "object") {
      const record = heartbeat as Record<string, unknown>;
      const every = record.every;
      return {
        every: typeof every === "string" && every.trim() ? every : "0m",
      };
    }
    return { every: "0m" };
  }, [loadedAgent?.heartbeat_config]);

  const loadedIdentityProfile = useMemo(() => {
    const identity = loadedAgent?.identity_profile;
    if (identity && typeof identity === "object") {
      const record = identity as Record<string, unknown>;
      return withIdentityDefaults({
        role: typeof record.role === "string" ? record.role : undefined,
        communication_style:
          typeof record.communication_style === "string"
            ? record.communication_style
            : undefined,
        emoji: typeof record.emoji === "string" ? record.emoji : undefined,
        model_profile:
          loadedAgent?.model_profile === "general" ||
          loadedAgent?.model_profile === "coder" ||
          loadedAgent?.model_profile === "budget"
            ? loadedAgent.model_profile
            : undefined,
        primary_model: loadedAgent?.model_primary ?? undefined,
        fallback_models: loadedAgent?.model_fallbacks ?? undefined,
        fallback_policy:
          loadedAgent?.model_fallback_policy === "profile" ||
          loadedAgent?.model_fallback_policy === "explicit-only" ||
          loadedAgent?.model_fallback_policy === "none"
            ? loadedAgent.model_fallback_policy
            : undefined,
        max_tokens_per_run:
          typeof record.max_tokens_per_run === "number"
            ? String(record.max_tokens_per_run)
            : typeof record.max_tokens_per_run === "string"
              ? record.max_tokens_per_run
              : undefined,
      });
    }
    return withIdentityDefaults(null);
  }, [loadedAgent]);

  const resolvedName = name ?? loadedAgent?.name ?? "";
  const resolvedIsGatewayMain =
    isGatewayMain ?? Boolean(loadedAgent?.is_gateway_main);
  const resolvedHeartbeatEvery = heartbeatEvery ?? loadedHeartbeat.every;
  const resolvedIdentityProfile = identityProfile ?? loadedIdentityProfile;

  const resolvedBoardId = useMemo(() => {
    if (resolvedIsGatewayMain) return boardId ?? "";
    return boardId ?? loadedAgent?.board_id ?? boards[0]?.id ?? "";
  }, [boardId, boards, loadedAgent?.board_id, resolvedIsGatewayMain]);
  const selectedBoard = useMemo(
    () => boards.find((board) => board.id === resolvedBoardId) ?? null,
    [boards, resolvedBoardId],
  );
  const runtimeGatewayId = selectedBoard?.gateway_id ?? loadedAgent?.gateway_id;
  const runtimeQuery = useQuery({
    queryKey: ["gateway-runtime", runtimeGatewayId],
    enabled: Boolean(isSignedIn && runtimeGatewayId),
    queryFn: async () => {
      const response = await getGatewayRuntime(runtimeGatewayId!);
      if (response.status !== 200) {
        throw new Error("Unable to load verified runtime models.");
      }
      return response.data;
    },
    staleTime: 30_000,
  });
  const runtimeModelOptions = useMemo(
    () => getRuntimeModelOptions(runtimeQuery.data),
    [runtimeQuery.data],
  );
  const defaultRuntimeModelLabel = useMemo(
    () =>
      getDefaultRuntimeModelLabel(
        runtimeQuery.data,
        resolvedIdentityProfile.model_profile,
      ),
    [resolvedIdentityProfile.model_profile, runtimeQuery.data],
  );
  const providerChoicesSummary = useMemo(
    () => getProviderChoicesSummary(runtimeQuery.data),
    [runtimeQuery.data],
  );
  const configuredModelLabels = useMemo(
    () => getConfiguredRuntimeModelLabels(runtimeQuery.data),
    [runtimeQuery.data],
  );
  const availableModelRefs = useMemo(
    () => new Set(runtimeModelOptions.map((option) => option.value)),
    [runtimeModelOptions],
  );
  const isLoading =
    boardsQuery.isLoading || agentQuery.isLoading || updateMutation.isPending;
  const errorMessage =
    error ??
    agentQuery.error?.message ??
    boardsQuery.error?.message ??
    runtimeQuery.error?.message ??
    null;

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isSignedIn || !agentId || !loadedAgent) return;
    const trimmed = resolvedName.trim();
    if (!trimmed) {
      setError("Agent name is required.");
      return;
    }
    if (!resolvedIsGatewayMain && !resolvedBoardId) {
      setError("Select a board or mark this agent as the gateway main.");
      return;
    }
    if (
      resolvedIsGatewayMain &&
      !resolvedBoardId &&
      !loadedAgent.is_gateway_main &&
      !loadedAgent.board_id
    ) {
      setError(
        "Select a board once so we can resolve the gateway main session key.",
      );
      return;
    }
    setError(null);

    const existingHeartbeat =
      loadedAgent.heartbeat_config &&
      typeof loadedAgent.heartbeat_config === "object"
        ? (loadedAgent.heartbeat_config as Record<string, unknown>)
        : {};

    const payload: AgentUpdate = {
      name: trimmed,
      heartbeat_config: {
        ...existingHeartbeat,
        every: resolvedHeartbeatEvery.trim() || "0m",
        target: normalizedTargetForEvery(resolvedHeartbeatEvery.trim() || "0m"),
        includeReasoning:
          typeof existingHeartbeat.includeReasoning === "boolean"
            ? existingHeartbeat.includeReasoning
            : false,
      } as unknown as Record<string, unknown>,
      identity_profile: mergeIdentityProfile(
        loadedAgent.identity_profile,
        resolvedIdentityProfile,
      ) as unknown as Record<string, unknown> | null,
      model_profile: resolvedIdentityProfile.model_profile,
      model_fallback_policy: resolvedIdentityProfile.fallback_policy,
    };
    const primaryModel = resolvedIdentityProfile.primary_model.trim();
    if (primaryModel && !availableModelRefs.has(primaryModel)) {
      setError(
        "Pick a node-enabled primary model or inherit the node profile default.",
      );
      return;
    }
    payload.model_primary = primaryModel || null;
    payload.model_fallbacks = resolvedIdentityProfile.fallback_models.filter(
      (value) => value !== primaryModel,
    );
    if (!resolvedIsGatewayMain) {
      payload.board_id = resolvedBoardId || null;
    } else if (resolvedBoardId) {
      payload.board_id = resolvedBoardId;
    }
    if (Boolean(loadedAgent.is_gateway_main) !== resolvedIsGatewayMain) {
      payload.is_gateway_main = resolvedIsGatewayMain;
    }

    updateMutation.mutate({ agentId, params: { force: true }, data: payload });
  };

  const toggleFallbackModel = (modelRef: string) => {
    setIdentityProfile({
      ...resolvedIdentityProfile,
      fallback_models: resolvedIdentityProfile.fallback_models.includes(modelRef)
        ? resolvedIdentityProfile.fallback_models.filter(
            (value) => value !== modelRef,
          )
        : [
            ...resolvedIdentityProfile.fallback_models.filter(
              (value) => value !== resolvedIdentityProfile.primary_model,
            ),
            modelRef,
          ],
    });
  };

  return (
    <DashboardPageLayout
      signedOut={{
        message: "Sign in to edit agents.",
        forceRedirectUrl: `/agents/${agentId}/edit`,
        signUpForceRedirectUrl: `/agents/${agentId}/edit`,
      }}
      title={
        resolvedName.trim() ? resolvedName : (loadedAgent?.name ?? "Edit agent")
      }
      description="Status is controlled by standby-first presence policy and task-driven wake behavior."
    >
      <form
        onSubmit={handleSubmit}
        className="space-y-6 rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm"
      >
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">
            Basic configuration
          </p>
          <div className="mt-4 space-y-6">
            <div className="grid gap-6 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-strong">
                  Agent name <span className="text-[color:var(--danger)]">*</span>
                </label>
                <Input
                  value={resolvedName}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. Deploy bot"
                  disabled={isLoading}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-strong">
                  Role
                </label>
                <Input
                  value={resolvedIdentityProfile.role}
                  onChange={(event) =>
                    setIdentityProfile({
                      ...resolvedIdentityProfile,
                      role: event.target.value,
                    })
                  }
                  placeholder="e.g. Founder, Social Media Manager"
                  disabled={isLoading}
                />
              </div>
            </div>
            <div className="grid gap-6 md:grid-cols-2">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-strong">
                    Board
                    {resolvedIsGatewayMain ? (
                      <span className="ml-2 text-xs font-normal text-muted">
                        optional
                      </span>
                    ) : (
                      <span className="text-[color:var(--danger)]"> *</span>
                    )}
                  </label>
                  {resolvedBoardId ? (
                    <button
                      type="button"
                      className="text-xs font-medium text-muted hover:text-strong"
                      onClick={() => {
                        setBoardId("");
                      }}
                      disabled={isLoading}
                    >
                      Clear board
                    </button>
                  ) : null}
                </div>
                <SearchableSelect
                  ariaLabel="Select board"
                  value={resolvedBoardId}
                  onValueChange={(value) => setBoardId(value)}
                  options={getBoardOptions(boards)}
                  placeholder={
                    resolvedIsGatewayMain
                      ? "No board (main agent)"
                      : "Select board"
                  }
                  searchPlaceholder="Search boards..."
                  emptyMessage="No matching boards."
                  triggerClassName="h-11 w-full rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] px-3 py-2 text-sm font-medium text-strong shadow-sm focus:border-[color:var(--accent)] focus:ring-2 focus:ring-[color:var(--accent-soft)]"
                  contentClassName="rounded-xl border border-[color:var(--border)] shadow-lg"
                  itemClassName="px-4 py-3 text-sm text-muted data-[selected=true]:bg-[color:var(--surface-muted)] data-[selected=true]:text-strong"
                  disabled={boards.length === 0}
                />
                {resolvedIsGatewayMain ? (
                  <p className="text-xs text-muted">
                    Main agents are not attached to a board. If a board is
                    selected, it is only used to resolve the gateway main
                    session key and will be cleared on save.
                  </p>
                ) : boards.length === 0 ? (
                  <p className="text-xs text-muted">
                    Create a board before assigning agents.
                  </p>
                ) : null}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-strong">
                  Emoji
                </label>
                <Select
                  value={resolvedIdentityProfile.emoji}
                  onValueChange={(value) =>
                    setIdentityProfile({
                      ...resolvedIdentityProfile,
                      emoji: value,
                    })
                  }
                  disabled={isLoading}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select emoji" />
                  </SelectTrigger>
                  <SelectContent>
                    {AGENT_EMOJI_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.glyph} {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <div className="mt-6 rounded-xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
            <label className="flex items-start gap-3 text-sm text-muted">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 rounded border-[color:var(--border)] text-[color:var(--accent)] focus:ring-[color:var(--accent-soft)]"
                checked={resolvedIsGatewayMain}
                onChange={(event) => setIsGatewayMain(event.target.checked)}
                disabled={isLoading}
              />
              <span>
                <span className="block font-medium text-strong">
                  Gateway main agent
                </span>
                <span className="block text-xs text-muted">
                  Uses the gateway main session key and is not tied to a single
                  board.
                </span>
              </span>
            </label>
          </div>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">
            Personality & behavior
          </p>
          <div className="mt-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-strong">
                Communication style
              </label>
              <Input
                value={resolvedIdentityProfile.communication_style}
                onChange={(event) =>
                  setIdentityProfile({
                    ...resolvedIdentityProfile,
                    communication_style: event.target.value,
                  })
                }
                disabled={isLoading}
              />
            </div>
          </div>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">
            Model policy
          </p>
          <div className="mt-4 grid gap-6 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-strong">
                Model profile
              </label>
              <Select
                value={resolvedIdentityProfile.model_profile}
                onValueChange={(value) =>
                  setIdentityProfile({
                    ...resolvedIdentityProfile,
                    model_profile: value as IdentityProfile["model_profile"],
                  })
                }
                disabled={isLoading}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select model profile" />
                </SelectTrigger>
                <SelectContent>
                  {MODEL_PROFILE_OPTIONS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-strong">
                Primary model
              </label>
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-muted">
                  Leave this blank to inherit the selected profile default:{" "}
                  {defaultRuntimeModelLabel}.
                </p>
                {resolvedIdentityProfile.primary_model ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      setIdentityProfile({
                        ...resolvedIdentityProfile,
                        primary_model: "",
                      })
                    }
                    disabled={isLoading}
                  >
                    Use default
                  </Button>
                ) : null}
              </div>
              <SearchableSelect
                value={resolvedIdentityProfile.primary_model}
                onValueChange={(value) =>
                  setIdentityProfile({
                    ...resolvedIdentityProfile,
                    primary_model: value,
                    fallback_models: resolvedIdentityProfile.fallback_models.filter(
                      (candidate) => candidate !== value,
                    ),
                  })
                }
                options={runtimeModelOptions}
                ariaLabel="Select primary model"
                placeholder={
                  runtimeModelOptions.length > 0
                    ? `Inherit profile default (${defaultRuntimeModelLabel})`
                    : "No verified models available"
                }
                searchPlaceholder="Search verified models..."
                emptyMessage="No verified models available."
                disabled={isLoading || runtimeModelOptions.length === 0}
              />
              {providerChoicesSummary ? (
                <p className="text-xs text-muted">
                  Verified providers: {providerChoicesSummary}.
                </p>
              ) : null}
              {configuredModelLabels.length > 0 ? (
                <div className="rounded-xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-3">
                  <p className="text-xs font-medium text-strong">
                    Configured for later
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    These providers are configured on the gateway but still need
                    runtime auth or validation before they become selectable.
                  </p>
                  <ul className="mt-2 space-y-1 text-xs text-muted">
                    {configuredModelLabels.map((label) => (
                      <li key={label}>{label}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-strong">
                Fallback models
              </label>
              <div className="max-h-40 space-y-2 overflow-y-auto rounded-xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-3">
                {runtimeModelOptions.length > 0 ? (
                  runtimeModelOptions.map((option) => {
                    const checked = resolvedIdentityProfile.fallback_models.includes(
                      option.value,
                    );
                    const disabled =
                      option.value === resolvedIdentityProfile.primary_model ||
                      isLoading;
                    return (
                      <label
                        key={option.value}
                        className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm text-muted"
                      >
                        <span className="min-w-0 truncate">{option.label}</span>
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-[color:var(--border)] text-[color:var(--accent)] focus:ring-[color:var(--accent-soft)]"
                          checked={checked}
                          disabled={disabled}
                          onChange={() => toggleFallbackModel(option.value)}
                        />
                      </label>
                    );
                  })
                ) : (
                  <p className="text-xs text-muted">
                    No verified fallback models are available for this gateway.
                  </p>
                )}
              </div>
              <p className="text-xs text-muted">
                Only verified gateway models are selectable here.
              </p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-strong">
                Fallback policy
              </label>
              <Select
                value={resolvedIdentityProfile.fallback_policy}
                onValueChange={(value) =>
                  setIdentityProfile({
                    ...resolvedIdentityProfile,
                    fallback_policy: value as IdentityProfile["fallback_policy"],
                  })
                }
                disabled={isLoading}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select fallback policy" />
                </SelectTrigger>
                <SelectContent>
                  {FALLBACK_POLICY_OPTIONS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-strong">
                Max tokens per run
              </label>
              <Input
                value={resolvedIdentityProfile.max_tokens_per_run}
                onChange={(event) =>
                  setIdentityProfile({
                    ...resolvedIdentityProfile,
                    max_tokens_per_run: event.target.value,
                  })
                }
                placeholder="e.g. 12000"
                inputMode="numeric"
                disabled={isLoading}
              />
            </div>
          </div>
          {runtimeQuery.isLoading ? (
            <p className="mt-4 text-xs text-muted">
              Loading verified model catalog from the gateway…
            </p>
          ) : null}
          {runtimeQuery.data && runtimeModelOptions.length === 0 ? (
            <p className="mt-4 text-xs text-muted">
              This gateway has no approved models exposed for agent selection
              yet.
            </p>
          ) : null}
          {resolvedIdentityProfile.primary_model &&
          !availableModelRefs.has(resolvedIdentityProfile.primary_model) ? (
            <p className="mt-4 text-xs text-[color:var(--warning)]">
              The current primary model is outside the verified gateway catalog.
              Pick a verified option before saving.
            </p>
          ) : null}
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">
            Schedule & notifications
          </p>
          <div className="mt-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-strong">
                Interval
              </label>
              <Input
                value={resolvedHeartbeatEvery}
                onChange={(event) => setHeartbeatEvery(event.target.value)}
                placeholder="e.g. 0m"
                disabled={isLoading}
              />
              <p className="text-xs text-muted">
                Standby-first by default. Use <code>0m</code> to keep the
                agent idle until real work wakes it, or set a cadence like{" "}
                <code>20m</code> or <code>30m</code> only if you want
                proactive periodic check-ins while active.
              </p>
            </div>
          </div>
        </div>

        {errorMessage ? (
          <div className="rounded-lg border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/10 p-3 text-sm text-[color:var(--danger)] shadow-sm">
            {errorMessage}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={isLoading}>
            {isLoading ? "Saving…" : "Save changes"}
          </Button>
          <Button
            variant="outline"
            type="button"
            onClick={() => router.push(`/agents/${agentId}`)}
          >
            Back to agent
          </Button>
        </div>
      </form>
    </DashboardPageLayout>
  );
}
