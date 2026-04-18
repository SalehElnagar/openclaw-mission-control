import { customFetch } from "@/api/mutator";
import type {
  GatewayProviderAuthConfig,
  GatewayProviderAuthMode,
  GatewayProviderAuthState,
} from "@/api/generated/model";

type ApiEnvelope<T> = {
  data: T;
  status: number;
  headers: Headers;
};

type ModelSelection = {
  primary_model?: string | null;
  fallback_models?: string[];
};

type GatewayModelProfiles = {
  general?: ModelSelection | null;
  coder?: ModelSelection | null;
  budget?: ModelSelection | null;
};

export type GatewayProviderConfig = {
  id: string;
  preset_id?: string | null;
  managed_by_catalog?: boolean | null;
  provider_type?: string | null;
  label?: string | null;
  base_url?: string | null;
  api_mode?: string | null;
  auth_header?: boolean | null;
  headers?: Record<string, string> | null;
};

export type GatewayProviderSecretRef = {
  provider_id: string;
  purpose: string;
  ref: string;
  alias?: string | null;
  storage_backend?: string | null;
  configured?: boolean | null;
  updated_at?: string | null;
  managed_by_catalog?: boolean | null;
};

export type GatewayModelCost = {
  input?: number | null;
  output?: number | null;
  cache_read?: number | null;
  cache_write?: number | null;
};

export type GatewayModelDefinition = {
  provider_id: string;
  model_id: string;
  preset_id?: string | null;
  managed_by_catalog?: boolean | null;
  label?: string | null;
  api_mode?: string | null;
  reasoning?: boolean | null;
  input_modalities?: string[];
  context_window?: number | null;
  max_tokens?: number | null;
  cost?: GatewayModelCost | null;
};

export type GatewayRuntimeProviderSummary = {
  id: string;
  provider_type: string;
  label: string;
  auth_mode?: GatewayProviderAuthMode | null;
  auth_state?: GatewayProviderAuthState | null;
  requires_login?: boolean | null;
  connected_profile?: string | null;
  verification_state?: "runtime" | "configured";
  configured_model_count?: number;
  verified_model_count?: number;
  secret_ref_count?: number;
  unresolved_secret_refs?: string[];
};

export type GatewayToolProfilePolicy = {
  profile?: "restricted" | "coding" | "research" | "browser-assisted";
  browser_enabled?: boolean;
  workspace_only_fs?: boolean;
  summary?: string | null;
};

export type GatewayRuntimeCatalogEntry = {
  ref: string;
  provider: string;
  provider_label: string;
  label: string;
  kind?: "model";
  verification_state?: "runtime" | "configured";
  selectable?: boolean;
  is_default?: boolean;
};

export type GatewayRuntimeSummary = {
  gateway_id: string;
  node_class?: "cloud" | "local";
  runtime_sync_generation: number;
  last_runtime_sync_at?: string | null;
  last_runtime_sync_error?: string | null;
  default_model_profile: "general" | "coder" | "budget";
  default_model_ref?: string | null;
  model_profiles: GatewayModelProfiles;
  catalog: GatewayRuntimeCatalogEntry[];
  available_models: string[];
  enabled_model_refs: string[];
  configured_provider_configs?: GatewayProviderConfig[];
  configured_provider_auth_configs?: GatewayProviderAuthConfig[];
  configured_model_definitions?: GatewayModelDefinition[];
  configured_provider_secret_refs?: GatewayProviderSecretRef[];
  providers?: GatewayRuntimeProviderSummary[];
  effective_tool_profile?: "restricted" | "coding" | "research" | "browser-assisted";
  effective_tool_policy?: GatewayToolProfilePolicy;
  drift_detected?: boolean;
};

export type GatewayRuntimeSyncRequest = {
  repair_stuck_agents?: boolean;
  sync_models?: boolean;
  wake_agents?: boolean;
};

export type GatewayRuntimeSyncResponse = {
  gateway_id: string;
  repaired_agents: string[];
  skipped_agents: string[];
  sync_generation: number;
  synced_models: boolean;
  telemetry_samples_ingested: number;
  warnings: string[];
};

export type GatewayUsagePullResponse = {
  gateway_id: string;
  ingested_samples: number;
  warnings: string[];
};

export type GatewayProviderAuthAction = "connect" | "refresh" | "disconnect";

export type GatewayProviderAuthChallenge = {
  session_id?: string | null;
  kind?: string | null;
  title?: string | null;
  message?: string | null;
  instructions: string[];
  action_label?: string | null;
  action_url?: string | null;
  code?: string | null;
  needs_input?: boolean | null;
  input_label?: string | null;
  poll_after_ms?: number | null;
};

