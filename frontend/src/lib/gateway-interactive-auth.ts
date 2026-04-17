import type { GatewayProviderAuthConfig } from "@/api/generated/model";
import type { GatewayRuntimeProviderSummary } from "@/api/runtime-control";
import type { ProviderAuthMode } from "@/lib/provider-auth";

const INTERACTIVE_AUTH_QUERY_PARAM = "connectProvider";

const normalizeProviderId = (value?: string | null): string | null => {
  const normalized = value?.trim();
  return normalized ? normalized : null;
};

const interactiveAuthSignature = (
  config?: GatewayProviderAuthConfig | null,
): string | null => {
  const providerId = normalizeProviderId(config?.provider_id);
  if (
    !providerId ||
    !isInteractiveProviderAuthMode(config?.auth_mode ?? null)
  ) {
    return null;
  }
  return [
    providerId,
    config?.auth_mode ?? "",
    config?.profile_id?.trim() ?? "",
  ].join("::");
};

export const isInteractiveProviderAuthMode = (
  mode?: ProviderAuthMode | null,
): boolean => mode === "oauth" || mode === "login";

export const findPendingInteractiveProviderIds = ({
  nextAuthConfigs,
  previousAuthConfigs = [],
  runtimeProviders = [],
}: {
  nextAuthConfigs: GatewayProviderAuthConfig[];
  previousAuthConfigs?: GatewayProviderAuthConfig[];
  runtimeProviders?: GatewayRuntimeProviderSummary[];
}): string[] => {
  const previousByProviderId = new Map(
    previousAuthConfigs
      .map((config) => {
        const providerId = normalizeProviderId(config.provider_id);
        return providerId ? [providerId, config] : null;
      })
      .filter((entry): entry is [string, GatewayProviderAuthConfig] =>
        Boolean(entry),
      ),
  );
  const runtimeByProviderId = new Map(
    runtimeProviders
      .map((provider) => {
        const providerId = normalizeProviderId(provider.id);
        return providerId ? [providerId, provider] : null;
      })
      .filter((entry): entry is [string, GatewayRuntimeProviderSummary] =>
        Boolean(entry),
      ),
  );

  return Array.from(
    new Set(
      nextAuthConfigs.flatMap((config) => {
        const providerId = normalizeProviderId(config.provider_id);
        if (!providerId) {
          return [];
        }
        if (!isInteractiveProviderAuthMode(config.auth_mode ?? null)) {
          return [];
        }
        const runtime = runtimeByProviderId.get(providerId) ?? null;
        const previousSignature = interactiveAuthSignature(
          previousByProviderId.get(providerId) ?? null,
        );
        const nextSignature = interactiveAuthSignature(config);
        const changed = previousSignature !== nextSignature;
        const needsLogin =
          !runtime ||
          runtime.requires_login === true ||
          runtime.auth_state === "requires-login" ||
          runtime.auth_state === "configured" ||
          runtime.verification_state !== "runtime";

        return changed || needsLogin ? [providerId] : [];
      }),
    ),
  );
};

export const buildGatewayConnectRedirectPath = (
  gatewayId: string,
  providerIds: string[],
): string => {
  const cleanedProviderIds = Array.from(
    new Set(
      providerIds
        .map((providerId) => providerId.trim())
        .filter((providerId) => providerId.length > 0),
    ),
  );
  if (cleanedProviderIds.length === 0) {
    return `/gateways/${gatewayId}`;
  }
  const params = new URLSearchParams();
  cleanedProviderIds.forEach((providerId) => {
    params.append(INTERACTIVE_AUTH_QUERY_PARAM, providerId);
  });
  return `/gateways/${gatewayId}?${params.toString()}`;
};

export const readPendingInteractiveProviderIds = (
  searchParams: Pick<URLSearchParams, "getAll">,
): string[] =>
  Array.from(
    new Set(
      searchParams
        .getAll(INTERACTIVE_AUTH_QUERY_PARAM)
        .map((providerId) => providerId.trim())
        .filter((providerId) => providerId.length > 0),
    ),
  );
