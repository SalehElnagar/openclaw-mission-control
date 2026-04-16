"use client";

export const dynamic = "force-dynamic";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { SignedIn, SignedOut, useAuth } from "@/auth/clerk";
import { Boxes, ChevronRight, FolderPlus, Wallet } from "lucide-react";

import { ApiError } from "@/api/mutator";
import {
  createProduct,
  type ProductPlannerMode,
  listProducts,
  type ProductOptimizeFor,
  type ProductStatus,
  type ProductSummaryRead,
} from "@/api/products";
import { getGatewayRuntime } from "@/api/runtime-control";
import {
  type listGatewaysApiV1GatewaysGetResponse,
  useListGatewaysApiV1GatewaysGet,
} from "@/api/generated/gateways/gateways";
import { SignedOutPanel } from "@/components/auth/SignedOutPanel";
import { Markdown } from "@/components/atoms/Markdown";
import { DashboardSidebar } from "@/components/organisms/DashboardSidebar";
import { DashboardShell } from "@/components/templates/DashboardShell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

const PRODUCT_QUERY_KEY = ["products"] as const;
const OPTIMIZE_OPTIONS: Array<{ value: ProductOptimizeFor; label: string }> = [
  { value: "balanced", label: "Balanced" },
  { value: "cheapest-acceptable", label: "Cheapest acceptable" },
  { value: "highest-quality-within-budget", label: "Highest quality within budget" },
];
const PLANNER_MODE_OPTIONS: Array<{ value: ProductPlannerMode; label: string; hint: string }> = [
  {
    value: "auto",
    label: "Auto",
    hint: "Mission Control starts cheap and escalates only when the product reasoning gets harder.",
  },
  {
    value: "fast-thinking",
    label: "Fast",
    hint: "Bias toward GPT-5.4 Mini for faster, cheaper planning turns.",
  },
  {
    value: "deep-thinking",
    label: "Thinking",
    hint: "Bias toward GPT-5.4 / Codex-style deeper planning for stronger product reasoning.",
  },
  {
    value: "security-planning",
    label: "Security",
    hint: "Bias toward the security planner when the product needs privacy or compliance-heavy planning.",
  },
  {
    value: "custom",
    label: "Custom",
    hint: "Pin the planner to one verified model from the selected gateway.",
  },
];

const statusTone = (status: ProductStatus) => {
  if (status === "active") return "text-emerald-300 border-emerald-500/30 bg-emerald-500/10";
  if (status === "archived") return "text-slate-300 border-slate-500/30 bg-slate-500/10";
  return "text-amber-200 border-amber-500/30 bg-amber-500/10";
};

