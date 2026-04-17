import type { NodeClass } from "@/lib/node-scope";

export type ProviderAuthMode = "api-key" | "token" | "oauth" | "login";
export type ProviderAuthState =
  | "verified"
  | "configured"
  | "requires-login"
  | "expired"
  | "disconnected";

export type ProviderAuthModeOption = {
  value: ProviderAuthMode;
  label: string;
  description: string;
};

const ALL_PROVIDER_AUTH_MODES: ProviderAuthMode[] = [
  "api-key",
  "token",
  "oauth",
  "login",
];

export const providerAuthModesForNodeClass = (
  _nodeClass: NodeClass,
): ProviderAuthMode[] => ALL_PROVIDER_AUTH_MODES;

export const providerAuthModeOptionsForNodeClass = (
  nodeClass: NodeClass,
): ProviderAuthModeOption[] =>
  providerAuthModesForNodeClass(nodeClass).map((mode) => ({
    value: mode,
    label: providerAuthModeLabel(mode),
    description: providerAuthModeDescription(mode, nodeClass),
  }));

export const providerAuthModeLabel = (mode: ProviderAuthMode): string => {
  switch (mode) {
    case "api-key":
      return "API key";
    case "token":
      return "Token";
    case "oauth":
      return "OAuth";
    case "login":
      return "Login";
  }
};

export const providerAuthModeDescription = (
  mode: ProviderAuthMode,
  nodeClass: NodeClass,
): string => {
  switch (mode) {
    case "api-key":
      return nodeClass === "cloud"
        ? "Write-only API key stored for this cloud node."
        : "Write-only API key stored for this node.";
    case "token":
      return nodeClass === "cloud"
        ? "Write-only bearer token stored for this cloud node."
        : "Write-only bearer token stored for this node.";
    case "oauth":
      return nodeClass === "cloud"
        ? "Browser-based sign-in against the remote cloud node session with a managed interactive profile."
        : "Browser-based sign-in on this node with a managed interactive profile.";
    case "login":
      return nodeClass === "cloud"
        ? "CLI or device-style sign-in against the remote cloud node session with a managed interactive profile."
        : "CLI or device-style sign-in on this node with a managed interactive profile.";
  }
};

export const providerAuthStateLabel = (
  state?: ProviderAuthState | null,
  requiresLogin?: boolean | null,
): string => {
  if (requiresLogin) {
    return "Login required";
  }
  switch (state) {
    case "verified":
      return "Verified";
    case "requires-login":
      return "Login required";
    case "expired":
      return "Expired";
    case "disconnected":
      return "Disconnected";
    case "configured":
    default:
      return "Configured";
  }
};

export const providerAuthStateTone = (
  state?: ProviderAuthState | null,
  requiresLogin?: boolean | null,
): "success" | "warning" | "danger" | "neutral" => {
  if (requiresLogin || state === "requires-login") {
    return "warning";
  }
  if (state === "verified") {
    return "success";
  }
  if (state === "expired" || state === "disconnected") {
    return "danger";
  }
  return "neutral";
};

export const providerAuthAllowsInteractiveActions = (
  _nodeClass: NodeClass,
  mode?: ProviderAuthMode | null,
): boolean => mode === "oauth" || mode === "login";
