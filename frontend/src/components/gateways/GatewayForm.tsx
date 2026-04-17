import type { FormEvent } from "react";

import type { GatewayModelProfiles } from "@/api/generated/model";
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

type ModelProfileName = (typeof MODEL_PROFILE_OPTIONS)[number]["value"];

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
  availableModelRefs?: Array<{ ref: string; label: string }>;
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
  onModelProfilePrimaryChange?: (
    profile: ModelProfileName,
    value: string | null,
  ) => void;
};

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
  availableModelRefs = [],
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
  onModelProfilePrimaryChange,
}: GatewayFormProps) {
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
              onClick={() =>
                onDisableDevicePairingChange(!disableDevicePairing)
              }
              disabled={isLoading}
              className={`inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition ${
                disableDevicePairing
                  ? "border-emerald-600 bg-emerald-600"
                  : "border-[color:var(--border)] bg-[color:var(--surface-muted)]"
              } ${isLoading ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
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
              className={`inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition ${
                allowInsecureTls
                  ? "border-emerald-600 bg-emerald-600"
                  : "border-[color:var(--border)] bg-[color:var(--surface-muted)]"
              } ${isLoading ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
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
          <h2 className="text-sm font-semibold text-strong">Model policy</h2>
          <p className="text-xs text-muted">
            Keep one shared operator surface, but only pin profiles to models this node can actually support.
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
              {availableModelRefs.length > 0
                ? `${availableModelRefs.length} verified runtime model${availableModelRefs.length === 1 ? "" : "s"} available`
                : "Save this node and reconcile runtime to unlock verified model choices."}
            </div>
          </div>
        </div>

        {onModelProfilePrimaryChange ? (
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            {MODEL_PROFILE_OPTIONS.map((option) => (
              <div key={option.value} className="space-y-2">
                <label className="text-sm font-medium text-strong">
                  {option.label} primary model
                </label>
                <Select
                  value={
                    modelProfiles?.[option.value]?.primary_model ?? "__inherit__"
                  }
                  onValueChange={(value) =>
                    onModelProfilePrimaryChange(
                      option.value,
                      value === "__inherit__" ? null : value,
                    )
                  }
                  disabled={isLoading || availableModelRefs.length === 0}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Inherit runtime default" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__inherit__">Inherit runtime default</SelectItem>
                    {availableModelRefs.map((entry) => (
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