export default function ProductsPage() {
  const { isSignedIn } = useAuth();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [defaultGatewayId, setDefaultGatewayId] = useState<string>("none");
  const [localWorkingDirectory, setLocalWorkingDirectory] = useState("");
  const [remoteRepositoryUrl, setRemoteRepositoryUrl] = useState("");
  const [dailyBudget, setDailyBudget] = useState("");
  const [totalBudget, setTotalBudget] = useState("");
  const [optimizeFor, setOptimizeFor] = useState<ProductOptimizeFor>("balanced");
  const [plannerMode, setPlannerMode] = useState<ProductPlannerMode>("auto");
  const [plannerModelOverride, setPlannerModelOverride] = useState("auto");
  const [error, setError] = useState<string | null>(null);

  const productsQuery = useQuery<ProductSummaryRead[], ApiError>({
    queryKey: [...PRODUCT_QUERY_KEY],
    queryFn: listProducts,
    enabled: Boolean(isSignedIn),
  });
  const gatewaysQuery = useListGatewaysApiV1GatewaysGet<
    listGatewaysApiV1GatewaysGetResponse,
    ApiError
  >(undefined, {
    query: {
      enabled: Boolean(isSignedIn),
      refetchOnMount: "always",
      retry: false,
    },
  });
  const gateways = gatewaysQuery.data?.status === 200 ? gatewaysQuery.data.data.items ?? [] : [];
  const runtimeQuery = useQuery({
    queryKey: ["gateway-runtime", defaultGatewayId],
    queryFn: () => getGatewayRuntime(defaultGatewayId),
    enabled: Boolean(isSignedIn && defaultGatewayId !== "none"),
    retry: false,
  });
  const plannerModelOptions =
    runtimeQuery.data?.data.catalog?.filter((entry) => entry.selectable) ?? [];

  const totals = useMemo(() => {
    const items = productsQuery.data ?? [];
    return {
      active: items.filter((item) => item.status === "active").length,
      draft: items.filter((item) => item.status === "draft").length,
      services: items.reduce((sum, item) => sum + item.services_count, 0),
    };
  }, [productsQuery.data]);

  const createMutation = useMutation({
    mutationFn: createProduct,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [...PRODUCT_QUERY_KEY] });
      setDialogOpen(false);
      setName("");
      setDescription("");
      setDefaultGatewayId("none");
      setLocalWorkingDirectory("");
      setRemoteRepositoryUrl("");
      setDailyBudget("");
      setTotalBudget("");
      setOptimizeFor("balanced");
      setPlannerMode("auto");
      setPlannerModelOverride("auto");
      setError(null);
    },
    onError: (mutationError: ApiError) => {
      setError(mutationError.message);
    },
  });

  return (
    <DashboardShell>
      <DashboardSidebar />
      <main className="min-w-0 bg-app">
        <SignedOut>
          <div className="mx-auto max-w-3xl px-6 py-10">
            <SignedOutPanel
              message="Sign in to manage products and service plans."
              forceRedirectUrl="/onboarding"
              signUpForceRedirectUrl="/onboarding"
            />
          </div>
        </SignedOut>

        <SignedIn>
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-6 py-8">
            <section className="rounded-[28px] border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div className="space-y-3">
                  <span className="inline-flex items-center gap-2 rounded-full border border-cyan-500/20 bg-cyan-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-cyan-200">
                    <Boxes className="h-3.5 w-3.5" />
                    Products
                  </span>
                  <div>
                    <h1 className="text-3xl font-semibold tracking-tight text-strong">
                      Product folders and approved service starts
                    </h1>
                    <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">
                      Open a product, chat with Mission Control about what to build, review the draft
                      plan, approve it, then let execution drop into the existing service cockpit.
                    </p>
                  </div>
                </div>
                <Button
                  className="inline-flex items-center gap-2"
                  onClick={() => setDialogOpen(true)}
                >
                  <FolderPlus className="h-4 w-4" />
                  New product
                </Button>
              </div>

              <div className="mt-6 grid gap-4 md:grid-cols-3">
                <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">
                    Active products
                  </p>
                  <p className="mt-3 text-3xl font-semibold text-strong">{totals.active}</p>
                </div>
                <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">
                    Drafts waiting on planning
                  </p>
                  <p className="mt-3 text-3xl font-semibold text-strong">{totals.draft}</p>
                </div>
                <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">
                    Services seeded
                  </p>
                  <p className="mt-3 text-3xl font-semibold text-strong">{totals.services}</p>
                </div>
              </div>
            </section>

            <section className="grid gap-5 xl:grid-cols-2">
              {(productsQuery.data ?? []).map((product) => (
                <Link
                  key={product.id}
                  href={`/products/${product.id}`}
                  className="group rounded-[26px] border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm transition hover:border-cyan-400/40 hover:bg-[color:var(--surface-muted)]"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={cn(
                            "rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]",
                            statusTone(product.status),
                          )}
                        >
                          {product.status}
                        </span>
                        <span className="text-xs text-muted">
                          {product.latest_plan_status ? `Plan ${product.latest_plan_status}` : "No plan yet"}
                        </span>
                      </div>
                      <div>
                        <h2 className="text-2xl font-semibold text-strong">{product.name}</h2>
                        <div className="mt-2 text-sm leading-6 text-muted">
                          {product.description ? (
                            <Markdown content={product.description} variant="basic" />
                          ) : (
                            "No product brief yet."
                          )}
                        </div>
                      </div>
                    </div>
                    <ChevronRight className="h-5 w-5 text-muted transition group-hover:text-cyan-200" />
                  </div>

                  <div className="mt-6 grid gap-3 md:grid-cols-3">
                    <div className="rounded-2xl border border-[color:var(--border)] bg-app/60 p-4">
                      <p className="text-xs uppercase tracking-[0.16em] text-muted">Services</p>
                      <p className="mt-3 text-2xl font-semibold text-strong">{product.services_count}</p>
                    </div>
                    <div className="rounded-2xl border border-[color:var(--border)] bg-app/60 p-4">
                      <p className="text-xs uppercase tracking-[0.16em] text-muted">Budget posture</p>
                      <p className="mt-3 text-lg font-semibold text-strong">
                        {product.budget_policy.optimize_for.replaceAll("-", " ")}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-[color:var(--border)] bg-app/60 p-4">
                      <p className="text-xs uppercase tracking-[0.16em] text-muted">Latest activity</p>
                      <p className="mt-3 text-sm font-medium text-strong">
                        {product.latest_activity_at ? formatTimestamp(product.latest_activity_at) : "No activity yet"}
                      </p>
                    </div>
                  </div>
                </Link>
              ))}
            </section>

            {productsQuery.data?.length === 0 ? (
              <section className="rounded-[28px] border border-dashed border-[color:var(--border)] bg-[color:var(--surface)] p-10 text-center shadow-sm">
                <div className="mx-auto max-w-2xl space-y-4">
                  <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-cyan-500/10 text-cyan-200">
                    <Wallet className="h-6 w-6" />
                  </div>
                  <h2 className="text-2xl font-semibold text-strong">No products yet</h2>
                  <p className="text-sm leading-6 text-muted">
                    Create a product folder, define the budget posture, and start the planning chat.
                    Mission Control will draft the first execution plan before any work begins.
                  </p>
                </div>
              </section>
            ) : null}
          </div>
        </SignedIn>
      </main>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create a product folder</DialogTitle>
            <DialogDescription>
              This becomes the portfolio folder for product chat, planning, budgets, and service
              execution areas.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-5 py-2">
            <div className="grid gap-2">
              <label className="text-sm font-medium text-strong" htmlFor="product-name">
                Product name
              </label>
              <Input
                id="product-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. FleetOps Platform"
              />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2">
                <label className="text-sm font-medium text-strong" htmlFor="local-workdir">
                  Local working directory
                </label>
                <Input
                  id="local-workdir"
                  value={localWorkingDirectory}
                  onChange={(event) => setLocalWorkingDirectory(event.target.value)}
                  placeholder="/Users/salehelnagar/Workspace/platform/FleetOps"
                />
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium text-strong" htmlFor="remote-repo">
                  Remote repository URL
                </label>
                <Input
                  id="remote-repo"
                  value={remoteRepositoryUrl}
                  onChange={(event) => setRemoteRepositoryUrl(event.target.value)}
                  placeholder="https://github.com/your-org/fleetops"
                />
              </div>
            </div>
            <p className="text-xs leading-5 text-muted">
              Add at least one of these so Mission Control knows where the product should live.
            </p>
            <div className="grid gap-2">
              <label className="text-sm font-medium text-strong" htmlFor="product-description">
                Product brief
              </label>
              <Textarea
                id="product-description"
                rows={4}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What the product is, who it serves, and the outcome you want Mission Control to deliver."
              />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2">
                <label className="text-sm font-medium text-strong">Default gateway</label>
                <Select value={defaultGatewayId} onValueChange={setDefaultGatewayId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a gateway" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Choose automatically</SelectItem>
                    {gateways.map((gateway) => (
                      <SelectItem key={gateway.id} value={gateway.id}>
                        {gateway.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium text-strong">Optimize for</label>
                <Select
                  value={optimizeFor}
                  onValueChange={(value) => setOptimizeFor(value as ProductOptimizeFor)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {OPTIMIZE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
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
                        defaultGatewayId === "none"
                          ? "Choose a gateway first"
                          : plannerMode === "custom"
                            ? "Choose a verified model"
                            : "Only used for custom mode"
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
                  {defaultGatewayId === "none"
                    ? "Pick a gateway if you want to pin the planner to a verified runtime model."
                    : plannerMode === "custom"
                      ? "Only verified gateway models are selectable here."
                      : "Mission Control ignores this unless planner style is set to Custom model."}
                </p>
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2">
                <label className="text-sm font-medium text-strong" htmlFor="daily-budget">
                  Daily budget cap (USD)
                </label>
                <Input
                  id="daily-budget"
                  inputMode="decimal"
                  value={dailyBudget}
                  onChange={(event) => setDailyBudget(event.target.value)}
                  placeholder="Optional"
                />
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium text-strong" htmlFor="total-budget">
                  Total budget cap (USD)
                </label>
                <Input
                  id="total-budget"
                  inputMode="decimal"
                  value={totalBudget}
                  onChange={(event) => setTotalBudget(event.target.value)}
                  placeholder="Optional"
                />
              </div>
            </div>
            {error ? (
              <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                {error}
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={createMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() =>
                createMutation.mutate({
                  name,
                  description,
                  local_working_directory: localWorkingDirectory || null,
                  remote_repository_url: remoteRepositoryUrl || null,
                  default_gateway_id: defaultGatewayId === "none" ? null : defaultGatewayId,
                  budget_policy: {
                    daily_budget_cap_usd: dailyBudget ? Number.parseFloat(dailyBudget) : null,
                    total_budget_cap_usd: totalBudget ? Number.parseFloat(totalBudget) : null,
                    optimize_for: optimizeFor,
                  },
                  planner_policy: {
                    mode: plannerMode,
                    model_override:
                      plannerMode === "custom" && plannerModelOverride !== "auto"
                        ? plannerModelOverride
                        : null,
                  },
                })
              }
              disabled={
                !name.trim() ||
                (!localWorkingDirectory.trim() && !remoteRepositoryUrl.trim()) ||
                (plannerMode === "custom" && plannerModelOverride === "auto") ||
                createMutation.isPending
              }
            >
              {createMutation.isPending ? "Creating..." : "Create product"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardShell>
  );
}
