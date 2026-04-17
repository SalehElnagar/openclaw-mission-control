import type {
  GatewayModelDefinition,
  GatewayProviderAuthConfig,
  GatewayProviderConfig,
  GatewayProviderSecretRef,
} from "@/api/generated/model";
import type {
  GatewayRuntimeCatalogEntry,
  GatewayRuntimeProviderSummary,
} from "@/api/runtime-control";

type GatewayRuntimeViewInput = {
  runtimeCatalog: GatewayRuntimeCatalogEntry[];
  runtimeProviders: GatewayRuntimeProviderSummary[];
  configuredProviderConfigs: GatewayProviderConfig[];
  configuredProviderAuthConfigs: GatewayProviderAuthConfig[];
  configuredModelDefinitions: GatewayModelDefinition[];
  configuredProviderSecretRefs: GatewayProviderSecretRef[];
};

export type GatewayRuntimeView = {
  managedProviderIds: string[];
  managedProviders: GatewayRuntimeProviderSummary[];
  unmanagedProviders: GatewayRuntimeProviderSummary[];
  managedLiveCatalogEntries: GatewayRuntimeCatalogEntry[];
  unmanagedLiveCatalogEntries: GatewayRuntimeCatalogEntry[];
  configuredOnlyCatalogEntries: GatewayRuntimeCatalogEntry[];
};

const modelRef = (definition: GatewayModelDefinition): string =>
  `${definition.provider_id}/${definition.model_id}`;

export const buildGatewayRuntimeView = ({
  runtimeCatalog,
  runtimeProviders,
  configuredProviderConfigs,
  configuredProviderAuthConfigs,
  configuredModelDefinitions,
  configuredProviderSecretRefs,
}: GatewayRuntimeViewInput): GatewayRuntimeView => {
  const managedProviderIds = Array.from(
    new Set([
      ...configuredProviderConfigs.map((provider) => provider.id),
      ...configuredProviderAuthConfigs.map((config) => config.provider_id),
      ...configuredModelDefinitions.map((definition) => definition.provider_id),
      ...configuredProviderSecretRefs.map((secretRef) => secretRef.provider_id),
    ]),
  ).sort();
  const managedProviderIdSet = new Set(managedProviderIds);
  const managedModelRefs = new Set(configuredModelDefinitions.map(modelRef));
  const runtimeModels = runtimeCatalog.filter(
    (entry) => (entry.kind ?? "model") === "model",
  );
  const liveCatalogEntries = runtimeModels.filter(
    (entry) => entry.selectable !== false,
  );

  return {
    managedProviderIds,
    managedProviders: runtimeProviders.filter((provider) =>
      managedProviderIdSet.has(provider.id),
    ),
    unmanagedProviders: runtimeProviders.filter(
      (provider) => !managedProviderIdSet.has(provider.id),
    ),
    managedLiveCatalogEntries: liveCatalogEntries.filter(
      (entry) =>
        managedProviderIdSet.has(entry.provider) || managedModelRefs.has(entry.ref),
    ),
    unmanagedLiveCatalogEntries: liveCatalogEntries.filter(
      (entry) =>
        !managedProviderIdSet.has(entry.provider) && !managedModelRefs.has(entry.ref),
    ),
    configuredOnlyCatalogEntries: runtimeModels.filter(
      (entry) => entry.selectable === false,
    ),
  };
};
