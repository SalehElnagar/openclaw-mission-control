"use client";

export const dynamic = "force-dynamic";

import { useMemo, useState } from "react";
import Link from "next/link";

import { useAuth } from "@/auth/clerk";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, FolderTree, KanbanSquare, ShieldCheck } from "lucide-react";

import { ApiError } from "@/api/mutator";
import {
  type listBoardsApiV1BoardsGetResponse,
  getListBoardsApiV1BoardsGetQueryKey,
  useDeleteBoardApiV1BoardsBoardIdDelete,
  useListBoardsApiV1BoardsGet,
} from "@/api/generated/boards/boards";
import {
  type getBoardGroupSnapshotApiV1BoardGroupsGroupIdSnapshotGetResponse,
  type listBoardGroupsApiV1BoardGroupsGetResponse,
  useGetBoardGroupSnapshotApiV1BoardGroupsGroupIdSnapshotGet,
  useListBoardGroupsApiV1BoardGroupsGet,
} from "@/api/generated/board-groups/board-groups";
import type { BoardRead } from "@/api/generated/model";
import { BoardsTable } from "@/components/boards/BoardsTable";
import { DashboardPageLayout } from "@/components/templates/DashboardPageLayout";
import { buttonVariants } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";
import { createOptimisticListDeleteMutation } from "@/lib/list-delete";
import { pickOperationsGroup } from "@/lib/operations-group";
import { useOrganizationMembership } from "@/lib/use-organization-membership";
import { useUrlSorting } from "@/lib/use-url-sorting";

const BOARD_SORTABLE_COLUMNS = ["name", "group", "updated_at"];

type OperationsHeroProps = {
  isSignedIn: boolean;
  operationsGroupId: string;
  boardCount: number;
};

function OperationsHero({
  isSignedIn,
  operationsGroupId,
  boardCount,
}: OperationsHeroProps) {
  const operationsSnapshotQuery =
    useGetBoardGroupSnapshotApiV1BoardGroupsGroupIdSnapshotGet<
      getBoardGroupSnapshotApiV1BoardGroupsGroupIdSnapshotGetResponse,
      ApiError
    >(
      operationsGroupId,
      { include_done: false, per_board_task_limit: 6 },
      {
        query: {
          enabled: Boolean(isSignedIn && operationsGroupId),
          refetchInterval: 30_000,
          refetchOnMount: "always",
        },
      },
    );
  const operationsSnapshot =
    operationsSnapshotQuery.data?.status === 200
      ? operationsSnapshotQuery.data.data
      : null;
  const operationsBoards = operationsSnapshot?.boards ?? [];
  const activeTaskCount = operationsBoards.reduce(
    (total, board) =>
      total + (board.task_counts?.in_progress ?? 0) + (board.task_counts?.review ?? 0),
    0,
  );
  const readyAgentCount = (operationsSnapshot?.agent_workload ?? []).filter(
    (item) => item.agent.status === "online" || item.agent.status === "standby",
  ).length;

  return (
    <div className="rounded-3xl border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-quiet">
            Mission control
          </p>
          <h2 className="mt-2 text-3xl font-semibold text-strong">
            Run delivery from one main board, not seven tables
          </h2>
          <p className="mt-3 text-sm leading-6 text-muted">
            The Development group is now the operator surface for
            requirements, execution, review, security, QA, and done.
            Use board administration only when you need to edit the
            workflow itself.
          </p>
        </div>
        <Link
          href={`/board-groups/${operationsGroupId}`}
          className={buttonVariants({ size: "lg", variant: "primary" })}
        >
          Open main board
        </Link>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-quiet">Boards</p>
          <p className="mt-2 text-2xl font-semibold text-strong">{boardCount}</p>
        </div>
        <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-quiet">Active work</p>
          <p className="mt-2 text-2xl font-semibold text-strong">{activeTaskCount}</p>
        </div>
        <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-quiet">Pending approvals</p>
          <p className="mt-2 text-2xl font-semibold text-strong">
            {operationsSnapshot?.pending_approvals_count ?? 0}
          </p>
        </div>
        <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-quiet">Ready agents</p>
          <p className="mt-2 text-2xl font-semibold text-strong">{readyAgentCount}</p>
        </div>
      </div>
    </div>
  );
}

