import { describe, expect, it } from "vitest";

import type { GatewayRuntimeSummary } from "@/api/runtime-control";

import {
  getConfiguredRuntimeModelLabels,
  getDefaultRuntimeModelLabel,
  getProviderChoicesSummary,
  getRuntimeModelOptions,
} from "./agent-model-catalog";

const makeRuntime = (
  overrides: Partial<GatewayRuntimeSummary> = {},
): GatewayRuntimeSummary => ({
  gateway_id: "gateway-1",
  runtime_sync_generation: 1,
  default_model_profile: "general",
  default_model_ref: "microsoft-foundry/model-router",
  model_profiles: {
    general: {
      primary_model: "microsoft-foundry/model-router",
      fallback_models: [],
    },
    coder: {
      primary_model: "openai-codex/gpt-5.4",
      fallback_models: [],
    },
    budget: null,
  },
  catalog: [
    {
      ref: "microsoft-foundry/model-router",
      provider: "microsoft-foundry",
      provider_label: "Azure Foundry",
      label: "Azure Foundry Model Router",
      verification_state: "runtime",
      selectable: true,
      is_default: true,
    },
    {
      ref: "openai-codex/gpt-5.4",
      provider: "openai-codex",
      provider_label: "Codex",
      label: "Codex GPT-5.4",
      verification_state: "runtime",
      selectable: true,
      is_default: false,
    },
    {
      ref: "anthropic/claude-sonnet-4-6",
      provider: "anthropic",
      provider_label: "Claude",
      label: "Claude Sonnet 4.6",
      verification_state: "configured",
      selectable: false,
      is_default: false,
    },
  ],
  available_models: [
    "microsoft-foundry/model-router",
    "openai-codex/gpt-5.4",
  ],
  ...overrides,
});

describe("agent-model-catalog helpers", () => {
  it("returns only selectable runtime models for the dropdown", () => {
    const runtime = makeRuntime();

    expect(getRuntimeModelOptions(runtime)).toEqual([
      {
        value: "microsoft-foundry/model-router",
        label: "Azure Foundry · Azure Foundry Model Router · default · runtime",
      },
      {
        value: "openai-codex/gpt-5.4",
        label: "Codex · Codex GPT-5.4 · runtime",
      },
    ]);
  });

  it("resolves the inherited label from the selected model profile", () => {
    const runtime = makeRuntime();

    expect(getDefaultRuntimeModelLabel(runtime, "general")).toBe(
      "Azure Foundry Model Router",
    );
    expect(getDefaultRuntimeModelLabel(runtime, "coder")).toBe("Codex GPT-5.4");
  });

  it("falls back to known provider labels when the API omits provider_label", () => {
    const runtime = makeRuntime({
      catalog: [
        {
          ref: "microsoft-foundry/model-router",
          provider: "microsoft-foundry",
          provider_label: "",
          label: "Azure Foundry Model Router",
          verification_state: "runtime",
          selectable: true,
          is_default: true,
        },
      ],
      available_models: ["microsoft-foundry/model-router"],
    });

    expect(getProviderChoicesSummary(runtime)).toBe("Azure Foundry");
  });

  it("returns configured-but-not-live models for explanatory UI", () => {
    const runtime = makeRuntime({
      catalog: [
        {
          ref: "anthropic/claude-sonnet-4-6",
          provider: "anthropic",
          provider_label: "",
          label: "Claude Sonnet 4.6",
          verification_state: "configured",
          selectable: false,
          is_default: false,
        },
        {
          ref: "google-antigravity/claude-opus-4-6-thinking",
          provider: "google-antigravity",
          provider_label: "",
          label: "Antigravity Claude Opus 4.6 Thinking",
          verification_state: "configured",
          selectable: false,
          is_default: false,
        },
      ],
      available_models: [],
    });

    expect(getConfiguredRuntimeModelLabels(runtime)).toEqual([
      "Claude · Claude Sonnet 4.6 · configured",
      "Antigravity · Antigravity Claude Opus 4.6 Thinking · configured",
    ]);
  });
});
