"use client";

export const dynamic = "force-dynamic";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/auth/clerk";

import { ApiError } from "@/api/mutator";
import {
  type listBoardsApiV1BoardsGetResponse,
  useListBoardsApiV1BoardsGet,
} from "@/api/generated/boards/boards";
import type { AgentCreate, BoardRead } from "@/api/generated/model";
import { useCreateAgentApiV1AgentsPost } from "@/api/generated/agents/agents";
import { getGatewayRuntime } from "@/api/runtime-control";
import { useOrganizationMembership } from "@/lib/use-organization-membership";
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

const normalizeIdentityProfile = (
  profile: IdentityProfile,
): Record<string, unknown> | null => {
  const maxTokens = Number.parseInt(profile.max_tokens_per_run.trim(), 10);
  const normalized: Record<string, unknown> = {
    role: profile.role.trim(),
    communication_style: profile.communication_style.trim(),
    emoji: profile.emoji.trim(),
  };
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    normalized.max_tokens_per_run = maxTokens;
  }
  const hasValue = Object.values(normalized).some((value) =>
    Array.isArray(value)
      ? value.length > 0
      : typeof value === "number"
        ? value > 0
        : typeof value === "string"
          ? value.length > 0
          : Boolean(value),
  );
  return hasValue ? normalized : null;
};

const normalizedTargetForEvery = (every: string): "none" | "last" =>
  STANDBY_VALUES.has(every.trim().toLowerCase()) ? "none" : "last";

