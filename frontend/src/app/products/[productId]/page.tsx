"use client";

export const dynamic = "force-dynamic";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { SignedIn, SignedOut, useAuth } from "@/auth/clerk";
import {
  ArrowUpRight,
  Bot,
  CircleDollarSign,
  ClipboardCheck,
  FolderRoot,
  MessageSquare,
  Settings2,
  Rocket,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import { ApiError } from "@/api/mutator";
import {
  approveProductPlan,
  getProduct,
  getProductPlan,
  listProductChat,
  listProductServices,
  postProductChat,
  updateProduct,
  type ProductLeadRuntimeDefaults,
  type ProductMessageRead,
  type ProductPlannerMode,
  type ProductPlanRead,
  type ProductRead,
  type ProductServiceRead,
} from "@/api/products";
import {
  getGatewayRuntime,
  type GatewayRuntimeCatalogEntry,
} from "@/api/runtime-control";
import { SignedOutPanel } from "@/components/auth/SignedOutPanel";
import { Markdown } from "@/components/atoms/Markdown";
import { DashboardSidebar } from "@/components/organisms/DashboardSidebar";
import { DashboardShell } from "@/components/templates/DashboardShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { formatTimestamp } from "@/lib/formatters";

const productQueryKey = (productId: string) => ["product", productId] as const;
const productChatQueryKey = (productId: string) => ["product", productId, "chat"] as const;
const productPlanQueryKey = (productId: string) => ["product", productId, "plan"] as const;
const productServicesQueryKey = (productId: string) => ["product", productId, "services"] as const;

const money = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : `$${value.toFixed(2)}`;
const PLANNER_MODE_OPTIONS: Array<{ value: ProductPlannerMode; label: string; hint: string }> = [
  {
    value: "auto",
    label: "Auto",
    hint: "Start cheap and escalate only when product planning gets more complex.",
  },
  {
    value: "fast-thinking",
    label: "Fast",
    hint: "Prefer GPT-5.4 Mini for lighter, cheaper planner turns.",
  },
  {
    value: "deep-thinking",
    label: "Thinking",
    hint: "Prefer the stronger GPT-5.4 / Codex-style planner for deeper architecture reasoning.",
  },
  {
    value: "security-planning",
    label: "Security",
    hint: "Bias toward the security planner for privacy, compliance, and risk-heavy discovery.",
  },
  {
    value: "custom",
    label: "Custom",
    hint: "Pin this product planner to one verified gateway model.",
  },
];

const FALLBACK_PLANNER_MODEL_LABELS: Record<string, string> = {
  "microsoft-foundry/gpt-5.4-mini": "GPT-5.4 Mini",
  "openai-codex/gpt-5.4": "GPT-5.4 Thinking",
  "claude-cli/claude-opus-4-6": "Claude Opus 4.6",
};

const plannerModeLabel = (mode: ProductPlannerMode | string | null | undefined) =>
  PLANNER_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? "Auto";

const plannerModelLabel = (
  modelRef: string | null | undefined,
  catalog?: GatewayRuntimeCatalogEntry[],
) => {
  if (!modelRef) {
    return "Not selected yet";
  }
  const match = catalog?.find((entry) => entry.ref === modelRef);
  return match?.label ?? FALLBACK_PLANNER_MODEL_LABELS[modelRef] ?? modelRef;
};

type LeadRuntimeMode = "inherit" | "custom";
type LeadRuntimeDraft = {
  model_profile: "general" | "coder" | "budget";
  model_primary: string;
  model_fallback_policy: "profile" | "explicit-only" | "none";
  model_fallbacks: string[];
};

const DEFAULT_LEAD_RUNTIME_DRAFT: LeadRuntimeDraft = {
  model_profile: "general",
  model_primary: "",
  model_fallback_policy: "profile",
  model_fallbacks: [],
};

const toLeadRuntimeDraft = (
  value: ProductLeadRuntimeDefaults | null | undefined,
): LeadRuntimeDraft => ({
  model_profile: value?.model_profile ?? "general",
  model_primary: value?.model_primary ?? "",
  model_fallback_policy: value?.model_fallback_policy ?? "profile",
  model_fallbacks: value?.model_fallbacks ?? [],
});

function ChatMessage({
  message,
  catalog,
}: {
  message: ProductMessageRead;
  catalog: GatewayRuntimeCatalogEntry[];
}) {
  const tone =
    message.role === "assistant"
      ? "border-cyan-500/30 bg-cyan-500/10"
      : message.role === "system"
        ? "border-amber-500/30 bg-amber-500/10"
        : "border-[color:var(--border)] bg-[color:var(--surface-muted)]";
  const label =
    message.role === "assistant" ? "Mission Control" : message.role === "system" ? "System" : "You";
  const plannerModel =
    message.role === "assistant" && typeof message.meta?.planner_model_ref === "string"
      ? message.meta.planner_model_ref
      : null;
  const plannerModelDisplay =
    message.role === "assistant" && typeof message.meta?.planner_model_label === "string"
      ? message.meta.planner_model_label
      : plannerModelLabel(plannerModel, catalog);

  return (
    <div className={cn("rounded-2xl border p-4", tone)}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold text-strong">{label}</p>
          {plannerModel ? (
            <code className="rounded-full bg-app/70 px-2.5 py-1 text-[11px] text-cyan-100">
              {plannerModelDisplay}
            </code>
          ) : null}
        </div>
        <span className="text-xs text-muted">{formatTimestamp(message.created_at)}</span>
      </div>
      <div className="mt-3 text-sm leading-6 text-strong">
        <Markdown content={message.content} variant="basic" />
      </div>
    </div>
  );
}

function PlannerThinkingCard() {
  return (
    <div className="rounded-2xl border border-cyan-500/30 bg-cyan-500/10 p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-strong">Mission Control</p>
          <p className="mt-2 text-sm text-muted">
            Thinking through the product brief, updating the draft plan, and deciding the next best follow-up.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-cyan-200" />
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-cyan-200 [animation-delay:120ms]" />
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-cyan-200 [animation-delay:240ms]" />
        </div>
      </div>
    </div>
  );
}

function PlanCard({
  plan,
  plannerModelDisplay,
}: {
  plan: ProductPlanRead;
  plannerModelDisplay: string;
}) {
  return (
    <div className="rounded-[26px] border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-200">
            Current plan
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-strong">
            {plan.status === "approved" ? "Approved execution plan" : "Draft plan"}
          </h2>
        </div>
        <span
          className={cn(
            "rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]",
            plan.status === "approved"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
              : "border-amber-500/30 bg-amber-500/10 text-amber-100",
          )}
        >
          {plan.status}
        </span>
      </div>

      <div className="mt-5 space-y-5">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-muted">Planner status</p>
            <p className="mt-3 text-sm font-semibold text-strong">
              {plan.planner_status?.replaceAll("-", " ") ?? "waiting for first message"}
            </p>
            <p className="mt-2 text-sm leading-6 text-muted">
              {plan.planner_status_reason ??
                "Mission Control keeps execution paused while the planner gathers enough detail to draft the product plan."}
            </p>
          </div>
          <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-muted">Planner model</p>
            <p className="mt-3 text-sm font-semibold text-strong">
              {plannerModelDisplay}
            </p>
            <p className="mt-2 text-sm leading-6 text-muted">
              {plan.planner_last_escalation_reason ??
                "Mission Control uses the budget-aware planner model first and escalates only when the product reasoning gets deeper or riskier."}
            </p>
          </div>
        </div>

        <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 p-4">
          <p className="text-xs uppercase tracking-[0.18em] text-cyan-100">Execution state</p>
          <p className="mt-3 text-sm leading-6 text-cyan-50">
            {plan.status === "approved"
              ? "Execution has been approved and the product services can run through the normal lifecycle."
              : plan.missing_questions.length
                ? "Execution is paused while Mission Control gathers the last missing product answers."
                : "Execution is paused and the draft is complete enough to approve."}
          </p>
        </div>

        <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
          <p className="text-xs uppercase tracking-[0.18em] text-muted">Objective</p>
          <p className="mt-3 text-sm leading-6 text-strong">{plan.objective ?? "TBD"}</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-muted">Target audience</p>
            <p className="mt-3 text-sm leading-6 text-strong">{plan.target_audience ?? "TBD"}</p>
          </div>
          <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-muted">Scope</p>
            <p className="mt-3 text-sm leading-6 text-strong">{plan.scope ?? "TBD"}</p>
          </div>
        </div>
        <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
          <p className="text-xs uppercase tracking-[0.18em] text-muted">Out of scope</p>
          <p className="mt-3 text-sm leading-6 text-strong">{plan.exclusions ?? "TBD"}</p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-muted">Estimated daily budget</p>
            <p className="mt-3 text-2xl font-semibold text-strong">
              {money(plan.estimated_daily_budget_usd)}
            </p>
          </div>
          <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-muted">Estimated total budget</p>
            <p className="mt-3 text-2xl font-semibold text-strong">
              {money(plan.estimated_total_budget_usd)}
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-strong">
            <Sparkles className="h-4 w-4 text-cyan-200" />
            Recommended model mix
          </div>
          <div className="space-y-3">
            {plan.model_recommendations.map((recommendation) => (
              <div
                key={`${recommendation.slice}-${recommendation.model_ref}`}
                className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-strong">{recommendation.slice}</p>
                  <code className="rounded-full bg-app/70 px-3 py-1 text-[11px] text-cyan-100">
                    {recommendation.model_ref}
                  </code>
                </div>
                <p className="mt-2 text-sm leading-6 text-muted">{recommendation.rationale}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-strong">
            <Rocket className="h-4 w-4 text-cyan-200" />
            Proposed services
          </div>
          <div className="space-y-3">
            {plan.proposed_services.map((service) => (
              <div
                key={service.slug}
                className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4"
              >
                <p className="text-sm font-semibold text-strong">{service.name}</p>
                <p className="mt-2 text-sm leading-6 text-muted">
                  {service.description ?? "Execution area to be created on approval."}
                </p>
                {service.epics.length ? (
                  <ul className="mt-3 space-y-2 text-sm text-strong">
                    {service.epics.map((epic) => (
                      <li key={epic}>• {epic}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </div>
        </div>

        {plan.missing_questions.length ? (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-amber-100">
              <ClipboardCheck className="h-4 w-4" />
              Still needed before approval
            </div>
            <ul className="mt-3 space-y-2 text-sm leading-6 text-amber-50">
              {plan.missing_questions.map((question) => (
                <li key={question}>• {question}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {plan.budget_warnings.length ? (
          <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-rose-100">
              <CircleDollarSign className="h-4 w-4" />
              Budget guidance
            </div>
            <ul className="mt-3 space-y-2 text-sm leading-6 text-rose-50">
              {plan.budget_warnings.map((warning) => (
                <li key={warning}>• {warning}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {plan.plan_sync_status === "stale" ? (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-amber-100">
              <ClipboardCheck className="h-4 w-4" />
              Plan sync warning
            </div>
            <p className="mt-3 text-sm leading-6 text-amber-50">
              The assistant reply landed, but the structured plan needs another sync pass.
              {plan.plan_sync_error ? ` ${plan.plan_sync_error}` : ""}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function ProductDetailPage() {
  const { isSignedIn } = useAuth();
  const params = useParams();
  const queryClient = useQueryClient();
  const productIdParam = params?.productId;
  const productId = Array.isArray(productIdParam) ? productIdParam[0] : productIdParam;
  const [draftMessage, setDraftMessage] = useState("");
  const [chatError, setChatError] = useState<string | null>(null);
  const [localWorkingDirectory, setLocalWorkingDirectory] = useState("");
  const [remoteRepositoryUrl, setRemoteRepositoryUrl] = useState("");
  const [plannerMode, setPlannerMode] = useState<ProductPlannerMode>("auto");
  const [plannerModelOverride, setPlannerModelOverride] = useState("auto");
  const [chatPlannerMode, setChatPlannerMode] = useState<ProductPlannerMode>("auto");
  const [chatPlannerModelOverride, setChatPlannerModelOverride] = useState("auto");
  const [leadRuntimeMode, setLeadRuntimeMode] = useState<LeadRuntimeMode>("inherit");
  const [leadRuntimeDraft, setLeadRuntimeDraft] = useState<LeadRuntimeDraft>(
    DEFAULT_LEAD_RUNTIME_DRAFT,
  );
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const productQuery = useQuery<ProductRead, ApiError>({
    queryKey: productId ? [...productQueryKey(productId)] : ["product", "missing"],
    queryFn: () => getProduct(productId as string),
    enabled: Boolean(isSignedIn && productId),
  });
  const chatQuery = useQuery<ProductMessageRead[], ApiError>({
    queryKey: productId ? [...productChatQueryKey(productId)] : ["product-chat", "missing"],
    queryFn: () => listProductChat(productId as string),
    enabled: Boolean(isSignedIn && productId),
  });
  const planQuery = useQuery<ProductPlanRead, ApiError>({
    queryKey: productId ? [...productPlanQueryKey(productId)] : ["product-plan", "missing"],
    queryFn: () => getProductPlan(productId as string),
    enabled: Boolean(isSignedIn && productId),
    retry: false,
  });
  const servicesQuery = useQuery<ProductServiceRead[], ApiError>({
    queryKey: productId ? [...productServicesQueryKey(productId)] : ["product-services", "missing"],
    queryFn: () => listProductServices(productId as string),
    enabled: Boolean(isSignedIn && productId),
  });
  const runtimeQuery = useQuery({
    queryKey: ["product-gateway-runtime", productQuery.data?.default_gateway_id],
    queryFn: () => getGatewayRuntime(productQuery.data?.default_gateway_id as string),
    enabled: Boolean(isSignedIn && productQuery.data?.default_gateway_id),
    retry: false,
  });
  const plannerModelOptions = useMemo(
    () =>
      runtimeQuery.data?.data.catalog?.filter((entry) => entry.selectable) ?? [],
    [runtimeQuery.data],
  );
  const availableRuntimeModelRefs = useMemo(
    () => new Set(plannerModelOptions.map((entry) => entry.ref)),
    [plannerModelOptions],
  );
  const latestAssistantMessage = useMemo(
    () => [...(chatQuery.data ?? [])].reverse().find((message) => message.role === "assistant") ?? null,
    [chatQuery.data],
  );
  const lastActualPlannerModelRef =
    typeof latestAssistantMessage?.meta?.planner_model_ref === "string"
      ? latestAssistantMessage.meta.planner_model_ref
      : planQuery.data?.planner_model_ref ?? null;
  const lastActualPlannerModelDisplay = plannerModelLabel(
    lastActualPlannerModelRef,
    runtimeQuery.data?.data.catalog,
  );
  const nodeDefaultProfile = runtimeQuery.data?.data.default_model_profile ?? "general";
  const nodeDefaultModelLabel = plannerModelLabel(
    runtimeQuery.data?.data.default_model_ref,
    runtimeQuery.data?.data.catalog,
  );
  const lacksLocationAnchor = !(
    (productQuery.data?.local_working_directory ?? "").trim() ||
    (productQuery.data?.remote_repository_url ?? "").trim()
  );
  const hasStalePlanSync = (planQuery.data?.plan_sync_status ?? "").trim().toLowerCase() === "stale";

  useEffect(() => {
    if (!productQuery.data) {
      return;
    }
    setLocalWorkingDirectory(productQuery.data.local_working_directory ?? "");
    setRemoteRepositoryUrl(productQuery.data.remote_repository_url ?? "");
    setPlannerMode(productQuery.data.planner_policy.mode);
    setPlannerModelOverride(productQuery.data.planner_policy.model_override ?? "auto");
    setChatPlannerMode(productQuery.data.planner_policy.mode);
    setChatPlannerModelOverride(productQuery.data.planner_policy.model_override ?? "auto");
    setLeadRuntimeMode(productQuery.data.lead_runtime_defaults ? "custom" : "inherit");
    setLeadRuntimeDraft(toLeadRuntimeDraft(productQuery.data.lead_runtime_defaults));
  }, [productQuery.data]);

  const sendMessageMutation = useMutation({
    mutationFn: (content: string) =>
      postProductChat(productId as string, {
        content,
        planner_mode_override:
          chatPlannerMode !== productQuery.data?.planner_policy.mode ? chatPlannerMode : null,
        planner_model_override:
          chatPlannerMode === "custom" &&
          chatPlannerModelOverride !== "auto" &&
          chatPlannerModelOverride !== (productQuery.data?.planner_policy.model_override ?? "auto")
            ? chatPlannerModelOverride
            : null,
      }),
    onSuccess: async () => {
      setDraftMessage("");
      setChatError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: productChatQueryKey(productId as string) }),
        queryClient.invalidateQueries({ queryKey: productPlanQueryKey(productId as string) }),
        queryClient.invalidateQueries({ queryKey: productQueryKey(productId as string) }),
      ]);
    },
    onError: (error: ApiError) => setChatError(error.message),
  });

  const approveMutation = useMutation({
    mutationFn: () => approveProductPlan(productId as string),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: productPlanQueryKey(productId as string) }),
        queryClient.invalidateQueries({ queryKey: productServicesQueryKey(productId as string) }),
        queryClient.invalidateQueries({ queryKey: productChatQueryKey(productId as string) }),
        queryClient.invalidateQueries({ queryKey: productQueryKey(productId as string) }),
      ]);
    },
  });
  const updateProductMutation = useMutation({
    mutationFn: () => {
      const trimmedLeadPrimary = leadRuntimeDraft.model_primary.trim();
      if (
        leadRuntimeMode === "custom" &&
        trimmedLeadPrimary &&
        !availableRuntimeModelRefs.has(trimmedLeadPrimary)
      ) {
        throw new ApiError(
          422,
          "Pick a node-enabled primary model or switch the lead back to inherited node defaults.",
          null,
        );
      }
      const normalizedLeadFallbacks =
        leadRuntimeDraft.model_fallback_policy === "none"
          ? []
          : leadRuntimeDraft.model_fallbacks.filter(
              (value) => value !== trimmedLeadPrimary && availableRuntimeModelRefs.has(value),
            );
      return updateProduct(productId as string, {
        local_working_directory: localWorkingDirectory || null,
        remote_repository_url: remoteRepositoryUrl || null,
        planner_policy: {
          mode: plannerMode,
          model_override:
            plannerMode === "custom" && plannerModelOverride !== "auto" ? plannerModelOverride : null,
        },
        lead_runtime_defaults:
          leadRuntimeMode === "custom"
            ? {
                model_profile: leadRuntimeDraft.model_profile,
                model_primary: trimmedLeadPrimary || null,
                model_fallback_policy: leadRuntimeDraft.model_fallback_policy,
                model_fallbacks:
                  normalizedLeadFallbacks.length > 0 ? normalizedLeadFallbacks : null,
              }
            : null,
      });
    },
    onSuccess: async () => {
      setSettingsError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: productQueryKey(productId as string) }),
        queryClient.invalidateQueries({ queryKey: productPlanQueryKey(productId as string) }),
      ]);
    },
    onError: (error: ApiError) => setSettingsError(error.message),
  });

  const toggleLeadFallbackModel = (modelRef: string) => {
    setLeadRuntimeDraft((current) => {
      const nextValues = current.model_fallbacks.includes(modelRef)
        ? current.model_fallbacks.filter((value) => value !== modelRef)
        : [...current.model_fallbacks, modelRef];
      return {
        ...current,
        model_fallbacks: nextValues.filter((value) => value !== current.model_primary),
      };
    });
  };

  return (
    <DashboardShell>
      <DashboardSidebar />
      <main className="min-w-0 bg-app">
        <SignedOut>
          <div className="mx-auto max-w-3xl px-6 py-10">
            <SignedOutPanel
              message="Sign in to open products, review plans, and launch service execution."
              forceRedirectUrl="/onboarding"
              signUpForceRedirectUrl="/onboarding"
            />
          </div>
        </SignedOut>

        <SignedIn>
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-6 py-8">
            {productQuery.data ? (
              <section className="rounded-[28px] border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm">
                <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-3">
                    <span className="inline-flex items-center gap-2 rounded-full border border-cyan-500/20 bg-cyan-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-cyan-200">
                      <Bot className="h-3.5 w-3.5" />
                      Product folder
                    </span>
                    <div>
                      <h1 className="text-3xl font-semibold tracking-tight text-strong">
                        {productQuery.data.name}
                      </h1>
                      <p className="mt-3 max-w-3xl text-sm leading-6 text-muted">
                        {productQuery.data.description ?? "No product brief yet. Use the chat below to draft the execution plan."}
                      </p>
                    </div>
                  </div>

	                  <div className="grid min-w-[280px] gap-3 rounded-[24px] border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-muted">Status</span>
                      <span className="rounded-full border border-cyan-500/20 bg-cyan-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-200">
                        {productQuery.data.status}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-muted">Optimize for</span>
                      <span className="text-sm font-semibold text-strong">
                        {productQuery.data.budget_policy.optimize_for.replaceAll("-", " ")}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-muted">Daily cap</span>
                      <span className="text-sm font-semibold text-strong">
                        {money(productQuery.data.budget_policy.daily_budget_cap_usd)}
                      </span>
                    </div>
	                    <div className="flex items-center justify-between gap-3">
	                      <span className="text-sm text-muted">Total cap</span>
	                      <span className="text-sm font-semibold text-strong">
	                        {money(productQuery.data.budget_policy.total_budget_cap_usd)}
	                      </span>
	                    </div>
	                    <div className="flex items-center justify-between gap-3">
	                      <span className="text-sm text-muted">Planner style</span>
	                      <span className="text-sm font-semibold text-strong">
	                        {plannerModeLabel(productQuery.data.planner_policy.mode)}
	                      </span>
	                    </div>
	                    <div className="flex items-center justify-between gap-3">
	                      <span className="text-sm text-muted">Last planner model</span>
	                      <span className="text-sm font-semibold text-strong">
	                        {lastActualPlannerModelDisplay}
	                      </span>
	                    </div>
	                  </div>
	                </div>
                <div className="mt-5 grid gap-3 md:grid-cols-2">
                  <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
                    <p className="text-xs uppercase tracking-[0.18em] text-muted">Local working directory</p>
                    <p className="mt-3 text-sm leading-6 text-strong">
                      {productQuery.data.local_working_directory ?? "Not set"}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
                    <p className="text-xs uppercase tracking-[0.18em] text-muted">Remote repository</p>
                    <p className="mt-3 break-all text-sm leading-6 text-strong">
                      {productQuery.data.remote_repository_url ?? "Not set"}
                    </p>
                  </div>
                </div>
	              </section>
            ) : null}

            <section className="grid gap-8 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
              <div className="space-y-6">
                <div className="rounded-[26px] border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm">
                  <div className="flex items-center gap-2">
                    <MessageSquare className="h-5 w-5 text-cyan-200" />
                    <h2 className="text-2xl font-semibold text-strong">Product chat</h2>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-muted">
                    Describe the product or service conversationally. Mission Control will reason through the brief,
                    ask only the most useful next questions, and keep the execution plan paused until you approve it.
                  </p>

                  <div className="mt-6 space-y-4">
                    {(chatQuery.data ?? []).map((message) => (
                      <ChatMessage
                        key={message.id}
                        message={message}
                        catalog={runtimeQuery.data?.data.catalog ?? []}
                      />
                    ))}
                    {sendMessageMutation.isPending ? <PlannerThinkingCard /> : null}
                    {chatQuery.data?.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-[color:var(--border)] bg-[color:var(--surface-muted)] p-6 text-sm leading-6 text-muted">
                        Start by describing the product, the users it serves, and the result you want. Mission
                        Control will draft the initial plan, keep updating it as the conversation evolves, and only
                        ask for the missing decisions that actually matter.
                      </div>
                    ) : null}
                  </div>

                  <div className="mt-6 space-y-3">
                    <Textarea
                      rows={5}
                      value={draftMessage}
                      onChange={(event) => setDraftMessage(event.target.value)}
                      placeholder="Describe the product, answer the last questions, or refine the scope..."
                    />
                    {chatError ? (
                      <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                        {chatError}
                      </div>
                    ) : null}
                    <div className="grid gap-3 rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
                      <div className="grid gap-2">
                        <label className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                          Planner for this message
                        </label>
                        <Select
                          value={chatPlannerMode}
                          onValueChange={(value) => {
                            setChatPlannerMode(value as ProductPlannerMode);
                            if (value !== "custom") {
                              setChatPlannerModelOverride("auto");
                            }
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {PLANNER_MODE_OPTIONS.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-xs leading-5 text-muted">
                          {PLANNER_MODE_OPTIONS.find((option) => option.value === chatPlannerMode)?.hint}
                        </p>
                      </div>
                      <div className="grid gap-2">
                        <label className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                          Custom model
                        </label>
                        <Select
                          value={chatPlannerModelOverride}
                          onValueChange={setChatPlannerModelOverride}
                          disabled={chatPlannerMode !== "custom"}
                        >
                          <SelectTrigger>
                            <SelectValue
                              placeholder={
                                chatPlannerMode === "custom"
                                  ? "Choose a verified model"
                                  : "Only used for Custom"
                              }
                            />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="auto">Use saved default</SelectItem>
                            {plannerModelOptions.map((entry) => (
                              <SelectItem key={entry.ref} value={entry.ref}>
                                {entry.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-xs leading-5 text-muted">
                          {chatPlannerMode === "custom"
                            ? "Temporary override for the next planner turn only."
                            : `Saved default: ${plannerModeLabel(productQuery.data?.planner_policy.mode)}.`}
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="text-xs text-muted">
                        {lastActualPlannerModelRef
                          ? `Last planner model: ${lastActualPlannerModelDisplay}`
                          : "Mission Control will choose a planner model when the first message is sent."}
                      </div>
                      <Button
                        onClick={() => sendMessageMutation.mutate(draftMessage)}
                        disabled={
                          !draftMessage.trim() ||
                          sendMessageMutation.isPending ||
                          (chatPlannerMode === "custom" && chatPlannerModelOverride === "auto")
                        }
                      >
                        {sendMessageMutation.isPending ? "Mission Control is thinking..." : "Send to Mission Control"}
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="rounded-[26px] border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm">
                  <div className="flex items-center gap-2">
                    <Rocket className="h-5 w-5 text-cyan-200" />
                    <h2 className="text-2xl font-semibold text-strong">Services</h2>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-muted">
                    Approved services become board-group execution areas and keep using the existing main-board cockpit under the hood.
                  </p>

                  <div className="mt-6 grid gap-4">
                    {(servicesQuery.data ?? []).map((service) => (
                      <Link
                        key={service.id}
                        href={`/board-groups/${service.id}`}
                        className="group rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-5 transition hover:border-cyan-400/40"
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <p className="text-lg font-semibold text-strong">{service.name}</p>
                            <p className="mt-2 text-sm leading-6 text-muted">
                              {service.description ?? "Execution area ready for lifecycle work."}
                            </p>
                          </div>
                          <ArrowUpRight className="h-5 w-5 text-muted transition group-hover:text-cyan-200" />
                        </div>
                      </Link>
                    ))}
                    {servicesQuery.data?.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-[color:var(--border)] bg-[color:var(--surface-muted)] p-5 text-sm leading-6 text-muted">
                        No services exist yet. Approve the draft plan to seed the execution board groups and the first epics.
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>

	              <div className="space-y-6">
        {planQuery.data ? (
          <PlanCard
            plan={planQuery.data}
            plannerModelDisplay={plannerModelLabel(
              planQuery.data.planner_model_ref,
              runtimeQuery.data?.data.catalog,
            )}
          />
        ) : null}

	                <div className="rounded-[26px] border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm">
		                  <div className="flex items-center gap-2">
		                    <Settings2 className="h-5 w-5 text-cyan-200" />
		                    <h2 className="text-2xl font-semibold text-strong">Planner & lead settings</h2>
		                  </div>
		                  <p className="mt-2 text-sm leading-6 text-muted">
		                    Choose how the product planner should think, tell Mission Control where the work should live, and decide whether new board leads should inherit the node toolchain or use a product-specific runtime policy.
		                  </p>
	                  <div className="mt-6 grid gap-4">
	                    <div className="grid gap-2">
	                      <label className="text-sm font-medium text-strong" htmlFor="product-local-workdir">
	                        Local working directory
	                      </label>
	                      <Input
	                        id="product-local-workdir"
	                        value={localWorkingDirectory}
	                        onChange={(event) => setLocalWorkingDirectory(event.target.value)}
	                        placeholder="/Users/salehelnagar/Workspace/platform/FleetOps"
	                      />
	                    </div>
	                    <div className="grid gap-2">
	                      <label className="text-sm font-medium text-strong" htmlFor="product-remote-repo">
	                        Remote repository URL
	                      </label>
	                      <Input
	                        id="product-remote-repo"
	                        value={remoteRepositoryUrl}
	                        onChange={(event) => setRemoteRepositoryUrl(event.target.value)}
	                        placeholder="https://github.com/your-org/fleetops"
	                      />
	                    </div>
		                    <div className="grid gap-4 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
	                      <div className="grid gap-2">
	                        <label className="text-sm font-medium text-strong">Planner style</label>
	                        <Select
	                          value={plannerMode}
	                          onValueChange={(value) => {
	                            setPlannerMode(value as ProductPlannerMode);
	                            if (value !== "custom") {
	                              setPlannerModelOverride("auto");
	                            }
	                          }}
	                        >
	                          <SelectTrigger>
	                            <SelectValue />
	                          </SelectTrigger>
	                          <SelectContent>
	                            {PLANNER_MODE_OPTIONS.map((option) => (
	                              <SelectItem key={option.value} value={option.value}>
	                                {option.label}
	                              </SelectItem>
	                            ))}
	                          </SelectContent>
	                        </Select>
	                        <p className="text-xs leading-5 text-muted">
	                          {PLANNER_MODE_OPTIONS.find((option) => option.value === plannerMode)?.hint}
	                        </p>
	                      </div>
	                      <div className="grid gap-2">
	                        <label className="text-sm font-medium text-strong">Planner model override</label>
	                        <Select
	                          value={plannerModelOverride}
	                          onValueChange={setPlannerModelOverride}
	                          disabled={plannerMode !== "custom"}
	                        >
	                          <SelectTrigger>
	                            <SelectValue
	                              placeholder={
	                                productQuery.data?.default_gateway_id
	                                  ? plannerMode === "custom"
	                                    ? "Choose a verified model"
	                                    : "Only used for custom mode"
	                                  : "Add a default gateway to unlock verified model choices"
	                              }
	                            />
	                          </SelectTrigger>
	                          <SelectContent>
	                            <SelectItem value="auto">No override</SelectItem>
	                            {plannerModelOptions.map((entry) => (
	                              <SelectItem key={entry.ref} value={entry.ref}>
	                                {entry.label}
	                              </SelectItem>
	                            ))}
	                          </SelectContent>
	                        </Select>
		                        <p className="text-xs leading-5 text-muted">
		                          {productQuery.data?.default_gateway_id
		                            ? plannerMode === "custom"
		                              ? "Only verified gateway models are selectable here."
		                              : "Mission Control only uses this when Planner style is set to Custom model."
		                            : "Pick a default gateway on the product if you want to pin the planner to a specific verified model."}
		                        </p>
		                      </div>
		                    </div>
                        <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
                          <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                            <div className="space-y-1">
                              <p className="text-sm font-medium text-strong">Lead runtime defaults</p>
                              <p className="text-xs leading-5 text-muted">
                                New board leads inherit the selected node by default. Switch to custom only when this product needs a different verified model profile or fallback chain.
                              </p>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <Button
                                type="button"
                                variant={leadRuntimeMode === "inherit" ? "primary" : "outline"}
                                size="sm"
                                onClick={() => setLeadRuntimeMode("inherit")}
                              >
                                Inherit node default
                              </Button>
                              <Button
                                type="button"
                                variant={leadRuntimeMode === "custom" ? "primary" : "outline"}
                                size="sm"
                                onClick={() => setLeadRuntimeMode("custom")}
                                disabled={!productQuery.data?.default_gateway_id}
                              >
                                Custom lead policy
                              </Button>
                            </div>
                          </div>
                          {leadRuntimeMode === "inherit" ? (
                            <div className="mt-4 rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] p-4 text-sm text-muted">
                              Lead provisioning will inherit the node default profile{" "}
                              <span className="font-semibold text-strong">{nodeDefaultProfile}</span>
                              {" "}and resolve to{" "}
                              <span className="font-semibold text-strong">{nodeDefaultModelLabel}</span>.
                            </div>
                          ) : (
                            <div className="mt-4 grid gap-4 md:grid-cols-2">
                              <div className="grid gap-2">
                                <label className="text-sm font-medium text-strong">Lead model profile</label>
                                <Select
                                  value={leadRuntimeDraft.model_profile}
                                  onValueChange={(value) =>
                                    setLeadRuntimeDraft((current) => ({
                                      ...current,
                                      model_profile: value as LeadRuntimeDraft["model_profile"],
                                    }))
                                  }
                                  disabled={!productQuery.data?.default_gateway_id}
                                >
                                  <SelectTrigger>
                                    <SelectValue placeholder="Select lead profile" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="general">general</SelectItem>
                                    <SelectItem value="coder">coder</SelectItem>
                                    <SelectItem value="budget">budget</SelectItem>
                                  </SelectContent>
                                </Select>
                                <p className="text-xs leading-5 text-muted">
                                  This stays inside the node’s verified model pool and uses that profile’s fallback chain unless you override it below.
                                </p>
                              </div>
                              <div className="grid gap-2">
                                <label className="text-sm font-medium text-strong">Lead primary model</label>
                                <Select
                                  value={leadRuntimeDraft.model_primary || "auto"}
                                  onValueChange={(value) =>
                                    setLeadRuntimeDraft((current) => ({
                                      ...current,
                                      model_primary: value === "auto" ? "" : value,
                                      model_fallbacks: current.model_fallbacks.filter(
                                        (candidate) => candidate !== value,
                                      ),
                                    }))
                                  }
                                  disabled={!productQuery.data?.default_gateway_id}
                                >
                                  <SelectTrigger>
                                    <SelectValue placeholder="Choose a verified model" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="auto">Use profile default</SelectItem>
                                    {plannerModelOptions.map((entry) => (
                                      <SelectItem key={entry.ref} value={entry.ref}>
                                        {entry.label}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <p className="text-xs leading-5 text-muted">
                                  Only verified models from the product’s default node are allowed here.
                                </p>
                              </div>
                              <div className="grid gap-2">
                                <label className="text-sm font-medium text-strong">Lead fallback models</label>
                                <div className="max-h-40 space-y-2 overflow-y-auto rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] p-3">
                                  {plannerModelOptions.length > 0 ? (
                                    plannerModelOptions.map((entry) => {
                                      const checked = leadRuntimeDraft.model_fallbacks.includes(entry.ref);
                                      const disabled = entry.ref === leadRuntimeDraft.model_primary;
                                      return (
                                        <label
                                          key={entry.ref}
                                          className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm text-muted"
                                        >
                                          <span className="min-w-0 truncate">{entry.label}</span>
                                          <input
                                            type="checkbox"
                                            className="h-4 w-4 rounded border-[color:var(--border)] text-[color:var(--accent)] focus:ring-[color:var(--accent-soft)]"
                                            checked={checked}
                                            disabled={disabled}
                                            onChange={() => toggleLeadFallbackModel(entry.ref)}
                                          />
                                        </label>
                                      );
                                    })
                                  ) : (
                                    <p className="text-xs text-muted">
                                      No verified fallback models are available for this node yet.
                                    </p>
                                  )}
                                </div>
                              </div>
                              <div className="grid gap-2">
                                <label className="text-sm font-medium text-strong">Lead fallback policy</label>
                                <Select
                                  value={leadRuntimeDraft.model_fallback_policy}
                                  onValueChange={(value) =>
                                    setLeadRuntimeDraft((current) => ({
                                      ...current,
                                      model_fallback_policy: value as LeadRuntimeDraft["model_fallback_policy"],
                                    }))
                                  }
                                  disabled={!productQuery.data?.default_gateway_id}
                                >
                                  <SelectTrigger>
                                    <SelectValue placeholder="Select fallback policy" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="profile">profile</SelectItem>
                                    <SelectItem value="explicit-only">explicit-only</SelectItem>
                                    <SelectItem value="none">none</SelectItem>
                                  </SelectContent>
                                </Select>
                                <p className="text-xs leading-5 text-muted">
                                  Use profile to inherit node fallbacks, explicit-only to stick to the list above, or none to disable fallback models.
                                </p>
                              </div>
                            </div>
                          )}
                          {!productQuery.data?.default_gateway_id ? (
                            <p className="mt-3 text-xs leading-5 text-muted">
                              Pick a default node on this product to unlock custom lead runtime choices. Until then, Mission Control can only inherit the node policy.
                            </p>
                          ) : null}
                        </div>
		                    {settingsError ? (
		                      <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
		                        {settingsError}
		                      </div>
		                    ) : null}
	                    <div className="flex flex-col gap-4 rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4 md:flex-row md:items-start md:justify-between">
	                      <div className="flex min-w-0 flex-1 items-start gap-3">
	                        <FolderRoot className="mt-0.5 h-4 w-4 text-cyan-200" />
	                        <p className="text-sm leading-6 text-muted">
	                          Keep at least one path on this product: either a local working directory or a remote repository URL.
	                        </p>
	                      </div>
	                      <Button
	                        className="w-full shrink-0 whitespace-nowrap md:w-auto"
		                        onClick={() => updateProductMutation.mutate()}
		                        disabled={
		                          (!localWorkingDirectory.trim() && !remoteRepositoryUrl.trim()) ||
		                          (plannerMode === "custom" && plannerModelOverride === "auto") ||
                              (leadRuntimeMode === "custom" && !productQuery.data?.default_gateway_id) ||
		                          updateProductMutation.isPending
		                        }
		                      >
		                        {updateProductMutation.isPending ? "Saving..." : "Save planner & lead settings"}
		                      </Button>
		                    </div>
		                  </div>
		                </div>

	                <div className="rounded-[26px] border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-5 w-5 text-cyan-200" />
                    <h2 className="text-2xl font-semibold text-strong">Approval gate</h2>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-muted">
                    Mission Control will not create services or start execution until you explicitly approve the current draft.
                  </p>
                  <div className="mt-6 rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4 text-sm leading-6 text-muted">
                    {!planQuery.data
                      ? "Mission Control is still loading the current draft plan."
                      : lacksLocationAnchor
                        ? "Add at least one product location anchor first: a local working directory or a remote repository URL."
                        : hasStalePlanSync
                          ? "The assistant reply landed, but the structured plan needs a clean sync before approval can start execution."
                          : planQuery.data.missing_questions.length
                            ? "Answer the remaining intake questions first. Once the draft is complete, approval will create the service board groups and seed the backlog epics."
                            : "The draft is complete. Approval creates the service board groups, seeds the standard workflow lanes, and starts the first epics in backlog."}
                  </div>
                  <div className="mt-5 flex justify-end">
                    <Button
                      onClick={() => approveMutation.mutate()}
                      disabled={
                        !planQuery.data ||
                        lacksLocationAnchor ||
                        hasStalePlanSync ||
                        planQuery.data.status === "approved" ||
                        planQuery.data.missing_questions.length > 0 ||
                        approveMutation.isPending
                      }
                    >
                      {planQuery.data?.status === "approved"
                        ? "Already approved"
                        : approveMutation.isPending
                          ? "Approving..."
                          : "Approve and start execution"}
                    </Button>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </SignedIn>
      </main>
    </DashboardShell>
  );
}
