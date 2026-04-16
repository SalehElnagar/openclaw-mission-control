"use client";

export const dynamic = "force-dynamic";

import { useMemo, useState } from "react";
import Link from "next/link";

import { useAuth } from "@/auth/clerk";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, FolderKanban, LayoutPanelTop, Wrench } from "lucide-react";

import { ApiError } from "@/api/mutator";
import {
  type listBoardGroupsApiV1BoardGroupsGetResponse,
  getListBoardGroupsApiV1BoardGroupsGetQueryKey,
  useDeleteBoardGroupApiV1BoardGroupsGroupIdDelete,
  useListBoardGroupsApiV1BoardGroupsGet,
} from "@/api/generated/board-groups/board-groups";
import type { BoardGroupRead } from "@/api/generated/model";
import { BoardGroupsTable } from "@/components/board-groups/BoardGroupsTable";
import { DashboardPageLayout } from "@/components/templates/DashboardPageLayout";
import { buttonVariants } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";
import { createOptimisticListDeleteMutation } from "@/lib/list-delete";
import { pickOperationsGroup } from "@/lib/operations-group";
import { useUrlSorting } from "@/lib/use-url-sorting";

const BOARD_GROUP_SORTABLE_COLUMNS = ["name", "updated_at"];

export default function BoardGroupsPage() {
  const { isSignedIn } = useAuth();
  const queryClient = useQueryClient();
  const { sorting, onSortingChange } = useUrlSorting({
    allowedColumnIds: BOARD_GROUP_SORTABLE_COLUMNS,
    defaultSorting: [{ id: "name", desc: false }],
    paramPrefix: "board_groups",
  });
  const [deleteTarget, setDeleteTarget] = useState<BoardGroupRead | null>(null);

  const groupsKey = getListBoardGroupsApiV1BoardGroupsGetQueryKey();
  const groupsQuery = useListBoardGroupsApiV1BoardGroupsGet<
    listBoardGroupsApiV1BoardGroupsGetResponse,
    ApiError
  >(undefined, {
    query: {
      enabled: Boolean(isSignedIn),
      refetchInterval: 30_000,
      refetchOnMount: "always",
    },
  });

  const groups = useMemo(
    () =>
      groupsQuery.data?.status === 200
        ? (groupsQuery.data.data.items ?? [])
        : [],
    [groupsQuery.data],
  );
  const operationsGroup = useMemo(() => pickOperationsGroup(groups), [groups]);

  const deleteMutation = useDeleteBoardGroupApiV1BoardGroupsGroupIdDelete<
    ApiError,
    { previous?: listBoardGroupsApiV1BoardGroupsGetResponse }
  >(
    {
      mutation: createOptimisticListDeleteMutation<
        BoardGroupRead,
        listBoardGroupsApiV1BoardGroupsGetResponse,
        { groupId: string }
      >({
        queryClient,
        queryKey: groupsKey,
        getItemId: (group) => group.id,
        getDeleteId: ({ groupId }) => groupId,
        onSuccess: () => {
          setDeleteTarget(null);
        },
        invalidateQueryKeys: [groupsKey],
      }),
    },
    queryClient,
  );

  const handleDelete = () => {
    if (!deleteTarget) return;
    deleteMutation.mutate({ groupId: deleteTarget.id });
  };

  return (
    <>
      <DashboardPageLayout
        signedOut={{
          message: "Sign in to view board groups.",
          forceRedirectUrl: "/board-groups",
        }}
        title="Workflow admin"
        description="Board groups define how related boards behave as one cockpit. The Development group is the primary operator surface."
        headerActions={
          <div className="flex flex-wrap gap-3">
            {operationsGroup ? (
              <Link
                href={`/board-groups/${operationsGroup.id}`}
                className={buttonVariants({ size: "md", variant: "primary" })}
              >
                Open Development cockpit
              </Link>
            ) : null}
            <Link
              href="/board-groups/new"
              className={buttonVariants({ size: "md", variant: "outline" })}
            >
              Create group
            </Link>
          </div>
        }
        stickyHeader
      >
        <div className="space-y-8">
          <section className="grid gap-6 xl:grid-cols-[1.25fr_0.75fr]">
            <div className="rounded-3xl border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-quiet">
                Primary workspace
              </p>
              <h2 className="mt-2 text-3xl font-semibold text-strong">
                Groups keep the cockpit coherent
              </h2>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">
                A board group is the shared context layer for boards, memory,
                agent coordination, and cross-board visibility. In this setup,
                the Development group is the default mission-control workspace.
              </p>
              {operationsGroup ? (
                <div className="mt-6 rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-xs uppercase tracking-[0.2em] text-quiet">
                        Recommended group
                      </p>
                      <h3 className="mt-2 text-xl font-semibold text-strong">
                        {operationsGroup.name}
                      </h3>
                      <p className="mt-2 text-sm text-muted">
                        {operationsGroup.description?.trim() ||
                          "Use this group as the live operator cockpit for requirements, execution, review, security, QA, and done."}
                      </p>
                    </div>
                    <Link
                      href={`/board-groups/${operationsGroup.id}`}
                      className={buttonVariants({ size: "sm", variant: "primary" })}
                    >
                      Open cockpit
                    </Link>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="rounded-3xl border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-quiet">
                What this page is for
              </p>
              <div className="mt-5 space-y-4 text-sm text-muted">
                <div className="flex items-start gap-3 rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
                  <FolderKanban className="mt-0.5 h-4 w-4 text-[color:var(--accent)]" />
                  <div>
                    <p className="font-medium text-strong">Group topology</p>
                    <p className="mt-1">
                      Decide which boards share memory, activity, and
                      cross-board visibility.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3 rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
                  <LayoutPanelTop className="mt-0.5 h-4 w-4 text-[color:var(--accent)]" />
                  <div>
                    <p className="font-medium text-strong">Cockpit routing</p>
                    <p className="mt-1">
                      Choose the group that should open first when the operator
                      clicks Boards.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3 rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
                  <Wrench className="mt-0.5 h-4 w-4 text-[color:var(--accent)]" />
                  <div>
                    <p className="font-medium text-strong">Maintenance only</p>
                    <p className="mt-1">
                      Use this page to edit structure. Day-to-day execution
                      should stay inside the live cockpit.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section>
            <div className="mb-4 flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-quiet">
                  Group directory
                </p>
                <h3 className="mt-2 text-xl font-semibold text-strong">
                  Open a cockpit or update workflow structure
                </h3>
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {groups.map((group) => (
                <Link
                  key={group.id}
                  href={`/board-groups/${group.id}`}
                  className="group rounded-3xl border border-[color:var(--border)] bg-[color:var(--surface)] p-5 shadow-sm transition hover:border-[color:var(--accent-soft)] hover:bg-[color:var(--surface-muted)]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-[0.2em] text-quiet">
                        {group.slug}
                      </p>
                      <h4 className="mt-2 text-lg font-semibold text-strong">
                        {group.name}
                      </h4>
                      <p className="mt-2 text-sm text-muted">
                        {group.description?.trim() || "No description yet."}
                      </p>
                    </div>
                    <ArrowUpRight className="h-4 w-4 text-quiet transition group-hover:text-[color:var(--accent)]" />
                  </div>
                </Link>
              ))}
            </div>
          </section>

          <details className="overflow-hidden rounded-3xl border border-[color:var(--border)] bg-[color:var(--surface)] shadow-sm">
            <summary className="cursor-pointer list-none px-6 py-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-quiet">
                    Administration
                  </p>
                  <h3 className="mt-2 text-lg font-semibold text-strong">
                    Open raw board-group administration
                  </h3>
                  <p className="mt-1 text-sm text-muted">
                    The full CRUD table is still here when you need exact
                    control.
                  </p>
                </div>
                <span className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Expand admin view
                </span>
              </div>
            </summary>
            <div className="border-t border-[color:var(--border)] px-6 py-6">
              <div className="overflow-hidden rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)]">
                <BoardGroupsTable
                  groups={groups}
                  isLoading={groupsQuery.isLoading}
                  sorting={sorting}
                  onSortingChange={onSortingChange}
                  showActions
                  stickyHeader
                  onDelete={setDeleteTarget}
                  emptyState={{
                    title: "No groups yet",
                    description:
                      "Create a board group to increase cross-board visibility for agents.",
                    actionHref: "/board-groups/new",
                    actionLabel: "Create your first group",
                  }}
                />
              </div>
            </div>
          </details>

          {groupsQuery.error ? (
            <p className="text-sm text-red-500">{groupsQuery.error.message}</p>
          ) : null}
        </div>
      </DashboardPageLayout>
      <ConfirmActionDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
          }
        }}
        ariaLabel="Delete board group"
        title="Delete board group"
        description={
          <>
            This will remove {deleteTarget?.name}. Boards will be ungrouped.
            This action cannot be undone.
          </>
        }
        errorMessage={deleteMutation.error?.message}
        onConfirm={handleDelete}
        isConfirming={deleteMutation.isPending}
      />
    </>
  );
}
