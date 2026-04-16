"use client";

export const dynamic = "force-dynamic";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { useQueries, useQuery } from "@tanstack/react-query";
import { FileText, FolderOpen, Rocket, ShieldAlert } from "lucide-react";

import { DashboardPageLayout } from "@/components/templates/DashboardPageLayout";
import { ApiError } from "@/api/mutator";
import {
  getProductPlan,
  listProducts,
  type ProductPlanRead,
  type ProductSummaryRead,
} from "@/api/products";
import { useAuth } from "@/auth/clerk";
import { Markdown } from "@/components/atoms/Markdown";
import { Button } from "@/components/ui/button";
import { formatTimestamp } from "@/lib/formatters";

const PRODUCT_QUERY_KEY = ["products"] as const;

const money = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : `$${value.toFixed(2)}`;

export default function DocsPage() {
  const { isSignedIn } = useAuth();
  const router = useRouter();

  const productsQuery = useQuery<ProductSummaryRead[], ApiError>({
    queryKey: [...PRODUCT_QUERY_KEY],
    queryFn: listProducts,
    enabled: Boolean(isSignedIn),
  });

  const products = useMemo(() => productsQuery.data ?? [], [productsQuery.data]);

  const planQueries = useQueries({
    queries: products.map((product) => ({
      queryKey: ["product", product.id, "plan"] as const,
      queryFn: () => getProductPlan(product.id),
      enabled: Boolean(isSignedIn),
      retry: false,
    })),
  });

  const docCards = useMemo(() => {
    return products
      .map((product, index) => ({
        product,
        plan: planQueries[index]?.data as ProductPlanRead | undefined,
      }))
      .sort((left, right) => {
        const leftStamp = left.product.latest_activity_at ?? left.product.updated_at;
        const rightStamp = right.product.latest_activity_at ?? right.product.updated_at;
        return new Date(rightStamp).getTime() - new Date(leftStamp).getTime();
      });
  }, [planQueries, products]);

  const stats = useMemo(() => {
    const plans = docCards.map((item) => item.plan).filter(Boolean) as ProductPlanRead[];
    return {
      products: products.length,
      plans: plans.length,
      approved: plans.filter((plan) => plan.status === "approved").length,
      stale: plans.filter((plan) => (plan.plan_sync_status ?? "").toLowerCase() === "stale").length,
    };
  }, [docCards, products.length]);

  return (
    <DashboardPageLayout
      signedOut={{
        message: "Sign in to browse product briefs, execution plans, and generated artifacts.",
        forceRedirectUrl: "/docs",
        signUpForceRedirectUrl: "/docs",
      }}
      title="Docs"
      description="A workspace-style library of product briefs, plans, and execution-ready artifacts."
      headerActions={
        <Button onClick={() => router.push("/products")}>Open products</Button>
      }
      stickyHeader
    >
      <div className="space-y-6">
        <section className="grid gap-4 md:grid-cols-4">
          <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface)] p-4 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Product folders</p>
            <p className="mt-3 text-3xl font-semibold text-strong">{stats.products}</p>
          </div>
          <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface)] p-4 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Drafts & plans</p>
            <p className="mt-3 text-3xl font-semibold text-strong">{stats.plans}</p>
          </div>
          <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface)] p-4 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Approved for execution</p>
            <p className="mt-3 text-3xl font-semibold text-emerald-300">{stats.approved}</p>
          </div>
          <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface)] p-4 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Sync warnings</p>
            <p className="mt-3 text-3xl font-semibold text-amber-200">{stats.stale}</p>
          </div>
        </section>

        {!products.length ? (
          <section className="rounded-[26px] border border-dashed border-[color:var(--border)] bg-[color:var(--surface)] p-8 text-center shadow-sm">
            <FileText className="mx-auto h-10 w-10 text-cyan-200" />
            <h2 className="mt-4 text-2xl font-semibold text-strong">No product docs yet</h2>
            <p className="mt-2 text-sm leading-6 text-muted">
              Start a product folder first, then Mission Control will draft the plan and keep the artifacts here.
            </p>
            <Button className="mt-5" onClick={() => router.push("/products")}>
              Create or open a product
            </Button>
          </section>
        ) : (
          <section className="grid gap-5 xl:grid-cols-2">
            {docCards.map(({ product, plan }) => {
              const stale = (plan?.plan_sync_status ?? "").toLowerCase() === "stale";
              const epicCount = plan?.initial_epics.length ?? 0;
              const serviceCount = plan?.proposed_services.length ?? product.services_count;
              return (
                <article
                  key={product.id}
                  className="rounded-[26px] border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full border border-cyan-500/20 bg-cyan-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-200">
                          {plan?.status ?? "no plan"}
                        </span>
                        {stale ? (
                          <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-100">
                            sync warning
                          </span>
                        ) : null}
                        {product.status === "active" ? (
                          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-200">
                            active
                          </span>
                        ) : null}
                      </div>
                      <div>
                        <h2 className="text-2xl font-semibold text-strong">{product.name}</h2>
                        <p className="mt-2 text-sm text-muted">
                          Last updated {formatTimestamp(product.latest_activity_at ?? product.updated_at)}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      className="shrink-0"
                      onClick={() => router.push(`/products/${product.id}`)}
                    >
                      Open workspace
                    </Button>
                  </div>

                  <div className="mt-5 grid gap-4 sm:grid-cols-3">
                    <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
                      <div className="flex items-center gap-2 text-sm font-semibold text-strong">
                        <FolderOpen className="h-4 w-4 text-cyan-200" />
                        Services
                      </div>
                      <p className="mt-3 text-2xl font-semibold text-strong">{serviceCount}</p>
                    </div>
                    <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
                      <div className="flex items-center gap-2 text-sm font-semibold text-strong">
                        <Rocket className="h-4 w-4 text-cyan-200" />
                        Initial epics
                      </div>
                      <p className="mt-3 text-2xl font-semibold text-strong">{epicCount}</p>
                    </div>
                    <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
                      <div className="flex items-center gap-2 text-sm font-semibold text-strong">
                        <ShieldAlert className="h-4 w-4 text-cyan-200" />
                        Est. total
                      </div>
                      <p className="mt-3 text-2xl font-semibold text-strong">
                        {money(plan?.estimated_total_budget_usd ?? product.estimated_total_budget_usd)}
                      </p>
                    </div>
                  </div>

                  <div className="mt-5 space-y-4">
                    <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Objective</p>
                      <p className="mt-3 text-sm leading-6 text-strong">
                        {plan?.objective ?? product.description ?? "No objective drafted yet."}
                      </p>
                    </div>

                    {product.description ? (
                      <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
                        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Brief</p>
                        <div className="mt-3 text-sm leading-6 text-strong">
                          <Markdown content={product.description} variant="basic" />
                        </div>
                      </div>
                    ) : null}

                    {plan?.proposed_services.length ? (
                      <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
                        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Planned services</p>
                        <ul className="mt-3 space-y-2 text-sm leading-6 text-strong">
                          {plan.proposed_services.slice(0, 3).map((service) => (
                            <li key={service.slug}>• {service.name}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </section>
        )}
      </div>
    </DashboardPageLayout>
  );
}
