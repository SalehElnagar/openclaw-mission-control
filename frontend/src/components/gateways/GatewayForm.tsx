import type { FormEvent } from "react";

import type {
  GatewayModelDefinition,
  GatewayModelProfiles,
  GatewayProviderConfig,
  GatewayProviderSecretRef,
  GatewayRuntimeProviderSummary,
  GatewayToolProfilePolicy,
} from "@/api/generated/model";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { GatewayCheckStatus } from "@/lib/gateway-form";
import type { NodeClass } from "@/lib/node-scope";

const MODEL_PROFILE_OPTIONS = [
  { value: "general", label: "General" },
  { value: "coder", label: "Coder" },
  { value: "budget", label: "Budget" },
] as const;

const TOOL_PROFILE_OPTIONS = [
  { value: "restricted", label: "Restricted" },
  { value: "coding", label: "Coding" },
  { value: "research", label: "Research" },
  { value: "browser-assisted", label: "Browser-assisted" },
] as const;

type ModelProfileName = (typeof MODEL_PROFILE_OPTIONS)[number]["value"];
type ToolProfileName = (typeof TOOL_PROFILE_OPTIONS)[number]["value"];

type GatewayFormProps = {
  name: string;
  nodeClass: NodeClass;
  gatewayUrl: string;
  gatewayToken: string;
  disableDevicePairing: boolean;
  workspaceRoot: string;
  allowInsecureTls: boolean;
  defaultModelProfile: ModelProfileName;
  modelProfiles?: GatewayModelProfiles;
  verifiedModelRefs?: Array<{ ref: string; label: string }>;
  enabledModelRefs?: string[];
  providerConfigs?: GatewayProviderConfig[];
  modelDefinitions?: GatewayModelDefinition[];
  providerSecretRefs?: GatewayProviderSecretRef[];
  toolProfile: ToolProfileName;
  effectiveToolPolicy?: GatewayToolProfilePolicy | null;
  runtimeProviderSummaries?: GatewayRuntimeProviderSummary[];
  driftDetected?: boolean;
  gatewayUrlError: string | null;
  gatewayCheckStatus: GatewayCheckStatus;
  gatewayCheckMessage: string | null;
  errorMessage: string | null;
  isLoading: boolean;
  canSubmit: boolean;
  workspaceRootPlaceholder: string;
  cancelLabel: string;
  submitLabel: string;
  submitBusyLabel: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
  onNameChange: (next: string) => void;
  onNodeClassChange: (next: NodeClass) => void;
  onGatewayUrlChange: (next: string) => void;
  onGatewayTokenChange: (next: string) => void;
  onDisableDevicePairingChange: (next: boolean) => void;
  onWorkspaceRootChange: (next: string) => void;
  onAllowInsecureTlsChange: (next: boolean) => void;
  onDefaultModelProfileChange: (next: ModelProfileName) => void;
  onEnabledModelRefsChange?: (next: string[]) => void;
  onModelProfilePrimaryChange?: (
    profile: ModelProfileName,
    value: string | null,
  ) => void;
  onProviderConfigsChange?: (next: GatewayProviderConfig[]) => void;
  onModelDefinitionsChange?: (next: GatewayModelDefinition[]) => void;
  onProviderSecretRefsChange?: (next: GatewayProviderSecretRef[]) => void;
  onToolProfileChange?: (next: ToolProfileName) => void;
};

function toNumberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function boolSwitchClass(enabled: boolean, disabled: boolean) {
  return `inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition ${
    enabled
      ? "border-emerald-600 bg-emerald-600"
      : "border-[color:var(--border)] bg-[color:var(--surface-muted)]"
  } ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`;
}