export default function NewAgentPage() {
  const router = useRouter();
  const { isSignedIn } = useAuth();

  const { isAdmin } = useOrganizationMembership(isSignedIn);

  const [name, setName] = useState("");
  const [boardId, setBoardId] = useState<string>("");
  const [heartbeatEvery, setHeartbeatEvery] = useState("0m");
  const [identityProfile, setIdentityProfile] = useState<IdentityProfile>({
                    ...DEFAULT_IDENTITY_PROFILE,
    model_profile: "coder",
    primary_model: "",
    fallback_models: [],
    fallback_policy: "profile",
    max_tokens_per_run: "",
  });
  const [error, setError] = useState<string | null>(null);

  const boardsQuery = useListBoardsApiV1BoardsGet<
    listBoardsApiV1BoardsGetResponse,
    ApiError
  >(undefined, {
    query: {
      enabled: Boolean(isSignedIn && isAdmin),
      refetchOnMount: "always",
    },
  });

  const createAgentMutation = useCreateAgentApiV1AgentsPost<ApiError>({
    mutation: {
      onSuccess: (result) => {
        if (result.status === 200) {
          router.push(`/agents/${result.data.id}`);
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
  const displayBoardId = boardId || boards[0]?.id || "";
  const selectedBoard = useMemo(
    () => boards.find((board) => board.id === displayBoardId) ?? null,
    [boards, displayBoardId],
  );
  const runtimeQuery = useQuery({
    queryKey: ["gateway-runtime", selectedBoard?.gateway_id],
    enabled: Boolean(isSignedIn && selectedBoard?.gateway_id),
    queryFn: async () => {
      const response = await getGatewayRuntime(selectedBoard!.gateway_id!);
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
        identityProfile.model_profile,
      ),
    [identityProfile.model_profile, runtimeQuery.data],
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
  const isLoading = boardsQuery.isLoading || createAgentMutation.isPending;
  const errorMessage =
    error ??
    boardsQuery.error?.message ??
    runtimeQuery.error?.message ??
    null;

  const toggleFallbackModel = (modelRef: string) => {
    setIdentityProfile((current) => {
      const nextValues = current.fallback_models.includes(modelRef)
        ? current.fallback_models.filter((value) => value !== modelRef)
        : [...current.fallback_models, modelRef];
      return {
        ...current,
        fallback_models: nextValues.filter(
          (value) => value !== current.primary_model,
        ),
      };
    });
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isSignedIn) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Agent name is required.");
      return;
    }
    const resolvedBoardId = displayBoardId;
    if (!resolvedBoardId) {
      setError("Select a board before creating an agent.");
      return;
    }
    if (!selectedBoard?.gateway_id) {
      setError("The selected board is missing a gateway.");
      return;
    }
    const primaryModel = identityProfile.primary_model.trim();
    if (primaryModel && !availableModelRefs.has(primaryModel)) {
      setError(
        "Pick a node-enabled primary model or inherit the node profile default.",
      );
      return;
    }
    setError(null);
    const payload: AgentCreate = {
      name: trimmed,
      board_id: resolvedBoardId,
      heartbeat_config: {
        every: heartbeatEvery.trim() || "0m",
        target: normalizedTargetForEvery(heartbeatEvery.trim() || "0m"),
        includeReasoning: false,
      },
      identity_profile: normalizeIdentityProfile(identityProfile),
      model_profile: identityProfile.model_profile,
      model_fallback_policy: identityProfile.fallback_policy,
    };
    if (primaryModel) {
      payload.model_primary = primaryModel;
    }
    const fallbackModels = identityProfile.fallback_models.filter(
      (value) => value !== primaryModel,
    );
    if (fallbackModels.length > 0) {
      payload.model_fallbacks = fallbackModels;
    }
    createAgentMutation.mutate({
      data: {
        ...payload,
      },
    });
  };

  return (
    <DashboardPageLayout
      signedOut={{
        message: "Sign in to create an agent.",
        forceRedirectUrl: "/agents/new",
        signUpForceRedirectUrl: "/agents/new",
      }}
      title="Create agent"
      description="Agents start in provisioning until they check in."
      isAdmin={isAdmin}
      adminOnlyMessage="Only organization owners and admins can create agents."
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
                  value={name}
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
                  value={identityProfile.role}
                  onChange={(event) =>
                    setIdentityProfile((current) => ({
                      ...current,
                      role: event.target.value,
                    }))
                  }
                  placeholder="e.g. Founder, Social Media Manager"
                  disabled={isLoading}
                />
              </div>
            </div>
            <div className="grid gap-6 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-strong">
                  Board <span className="text-[color:var(--danger)]">*</span>
                </label>
                <SearchableSelect
                  ariaLabel="Select board"
                  value={displayBoardId}
                  onValueChange={setBoardId}
                  options={getBoardOptions(boards)}
                  placeholder="Select board"
                  searchPlaceholder="Search boards..."
                  emptyMessage="No matching boards."
                  triggerClassName="h-11 w-full rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] px-3 py-2 text-sm font-medium text-strong shadow-sm focus:border-[color:var(--accent)] focus:ring-2 focus:ring-[color:var(--accent-soft)]"
                  contentClassName="rounded-xl border border-[color:var(--border)] shadow-lg"
                  itemClassName="px-4 py-3 text-sm text-muted data-[selected=true]:bg-[color:var(--surface-muted)] data-[selected=true]:text-strong"
                  disabled={boards.length === 0}
                />
                {boards.length === 0 ? (
                  <p className="text-xs text-muted">
                    Create a board before adding agents.
                  </p>
                ) : null}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-strong">
                  Emoji
                </label>
                <Select
                  value={identityProfile.emoji}
                  onValueChange={(value) =>
                    setIdentityProfile((current) => ({
                      ...current,
                      emoji: value,
                    }))
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
                value={identityProfile.communication_style}
                onChange={(event) =>
                  setIdentityProfile((current) => ({
                    ...current,
                    communication_style: event.target.value,
                  }))
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
                value={identityProfile.model_profile}
                onValueChange={(value) =>
                  setIdentityProfile((current) => ({
                    ...current,
                    model_profile: value as IdentityProfile["model_profile"],
                  }))
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
                {identityProfile.primary_model ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      setIdentityProfile((current) => ({
                        ...current,
                        primary_model: "",
                      }))
                    }
                    disabled={isLoading}
                  >
                    Use default
                  </Button>
                ) : null}
              </div>
              <SearchableSelect
                value={identityProfile.primary_model}
                onValueChange={(value) =>
                  setIdentityProfile((current) => ({
                    ...current,
                    primary_model: value,
                    fallback_models: current.fallback_models.filter(
                      (candidate) => candidate !== value,
                    ),
                  }))
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
                    These providers are present in the gateway config but still
                    need runtime auth or validation before they become
                    selectable here.
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
                    const checked = identityProfile.fallback_models.includes(
                      option.value,
                    );
                    const disabled =
                      option.value === identityProfile.primary_model || isLoading;
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
                value={identityProfile.fallback_policy}
                onValueChange={(value) =>
                  setIdentityProfile((current) => ({
                    ...current,
                    fallback_policy: value as IdentityProfile["fallback_policy"],
                  }))
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
                value={identityProfile.max_tokens_per_run}
                onChange={(event) =>
                  setIdentityProfile((current) => ({
                    ...current,
                    max_tokens_per_run: event.target.value,
                  }))
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
          {identityProfile.primary_model &&
          !availableModelRefs.has(identityProfile.primary_model) ? (
            <p className="mt-4 text-xs text-[color:var(--warning)]">
              The selected primary model is outside the verified gateway
              catalog. Pick a verified option or inherit the default before
              saving.
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
                value={heartbeatEvery}
                onChange={(event) => setHeartbeatEvery(event.target.value)}
                placeholder="e.g. 0m"
                disabled={isLoading}
              />
              <p className="text-xs text-muted">
                Standby-first by default. Use <code>0m</code> to keep the
                agent idle until real work wakes it, or set a cadence like{" "}
                <code>20m</code> or <code>30m</code> only if you want proactive
                periodic check-ins.
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
            {isLoading ? "Creating…" : "Create agent"}
          </Button>
          <Button
            variant="outline"
            type="button"
            onClick={() => router.push("/agents")}
          >
            Back to agents
          </Button>
        </div>
      </form>
    </DashboardPageLayout>
  );
}
