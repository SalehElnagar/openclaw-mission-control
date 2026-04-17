import type { GatewayRead } from "@/api/generated/model";

export type NodeClass = "cloud" | "local";
export type NodeScopeValue = "all" | `class:${NodeClass}` | `gateway:${string}`;

export type NodeScopeOption = {
  value: NodeScopeValue;
  label: string;
  description: string;
};

export const ALL_NODES_SCOPE: NodeScopeValue = "all";

export const normalizeNodeClass = (
  value: string | null | undefined,
): NodeClass => (value === "local" ? "local" : "cloud");

export const nodeScopeStorageKey = (organizationId: string) =>
  `openclaw_node_scope:${organizationId}`;

export const parseNodeScopeValue = (
  value: string | null | undefined,
): NodeScopeValue => {
  if (!value || value === ALL_NODES_SCOPE) return ALL_NODES_SCOPE;
  if (value === "class:cloud" || value === "class:local") {
    return value;
  }
  if (value.startsWith("gateway:")) {
    return value as NodeScopeValue;
  }
  return ALL_NODES_SCOPE;
};

export const nodeScopeGatewayId = (
  scope: NodeScopeValue,
): string | null => (scope.startsWith("gateway:") ? scope.slice("gateway:".length) : null);

export const nodeScopeClass = (
  scope: NodeScopeValue,
): NodeClass | null => {
  if (scope === "class:cloud") return "cloud";
  if (scope === "class:local") return "local";
  return null;
};

export const gatewayMatchesNodeScope = (
  gateway: Pick<GatewayRead, "id"> & { node_class?: string | null },
  scope: NodeScopeValue,
): boolean => {
  if (scope === ALL_NODES_SCOPE) return true;
  const gatewayId = nodeScopeGatewayId(scope);
  if (gatewayId) return gateway.id === gatewayId;
  const scopeClass = nodeScopeClass(scope);
  return scopeClass ? normalizeNodeClass(gateway.node_class) === scopeClass : true;
};

export const filterGatewaysForNodeScope = <T extends Pick<GatewayRead, "id"> & {
  node_class?: string | null;
}>(
  gateways: T[],
  scope: NodeScopeValue,
): T[] => gateways.filter((gateway) => gatewayMatchesNodeScope(gateway, scope));

export const gatewayIdsForNodeScope = (
  gateways: Array<Pick<GatewayRead, "id"> & { node_class?: string | null }>,
  scope: NodeScopeValue,
): string[] => filterGatewaysForNodeScope(gateways, scope).map((gateway) => gateway.id);

export const isNodeScopeOptionValid = (
  scope: NodeScopeValue,
  gateways: Array<Pick<GatewayRead, "id"> & { node_class?: string | null }>,
): boolean => {
  if (scope === ALL_NODES_SCOPE || scope === "class:cloud" || scope === "class:local") {
    return true;
  }
  const gatewayId = nodeScopeGatewayId(scope);
  return gatewayId ? gateways.some((gateway) => gateway.id === gatewayId) : false;
};

export const nodeScopeOptions = (
  gateways: Array<Pick<GatewayRead, "id" | "name"> & { node_class?: string | null }>,
): NodeScopeOption[] => {
  const options: NodeScopeOption[] = [
    {
      value: ALL_NODES_SCOPE,
      label: "All nodes",
      description: "Combined operator view across every configured node.",
    },
  ];

  if (gateways.some((gateway) => normalizeNodeClass(gateway.node_class) === "cloud")) {
    options.push({
      value: "class:cloud",
      label: "Cloud",
      description: "Aggregate view across cloud nodes only.",
    });
  }

  if (gateways.some((gateway) => normalizeNodeClass(gateway.node_class) === "local")) {
    options.push({
      value: "class:local",
      label: "Local",
      description: "Aggregate view across local nodes only.",
    });
  }

  gateways.forEach((gateway) => {
    options.push({
      value: `gateway:${gateway.id}`,
      label: gateway.name,
      description: `${normalizeNodeClass(gateway.node_class)} node`,
    });
  });

  return options;
};

export const scopedGatewayOptions = <T extends Pick<GatewayRead, "id"> & {
  node_class?: string | null;
}>(
  gateways: T[],
  scope: NodeScopeValue,
  selectedGatewayId?: string | null,
): T[] => {
  const scoped = filterGatewaysForNodeScope(gateways, scope);
  if (!selectedGatewayId || scoped.some((gateway) => gateway.id === selectedGatewayId)) {
    return scoped;
  }
  const selected = gateways.find((gateway) => gateway.id === selectedGatewayId);
  return selected ? [selected, ...scoped] : scoped;
};
