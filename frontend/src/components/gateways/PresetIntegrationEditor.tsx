"use client";

import { useMemo, useState } from "react";

import type {
  GatewayModelDefinition,
  GatewayProviderAuthConfig,
  GatewayProviderConfig,
  GatewayProviderSecretInput,
  GatewayProviderSecretRef,
} from "@/api/generated/model";
import type { GatewayRuntimeProviderSummary } from "@/api/runtime-control";
import type { ToolchainCatalogProviderPreset } from "@/api/toolchain";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import SearchableSelect from "@/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { NodeClass } from "@/lib/node-scope";
import {
  providerAuthModeDescription,
  providerAuthModeLabel,
  providerAuthStateLabel,
  type ProviderAuthMode,
} from "@/lib/provider-auth";
import {
  getPresetAllowedAuthModes,
  getPresetProductLine,
  getPresetScopeLabel,
  getPresetSummary,
  getToolchainAuthGuide,
} from "@/lib/toolchain-guidance";

type PresetIntegrationEditorProps = {
  nodeClass: NodeClass;
  toolchainCatalog: ToolchainCatalogProviderPreset[];
  providerConfigs: GatewayProviderConfig[];
  providerAuthConfigs: GatewayProviderAuthConfig[];
  modelDefinitions: GatewayModelDefinition[];
  providerSecretRefs: GatewayProviderSecretRef[];
  providerSecretInputs: GatewayProviderSecretInput[];
  runtimeProviderSummaries?: GatewayRuntimeProviderSummary[];
  enabledModelRefs?: string[];
  isLoading: boolean;
  onProviderConfigsChange?: (next: GatewayProviderConfig[]) => void;
  onProviderAuthConfigsChange?: (next: GatewayProviderAuthConfig[]) => void;
  onModelDefinitionsChange?: (next: GatewayModelDefinition[]) => void;
  onProviderSecretRefsChange?: (next: GatewayProviderSecretRef[]) => void;
  onProviderSecretInputsChange?: (next: GatewayProviderSecretInput[]) => void;
  onEnabledModelRefsChange?: (next: string[]) => void;
};

type SecretEntryMode = "existing" | "paste-once";

type PresetIntegrationDraft = {
  mode: "new" | "existing";
  preset: ToolchainCatalogProviderPreset;
  providerConfig: GatewayProviderConfig;
  authConfig: GatewayProviderAuthConfig;
  modelDefinitions: GatewayModelDefinition[];
  enabledModelRefs: string[];
  providerSecretRefs: GatewayProviderSecretRef[];
  providerSecretInputs: GatewayProviderSecretInput[];
};

type PresetIntegrationState = {
  preset: ToolchainCatalogProviderPreset;
  providerConfig: GatewayProviderConfig;
  allowedModes: ProviderAuthMode[];
  authConfig: GatewayProviderAuthConfig;
  authMode: ProviderAuthMode;
  runtime?: GatewayRuntimeProviderSummary;
  providerSecretRefs: GatewayProviderSecretRef[];
  providerSecretInputs: GatewayProviderSecretInput[];
  modelDefinitions: GatewayModelDefinition[];
  enabledModelRefs: string[];
  hasServiceSecret: boolean;
  selectedModelRefs: Set<string>;
  availableModelCount: number;
  selectedModelCount: number;
  enabledModelCount: number;
  status: {
    label: string;
    variant: "outline" | "warning" | "danger" | "success";
  };
};

const servicePurposeForMode = (
  authMode?: ProviderAuthMode | null,
): "apiKey" | "token" | null => {
  if (authMode === "api-key") {
    return "apiKey";
  }
  if (authMode === "token") {
    return "token";
  }
  return null;
};

const providerRef = (providerId: string, modelId: string) =>
  `${providerId}/${modelId}`;

const secretScopeKey = (providerId: string, purpose: string) =>
  `${providerId}::${purpose}`;

const dedupeModelRefs = (values: string[]) => Array.from(new Set(values));

const defaultModelDefinitionsForPreset = (
  preset: ToolchainCatalogProviderPreset,
): GatewayModelDefinition[] =>
  preset.models
    .map((model) => buildModelDefinition(preset, model.model_id))
    .filter((model): model is GatewayModelDefinition => Boolean(model));

const defaultEnabledModelRefsForPreset = (
  preset: ToolchainCatalogProviderPreset,
): string[] => {
  const selected = defaultModelDefinitionsForPreset(preset);
  const preferred = preset.models
    .filter((model) => model.enabled_by_default !== false)
    .map((model) => providerRef(preset.provider_id, model.model_id));
  if (preferred.length > 0) {
    return preferred;
  }
  return selected.length > 0
    ? [providerRef(selected[0].provider_id, selected[0].model_id)]
    : [];
};

const ensurePresetDefinitionsForEnabledRefs = (
  preset: ToolchainCatalogProviderPreset,
  existingDefinitions: GatewayModelDefinition[],
  enabledRefs: string[],
): GatewayModelDefinition[] => {
  const nextDefinitions = [...existingDefinitions];
  const existingRefs = new Set(
    existingDefinitions.map((definition) =>
      providerRef(definition.provider_id, definition.model_id),
    ),
  );
  for (const enabledRef of enabledRefs) {
    if (
      !enabledRef.startsWith(`${preset.provider_id}/`) ||
      existingRefs.has(enabledRef)
    ) {
      continue;
    }
    const modelId = enabledRef.slice(`${preset.provider_id}/`.length);
    const definition = buildModelDefinition(preset, modelId);
    if (!definition) {
      continue;
    }
    nextDefinitions.push(definition);
    existingRefs.add(enabledRef);
  }
  return nextDefinitions;
};