export default function BoardsPage() {
  const { isSignedIn } = useAuth();
  const queryClient = useQueryClient();
  const { sorting, onSortingChange } = useUrlSorting({
    allowedColumnIds: BOARD_SORTABLE_COLUMNS,
    defaultSorting: [{ id: "name", desc: false }],
    paramPrefix: "boards",
  });

  const { isAdmin } = useOrganizationMembership(isSignedIn);
  const [deleteTarget, setDeleteTarget] = useState<BoardRead | null>(null);

  const boardsKey = getListBoardsApiV1BoardsGetQueryKey();
  const boardsQuery = useListBoardsApiV1BoardsGet<
    listBoardsApiV1BoardsGetResponse,
    ApiError
  >(undefined, {
    query: {
      enabled: Boolean(isSignedIn),
      refetchInterval: 30_000,
      refetchOnMount: "always",
    },
  });

  const groupsQuery = useListBoardGroupsApiV1BoardGroupsGet<
    listBoardGroupsApiV1BoardGroupsGetResponse,
    ApiError
  >(
    { limit: 200 },
    {
      query: {
        enabled: Boolean(isSignedIn),
        refetchInterval: 30_000,
        refetchOnMount: "always",
      },
    },
  );

  const boards = useMemo(
    () =>
      boardsQuery.data?.status === 200
        ? (boardsQuery.data.data.items ?? [])
        : [],
    [boardsQuery.data],
  );

  const groups = useMemo(() => {
    if (groupsQuery.data?.status !== 200) return [];
    return groupsQuery.data.data.items ?? [];
  }, [groupsQuery.data]);
  const operationsGroup = useMemo(() => pickOperationsGroup(groups), [groups]);
  const spotlightBoards = boards.slice(0, 6);

  const deleteMutation = useDeleteBoardApiV1BoardsBoardIdDelete<
    ApiError,
    { previous?: listBoardsApiV1BoardsGetResponse }
  >(
    {
      mutation: createOptimisticListDeleteMutation<
        BoardRead,
        listBoardsApiV1BoardsGetResponse,
        { boardId: string }
      >({
        queryClient,
        queryKey: boardsKey,
        getItemId: (board) => board.id,
        getDeleteId: ({ boardId }) => boardId,
        onSuccess: () => {
          setDeleteTarget(null);
        },
        invalidateQueryKeys: [boardsKey],
      }),
    },
    queryClient,
  );

  const handleDelete = () => {
    if (!deleteTarget) return;
    deleteMutation.mutate({ boardId: deleteTarget.id });
  };

  return (
    <>
      <DashboardPageLayout
        signedOut={{
          message: "Sign in to view boards.",
          forceRedirectUrl: "/boards",
          signUpForceRedirectUrl: "/boards",
        }}
        title="Boards"
        description="The Development cockpit is the main workspace. Use the admin tools below when you want to change the workflow itself."
        headerActions={
          isAdmin ? (
            <div className="flex flex-wrap gap-3">
              {operationsGroup ? (
                <Link
                  href={`/board-groups/${operationsGroup.id}`}
                  className={buttonVariants({ size: "md", variant: "primary" })}
                >
                  Open main board
                </Link>
              ) : null}
              <Link
                href="/boards/new"
                className={buttonVariants({
                  size: "md",
                  variant: "outline",
                })}
              >
                Create board
              </Link>
            </div>
          ) : operationsGroup ? (
            <Link
              href={`/board-groups/${operationsGroup.id}`}
              className={buttonVariants({ size: "md", variant: "primary" })}
            >
              Open main board
            </Link>
          ) : null
        }
        stickyHeader
      >
        <div className="space-y-8">
          <section className="grid gap-6 xl:grid-cols-[1.4fr_0.8fr]">
            {operationsGroup ? (
              <OperationsHero
                isSignedIn={Boolean(isSignedIn)}
                operationsGroupId={operationsGroup.id}
                boardCount={boards.length}
              />
            ) : (
              <div className="rounded-3xl border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-quiet">
                  Mission control
                </p>
                <h2 className="mt-2 text-3xl font-semibold text-strong">
                  Boards administration
                </h2>
                <p className="mt-3 text-sm leading-6 text-muted">
                  No Development cockpit group is available yet, so this page is staying in
                  admin mode until a board group can be resolved.
                </p>
              </div>
            )}

            <div className="rounded-3xl border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-quiet">
                Workflow admin
              </p>
              <h3 className="mt-2 text-xl font-semibold text-strong">
                Maintenance stays secondary
              </h3>
              <div className="mt-5 space-y-4 text-sm text-muted">
                <div className="flex items-start gap-3 rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
                  <KanbanSquare className="mt-0.5 h-4 w-4 text-[color:var(--accent)]" />
                  <div>
                    <p className="font-medium text-strong">Board structure</p>
                    <p className="mt-1">
                      Create and rename lifecycle boards without losing the new
                      cockpit as the day-to-day landing page.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3 rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
                  <FolderTree className="mt-0.5 h-4 w-4 text-[color:var(--accent)]" />
                  <div>
                    <p className="font-medium text-strong">Group governance</p>
                    <p className="mt-1">
                      Keep boards grouped into one coherent Development
                      workspace, then manage access and sequencing from there.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3 rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
                  <ShieldCheck className="mt-0.5 h-4 w-4 text-[color:var(--accent)]" />
                  <div>
                    <p className="font-medium text-strong">Safe operations</p>
                    <p className="mt-1">
                      Local-only bindings, token auth, and private gateway
                      routing stay untouched while the operator UX improves.
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
                  Board spotlight
                </p>
                <h3 className="mt-2 text-xl font-semibold text-strong">
                  Quick access to the live workflow
                </h3>
              </div>
              <Link
                href="/board-groups"
                className={buttonVariants({ size: "sm", variant: "ghost" })}
              >
                Workflow admin
              </Link>
            </div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {spotlightBoards.map((board) => {
                const group = groups.find((item) => item.id === board.board_group_id);
                return (
                  <Link
                    key={board.id}
                    href={`/boards/${board.id}`}
                    className="group rounded-3xl border border-[color:var(--border)] bg-[color:var(--surface)] p-5 shadow-sm transition hover:border-[color:var(--accent-soft)] hover:bg-[color:var(--surface-muted)]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-xs uppercase tracking-[0.2em] text-quiet">
                          {group?.name ?? "Ungrouped"}
                        </p>
                        <h4 className="mt-2 text-lg font-semibold text-strong">
                          {board.name}
                        </h4>
                        <p className="mt-2 text-sm text-muted">
                          {board.description?.trim() || "Open the board to inspect tasks, approvals, and live agent work."}
                        </p>
                      </div>
                      <ArrowUpRight className="h-4 w-4 text-quiet transition group-hover:text-[color:var(--accent)]" />
                    </div>
                  </Link>
                );
              })}
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
                    Open board administration
                  </h3>
                  <p className="mt-1 text-sm text-muted">
                    Raw board CRUD stays available here when you need it.
                  </p>
                </div>
                <span className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Expand admin view
                </span>
              </div>
            </summary>
            <div className="border-t border-[color:var(--border)] px-6 py-6">
              <div className="overflow-hidden rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-muted)]">
                <BoardsTable
                  boards={boards}
                  boardGroups={groups}
                  isLoading={boardsQuery.isLoading}
                  sorting={sorting}
                  onSortingChange={onSortingChange}
                  showActions
                  stickyHeader
                  onDelete={setDeleteTarget}
                  emptyState={{
                    title: "No boards yet",
                    description:
                      "Create your first board to start routing tasks and monitoring work across agents.",
                    actionHref: "/boards/new",
                    actionLabel: "Create your first board",
                  }}
                />
              </div>
            </div>
          </details>

          {boardsQuery.error ? (
            <p className="text-sm text-red-500">{boardsQuery.error.message}</p>
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
        ariaLabel="Delete board"
        title="Delete board"
        description={
          <>
            This will remove {deleteTarget?.name}. This action cannot be undone.
          </>
        }
        errorMessage={deleteMutation.error?.message}
        onConfirm={handleDelete}
        isConfirming={deleteMutation.isPending}
      />
    </>
  );
}