export type GatewayProviderAuthActionResponse = {
  gateway_id: string;
  provider_id: string;
  auth_mode?: GatewayProviderAuthMode | null;
  auth_state?: GatewayProviderAuthState | null;
  connected_profile?: string | null;
  requires_login?: boolean | null;
  message?: string | null;
  challenge?: GatewayProviderAuthChallenge | null;
  warnings: string[];
};

export type GatewayProviderAuthChallengeInputRequest = {
  session_id: string;
  input_text: string;
};

export type UsageAggregateBucket = {
  period: string;
  total_cost_usd: number;
  total_tokens: number;
};

export type UsageAggregateResponse = {
  total_cost_usd: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
  models: Record<string, number>;
  buckets: UsageAggregateBucket[];
};

export type GatewayAuditRecord = {
  id: string;
  event_type: string;
  message?: string | null;
  actor_type?: string | null;
  actor_user_id?: string | null;
  actor_label?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  previous_values?: Record<string, unknown> | null;
  new_values?: Record<string, unknown> | null;
  details?: Record<string, unknown> | null;
  created_at: string;
};

export type LimitOffsetResponse<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
};

export const getGatewayRuntime = async (
  gatewayId: string,
): Promise<ApiEnvelope<GatewayRuntimeSummary>> =>
  customFetch<ApiEnvelope<GatewayRuntimeSummary>>(
    `/api/v1/gateways/${gatewayId}/runtime`,
    { method: "GET" },
  );

export const reconcileGatewayRuntime = async (
  gatewayId: string,
  payload: GatewayRuntimeSyncRequest,
): Promise<ApiEnvelope<GatewayRuntimeSyncResponse>> =>
  customFetch<ApiEnvelope<GatewayRuntimeSyncResponse>>(
    `/api/v1/gateways/${gatewayId}/runtime/reconcile`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );

export const pullGatewayTelemetry = async (
  gatewayId: string,
): Promise<ApiEnvelope<GatewayUsagePullResponse>> =>
  customFetch<ApiEnvelope<GatewayUsagePullResponse>>(
    `/api/v1/gateways/${gatewayId}/telemetry/pull`,
    { method: "POST" },
  );

export const mutateGatewayProviderAuth = async (
  gatewayId: string,
  providerId: string,
  action: GatewayProviderAuthAction,
): Promise<ApiEnvelope<GatewayProviderAuthActionResponse>> =>
  customFetch<ApiEnvelope<GatewayProviderAuthActionResponse>>(
    `/api/v1/gateways/${gatewayId}/providers/${providerId}/${action}`,
    { method: "POST" },
  );

export const submitGatewayProviderAuthChallengeInput = async (
  gatewayId: string,
  providerId: string,
  payload: GatewayProviderAuthChallengeInputRequest,
): Promise<ApiEnvelope<GatewayProviderAuthActionResponse>> =>
  customFetch<ApiEnvelope<GatewayProviderAuthActionResponse>>(
    `/api/v1/gateways/${gatewayId}/providers/${providerId}/challenge-input`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );

export const listGatewayAudit = async (
  gatewayId: string,
  options?: { limit?: number; offset?: number },
): Promise<ApiEnvelope<LimitOffsetResponse<GatewayAuditRecord>>> => {
  const params = new URLSearchParams();
  if (typeof options?.limit === "number") {
    params.set("limit", String(options.limit));
  }
  if (typeof options?.offset === "number") {
    params.set("offset", String(options.offset));
  }
  const query = params.toString();
  const suffix = query ? `?${query}` : "";
  return customFetch<ApiEnvelope<LimitOffsetResponse<GatewayAuditRecord>>>(
    `/api/v1/gateways/${gatewayId}/audit${suffix}`,
    { method: "GET" },
  );
};

export const aggregateUsage = async (filters?: {
  gateway_id?: string;
  board_id?: string;
  agent_id?: string;
  task_id?: string;
  since?: string;
  until?: string;
}): Promise<ApiEnvelope<UsageAggregateResponse>> => {
  const params = new URLSearchParams();
  Object.entries(filters ?? {}).forEach(([key, value]) => {
    if (value) {
      params.set(key, value);
    }
  });
  const query = params.toString();
  const suffix = query ? `?${query}` : "";
  return customFetch<ApiEnvelope<UsageAggregateResponse>>(
    `/api/v1/telemetry/usage${suffix}`,
    { method: "GET" },
  );
};
