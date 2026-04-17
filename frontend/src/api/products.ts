import { customFetch } from "@/api/mutator";

export type ProductStatus = "draft" | "active" | "archived";
export type ProductOptimizeFor =
  | "balanced"
  | "cheapest-acceptable"
  | "highest-quality-within-budget";
export type ProductPlannerMode =
  | "auto"
  | "fast-thinking"
  | "deep-thinking"
  | "security-planning"
  | "custom";
export type ProductPlanStatus = "draft" | "approved";
export type ProductMessageRole = "user" | "assistant" | "system";

export type ProductExecutionPolicy = {
  requires_plan_approval: boolean;
  auto_start_on_approval: boolean;
  service_template: string;
};

export type ProductBudgetPolicy = {
  daily_budget_cap_usd: number | null;
  total_budget_cap_usd: number | null;
  optimize_for: ProductOptimizeFor;
};

export type ProductPlannerPolicy = {
  mode: ProductPlannerMode;
  model_override: string | null;
};

export type ProductLeadRuntimeDefaults = {
  model_profile: "general" | "coder" | "budget" | null;
  model_primary: string | null;
  model_fallback_policy: "profile" | "explicit-only" | "none";
  model_fallbacks: string[] | null;
};

export type ProductRead = {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  description: string | null;
  local_working_directory: string | null;
  remote_repository_url: string | null;
  status: ProductStatus;
  default_gateway_id: string | null;
  execution_policy: ProductExecutionPolicy;
  budget_policy: ProductBudgetPolicy;
  planner_policy: ProductPlannerPolicy;
  lead_runtime_defaults: ProductLeadRuntimeDefaults | null;
  created_at: string;
  updated_at: string;
};

export type ProductSummaryRead = ProductRead & {
  services_count: number;
  active_services_count: number;
  latest_activity_at: string | null;
  latest_plan_status: ProductPlanStatus | null;
  estimated_total_budget_usd: number | null;
};

export type ProductMessageRead = {
  id: string;
  product_id: string;
  role: ProductMessageRole;
  content: string;
  meta: Record<string, unknown> | null;
  created_at: string;
};

export type ProductServiceProposal = {
  name: string;
  slug: string;
  description: string | null;
  objective: string | null;
  epics: string[];
};

export type ProductEpicProposal = {
  title: string;
  description: string | null;
  priority: "low" | "medium" | "high";
  service_slug: string | null;
};

export type ProductModelRecommendation = {
  slice: string;
  model_ref: string;
  rationale: string;
  estimated_cost_usd: number | null;
};