function buildProviderConfig(
  preset: ToolchainCatalogProviderPreset,
): GatewayProviderConfig {
  return {
    id: preset.provider_id,
    preset_id: preset.preset_id,
    managed_by_catalog: true,
    provider_type: preset.provider_type,
    label: preset.display_label,
    base_url: preset.default_base_url ?? null,
    api_mode: preset.default_api_mode ?? null,
    auth_header: preset.default_auth_header ?? null,
    headers: preset.default_headers ?? null,
  };
}

function buildProviderAuthConfig(
  preset: ToolchainCatalogProviderPreset,
  authMode: ProviderAuthMode,
  existing?: GatewayProviderAuthConfig | null,
): GatewayProviderAuthConfig {
  return {
    provider_id: preset.provider_id,
    preset_id: preset.preset_id,
    managed_by_catalog: true,
    auth_mode: authMode,
    profile_id:
      authMode === "oauth" || authMode === "login"
        ? (existing?.profile_id ?? `${preset.provider_id}:managed`)
        : null,
    display_label: existing?.display_label ?? preset.display_label,
    secret_refs: existing?.secret_refs ?? [],
    token_header_name:
      authMode === "token"
        ? (existing?.token_header_name ??
          preset.default_token_header_name ??
          "Authorization")
        : null,
    token_header_prefix:
      authMode === "token"
        ? (existing?.token_header_prefix ??
          preset.default_token_header_prefix ??
          "Bearer")
        : null,
  };
}

function buildModelDefinition(
  preset: ToolchainCatalogProviderPreset,
  modelId: string,
): GatewayModelDefinition | null {
  const modelPreset = preset.models.find((item) => item.model_id === modelId);
  if (!modelPreset) {
    return null;
  }
  return {
    provider_id: preset.provider_id,
    model_id: modelPreset.model_id,
    preset_id: preset.preset_id,
    managed_by_catalog: true,
    label: modelPreset.label,
    api_mode: modelPreset.api_mode ?? preset.default_api_mode ?? null,
    reasoning: modelPreset.reasoning ?? null,
    input_modalities: modelPreset.input_modalities ?? [],
    context_window: modelPreset.context_window ?? null,
    max_tokens: modelPreset.max_tokens ?? null,
    cost: modelPreset.cost ?? null,
  };
}

function integrationStatus(
  runtime: GatewayRuntimeProviderSummary | undefined,
  authMode: ProviderAuthMode | undefined,
  hasServiceSecret: boolean,
  hasSelectedModels: boolean,
): { label: string; variant: "outline" | "warning" | "danger" | "success" } {
  if (runtime?.unresolved_secret_refs?.length) {
    return { label: "Error", variant: "danger" };
  }
  if (authMode === "oauth" || authMode === "login") {
    if (!runtime) {
      return { label: "Sign-in required", variant: "warning" };
    }
    if (runtime?.requires_login || runtime?.auth_state === "requires-login") {
      return { label: "Sign-in required", variant: "warning" };
    }
  } else if (
    (authMode === "api-key" || authMode === "token") &&
    !hasServiceSecret
  ) {
    return { label: "Needs secret", variant: "warning" };
  }
  if (
    runtime?.auth_state === "verified" ||
    runtime?.verification_state === "runtime"
  ) {
    return { label: "Verified", variant: "success" };
  }
  if (hasSelectedModels || authMode) {
    return { label: "Verifying", variant: "outline" };
  }
  return { label: "Not configured", variant: "outline" };
}

