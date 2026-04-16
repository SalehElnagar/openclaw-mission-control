import type {
  GatewayRuntimeCatalogEntry,
  GatewayRuntimeSummary,
} from "@/api/runtime-control";
import type { SearchableSelectOption } from "@/components/ui/searchable-select";

const KNOWN_PROVIDER_LABELS: Record<string, string> = {
  "microsoft-foundry": "Azure Foundry",
  "openai-codex": "Codex",
  "github-copilot": "GitHub Copilot",
  "google-antigravity": "Antigravity",
  antigravity: "Antigravity",
  anthropic: "Claude",
  claude: "Claude",
  grok: "Grok",
};

type RuntimeProfileName = "general" | "coder" | "budget";

const providerLabelForEntry = (entry: GatewayRuntimeCatalogEntry): string =>
  entry.provider_label || KNOWN_PROVIDER_LABELS[entry.provider] || entry.provider;

const verificationLabel = (entry: GatewayRuntimeCatalogEntry): string =>
  entry.verification_state === "configured" ? "configured" : "runtime";

const optionLabel = (entry: GatewayRuntimeCatalogEntry): string => {
  const providerLabel = providerLabelForEntry(entry);
  const defaultBadge = entry.is_default ? " · default" : "";
  return `${providerLabel} · ${entry.label}${defaultBadge} · ${verificationLabel(entry)}`;
};

const resolveDefaultRuntimeModelRef = (
  runtime: GatewayRuntimeSummary | null | undefined,
  profileName?: RuntimeProfileName,
): string | null => {
  if (!runtime) {
    return "openai-codex/gpt-5.4";
  }
  const profileSelection =
    profileName && runtime.model_profiles
      ? runtime.model_profiles[profileName]
      : undefined;
  const gatewayDefaultProfileSelection =
    runtime.model_profiles?.[runtime.default_model_profile];
  return (
    profileSelection?.primary_model ??
    runtime.default_model_ref ??
    gatewayDefaultProfileSelection?.primary_model ??
    "openai-codex/gpt-5.4"
  );
};

const labelForModelRef = (
  runtime: GatewayRuntimeSummary | null | undefined,
  modelRef: string | null | undefined,
): string => {
  const normalizedRef = modelRef?.trim();
  if (!normalizedRef) {
    return "Not configured";
  }
  const match = runtime?.catalog?.find((entry) => entry.ref === normalizedRef);
  if (match) {
    return match.label;
  }
  return normalizedRef;
};

export const getRuntimeModelOptions = (
  runtime: GatewayRuntimeSummary | null | undefined,
): SearchableSelectOption[] =>
  (runtime?.catalog ?? [])
    .filter((entry) => entry.selectable !== false && (entry.kind ?? "model") === "model")
    .map((entry) => ({
      value: entry.ref,
      label: optionLabel(entry),
    }));

export const getDefaultRuntimeModelLabel = (
  runtime: GatewayRuntimeSummary | null | undefined,
  profileName?: RuntimeProfileName,
): string => {
  return labelForModelRef(runtime, resolveDefaultRuntimeModelRef(runtime, profileName));
};

export const getProviderChoicesSummary = (
  runtime: GatewayRuntimeSummary | null | undefined,
): string => {
  const providerLabels = Array.from(
    new Set(
      (runtime?.catalog ?? [])
        .filter((entry) => entry.selectable !== false)
        .map(providerLabelForEntry),
    ),
  );
  return providerLabels.join(", ");
};

export const getConfiguredRuntimeModelLabels = (
  runtime: GatewayRuntimeSummary | null | undefined,
): string[] =>
  (runtime?.catalog ?? [])
    .filter((entry) => entry.selectable === false && (entry.kind ?? "model") === "model")
    .map(optionLabel);
