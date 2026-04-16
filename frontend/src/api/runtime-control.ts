import { customFetch } from "@/api/mutator";

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
  runtime_sync_generation: number;
  last_runtime_sync_at?: string | null;
  last_runtime_sync_error?: string | null;
  default_model_profile: "general" | "coder" | "budget";
  default_model_ref?: string | null;
  model_profiles: GatewayModelProfiles;
  catalog: GatewayRuntimeCatalogEntry[];
  available_models: string[];
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