export function GatewayForm({
  name,
  nodeClass,
  gatewayUrl,
  gatewayToken,
  disableDevicePairing,
  workspaceRoot,
  allowInsecureTls,
  defaultModelProfile,
  modelProfiles,
  verifiedModelRefs = [],
  enabledModelRefs = [],
  providerConfigs = [],
  modelDefinitions = [],
  providerSecretRefs = [],
  toolProfile,
  effectiveToolPolicy,
  runtimeProviderSummaries = [],
  driftDetected = false,
  gatewayUrlError,
  gatewayCheckStatus,
  gatewayCheckMessage,
  errorMessage,
  isLoading,
  canSubmit,
  workspaceRootPlaceholder,
  cancelLabel,
  submitLabel,
  submitBusyLabel,
  onSubmit,
  onCancel,
  onNameChange,
  onNodeClassChange,
  onGatewayUrlChange,
  onGatewayTokenChange,
  onDisableDevicePairingChange,
  onWorkspaceRootChange,
  onAllowInsecureTlsChange,
  onDefaultModelProfileChange,
  onEnabledModelRefsChange,
  onModelProfilePrimaryChange,
  onProviderConfigsChange,
  onModelDefinitionsChange,
  onProviderSecretRefsChange,
  onToolProfileChange,
}: GatewayFormProps) {
  const verifiedModelMap = new Map(verifiedModelRefs.map((entry) => [entry.ref, entry]));
  const effectiveEnabledModelRefs =
    enabledModelRefs.length > 0
      ? enabledModelRefs.filter((ref) => verifiedModelMap.has(ref))
      : verifiedModelRefs.map((entry) => entry.ref);
  const enabledModelEntries = effectiveEnabledModelRefs
    .map((ref) => verifiedModelMap.get(ref))
    .filter((entry): entry is { ref: string; label: string } => Boolean(entry));
  const providerOptions = providerConfigs
    .map((provider) => ({
      value: provider.id,
      label: provider.label?.trim() || provider.id,
    }))
    .filter((provider) => provider.value.trim().length > 0);
  const previewToolPolicy = effectiveToolPolicy ?? {
    profile: toolProfile,
    browser_enabled: toolProfile === "browser-assisted",
    workspace_only_fs: true,
    summary:
      toolProfile === "browser-assisted"
        ? "Coding posture plus browser access for browser-assisted workflows."
        : toolProfile === "restricted"
          ? "Tight execution posture with workspace-only filesystem access."
          : toolProfile === "research"
            ? "Research-oriented posture with workspace-only filesystem access."
            : "Balanced coding posture with workspace-only filesystem access.",
  };

  const updateProviderConfig = (
    index: number,
    patch: Partial<GatewayProviderConfig>,
  ) => {
    if (!onProviderConfigsChange) {
      return;
    }
    onProviderConfigsChange(
      providerConfigs.map((provider, providerIndex) =>
        providerIndex === index ? { ...provider, ...patch } : provider,
      ),
    );
  };

  const updateModelDefinition = (
    index: number,
    patch: Partial<GatewayModelDefinition>,
  ) => {
    if (!onModelDefinitionsChange) {
      return;
    }
    onModelDefinitionsChange(
      modelDefinitions.map((definition, definitionIndex) =>
        definitionIndex === index ? { ...definition, ...patch } : definition,
      ),
    );
  };

  const updateProviderSecretRef = (
    index: number,
    patch: Partial<GatewayProviderSecretRef>,
  ) => {
    if (!onProviderSecretRefsChange) {
      return;
    }
    onProviderSecretRefsChange(
      providerSecretRefs.map((secretRef, secretRefIndex) =>
        secretRefIndex === index ? { ...secretRef, ...patch } : secretRef,
      ),
    );
  };

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-6 rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-sm"
    >
      <div className="space-y-2">
        <label className="text-sm font-medium text-strong">
          Node name <span className="text-[color:var(--danger)]">*</span>
        </label>
        <Input
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder="Primary cloud node"
          disabled={isLoading}
        />
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <label className="text-sm font-medium text-strong">
            Node class <span className="text-[color:var(--danger)]">*</span>
          </label>
          <Select
            value={nodeClass}
            onValueChange={(value) => onNodeClassChange(value as NodeClass)}
            disabled={isLoading}
          >
            <SelectTrigger>
              <SelectValue placeholder="Choose a node class" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="cloud">Cloud</SelectItem>
              <SelectItem value="local">Local</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-strong">
            Gateway URL <span className="text-[color:var(--danger)]">*</span>
          </label>
          <Input
            value={gatewayUrl}
            onChange={(event) => onGatewayUrlChange(event.target.value)}
            placeholder="ws://gateway:18789"
            disabled={isLoading}
            className={
              gatewayUrlError
                ? "border-[color:var(--danger)] focus-visible:ring-[color:var(--danger)]"
                : undefined
            }
          />
          {gatewayUrlError ? (
            <p className="text-xs text-[color:var(--danger)]">{gatewayUrlError}</p>
          ) : gatewayCheckStatus === "error" && gatewayCheckMessage ? (
            <p className="text-xs text-[color:var(--danger)]">{gatewayCheckMessage}</p>
          ) : null}
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <label className="text-sm font-medium text-strong">Gateway token</label>
          <Input
            value={gatewayToken}
            onChange={(event) => onGatewayTokenChange(event.target.value)}
            placeholder="Bearer token"
            disabled={isLoading}
          />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-strong">
            Workspace root <span className="text-[color:var(--danger)]">*</span>
          </label>
          <Input
            value={workspaceRoot}
            onChange={(event) => onWorkspaceRootChange(event.target.value)}
            placeholder={workspaceRootPlaceholder}
            disabled={isLoading}
          />
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <label className="text-sm font-medium text-strong">
            Disable device pairing
          </label>
          <label className="flex h-10 items-center gap-3 px-1 text-sm text-strong">
            <button
              type="button"
              role="switch"
              aria-checked={disableDevicePairing}
              aria-label="Disable device pairing"
              onClick={() => onDisableDevicePairingChange(!disableDevicePairing)}
              disabled={isLoading}
              className={boolSwitchClass(disableDevicePairing, isLoading)}
            >
              <span
                className={`inline-block h-5 w-5 rounded-full bg-white shadow-sm transition ${
                  disableDevicePairing ? "translate-x-5" : "translate-x-0.5"
                }`}
              />
            </button>
          </label>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-strong">
            Allow self-signed TLS certificates
          </label>
          <label className="flex h-10 items-center gap-3 px-1 text-sm text-strong">
            <button
              type="button"
              role="switch"
              aria-checked={allowInsecureTls}
              aria-label="Allow self-signed TLS certificates"
              onClick={() => onAllowInsecureTlsChange(!allowInsecureTls)}
              disabled={isLoading}
              className={boolSwitchClass(allowInsecureTls, isLoading)}
            >
              <span
                className={`inline-block h-5 w-5 rounded-full bg-white shadow-sm transition ${
                  allowInsecureTls ? "translate-x-5" : "translate-x-0.5"
                }`}
              />
            </button>
          </label>
        </div>
      </div>

      <div className="rounded-xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-strong">Providers</h2>
          <p className="text-xs text-muted">
            Define the node-owned provider connections here. Secret refs stay as references only and are never stored as plaintext in Mission Control.
          </p>
        </div>
        <div className="mt-4 space-y-3">
          {providerConfigs.length > 0 ? (
            providerConfigs.map((provider, index) => (
              <div
                key={`${provider.id || "provider"}-${index}`}
                className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-strong">
                      {provider.label?.trim() || provider.id || `Provider ${index + 1}`}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      Connection and provider metadata only. Secrets are attached in the secret-ref section below.
                    </p>
                  </div>
                  {onProviderConfigsChange ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isLoading}
                      onClick={() =>
                        onProviderConfigsChange(
                          providerConfigs.filter((_, providerIndex) => providerIndex !== index),
                        )
                      }
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-xs font-medium uppercase tracking-wide text-quiet">
                      Provider id
                    </label>
                    <Input
                      value={provider.id}
                      onChange={(event) =>
                        updateProviderConfig(index, { id: event.target.value })
                      }
                      placeholder="microsoft-foundry"
                      disabled={isLoading}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium uppercase tracking-wide text-quiet">
                      Provider type
                    </label>
                    <Input
                      value={provider.provider_type ?? ""}
                      onChange={(event) =>
                        updateProviderConfig(index, { provider_type: event.target.value || null })
                      }
                      placeholder="microsoft-foundry"
                      disabled={isLoading}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium uppercase tracking-wide text-quiet">
                      Display label
                    </label>
                    <Input
                      value={provider.label ?? ""}
                      onChange={(event) =>
                        updateProviderConfig(index, { label: event.target.value || null })
                      }
                      placeholder="Azure Foundry"
                      disabled={isLoading}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium uppercase tracking-wide text-quiet">
                      Base URL
                    </label>
                    <Input
                      value={provider.base_url ?? ""}
                      onChange={(event) =>
                        updateProviderConfig(index, { base_url: event.target.value || null })
                      }
                      placeholder="https://example.openai.azure.com/openai/v1"
                      disabled={isLoading}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium uppercase tracking-wide text-quiet">
                      API mode
                    </label>
                    <Input
                      value={provider.api_mode ?? ""}
                      onChange={(event) =>
                        updateProviderConfig(index, { api_mode: event.target.value || null })
                      }
                      placeholder="openai-completions"
                      disabled={isLoading}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium uppercase tracking-wide text-quiet">
                      Use auth header
                    </label>
                    <label className="flex h-10 items-center gap-3 px-1 text-sm text-strong">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={provider.auth_header ?? false}
                        aria-label={`Use auth header for ${provider.id || `provider ${index + 1}`}`}
                        onClick={() =>
                          updateProviderConfig(index, {
                            auth_header: !(provider.auth_header ?? false),
                          })
                        }
                        disabled={isLoading}
                        className={boolSwitchClass(provider.auth_header ?? false, isLoading)}
                      >
                        <span
                          className={`inline-block h-5 w-5 rounded-full bg-white shadow-sm transition ${
                            provider.auth_header ? "translate-x-5" : "translate-x-0.5"
                          }`}
                        />
                      </button>
                    </label>
                  </div>
                </div>
              </div>
            ))
          ) : (
            <p className="rounded-lg border border-dashed border-[color:var(--border)] bg-[color:var(--surface)] px-4 py-3 text-sm text-muted">
              No managed providers saved yet. Existing nodes can be seeded from their live runtime config when you save this form.
            </p>
          )}
          {onProviderConfigsChange ? (
            <Button
              type="button"
              variant="outline"
              disabled={isLoading}
              onClick={() =>
                onProviderConfigsChange([
                  ...providerConfigs,
                  {
                    id: "",
                    provider_type: null,
                    label: null,
                    base_url: null,
                    api_mode: null,
                    auth_header: false,
                  },
                ])
              }
            >
              Add provider
            </Button>
          ) : null}
        </div>
      </div>

      <div className="rounded-xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-strong">Models</h2>
          <p className="text-xs text-muted">
            Define the provider-owned models this node should manage. Only verified live models become selectable for agents and product leads.
          </p>
        </div>
        <div className="mt-4 space-y-3">
          {modelDefinitions.length > 0 ? (
            modelDefinitions.map((definition, index) => (
              <div
                key={`${definition.provider_id || "provider"}-${definition.model_id || index}`}
                className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-strong">
                      {definition.label?.trim() ||
                        definition.model_id ||
                        `Model ${index + 1}`}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      Provider-owned runtime metadata. Costs and limits are optional but helpful for operator visibility.
                    </p>
                  </div>
                  {onModelDefinitionsChange ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isLoading}
                      onClick={() =>
                        onModelDefinitionsChange(
                          modelDefinitions.filter((_, modelIndex) => modelIndex !== index),
                        )
                      }
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-xs font-medium uppercase tracking-wide text-quiet">
                      Provider id
                    </label>
                    <Input
                      value={definition.provider_id}
                      onChange={(event) =>
                        updateModelDefinition(index, { provider_id: event.target.value })
                      }
                      placeholder={providerOptions[0]?.value ?? "microsoft-foundry"}
                      disabled={isLoading}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium uppercase tracking-wide text-quiet">
                      Model id
                    </label>
                    <Input
                      value={definition.model_id}
                      onChange={(event) =>
                        updateModelDefinition(index, { model_id: event.target.value })
                      }
                      placeholder="gpt-5.4-mini"
                      disabled={isLoading}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium uppercase tracking-wide text-quiet">
                      Display label
                    </label>
                    <Input
                      value={definition.label ?? ""}
                      onChange={(event) =>
                        updateModelDefinition(index, { label: event.target.value || null })
                      }
                      placeholder="GPT-5.4 Mini (Azure Foundry)"
                      disabled={isLoading}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium uppercase tracking-wide text-quiet">
                      API mode
                    </label>
                    <Input
                      value={definition.api_mode ?? ""}
                      onChange={(event) =>
                        updateModelDefinition(index, { api_mode: event.target.value || null })
                      }
                      placeholder="openai-completions"
                      disabled={isLoading}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium uppercase tracking-wide text-quiet">
                      Input modalities
                    </label>
                    <Input
                      value={(definition.input_modalities ?? []).join(", ")}
                      onChange={(event) =>
                        updateModelDefinition(index, {
                          input_modalities: event.target.value
                            .split(",")
                            .map((value) => value.trim())
                            .filter(Boolean),
                        })
                      }
                      placeholder="text, image"
                      disabled={isLoading}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium uppercase tracking-wide text-quiet">
                      Reasoning enabled
                    </label>
                    <label className="flex h-10 items-center gap-3 px-1 text-sm text-strong">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={definition.reasoning ?? false}
                        aria-label={`Reasoning enabled for ${definition.model_id || `model ${index + 1}`}`}
                        onClick={() =>
                          updateModelDefinition(index, {
                            reasoning: !(definition.reasoning ?? false),
                          })
                        }
                        disabled={isLoading}
                        className={boolSwitchClass(definition.reasoning ?? false, isLoading)}
                      >
                        <span
                          className={`inline-block h-5 w-5 rounded-full bg-white shadow-sm transition ${
                            definition.reasoning ? "translate-x-5" : "translate-x-0.5"
                          }`}
                        />
                      </button>
                    </label>
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium uppercase tracking-wide text-quiet">
                      Context window
                    </label>
                    <Input
                      value={definition.context_window ?? ""}
                      onChange={(event) =>
                        updateModelDefinition(index, {
                          context_window: toNumberOrNull(event.target.value),
                        })
                      }
                      placeholder="128000"
                      disabled={isLoading}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium uppercase tracking-wide text-quiet">
                      Max tokens
                    </label>
                    <Input
                      value={definition.max_tokens ?? ""}
                      onChange={(event) =>
                        updateModelDefinition(index, {
                          max_tokens: toNumberOrNull(event.target.value),
                        })
                      }
                      placeholder="16384"
                      disabled={isLoading}
                    />
                  </div>
                </div>
                <div className="mt-4 grid gap-4 md:grid-cols-4">
                  <div className="space-y-2">
                    <label className="text-xs font-medium uppercase tracking-wide text-quiet">
                      Cost input
                    </label>
                    <Input
                      value={definition.cost?.input ?? ""}
                      onChange={(event) =>
                        updateModelDefinition(index, {
                          cost: {
                            ...(definition.cost ?? {}),
                            input: toNumberOrNull(event.target.value),
                          },
                        })
                      }
                      placeholder="0.75"
                      disabled={isLoading}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium uppercase tracking-wide text-quiet">
                      Cost output
                    </label>
                    <Input
                      value={definition.cost?.output ?? ""}
                      onChange={(event) =>
                        updateModelDefinition(index, {
                          cost: {
                            ...(definition.cost ?? {}),
                            output: toNumberOrNull(event.target.value),
                          },
                        })
                      }
                      placeholder="4.50"
                      disabled={isLoading}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium uppercase tracking-wide text-quiet">
                      Cache read
                    </label>
                    <Input
                      value={definition.cost?.cache_read ?? ""}
                      onChange={(event) =>
                        updateModelDefinition(index, {
                          cost: {
                            ...(definition.cost ?? {}),
                            cache_read: toNumberOrNull(event.target.value),
                          },
                        })
                      }
                      placeholder="0.075"
                      disabled={isLoading}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium uppercase tracking-wide text-quiet">
                      Cache write
                    </label>
                    <Input
                      value={definition.cost?.cache_write ?? ""}
                      onChange={(event) =>
                        updateModelDefinition(index, {
                          cost: {
                            ...(definition.cost ?? {}),
                            cache_write: toNumberOrNull(event.target.value),
                          },
                        })
                      }
                      placeholder="0.75"
                      disabled={isLoading}
                    />
                  </div>
                </div>
              </div>
            ))
          ) : (
            <p className="rounded-lg border border-dashed border-[color:var(--border)] bg-[color:var(--surface)] px-4 py-3 text-sm text-muted">
              No managed models saved yet. Runtime-verified models remain visible below and can still be enabled for agents after verification.
            </p>
          )}
          {onModelDefinitionsChange ? (
            <Button
              type="button"
              variant="outline"
              disabled={isLoading}
              onClick={() =>
                onModelDefinitionsChange([
                  ...modelDefinitions,
                  {
                    provider_id: providerOptions[0]?.value ?? "",
                    model_id: "",
                    label: null,
                    api_mode: null,
                    reasoning: false,
                    input_modalities: ["text"],
                    context_window: null,
                    max_tokens: null,
                    cost: null,
                  },
                ])
              }
            >
              Add model
            </Button>
          ) : null}
        </div>
      </div>

      <div className="rounded-xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-strong">Secret refs</h2>
          <p className="text-xs text-muted">
            Store only secret references here. Use refs like <code>env:OPENCLAW_FOUNDRY_API_KEY</code> or <code>keyvault:foundry-key</code>, never plaintext secrets.
          </p>
        </div>
        <div className="mt-4 space-y-3">
          {providerSecretRefs.length > 0 ? (
            providerSecretRefs.map((secretRef, index) => (
              <div
                key={`${secretRef.provider_id || "provider"}-${secretRef.purpose || index}`}
                className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-strong">
                      {secretRef.provider_id || `Provider ref ${index + 1}`}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      Purposes typically look like <code>apiKey</code> or <code>header:api-key</code>.
                    </p>
                  </div>
                  {onProviderSecretRefsChange ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isLoading}
                      onClick={() =>
                        onProviderSecretRefsChange(
                          providerSecretRefs.filter((_, refIndex) => refIndex !== index),
                        )
                      }
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
                <div className="mt-4 grid gap-4 md:grid-cols-3">
                  <div className="space-y-2">
                    <label className="text-xs font-medium uppercase tracking-wide text-quiet">
                      Provider id
                    </label>
                    <Input
                      value={secretRef.provider_id}
                      onChange={(event) =>
                        updateProviderSecretRef(index, { provider_id: event.target.value })
                      }
                      placeholder={providerOptions[0]?.value ?? "microsoft-foundry"}
                      disabled={isLoading}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium uppercase tracking-wide text-quiet">
                      Purpose
                    </label>
                    <Input
                      value={secretRef.purpose}
                      onChange={(event) =>
                        updateProviderSecretRef(index, { purpose: event.target.value })
                      }
                      placeholder="apiKey"
                      disabled={isLoading}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium uppercase tracking-wide text-quiet">
                      Secret ref
                    </label>
                    <Input
                      value={secretRef.ref}
                      onChange={(event) =>
                        updateProviderSecretRef(index, { ref: event.target.value })
                      }
                      placeholder="env:OPENCLAW_FOUNDRY_API_KEY"
                      disabled={isLoading}
                    />
                  </div>
                </div>
              </div>
            ))
          ) : (
            <p className="rounded-lg border border-dashed border-[color:var(--border)] bg-[color:var(--surface)] px-4 py-3 text-sm text-muted">
              No managed secret refs saved yet. Existing live secrets remain preserved until you explicitly replace them with ref-backed provider auth.
            </p>
          )}
          {onProviderSecretRefsChange ? (
            <Button
              type="button"
              variant="outline"
              disabled={isLoading}
              onClick={() =>
                onProviderSecretRefsChange([
                  ...providerSecretRefs,
                  {
                    provider_id: providerOptions[0]?.value ?? "",
                    purpose: "apiKey",
                    ref: "",
                  },
                ])
              }
            >
              Add secret ref
            </Button>
          ) : null}
        </div>
      </div>

      <div className="rounded-xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-strong">Model policy</h2>
          <p className="text-xs text-muted">
            Keep one shared operator surface, but only pin profiles to models this node can actually verify at runtime.
          </p>
        </div>

        <div className="mt-4 grid gap-6 md:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium text-strong">
              Default profile
            </label>
            <Select
              value={defaultModelProfile}
              onValueChange={(value) =>
                onDefaultModelProfileChange(value as ModelProfileName)
              }
              disabled={isLoading}
            >
              <SelectTrigger>
                <SelectValue placeholder="Choose a default profile" />
              </SelectTrigger>
              <SelectContent>
                {MODEL_PROFILE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-strong">
              Verified node models
            </label>
            <div className="rounded-lg border border-dashed border-[color:var(--border)] bg-[color:var(--surface)] px-3 py-2 text-sm text-muted">
              {verifiedModelRefs.length > 0
                ? `${verifiedModelRefs.length} verified runtime model${verifiedModelRefs.length === 1 ? "" : "s"} available`
                : "Save this node and reconcile runtime to unlock verified model choices."}
            </div>
          </div>
        </div>

        <div className="mt-4 space-y-3 rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium text-strong">
                Enabled for agents
              </label>
              <p className="text-xs text-muted">
                Choose which verified node models agents and product leads can actually select on this node.
              </p>
            </div>
            {verifiedModelRefs.length > 0 && onEnabledModelRefsChange ? (
              <button
                type="button"
                onClick={() =>
                  onEnabledModelRefsChange(verifiedModelRefs.map((entry) => entry.ref))
                }
                className="text-xs font-medium text-[color:var(--accent)] hover:text-[color:var(--accent-strong)]"
                disabled={isLoading}
              >
                Use all verified models
              </button>
            ) : null}
          </div>
          {verifiedModelRefs.length === 0 ? (
            <p className="rounded-md border border-[color:var(--border)] bg-[color:var(--surface-muted)] px-3 py-2 text-xs text-muted">
              Runtime verification has to succeed before Mission Control can scope node-enabled models.
            </p>
          ) : (
            <div className="grid gap-2 md:grid-cols-2">
              {verifiedModelRefs.map((entry) => {
                const checked = effectiveEnabledModelRefs.includes(entry.ref);
                return (
                  <label
                    key={entry.ref}
                    className="flex cursor-pointer items-start gap-3 rounded-lg border border-[color:var(--border)] bg-[color:var(--surface-muted)] px-3 py-3 text-sm text-strong"
                  >
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded border-[color:var(--border)] text-[color:var(--accent)] focus:ring-[color:var(--accent)]"
                      checked={checked}
                      disabled={isLoading}
                      onChange={(event) => {
                        if (!onEnabledModelRefsChange) {
                          return;
                        }
                        const nextRefs = event.target.checked
                          ? [...effectiveEnabledModelRefs, entry.ref]
                          : effectiveEnabledModelRefs.filter((ref) => ref !== entry.ref);
                        onEnabledModelRefsChange(Array.from(new Set(nextRefs)));
                      }}
                    />
                    <div className="min-w-0">
                      <p className="font-medium text-strong">{entry.label}</p>
                      <p className="mt-1 truncate font-mono text-[11px] text-quiet">
                        {entry.ref}
                      </p>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
          {verifiedModelRefs.length > 0 ? (
            <p className="text-xs text-muted">
              {enabledModelEntries.length} of {verifiedModelRefs.length} verified model
              {verifiedModelRefs.length === 1 ? "" : "s"} enabled for agent selection.
            </p>
          ) : null}
        </div>

        {onModelProfilePrimaryChange ? (
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            {MODEL_PROFILE_OPTIONS.map((option) => (
              <div key={option.value} className="space-y-2">
                <label className="text-sm font-medium text-strong">
                  {option.label} primary model
                </label>
                <Select
                  value={modelProfiles?.[option.value]?.primary_model ?? "__inherit__"}
                  onValueChange={(value) =>
                    onModelProfilePrimaryChange(
                      option.value,
                      value === "__inherit__" ? null : value,
                    )
                  }
                  disabled={isLoading || enabledModelEntries.length === 0}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Inherit runtime default" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__inherit__">Inherit runtime default</SelectItem>
                    {enabledModelEntries.map((entry) => (
                      <SelectItem key={`${option.value}-${entry.ref}`} value={entry.ref}>
                        {entry.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="rounded-xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-strong">Tools</h2>
          <p className="text-xs text-muted">
            Low-level node tooling stays on named safety profiles. Mission Control expands the effective policy for review but does not expose raw tool internals here.
          </p>
        </div>
        <div className="mt-4 grid gap-6 md:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium text-strong">
              Tool profile
            </label>
            <Select
              value={toolProfile}
              onValueChange={(value) => onToolProfileChange?.(value as ToolProfileName)}
              disabled={isLoading || !onToolProfileChange}
            >
              <SelectTrigger>
                <SelectValue placeholder="Choose a tool profile" />
              </SelectTrigger>
              <SelectContent>
                {TOOL_PROFILE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2 rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] p-4">
            <p className="text-xs uppercase tracking-wide text-quiet">
              Effective policy
            </p>
            <p className="mt-2 text-sm font-medium text-strong">
              {TOOL_PROFILE_OPTIONS.find((option) => option.value === previewToolPolicy.profile)
                ?.label ?? previewToolPolicy.profile}
            </p>
            <p className="mt-2 text-xs leading-5 text-muted">
              {previewToolPolicy.summary ?? "Managed tool profile ready to apply."}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <span className="rounded-full border border-[color:var(--border)] bg-[color:var(--surface-muted)] px-3 py-1 text-xs font-medium text-strong">
                Browser {previewToolPolicy.browser_enabled ? "enabled" : "disabled"}
              </span>
              <span className="rounded-full border border-[color:var(--border)] bg-[color:var(--surface-muted)] px-3 py-1 text-xs font-medium text-strong">
                FS {previewToolPolicy.workspace_only_fs ? "workspace-only" : "broader access"}
              </span>
              {driftDetected ? (
                <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-200">
                  Runtime drift detected
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-strong">Runtime</h2>
          <p className="text-xs text-muted">
            Saving this form applies the managed toolchain fragment immediately and runs reconcile. Installed marketplace skills stay node-scoped and are still managed on the node detail page.
          </p>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {runtimeProviderSummaries.length > 0 ? (
            runtimeProviderSummaries.map((provider) => (
              <div
                key={provider.id}
                className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] p-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium text-strong">{provider.label}</p>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      provider.verification_state === "runtime"
                        ? "border border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                        : "border border-[color:var(--border)] bg-[color:var(--surface-muted)] text-muted"
                    }`}
                  >
                    {provider.verification_state === "runtime" ? "Verified" : "Configured"}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted">
                  {provider.provider_type} · {provider.verified_model_count ?? 0} verified /{" "}
                  {provider.configured_model_count ?? 0} configured models
                </p>
                {provider.unresolved_secret_refs?.length ? (
                  <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                    Unresolved secret refs: {provider.unresolved_secret_refs.join(", ")}
                  </div>
                ) : provider.secret_ref_count ? (
                  <p className="mt-3 text-xs text-muted">
                    {provider.secret_ref_count} secret ref
                    {provider.secret_ref_count === 1 ? "" : "s"} configured.
                  </p>
                ) : null}
              </div>
            ))
          ) : (
            <p className="rounded-lg border border-dashed border-[color:var(--border)] bg-[color:var(--surface)] px-4 py-3 text-sm text-muted md:col-span-2">
              Save and reconcile this node to observe verified providers, configured models, and runtime drift.
            </p>
          )}
        </div>
      </div>

      {errorMessage ? (
        <p className="text-sm text-[color:var(--danger)]">{errorMessage}</p>
      ) : null}

      <div className="flex justify-end gap-3">
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={isLoading}
        >
          {cancelLabel}
        </Button>
        <Button type="submit" disabled={isLoading || !canSubmit}>
          {isLoading ? submitBusyLabel : submitLabel}
        </Button>
      </div>
    </form>
  );
}
