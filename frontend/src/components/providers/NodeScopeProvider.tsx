"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";

import { useAuth } from "@/auth/clerk";
import { ApiError } from "@/api/mutator";
import {
  type listGatewaysApiV1GatewaysGetResponse,
  useListGatewaysApiV1GatewaysGet,
} from "@/api/generated/gateways/gateways";
import type { GatewayRead } from "@/api/generated/model";
import {
  ALL_NODES_SCOPE,
  type NodeScopeOption,
  type NodeScopeValue,
  filterGatewaysForNodeScope,
  isNodeScopeOptionValid,
  nodeScopeClass,
  nodeScopeGatewayId,
  nodeScopeOptions,
  nodeScopeStorageKey,
  parseNodeScopeValue,
} from "@/lib/node-scope";
import { useOrganizationMembership } from "@/lib/use-organization-membership";

type NodeScopeContextValue = {
  scope: NodeScopeValue;
  setScope: (value: NodeScopeValue) => void;
  options: NodeScopeOption[];
  gateways: GatewayRead[];
  scopedGateways: GatewayRead[];
  selectedGatewayId: string | null;
  selectedNodeClass: "cloud" | "local" | null;
  enabled: boolean;
  isLoading: boolean;
};

const NodeScopeContext = createContext<NodeScopeContextValue | null>(null);

type NodeScopeProviderProps = {
  children: ReactNode;
};

export function NodeScopeProvider({ children }: NodeScopeProviderProps) {
  const { isSignedIn } = useAuth();
  const { member, isAdmin } = useOrganizationMembership(isSignedIn);
  const enabled = Boolean(isSignedIn && isAdmin);
  const organizationId = member?.organization_id ?? null;
  const [scope, setScopeState] = useState<NodeScopeValue>(ALL_NODES_SCOPE);

  const gatewaysQuery = useListGatewaysApiV1GatewaysGet<
    listGatewaysApiV1GatewaysGetResponse,
    ApiError
  >(
    { limit: 200 },
    {
      query: {
        enabled,
        refetchInterval: 15_000,
        refetchOnMount: "always",
        retry: false,
      },
    },
  );

  const gateways = useMemo(
    () =>
      gatewaysQuery.data?.status === 200
        ? [...(gatewaysQuery.data.data.items ?? [])].sort((left, right) =>
            left.name.localeCompare(right.name),
          )
        : [],
    [gatewaysQuery.data],
  );

  useEffect(() => {
    if (!enabled || !organizationId || typeof window === "undefined") {
      setScopeState(ALL_NODES_SCOPE);
      return;
    }
    const stored = parseNodeScopeValue(
      window.localStorage.getItem(nodeScopeStorageKey(organizationId)),
    );
    setScopeState(
      isNodeScopeOptionValid(stored, gateways) ? stored : ALL_NODES_SCOPE,
    );
  }, [enabled, organizationId, gateways]);

  const setScope = (value: NodeScopeValue) => {
    setScopeState(value);
    if (!organizationId || typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(nodeScopeStorageKey(organizationId), value);
  };

  const value = useMemo<NodeScopeContextValue>(
    () => ({
      scope,
      setScope,
      options: nodeScopeOptions(gateways),
      gateways,
      scopedGateways: filterGatewaysForNodeScope(gateways, scope),
      selectedGatewayId: nodeScopeGatewayId(scope),
      selectedNodeClass: nodeScopeClass(scope),
      enabled,
      isLoading: enabled && gatewaysQuery.isLoading,
    }),
    [enabled, gateways, gatewaysQuery.isLoading, scope],
  );

  return (
    <NodeScopeContext.Provider value={value}>
      {children}
    </NodeScopeContext.Provider>
  );
}

export function useNodeScope() {
  const context = useContext(NodeScopeContext);
  if (!context) {
    throw new Error("useNodeScope must be used inside NodeScopeProvider");
  }
  return context;
}