export type ProductPlanRead = {
  id: string;
  product_id: string;
  status: ProductPlanStatus;
  planner_agent_id: string | null;
  planner_session_key: string | null;
  planner_model_ref: string | null;
  planner_status: string | null;
  planner_status_reason: string | null;
  planner_last_escalation_reason: string | null;
  plan_sync_status: string | null;
  plan_sync_error: string | null;
  intake_summary: string | null;
  objective: string | null;
  target_audience: string | null;
  scope: string | null;
  exclusions: string | null;
  missing_questions: string[];
  unresolved_question_keys: string[];
  completeness: Record<string, unknown>;
  proposed_services: ProductServiceProposal[];
  initial_epics: ProductEpicProposal[];
  role_assignments: Record<string, unknown>;
  model_recommendations: ProductModelRecommendation[];
  estimated_daily_budget_usd: number | null;
  estimated_total_budget_usd: number | null;
  budget_posture: string | null;
  budget_warnings: string[];
  last_message_at: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ProductCreatePayload = {
  name: string;
  slug?: string | null;
  description?: string | null;
  local_working_directory?: string | null;
  remote_repository_url?: string | null;
  status?: ProductStatus;
  default_gateway_id?: string | null;
  execution_policy?: Partial<ProductExecutionPolicy>;
  budget_policy?: Partial<ProductBudgetPolicy>;
  planner_policy?: Partial<ProductPlannerPolicy>;
  lead_runtime_defaults?: ProductLeadRuntimeDefaults | null;
};

export type ProductUpdatePayload = Partial<ProductCreatePayload>;

export type ProductChatPayload = {
  content: string;
  planner_mode_override?: ProductPlannerMode | null;
  planner_model_override?: string | null;
};

export type ProductServiceRead = {
  id: string;
  organization_id: string;
  product_id: string | null;
  name: string;
  slug: string;
  description: string | null;
  created_at: string;
  updated_at: string;
};

type ApiEnvelope<T> = { data: T; status: number; headers: Headers };

const ensureExecutionPolicy = (
  policy?: Partial<ProductExecutionPolicy>,
): ProductExecutionPolicy => ({
  requires_plan_approval: policy?.requires_plan_approval ?? true,
  auto_start_on_approval: policy?.auto_start_on_approval ?? true,
  service_template: policy?.service_template ?? "standard",
});

const ensureBudgetPolicy = (
  policy?: Partial<ProductBudgetPolicy>,
): ProductBudgetPolicy => ({
  daily_budget_cap_usd: policy?.daily_budget_cap_usd ?? null,
  total_budget_cap_usd: policy?.total_budget_cap_usd ?? null,
  optimize_for: policy?.optimize_for ?? "balanced",
});

const ensurePlannerPolicy = (
  policy?: Partial<ProductPlannerPolicy>,
): ProductPlannerPolicy => ({
  mode: policy?.mode ?? "auto",
  model_override: policy?.model_override ?? null,
});

const ensureLeadRuntimeDefaults = (
  defaults?: ProductLeadRuntimeDefaults | null,
): ProductLeadRuntimeDefaults | null => {
  if (defaults == null) {
    return null;
  }
  return {
    model_profile: defaults.model_profile ?? null,
    model_primary: defaults.model_primary ?? null,
    model_fallback_policy: defaults.model_fallback_policy ?? "profile",
    model_fallbacks: defaults.model_fallbacks ?? null,
  };
};

export const listProducts = async (): Promise<ProductSummaryRead[]> => {
  const response = await customFetch<ApiEnvelope<ProductSummaryRead[]>>("/api/v1/products", {
    method: "GET",
  });
  return response.data;
};

export const createProduct = async (
  payload: ProductCreatePayload,
): Promise<ProductRead> => {
  const response = await customFetch<ApiEnvelope<ProductRead>>("/api/v1/products", {
    method: "POST",
    body: JSON.stringify({
      name: payload.name,
      slug: payload.slug ?? null,
      description: payload.description ?? null,
      local_working_directory: payload.local_working_directory ?? null,
      remote_repository_url: payload.remote_repository_url ?? null,
      status: payload.status ?? "draft",
      default_gateway_id: payload.default_gateway_id ?? null,
      execution_policy: ensureExecutionPolicy(payload.execution_policy),
      budget_policy: ensureBudgetPolicy(payload.budget_policy),
      planner_policy: ensurePlannerPolicy(payload.planner_policy),
      lead_runtime_defaults: ensureLeadRuntimeDefaults(payload.lead_runtime_defaults),
    }),
  });
  return response.data;
};

export const getProduct = async (productId: string): Promise<ProductRead> => {
  const response = await customFetch<ApiEnvelope<ProductRead>>(`/api/v1/products/${productId}`, {
    method: "GET",
  });
  return response.data;
};

export const updateProduct = async (
  productId: string,
  payload: ProductUpdatePayload,
): Promise<ProductRead> => {
  const body: Record<string, unknown> = {};
  if (payload.name !== undefined) body.name = payload.name;
  if (payload.slug !== undefined) body.slug = payload.slug;
  if (payload.description !== undefined) body.description = payload.description;
  if (payload.local_working_directory !== undefined) {
    body.local_working_directory = payload.local_working_directory;
  }
  if (payload.remote_repository_url !== undefined) {
    body.remote_repository_url = payload.remote_repository_url;
  }
  if (payload.status !== undefined) body.status = payload.status;
  if (payload.default_gateway_id !== undefined) {
    body.default_gateway_id = payload.default_gateway_id;
  }
  if (payload.execution_policy !== undefined) {
    body.execution_policy = ensureExecutionPolicy(payload.execution_policy);
  }
  if (payload.budget_policy !== undefined) {
    body.budget_policy = ensureBudgetPolicy(payload.budget_policy);
  }
  if (payload.planner_policy !== undefined) {
    body.planner_policy = ensurePlannerPolicy(payload.planner_policy);
  }
  if (payload.lead_runtime_defaults !== undefined) {
    body.lead_runtime_defaults = ensureLeadRuntimeDefaults(payload.lead_runtime_defaults);
  }
  const response = await customFetch<ApiEnvelope<ProductRead>>(
    `/api/v1/products/${productId}`,
    {
      method: "PATCH",
      body: JSON.stringify(body),
    },
  );
  return response.data;
};

export const listProductChat = async (
  productId: string,
): Promise<ProductMessageRead[]> => {
  const response = await customFetch<ApiEnvelope<ProductMessageRead[]>>(
    `/api/v1/products/${productId}/chat`,
    {
      method: "GET",
    },
  );
  return response.data;
};

export const postProductChat = async (
  productId: string,
  payload: ProductChatPayload,
): Promise<ProductMessageRead> => {
  const response = await customFetch<ApiEnvelope<ProductMessageRead>>(
    `/api/v1/products/${productId}/chat`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
  return response.data;
};

export const getProductPlan = async (
  productId: string,
): Promise<ProductPlanRead> => {
  const response = await customFetch<ApiEnvelope<ProductPlanRead>>(
    `/api/v1/products/${productId}/plan`,
    {
      method: "GET",
    },
  );
  return response.data;
};

export const approveProductPlan = async (
  productId: string,
): Promise<ProductPlanRead> => {
  const response = await customFetch<ApiEnvelope<ProductPlanRead>>(
    `/api/v1/products/${productId}/plan/approve`,
    {
      method: "POST",
      body: JSON.stringify({ start_execution: true }),
    },
  );
  return response.data;
};

export const listProductServices = async (
  productId: string,
): Promise<ProductServiceRead[]> => {
  const response = await customFetch<ApiEnvelope<ProductServiceRead[]>>(
    `/api/v1/products/${productId}/services`,
    {
      method: "GET",
    },
  );
  return response.data;
};
