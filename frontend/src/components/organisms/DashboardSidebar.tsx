"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  BarChart3,
  Bot,
  FileText,
  Boxes,
  CheckCircle2,
  Folder,
  Building2,
  LayoutGrid,
  Network,
  Settings,
  Store,
  Tags,
  Users,
} from "lucide-react";

import { useAuth } from "@/auth/clerk";
import { ApiError } from "@/api/mutator";
import { useOrganizationMembership } from "@/lib/use-organization-membership";
import {
  type listBoardGroupsApiV1BoardGroupsGetResponse,
  useListBoardGroupsApiV1BoardGroupsGet,
} from "@/api/generated/board-groups/board-groups";
import {
  type healthzHealthzGetResponse,
  useHealthzHealthzGet,
} from "@/api/generated/default/default";
import { getOperationsGroupHref } from "@/lib/operations-group";
import { cn } from "@/lib/utils";

export function DashboardSidebar() {
  const pathname = usePathname();
  const { isSignedIn } = useAuth();
  const { isAdmin } = useOrganizationMembership(isSignedIn);
  const healthQuery = useHealthzHealthzGet<healthzHealthzGetResponse, ApiError>(
    {
      query: {
        refetchInterval: 30_000,
        refetchOnMount: "always",
        retry: false,
      },
      request: { cache: "no-store" },
    },
  );
  const groupsQuery = useListBoardGroupsApiV1BoardGroupsGet<
    listBoardGroupsApiV1BoardGroupsGetResponse,
    ApiError
  >(undefined, {
    query: {
      enabled: Boolean(isSignedIn),
      refetchInterval: 30_000,
      refetchOnMount: "always",
      retry: false,
    },
  });
  const primaryBoardsHref = getOperationsGroupHref(
    groupsQuery.data?.status === 200 ? (groupsQuery.data.data.items ?? []) : [],
  );
  const boardsActive =
    pathname.startsWith("/boards") ||
    pathname === primaryBoardsHref ||
    (primaryBoardsHref.startsWith("/board-groups/") &&
      pathname.startsWith(primaryBoardsHref));
  const workflowAdminActive = pathname.startsWith("/board-groups") && !boardsActive;

  const okValue = healthQuery.data?.data?.ok;
  const systemStatus: "unknown" | "operational" | "degraded" =
    okValue === true
      ? "operational"
      : okValue === false
        ? "degraded"
        : healthQuery.isError
          ? "degraded"
          : "unknown";
  const statusLabel =
    systemStatus === "operational"
      ? "All systems operational"
      : systemStatus === "unknown"
        ? "System status unavailable"
        : "System degraded";

  return (
    <aside className="fixed inset-y-0 left-0 z-40 flex w-[280px] -translate-x-full flex-col border-r border-[color:var(--border)] bg-[color:var(--surface)] pt-16 shadow-lg transition-transform duration-200 ease-in-out [[data-sidebar=open]_&]:translate-x-0 md:relative md:inset-auto md:z-auto md:w-[260px] md:translate-x-0 md:pt-0 md:shadow-none md:transition-none">
      <div className="flex-1 px-3 py-4">
        <p className="px-3 text-xs font-semibold uppercase tracking-wider text-muted">
          Navigation
        </p>
        <nav className="mt-3 space-y-4 text-sm">
          <div>
            <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-quiet">
              Overview
            </p>
            <div className="mt-1 space-y-1">
              <Link
                href="/dashboard"
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-muted transition",
                  pathname === "/dashboard"
                    ? "bg-[color:var(--accent-soft)] text-[color:var(--accent-strong)] font-semibold"
                    : "hover:bg-[color:var(--surface-muted)] hover:text-strong",
                )}
              >
                <BarChart3 className="h-4 w-4" />
                Dashboard
              </Link>
              <Link
                href="/activity"
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-muted transition",
                  pathname.startsWith("/activity")
                    ? "bg-[color:var(--accent-soft)] text-[color:var(--accent-strong)] font-semibold"
                    : "hover:bg-[color:var(--surface-muted)] hover:text-strong",
                )}
              >
                <Activity className="h-4 w-4" />
                Live feed
              </Link>
            </div>
          </div>

          <div>
            <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-quiet">
              Products
            </p>
            <div className="mt-1 space-y-1">
              <Link
                href="/products"
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-muted transition",
                  pathname.startsWith("/products")
                    ? "bg-[color:var(--accent-soft)] text-[color:var(--accent-strong)] font-semibold"
                    : "hover:bg-[color:var(--surface-muted)] hover:text-strong",
                )}
              >
                <Bot className="h-4 w-4" />
                Products
              </Link>
              <Link
                href="/docs"
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-muted transition",
                  pathname.startsWith("/docs")
                    ? "bg-[color:var(--accent-soft)] text-[color:var(--accent-strong)] font-semibold"
                    : "hover:bg-[color:var(--surface-muted)] hover:text-strong",
                )}
              >
                <FileText className="h-4 w-4" />
                Docs
              </Link>
              <Link
                href="/team"
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-muted transition",
                  pathname.startsWith("/team")
                    ? "bg-[color:var(--accent-soft)] text-[color:var(--accent-strong)] font-semibold"
                    : "hover:bg-[color:var(--surface-muted)] hover:text-strong",
                )}
              >
                <Users className="h-4 w-4" />
                Team
              </Link>
            </div>
          </div>

          <div>
            <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-quiet">
              Boards
            </p>
            <div className="mt-1 space-y-1">
              <Link
                href={primaryBoardsHref}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-muted transition",
                  boardsActive
                    ? "bg-[color:var(--accent-soft)] text-[color:var(--accent-strong)] font-semibold"
                    : "hover:bg-[color:var(--surface-muted)] hover:text-strong",
                )}
              >
                <LayoutGrid className="h-4 w-4" />
                Boards
              </Link>
              <Link
                href="/tags"
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-muted transition",
                  pathname.startsWith("/tags")
                    ? "bg-[color:var(--accent-soft)] text-[color:var(--accent-strong)] font-semibold"
                    : "hover:bg-[color:var(--surface-muted)] hover:text-strong",
                )}
              >
                <Tags className="h-4 w-4" />
                Tags
              </Link>
              <Link
                href="/approvals"
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-muted transition",
                  pathname.startsWith("/approvals")
                    ? "bg-[color:var(--accent-soft)] text-[color:var(--accent-strong)] font-semibold"
                    : "hover:bg-[color:var(--surface-muted)] hover:text-strong",
                )}
              >
                <CheckCircle2 className="h-4 w-4" />
                Approvals
              </Link>
              {isAdmin ? (
                <Link
                  href="/custom-fields"
                  className={cn(
                    "flex items-center gap-3 rounded-lg px-3 py-2.5 text-muted transition",
                    pathname.startsWith("/custom-fields")
                      ? "bg-[color:var(--accent-soft)] text-[color:var(--accent-strong)] font-semibold"
                      : "hover:bg-[color:var(--surface-muted)] hover:text-strong",
                  )}
                >
                  <Settings className="h-4 w-4" />
                  Custom fields
                </Link>
              ) : null}
            </div>
          </div>

          <div>
            {isAdmin ? (
              <>
                <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-quiet">
                  Skills
                </p>
                <div className="mt-1 space-y-1">
                  <Link
                    href="/skills/marketplace"
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-3 py-2.5 text-muted transition",
                      pathname === "/skills" ||
                        pathname.startsWith("/skills/marketplace")
                        ? "bg-[color:var(--accent-soft)] text-[color:var(--accent-strong)] font-semibold"
                        : "hover:bg-[color:var(--surface-muted)] hover:text-strong",
                    )}
                  >
                    <Store className="h-4 w-4" />
                    Marketplace
                  </Link>
                  <Link
                    href="/skills/packs"
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-3 py-2.5 text-muted transition",
                      pathname.startsWith("/skills/packs")
                        ? "bg-[color:var(--accent-soft)] text-[color:var(--accent-strong)] font-semibold"
                        : "hover:bg-[color:var(--surface-muted)] hover:text-strong",
                    )}
                  >
                    <Boxes className="h-4 w-4" />
                    Packs
                  </Link>
                </div>
              </>
            ) : null}
          </div>

          <div>
            <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-quiet">
              Administration
            </p>
            <div className="mt-1 space-y-1">
              <Link
                href="/board-groups"
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-muted transition",
                  workflowAdminActive
                    ? "bg-[color:var(--accent-soft)] text-[color:var(--accent-strong)] font-semibold"
                    : "hover:bg-[color:var(--surface-muted)] hover:text-strong",
                )}
              >
                <Folder className="h-4 w-4" />
                Workflow admin
              </Link>
              <Link
                href="/organization"
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-muted transition",
                  pathname.startsWith("/organization")
                    ? "bg-[color:var(--accent-soft)] text-[color:var(--accent-strong)] font-semibold"
                    : "hover:bg-[color:var(--surface-muted)] hover:text-strong",
                )}
              >
                <Building2 className="h-4 w-4" />
                Organization
              </Link>
              {isAdmin ? (
                <Link
                  href="/gateways"
                  className={cn(
                    "flex items-center gap-3 rounded-lg px-3 py-2.5 text-muted transition",
                    pathname.startsWith("/gateways")
                      ? "bg-[color:var(--accent-soft)] text-[color:var(--accent-strong)] font-semibold"
                      : "hover:bg-[color:var(--surface-muted)] hover:text-strong",
                  )}
                >
                  <Network className="h-4 w-4" />
                  Gateways
                </Link>
              ) : null}
              {isAdmin ? (
                <Link
                  href="/agents"
                  className={cn(
                    "flex items-center gap-3 rounded-lg px-3 py-2.5 text-muted transition",
                    pathname.startsWith("/agents")
                      ? "bg-[color:var(--accent-soft)] text-[color:var(--accent-strong)] font-semibold"
                      : "hover:bg-[color:var(--surface-muted)] hover:text-strong",
                  )}
                >
                  <Bot className="h-4 w-4" />
                  Agents
                </Link>
              ) : null}
            </div>
          </div>
        </nav>
      </div>
      <div className="border-t border-[color:var(--border)] p-4">
        <div className="flex items-center gap-2 text-xs text-muted">
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              systemStatus === "operational" && "bg-emerald-500",
              systemStatus === "degraded" && "bg-rose-500",
              systemStatus === "unknown" && "bg-[color:var(--text-quiet)]",
            )}
          />
          {statusLabel}
        </div>
      </div>
    </aside>
  );
}