export function PresetIntegrationEditor({
  nodeClass,
  toolchainCatalog,
  providerConfigs,
  providerAuthConfigs,
  modelDefinitions,
  providerSecretRefs,
  providerSecretInputs,
  runtimeProviderSummaries = [],
  enabledModelRefs = [],
  isLoading,
  onProviderConfigsChange,
  onProviderAuthConfigsChange,
  onModelDefinitionsChange,
  onProviderSecretRefsChange,
  onProviderSecretInputsChange,
  onEnabledModelRefsChange,
}: PresetIntegrationEditorProps) {
  const [pendingPresetId, setPendingPresetId] = useState<string>("");
  const [editorDraft, setEditorDraft] = useState<PresetIntegrationDraft | null>(
    null,
  );
  const [secretModes, setSecretModes] = useState<
    Record<string, SecretEntryMode>
  >({});

  const compatiblePresets = useMemo(
    () =>
      toolchainCatalog.filter((preset) =>
        preset.node_classes.includes(nodeClass),
      ),
    [nodeClass, toolchainCatalog],
  );
  const presetByProviderId = useMemo(
    () =>
      new Map(compatiblePresets.map((preset) => [preset.provider_id, preset])),
    [compatiblePresets],
  );
  const runtimeByProviderId = useMemo(
    () =>
      new Map(
        runtimeProviderSummaries.map((provider) => [provider.id, provider]),
      ),
    [runtimeProviderSummaries],
  );
  const providerConfigById = useMemo(
    () => new Map(providerConfigs.map((provider) => [provider.id, provider])),
    [providerConfigs],
  );
  const providerAuthById = useMemo(
    () =>
      new Map(
        providerAuthConfigs.map((config) => [config.provider_id, config]),
      ),
    [providerAuthConfigs],
  );
  const activeProviderIds = useMemo(() => {
    const ids = new Set<string>();
    for (const provider of compatiblePresets) {
      if (
        providerConfigs.some((item) => item.id === provider.provider_id) ||
        providerAuthConfigs.some(
          (item) => item.provider_id === provider.provider_id,
        ) ||
        modelDefinitions.some(
          (item) => item.provider_id === provider.provider_id,
        ) ||
        providerSecretRefs.some(
          (item) => item.provider_id === provider.provider_id,
        ) ||
        providerSecretInputs.some(
          (item) => item.provider_id === provider.provider_id,
        )
      ) {
        ids.add(provider.provider_id);
      }
    }
    return compatiblePresets
      .filter((provider) => ids.has(provider.provider_id))
      .map((provider) => provider.provider_id);
  }, [
    compatiblePresets,
    modelDefinitions,
    providerAuthConfigs,
    providerConfigs,
    providerSecretInputs,
    providerSecretRefs,
  ]);
  const availablePresetOptions = useMemo(
    () =>
      compatiblePresets
        .filter((preset) => !activeProviderIds.includes(preset.provider_id))
        .map((preset) => ({
          value: preset.provider_id,
          label: preset.display_label,
        })),
    [activeProviderIds, compatiblePresets],
  );
  const resolvedPendingPresetId = useMemo(() => {
    if (!availablePresetOptions.length) {
      return "";
    }
    return availablePresetOptions.some(
      (option) => option.value === pendingPresetId,
    )
      ? pendingPresetId
      : (availablePresetOptions[0]?.value ?? "");
  }, [availablePresetOptions, pendingPresetId]);
  const authGuide = useMemo(
    () => getToolchainAuthGuide(nodeClass),
    [nodeClass],
  );
  const pendingPreset = useMemo(
    () =>
      compatiblePresets.find(
        (preset) => preset.provider_id === resolvedPendingPresetId,
      ) ?? null,
    [compatiblePresets, resolvedPendingPresetId],
  );
  const buildPresetIntegrationState = (
    preset: ToolchainCatalogProviderPreset,
    {
      providerConfig,
      authConfig,
      providerModelDefinitions,
      providerEnabledModelRefs,
      providerScopedSecretRefs,
      providerScopedSecretInputs,
    }: {
      providerConfig: GatewayProviderConfig;
      authConfig: GatewayProviderAuthConfig;
      providerModelDefinitions: GatewayModelDefinition[];
      providerEnabledModelRefs: string[];
      providerScopedSecretRefs: GatewayProviderSecretRef[];
      providerScopedSecretInputs: GatewayProviderSecretInput[];
    },
  ): PresetIntegrationState => {
    const allowedModes = getPresetAllowedAuthModes(preset, nodeClass);
    const authMode =
      allowedModes.find((mode) => mode === authConfig.auth_mode) ??
      allowedModes[0] ??
      authConfig.auth_mode;
    const runtime = runtimeByProviderId.get(preset.provider_id);
    const secretRefByScope = new Map(
      providerScopedSecretRefs.map((secretRef) => [
        secretScopeKey(secretRef.provider_id, secretRef.purpose),
        secretRef,
      ]),
    );
    const secretInputByScope = new Map(
      providerScopedSecretInputs.map((secretInput) => [
        secretScopeKey(secretInput.provider_id, secretInput.purpose),
        secretInput,
      ]),
    );
    const selectedModelRefs = new Set(
      providerModelDefinitions.map((definition) =>
        providerRef(definition.provider_id, definition.model_id),
      ),
    );
    const servicePurpose = servicePurposeForMode(authMode);
    const hasServiceSecret = servicePurpose
      ? Boolean(
          secretRefByScope.get(
            secretScopeKey(preset.provider_id, servicePurpose),
          ) ||
          secretInputByScope.get(
            secretScopeKey(preset.provider_id, servicePurpose),
          )?.value,
        )
      : true;
    const scopedEnabledModelRefs = dedupeModelRefs(
      providerEnabledModelRefs.filter((ref) =>
        ref.startsWith(`${preset.provider_id}/`),
      ),
    );
    const selectedModelCount = preset.models.filter((model) =>
      selectedModelRefs.has(providerRef(preset.provider_id, model.model_id)),
    ).length;
    const enabledModelCount = preset.models.filter((model) =>
      scopedEnabledModelRefs.includes(
        providerRef(preset.provider_id, model.model_id),
      ),
    ).length;
    return {
      preset,
      providerConfig,
      allowedModes,
      authConfig: {
        ...authConfig,
        auth_mode: authMode,
      },
      authMode,
      runtime,
      providerSecretRefs: providerScopedSecretRefs,
      providerSecretInputs: providerScopedSecretInputs,
      modelDefinitions: providerModelDefinitions,
      enabledModelRefs: scopedEnabledModelRefs,
      hasServiceSecret,
      selectedModelRefs,
      availableModelCount: preset.models.length,
      selectedModelCount,
      enabledModelCount,
      status: integrationStatus(
        runtime,
        authMode,
        hasServiceSecret,
        selectedModelCount > 0,
      ),
    };
  };

  const buildDraftForPreset = (
    preset: ToolchainCatalogProviderPreset,
    mode: "new" | "existing",
  ): PresetIntegrationDraft => {
    const providerId = preset.provider_id;
    const allowedModes = getPresetAllowedAuthModes(preset, nodeClass);
    const existingAuthConfig = providerAuthById.get(providerId) ?? null;
    const nextAuthMode =
      allowedModes.find(
        (modeValue) => modeValue === existingAuthConfig?.auth_mode,
      ) ??
      allowedModes[0] ??
      "api-key";
    const providerScopedDefinitions = modelDefinitions.filter(
      (definition) => definition.provider_id === providerId,
    );
    const providerScopedEnabledModelRefs = enabledModelRefs.filter((ref) =>
      ref.startsWith(`${providerId}/`),
    );
    return {
      mode,
      preset,
      providerConfig:
        providerConfigById.get(providerId) ?? buildProviderConfig(preset),
      authConfig: buildProviderAuthConfig(
        preset,
        nextAuthMode,
        existingAuthConfig,
      ),
      modelDefinitions:
        mode === "new"
          ? defaultModelDefinitionsForPreset(preset)
          : ensurePresetDefinitionsForEnabledRefs(
              preset,
              providerScopedDefinitions,
              providerScopedEnabledModelRefs,
            ),
      enabledModelRefs:
        mode === "new"
          ? defaultEnabledModelRefsForPreset(preset)
          : dedupeModelRefs(providerScopedEnabledModelRefs),
      providerSecretRefs: providerSecretRefs.filter(
        (secretRef) => secretRef.provider_id === providerId,
      ),
      providerSecretInputs: providerSecretInputs.filter(
        (secretInput) => secretInput.provider_id === providerId,
      ),
    };
  };

  const openPresetIntegrationDraft = (
    presetId: string,
    modeOverride?: "new" | "existing",
  ) => {
    const preset = presetByProviderId.get(presetId);
    if (!preset) {
      return;
    }
    setEditorDraft(
      buildDraftForPreset(
        preset,
        modeOverride ??
          (activeProviderIds.includes(preset.provider_id) ? "existing" : "new"),
      ),
    );
  };

  const getPresetIntegrationState = (
    providerId: string,
  ): PresetIntegrationState | null => {
    const preset = presetByProviderId.get(providerId);
    if (!preset) {
      return null;
    }
    return buildPresetIntegrationState(preset, {
      providerConfig:
        providerConfigById.get(providerId) ?? buildProviderConfig(preset),
      authConfig:
        providerAuthById.get(providerId) ??
        buildProviderAuthConfig(
          preset,
          getPresetAllowedAuthModes(preset, nodeClass)[0] ?? "api-key",
        ),
      providerModelDefinitions: modelDefinitions.filter(
        (definition) => definition.provider_id === providerId,
      ),
      providerEnabledModelRefs: enabledModelRefs.filter((ref) =>
        ref.startsWith(`${providerId}/`),
      ),
      providerScopedSecretRefs: providerSecretRefs.filter(
        (secretRef) => secretRef.provider_id === providerId,
      ),
      providerScopedSecretInputs: providerSecretInputs.filter(
        (secretInput) => secretInput.provider_id === providerId,
      ),
    });
  };

  const editorIntegration = editorDraft
    ? buildPresetIntegrationState(editorDraft.preset, {
        providerConfig: editorDraft.providerConfig,
        authConfig: editorDraft.authConfig,
        providerModelDefinitions: editorDraft.modelDefinitions,
        providerEnabledModelRefs: editorDraft.enabledModelRefs,
        providerScopedSecretRefs: editorDraft.providerSecretRefs,
        providerScopedSecretInputs: editorDraft.providerSecretInputs,
      })
    : null;

  const replaceDraftProviderSecretInput = (
    purpose: string,
    nextSecretInput: GatewayProviderSecretInput | null,
  ) => {
    setEditorDraft((current) => {
      if (!current) {
        return current;
      }
      const filtered = current.providerSecretInputs.filter(
        (item) => item.purpose !== purpose,
      );
      return {
        ...current,
        providerSecretInputs: nextSecretInput
          ? [...filtered, nextSecretInput]
          : filtered,
      };
    });
  };

  const removePresetIntegration = (providerId: string) => {
    setEditorDraft((current) =>
      current?.preset.provider_id === providerId ? null : current,
    );
    onProviderConfigsChange?.(
      providerConfigs.filter((provider) => provider.id !== providerId),
    );
    onProviderAuthConfigsChange?.(
      providerAuthConfigs.filter((config) => config.provider_id !== providerId),
    );
    onModelDefinitionsChange?.(
      modelDefinitions.filter(
        (definition) => definition.provider_id !== providerId,
      ),
    );
    onProviderSecretRefsChange?.(
      providerSecretRefs.filter(
        (secretRef) => secretRef.provider_id !== providerId,
      ),
    );
    onProviderSecretInputsChange?.(
      providerSecretInputs.filter(
        (secretInput) => secretInput.provider_id !== providerId,
      ),
    );
    onEnabledModelRefsChange?.(
      enabledModelRefs.filter((ref) => !ref.startsWith(`${providerId}/`)),
    );
  };

  const updateDraftProviderAuthMode = (nextAuthMode: ProviderAuthMode) => {
    setEditorDraft((current) => {
      if (!current) {
        return current;
      }
      const nextPurpose = servicePurposeForMode(nextAuthMode);
      const previousPurpose = servicePurposeForMode(
        current.authConfig.auth_mode,
      );
      let nextSecretRefs = current.providerSecretRefs;
      let nextSecretInputs = current.providerSecretInputs;

      if (previousPurpose && nextPurpose && previousPurpose !== nextPurpose) {
        const existingRef =
          current.providerSecretRefs.find(
            (item) => item.purpose === previousPurpose,
          ) ?? null;
        const existingInput =
          current.providerSecretInputs.find(
            (item) => item.purpose === previousPurpose,
          ) ?? null;
        nextSecretRefs = current.providerSecretRefs.filter(
          (item) =>
            item.purpose !== previousPurpose && item.purpose !== nextPurpose,
        );
        nextSecretInputs = current.providerSecretInputs.filter(
          (item) =>
            item.purpose !== previousPurpose && item.purpose !== nextPurpose,
        );
        if (existingRef) {
          nextSecretRefs = [
            ...nextSecretRefs,
            { ...existingRef, purpose: nextPurpose },
          ];
        }
        if (existingInput) {
          nextSecretInputs = [
            ...nextSecretInputs,
            { ...existingInput, purpose: nextPurpose },
          ];
        }
      } else if (!nextPurpose) {
        nextSecretRefs = current.providerSecretRefs.filter(
          (item) => item.purpose !== "apiKey" && item.purpose !== "token",
        );
        nextSecretInputs = current.providerSecretInputs.filter(
          (item) => item.purpose !== "apiKey" && item.purpose !== "token",
        );
      }

      return {
        ...current,
        authConfig: buildProviderAuthConfig(
          current.preset,
          nextAuthMode,
          current.authConfig,
        ),
        providerSecretRefs: nextSecretRefs,
        providerSecretInputs: nextSecretInputs,
      };
    });
  };

  const toggleDraftPresetModel = (modelId: string, checked: boolean) => {
    setEditorDraft((current) => {
      if (!current) {
        return current;
      }
      const definition = buildModelDefinition(current.preset, modelId);
      if (!definition) {
        return current;
      }
      const modelRefValue = providerRef(current.preset.provider_id, modelId);
      const filteredDefinitions = current.modelDefinitions.filter(
        (item) =>
          !(
            item.provider_id === current.preset.provider_id &&
            item.model_id === modelId
          ),
      );
      return {
        ...current,
        modelDefinitions: checked
          ? [...filteredDefinitions, definition]
          : filteredDefinitions,
        enabledModelRefs: checked
          ? current.enabledModelRefs
          : current.enabledModelRefs.filter((ref) => ref !== modelRefValue),
      };
    });
  };

  const toggleDraftEnabledModel = (modelId: string, checked: boolean) => {
    setEditorDraft((current) => {
      if (!current) {
        return current;
      }
      const modelRefValue = providerRef(current.preset.provider_id, modelId);
      const selectedModels = new Set(
        current.modelDefinitions.map((definition) =>
          providerRef(definition.provider_id, definition.model_id),
        ),
      );
      const ensuredDefinitions =
        checked && !selectedModels.has(modelRefValue)
          ? (() => {
              const definition = buildModelDefinition(current.preset, modelId);
              return definition
                ? [...current.modelDefinitions, definition]
                : current.modelDefinitions;
            })()
          : current.modelDefinitions;
      return {
        ...current,
        modelDefinitions: ensuredDefinitions,
        enabledModelRefs: checked
          ? dedupeModelRefs([...current.enabledModelRefs, modelRefValue])
          : current.enabledModelRefs.filter((ref) => ref !== modelRefValue),
      };
    });
  };

  const saveEditorDraft = () => {
    if (!editorDraft) {
      return;
    }
    const providerId = editorDraft.preset.provider_id;
    onProviderConfigsChange?.([
      ...providerConfigs.filter((provider) => provider.id !== providerId),
      editorDraft.providerConfig,
    ]);
    onProviderAuthConfigsChange?.([
      ...providerAuthConfigs.filter(
        (config) => config.provider_id !== providerId,
      ),
      editorDraft.authConfig,
    ]);
    onModelDefinitionsChange?.([
      ...modelDefinitions.filter(
        (definition) => definition.provider_id !== providerId,
      ),
      ...editorDraft.modelDefinitions,
    ]);
    onProviderSecretRefsChange?.([
      ...providerSecretRefs.filter(
        (secretRef) => secretRef.provider_id !== providerId,
      ),
      ...editorDraft.providerSecretRefs,
    ]);
    onProviderSecretInputsChange?.([
      ...providerSecretInputs.filter(
        (secretInput) => secretInput.provider_id !== providerId,
      ),
      ...editorDraft.providerSecretInputs,
    ]);
    onEnabledModelRefsChange?.(
      dedupeModelRefs([
        ...enabledModelRefs.filter((ref) => !ref.startsWith(`${providerId}/`)),
        ...editorDraft.enabledModelRefs,
      ]),
    );
    setEditorDraft(null);
  };

  const renderSecretEditor = (integration: PresetIntegrationState) => {
    const { preset, authMode, providerSecretRefs, providerSecretInputs } =
      integration;
    const purpose = servicePurposeForMode(authMode);
    if (!purpose) {
      return (
        <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] px-4 py-3 text-sm text-muted">
          Interactive sign-in runs on the{" "}
          {nodeClass === "cloud" ? "remote cloud" : "selected"} node session.
          Save this integration into the node form first. When you save the
          node, Mission Control will open the node detail page and start the
          provider sign-in handoff there.
        </div>
      );
    }

    const scope = secretScopeKey(preset.provider_id, purpose);
    const existingSecret =
      providerSecretRefs.find(
        (secretRef) =>
          secretScopeKey(secretRef.provider_id, secretRef.purpose) === scope,
      ) ?? null;
    const pendingSecret =
      providerSecretInputs.find(
        (secretInput) =>
          secretScopeKey(secretInput.provider_id, secretInput.purpose) ===
          scope,
      ) ?? null;
    const selectedMode =
      secretModes[scope] ?? (existingSecret ? "existing" : "paste-once");

    return (
      <div className="space-y-3 rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-strong">Service secret</p>
            <p className="mt-1 text-xs text-muted">
              {authMode === "api-key"
                ? "Attach the provider API key once, or keep using the stored alias for this node."
                : "Attach the provider token once, or keep using the stored alias for this node."}
            </p>
          </div>
          <Select
            value={selectedMode}
            onValueChange={(value) => {
              const nextMode = value as SecretEntryMode;
              setSecretModes((current) => ({
                ...current,
                [scope]: nextMode,
              }));
              if (nextMode === "existing") {
                replaceDraftProviderSecretInput(purpose, null);
              }
            }}
            disabled={
              isLoading || (selectedMode === "existing" && !existingSecret)
            }
          >
            <SelectTrigger className="w-full max-w-[16rem]">
              <SelectValue placeholder="Choose secret flow" />
            </SelectTrigger>
            <SelectContent>
              {existingSecret ? (
                <SelectItem value="existing">
                  Use existing secret alias
                </SelectItem>
              ) : null}
              <SelectItem value="paste-once">Paste once</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {selectedMode === "existing" && existingSecret ? (
          <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface-muted)] px-4 py-3 text-sm text-muted">
            <p className="font-medium text-strong">
              {existingSecret.alias?.trim() || existingSecret.ref}
            </p>
            <p className="mt-1 text-xs text-muted">
              {existingSecret.storage_backend ?? "managed store"}
              {existingSecret.updated_at
                ? ` · updated ${new Date(existingSecret.updated_at).toLocaleString()}`
                : ""}
            </p>
            <p className="mt-2 text-xs text-muted">
              Mission Control will keep using this stored secret and will not
              show the value again.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 md:col-span-2">
              <label className="text-xs font-medium uppercase tracking-wide text-quiet">
                Paste once
              </label>
              <Input
                type="password"
                value={pendingSecret?.value ?? ""}
                onChange={(event) =>
                  replaceDraftProviderSecretInput(purpose, {
                    provider_id: preset.provider_id,
                    purpose,
                    mode: "paste-once",
                    value: event.target.value,
                    alias: pendingSecret?.alias ?? null,
                    preset_id: preset.preset_id,
                  })
                }
                placeholder={
                  authMode === "api-key"
                    ? "Paste the API key once"
                    : "Paste the token once"
                }
                disabled={isLoading}
              />
              <p className="text-[11px] leading-5 text-muted">
                The pasted value is write-only. Mission Control stores it in the
                configured secret backend and will only show alias metadata
                after save.
              </p>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium uppercase tracking-wide text-quiet">
                Secret alias
              </label>
              <Input
                value={pendingSecret?.alias ?? ""}
                onChange={(event) => {
                  const nextValue = pendingSecret?.value ?? "";
                  if (!nextValue.trim() && !event.target.value.trim()) {
                    replaceDraftProviderSecretInput(purpose, null);
                    return;
                  }
                  replaceDraftProviderSecretInput(purpose, {
                    provider_id: preset.provider_id,
                    purpose,
                    mode: "paste-once",
                    value: nextValue,
                    alias: event.target.value || null,
                    preset_id: preset.preset_id,
                  });
                }}
                placeholder={`${preset.provider_id}-${purpose}`}
                disabled={isLoading}
              />
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderIntegrationConfiguration = (
    integration: PresetIntegrationState,
  ) => {
    const {
      preset,
      providerConfig,
      allowedModes,
      authMode,
      runtime,
      selectedModelRefs,
      enabledModelRefs: integrationEnabledModelRefs,
      availableModelCount,
      selectedModelCount,
      enabledModelCount,
    } = integration;
    return (
      <>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-quiet">
              Provider
            </label>
            <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] px-4 py-3">
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">{getPresetProductLine(preset)}</Badge>
                <Badge variant="outline">{getPresetScopeLabel(preset)}</Badge>
              </div>
              <p className="mt-3 text-sm font-medium text-strong">
                {preset.display_label}
              </p>
              <p className="mt-2 text-xs leading-5 text-muted">
                {getPresetSummary(preset)}
              </p>
              {providerConfig.base_url ? (
                <p className="mt-3 text-[11px] font-mono text-quiet">
                  {providerConfig.base_url}
                </p>
              ) : null}
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-quiet">
              Authentication
            </label>
            <div className="grid gap-3">
              {allowedModes.map((mode) => {
                const isSelected = mode === authMode;
                return (
                  <button
                    key={`${preset.provider_id}-${mode}`}
                    type="button"
                    disabled={isLoading || isSelected}
                    onClick={() => updateDraftProviderAuthMode(mode)}
                    className={`rounded-xl border px-4 py-3 text-left transition ${
                      isSelected
                        ? "border-[color:var(--accent)] bg-[color:var(--accent-soft)]/35"
                        : "border-[color:var(--border)] bg-[color:var(--surface)] hover:border-[color:var(--border-strong)]"
                    } disabled:cursor-default disabled:opacity-100`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-medium text-strong">
                        {providerAuthModeLabel(mode)}
                      </p>
                      <Badge variant={isSelected ? "accent" : "outline"}>
                        {isSelected ? "Selected" : "Available"}
                      </Badge>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-muted">
                      {providerAuthModeDescription(mode, nodeClass)}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="mt-4">{renderSecretEditor(integration)}</div>

        <div className="mt-4 rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] p-4">
          <div className="space-y-1">
            <p className="text-sm font-medium text-strong">Models</p>
            <p className="text-xs text-muted">
              Choose the models this node should manage for{" "}
              {preset.display_label}, then decide which of the selected models
              are available to agents and product leads.
            </p>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Badge variant="outline">{availableModelCount} available</Badge>
            <Badge variant="outline">{selectedModelCount} selected</Badge>
            <Badge variant="outline">{enabledModelCount} enabled</Badge>
          </div>
          <div className="mt-4 space-y-3">
            {preset.models.map((model) => {
              const ref = providerRef(preset.provider_id, model.model_id);
              const selected = selectedModelRefs.has(ref);
              const enabled = integrationEnabledModelRefs.includes(ref);
              return (
                <div
                  key={ref}
                  className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface-muted)] px-4 py-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 rounded border-[color:var(--border)] text-[color:var(--accent)] focus:ring-[color:var(--accent)]"
                        checked={selected}
                        disabled={isLoading}
                        onChange={(event) =>
                          toggleDraftPresetModel(
                            model.model_id,
                            event.target.checked,
                          )
                        }
                      />
                      <div className="min-w-0">
                        <p className="font-medium text-strong">{model.label}</p>
                        <p className="mt-1 truncate font-mono text-[11px] text-quiet">
                          {ref}
                        </p>
                        {model.enabled_by_default === false ? (
                          <p className="mt-2 text-[11px] text-muted">
                            Available on demand. Mission Control keeps it out of
                            the initial managed set until you opt in.
                          </p>
                        ) : null}
                      </div>
                    </label>
                    <label className="flex items-center gap-2 text-xs font-medium text-muted">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-[color:var(--border)] text-[color:var(--accent)] focus:ring-[color:var(--accent)]"
                        checked={enabled}
                        disabled={isLoading}
                        onChange={(event) =>
                          toggleDraftEnabledModel(
                            model.model_id,
                            event.target.checked,
                          )
                        }
                      />
                      Enable for agents
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {runtime ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {runtime.auth_mode ? (
              <Badge variant="outline">
                {providerAuthModeLabel(runtime.auth_mode)}
              </Badge>
            ) : null}
            <Badge
              variant={
                providerAuthStateLabel(
                  runtime.auth_state,
                  runtime.requires_login,
                ) === "Verified"
                  ? "success"
                  : providerAuthStateLabel(
                        runtime.auth_state,
                        runtime.requires_login,
                      ) === "Login required"
                    ? "warning"
                    : "outline"
              }
            >
              {providerAuthStateLabel(
                runtime.auth_state,
                runtime.requires_login,
              )}
            </Badge>
            <Badge variant="outline">
              {runtime.verified_model_count ?? 0} verified
            </Badge>
          </div>
        ) : null}
      </>
    );
  };

  if (!compatiblePresets.length) {
    return (
      <div className="rounded-xl border border-dashed border-[color:var(--border)] bg-[color:var(--surface)] px-4 py-5 text-sm text-muted">
        No guided provider presets are available for this node class yet. Use
        the Advanced runtime surface for raw provider setup.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[18rem] flex-1 space-y-2">
            <label className="text-sm font-medium text-strong">
              Add integration
            </label>
            <SearchableSelect
              value={resolvedPendingPresetId}
              onValueChange={setPendingPresetId}
              options={availablePresetOptions}
              placeholder="Choose a provider"
              ariaLabel="Choose a provider preset"
              disabled={isLoading || availablePresetOptions.length === 0}
              searchPlaceholder="Search providers..."
              emptyMessage="All compatible presets are already configured."
            />
          </div>
          <Button
            type="button"
            disabled={
              isLoading ||
              !resolvedPendingPresetId ||
              !presetByProviderId.has(resolvedPendingPresetId)
            }
            onClick={() =>
              openPresetIntegrationDraft(resolvedPendingPresetId, "new")
            }
          >
            Add and configure
          </Button>
        </div>
        {pendingPreset ? (
          <div className="mt-4 rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] p-4">
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">
                {getPresetProductLine(pendingPreset)}
              </Badge>
              <Badge variant="outline">
                {getPresetScopeLabel(pendingPreset)}
              </Badge>
              {getPresetAllowedAuthModes(pendingPreset, nodeClass).map(
                (mode) => (
                  <Badge
                    key={`${pendingPreset.provider_id}-${mode}`}
                    variant="outline"
                  >
                    {providerAuthModeLabel(mode)}
                  </Badge>
                ),
              )}
            </div>
            <p className="mt-3 text-sm text-strong">
              {getPresetSummary(pendingPreset)}
            </p>
            <p className="mt-2 text-xs text-muted">
              {pendingPreset.models.length} model
              {pendingPreset.models.length === 1 ? "" : "s"} ready:{" "}
              {pendingPreset.models
                .slice(0, 2)
                .map((model) => model.label)
                .join(", ")}
              {pendingPreset.models.length > 2 ? ", and more." : "."}
            </p>
          </div>
        ) : null}
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {authGuide.map((item) => (
            <div
              key={item.mode}
              className={`rounded-xl border px-4 py-3 ${
                item.available
                  ? "border-[color:var(--border)] bg-[color:var(--surface)]"
                  : "border-[color:var(--border)] bg-[color:var(--surface)] opacity-70"
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-strong">{item.label}</p>
                <Badge variant={item.available ? "accent" : "outline"}>
                  {item.available ? "This node" : "Unavailable"}
                </Badge>
              </div>
              <p className="mt-2 text-xs leading-5 text-muted">
                {item.description}
              </p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted">
          Choose a supported provider preset first. Mission Control fills in the
          provider id, endpoint, and model catalog automatically, then keeps the
          guided flow focused on the auth path that actually fits this node. Raw
          runtime-only providers stay under Advanced runtime.
        </p>
      </div>

      {activeProviderIds.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[color:var(--border)] bg-[color:var(--surface)] px-4 py-5 text-sm text-muted">
          No preset integrations configured yet. Add one above to get a guided
          provider, auth, and model flow instead of typing raw node runtime
          metadata.
        </div>
      ) : null}

      {activeProviderIds.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {activeProviderIds.map((providerId) => {
            const integration = getPresetIntegrationState(providerId);
            if (!integration) {
              return null;
            }
            const {
              preset,
              providerConfig,
              authMode,
              runtime,
              hasServiceSecret,
              selectedModelCount,
              enabledModelCount,
              status,
            } = integration;
            const interactiveAuth =
              authMode === "oauth" || authMode === "login";
            return (
              <div
                key={providerId}
                className="rounded-xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-sm font-semibold text-strong">
                        {preset.display_label}
                      </h2>
                      <Badge variant={status.variant}>{status.label}</Badge>
                      <Badge variant="outline">
                        {providerAuthModeLabel(authMode)}
                      </Badge>
                    </div>
                    <p className="text-xs leading-5 text-muted">
                      {getPresetSummary(preset)}
                    </p>
                    {providerConfig.base_url ? (
                      <p className="text-[11px] font-mono text-quiet">
                        {providerConfig.base_url}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isLoading}
                      onClick={() =>
                        openPresetIntegrationDraft(providerId, "existing")
                      }
                    >
                      Configure
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isLoading}
                      onClick={() => removePresetIntegration(providerId)}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Badge variant="outline">
                    {getPresetProductLine(preset)}
                  </Badge>
                  <Badge variant="outline">{getPresetScopeLabel(preset)}</Badge>
                  <Badge variant="outline">{selectedModelCount} selected</Badge>
                  <Badge variant="outline">{enabledModelCount} enabled</Badge>
                  {runtime ? (
                    <Badge variant="outline">
                      {runtime.verified_model_count ?? 0} verified
                    </Badge>
                  ) : null}
                </div>
                <p className="mt-3 text-xs text-muted">
                  {interactiveAuth
                    ? runtime?.auth_state === "verified" &&
                      runtime?.requires_login !== true
                      ? "Interactive sign-in is already verified for this node."
                      : nodeClass === "cloud"
                        ? "Sign-in required after node save. Mission Control will take you to the node detail page and start the remote cloud session flow there."
                        : "Sign-in required after node save. Mission Control will take you to the node detail page and start the local node session flow there."
                    : hasServiceSecret
                      ? "Service-auth details are staged in this form and will be stored when you save the node."
                      : "Open Configure to attach the service secret before you save this node."}
                </p>
              </div>
            );
          })}
        </div>
      ) : null}

      <Dialog
        open={Boolean(editorIntegration)}
        onOpenChange={(open) => {
          if (!open) {
            setEditorDraft(null);
          }
        }}
      >
        {editorIntegration ? (
          <DialogContent className="max-w-4xl">
            <DialogHeader>
              <DialogTitle>
                Configure {editorIntegration.preset.display_label}
              </DialogTitle>
              <DialogDescription>
                Changes stay staged in this node form until you save the node.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-4">
              {renderIntegrationConfiguration(editorIntegration)}
            </div>
            <DialogFooter className="mt-6">
              <p className="mr-auto text-xs text-muted">
                {editorIntegration.authMode === "oauth" ||
                editorIntegration.authMode === "login"
                  ? "Save this integration first. When you save the node, Mission Control will open the node detail page and start the sign-in handoff there."
                  : "Save this integration first, then save the node to persist the provider auth and model changes."}
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditorDraft(null)}
              >
                Cancel
              </Button>
              <Button type="button" onClick={saveEditorDraft}>
                {editorDraft?.mode === "new"
                  ? "Add integration"
                  : "Save changes"}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
