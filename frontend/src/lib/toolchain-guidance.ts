import type { ToolchainCatalogProviderPreset } from "@/api/toolchain";
import type { NodeClass } from "@/lib/node-scope";
import {
  providerAuthModeDescription,
  providerAuthModeLabel,
  providerAuthModesForNodeClass,
  type ProviderAuthMode,
} from "@/lib/provider-auth";

const AUTH_MODE_ORDER: ProviderAuthMode[] = ["api-key", "token", "oauth", "login"];

export type ToolchainAuthGuideItem = {
  mode: ProviderAuthMode;
  label: string;
  description: string;
  available: boolean;
};

export const getToolchainAuthGuide = (
  nodeClass: NodeClass,
): ToolchainAuthGuideItem[] => {
  const availableModes = new Set(providerAuthModesForNodeClass(nodeClass));
  return AUTH_MODE_ORDER.map((mode) => ({
    mode,
    label: providerAuthModeLabel(mode),
    description: providerAuthModeDescription(mode, nodeClass),
    available: availableModes.has(mode),
  }));
};

export const getPresetAllowedAuthModes = (
  preset: ToolchainCatalogProviderPreset,
  nodeClass: NodeClass,
): ProviderAuthMode[] => {
  const availableModes = new Set(providerAuthModesForNodeClass(nodeClass));
  return preset.supported_auth_modes.filter((mode) => availableModes.has(mode));
};

export const getPresetProductLine = (
  preset: ToolchainCatalogProviderPreset,
): string =>
  preset.product_line?.trim() ||
  (preset.kind === "local-interactive" ? "Local interactive" : "Hosted API");

export const getPresetScopeLabel = (
  preset: ToolchainCatalogProviderPreset,
): string => {
  const supportsCloud = preset.node_classes.includes("cloud");
  const supportsLocal = preset.node_classes.includes("local");
  if (supportsCloud && supportsLocal) {
    return "Cloud + local";
  }
  if (supportsLocal) {
    return "Local only";
  }
  if (supportsCloud) {
    return "Cloud only";
  }
  return "Custom scope";
};

export const getPresetSummary = (
  preset: ToolchainCatalogProviderPreset,
): string => {
  const summary = preset.summary?.trim();
  if (summary) {
    return summary;
  }
  return preset.kind === "local-interactive"
    ? "Connect this provider interactively after saving the node."
    : "Mission Control manages the provider metadata and model catalog for this integration.";
};
