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

const CLOUD_AUTH_MODES: ProviderAuthMode[] = ["api-key", "token"];
const LOCAL_AUTH_MODES: ProviderAuthMode[] = [
  "api-key",
  "token",
  "oauth",
  "login",
];

export const providerAuthModesForNodeClass = (
  nodeClass: NodeClass,
): ProviderAuthMode[] =>
  nodeClass === "local" ? LOCAL_AUTH_MODES : CLOUD_AUTH_MODES;

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
  const cloudSuffix =
    nodeClass === "cloud"
      ? "Cloud nodes use secret refs and service auth only."
      : "Local nodes can use interactive provider auth flows.";
  switch (mode) {
    case "api-key":
      return "Secret-ref backed API key auth.";
    case "token":
      return "Secret-ref backed bearer token auth.";
    case "oauth":
      return nodeClass === "cloud"
        ? cloudSuffix
        : "Interactive OAuth provider auth backed by the node's secure store.";
    case "login":
      return nodeClass === "cloud"
        ? cloudSuffix
        : "Interactive login-backed provider auth backed by the node's secure store.";
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
  nodeClass: NodeClass,
  mode?: ProviderAuthMode | null,
): boolean =>
  nodeClass === "local" && (mode === "oauth" || mode === "login");
