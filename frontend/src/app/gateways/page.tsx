"use client";

export const dynamic = "force-dynamic";

import { useMemo, useState } from "react";
import Link from "next/link";

import { useAuth } from "@/auth/clerk";
import { useQueryClient } from "@tanstack/react-query";

import { GatewaysTable } from "@/components/gateways/GatewaysTable";
import { useNodeScope } from "@/components/providers/NodeScopeProvider";
import { DashboardPageLayout } from "@/components/templates/DashboardPageLayout";
import { buttonVariants } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";

import { ApiError } from "@/api/mutator";
import {
  type listGatewaysApiV1GatewaysGetResponse,
  getListGatewaysApiV1GatewaysGetQueryKey,
  useDeleteGatewayApiV1GatewaysGatewayIdDelete,
  useListGatewaysApiV1GatewaysGet,
} from "@/api/generated/gateways/gateways";
import { createOptimisticListDeleteMutation } from "@/lib/list-delete";
import { useOrganizationMembership } from "@/lib/use-organization-membership";
import type { GatewayRead } from "@/api/generated/model";
import { useUrlSorting } from "@/lib/use-url-sorting";

const GATEWAY_SORTABLE_COLUMNS = ["name", "workspace_root", "updated_at"];

export default function GatewaysPage() {
  const { isSignedIn } = useAuth();
  const queryClient = useQueryClient();
  const { scopedGateways, selectedGatewayId, selectedNodeClass } = useNodeScope();
  const { sorting, onSortingChange } = useUrlSorting({
    allowedColumnIds: GATEWAY_SORTABLE_COLUMNS,
    defaultSorting: [{ id: "name", desc: false }],
    paramPrefix: "gateways",
  });

  const { isAdmin } = useOrganizationMembership(isSignedIn);
  const [deleteTarget, setDeleteTarget] = useState<GatewayRead | null>(null);

  const gatewaysKey = getListGatewaysApiV1GatewaysGetQueryKey();
  const gatewaysQuery = useListGatewaysApiV1GatewaysGet<
    listGatewaysApiV1GatewaysGetResponse,
    ApiError
  >(undefined, {
    query: {
      enabled: Boolean(isSignedIn && isAdmin),
      refetchInterval: 30_000,
      refetchOnMount: "always",
    },
  });

  const gateways = useMemo(
    () =>
      gatewaysQuery.data?.status === 200
        ? (gatewaysQuery.data.data.items ?? [])
        : [],
    [gatewaysQuery.data],
  );
  const visibleGateways = useMemo(
    () =>
      selectedGatewayId || selectedNodeClass
        ? gateways.filter((gateway) =>
            scopedGateways.some((candidate) => candidate.id === gateway.id),
          )
        : gateways,
    [gateways, scopedGateways, selectedGatewayId, selectedNodeClass],
  );

  const deleteMutation = useDeleteGatewayApiV1GatewaysGatewayIdDelete<
    ApiError,
    { previous?: listGatewaysApiV1GatewaysGetResponse }
  >(
    {
      mutation: createOptimisticListDeleteMutation<
        GatewayRead,
        listGatewaysApiV1GatewaysGetResponse,
        { gatewayId: string }
      >({
        queryClient,
        queryKey: gatewaysKey,
        getItemId: (gateway) => gateway.id,
        getDeleteId: ({ gatewayId }) => gatewayId,
        onSuccess: () => {
          setDeleteTarget(null);
        },
        invalidateQueryKeys: [gatewaysKey],
      }),
    },
    queryClient,
  );

  const handleDelete = () => {
    if (!deleteTarget) return;
    deleteMutation.mutate({ gatewayId: deleteTarget.id });
  };

  return (
    <>
      <DashboardPageLayout
        signedOut={{
          message: "Sign in to view nodes.",
          forceRedirectUrl: "/gateways",
        }}
        title="Nodes"
        description="Manage the cloud and local runtimes Mission Control can target."
        headerActions={
          isAdmin && visibleGateways.length > 0 ? (
            <Link
              href="/gateways/new"
              className={buttonVariants({
                size: "md",
                variant: "primary",
              })}
            >
              Create node
            </Link>
          ) : null
        }
        isAdmin={isAdmin}
        adminOnlyMessage="Only organization owners and admins can access nodes."
        stickyHeader
      >
        <div className="overflow-hidden rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] shadow-sm">
          <GatewaysTable
            gateways={visibleGateways}
            isLoading={gatewaysQuery.isLoading}
            sorting={sorting}
            onSortingChange={onSortingChange}
            showActions
            stickyHeader
            onDelete={setDeleteTarget}
            emptyState={{
              title: "No nodes yet",
              description:
                "Create your first node to connect boards and start managing your OpenClaw runtimes.",
              actionHref: "/gateways/new",
              actionLabel: "Create your first node",
            }}
          />
        </div>

        {gatewaysQuery.error ? (
          <p className="mt-4 text-sm text-[color:var(--danger)]">
            {gatewaysQuery.error.message}
          </p>
        ) : null}
      </DashboardPageLayout>

      <ConfirmActionDialog
        open={Boolean(deleteTarget)}
        onOpenChange={() => setDeleteTarget(null)}
        title="Delete node?"
        description={
          <>
            This removes the node connection from Mission Control. Boards
            using it will need a new node assigned.
          </>
        }
        errorMessage={deleteMutation.error?.message}
        errorStyle="text"
        cancelVariant="ghost"
        onConfirm={handleDelete}
        isConfirming={deleteMutation.isPending}
      />
    </>
  );
}
