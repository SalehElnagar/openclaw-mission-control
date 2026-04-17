import { describe, expect, it } from "vitest";

import { buildGatewayRuntimeView } from "./gateway-runtime-view";

describe("buildGatewayRuntimeView", () => {
  it("separates managed runtime inventory from unmanaged discovery", () => {
    const view = buildGatewayRuntimeView({
      runtimeCatalog: [
        {
          ref: "anthropic/claude-sonnet-4-6",
          provider: "anthropic",
          provider_label: "Claude",
          label: "Claude Sonnet 4.6",
          verification_state: "runtime",
          selectable: true,
        },
        {
          ref: "github-models/openai/gpt-4.1",
          provider: "github-models",
          provider_label: "GitHub Models",
          label: "GitHub Models OpenAI GPT-4.1",
          verification_state: "runtime",
          selectable: true,
        },
        {
          ref: "github-models/openai/gpt-4o",
          provider: "github-models",
          provider_label: "GitHub Models",
          label: "GitHub Models OpenAI GPT-4o",
          verification_state: "configured",
          selectable: false,
        },
      ],
      runtimeProviders: [
        {
          id: "anthropic",
          provider_type: "anthropic",
          label: "Claude",
          verification_state: "runtime",
          configured_model_count: 1,
          verified_model_count: 1,
          secret_ref_count: 1,
          unresolved_secret_refs: [],
        },
        {
          id: "github-models",
          provider_type: "github-models",
          label: "GitHub Models",
          verification_state: "runtime",
          configured_model_count: 1,
          verified_model_count: 1,
          secret_ref_count: 1,
          unresolved_secret_refs: [],
        },
      ],
      configuredProviderConfigs: [
        {
          id: "github-models",
          provider_type: "github-models",
          label: "GitHub Models",
        },
      ],
      configuredProviderAuthConfigs: [
        {
          provider_id: "github-models",
          auth_mode: "token",
          secret_refs: [],
        },
      ],
      configuredModelDefinitions: [
        {
          provider_id: "github-models",
          model_id: "openai/gpt-4.1",
        },
      ],
      configuredProviderSecretRefs: [
        {
          provider_id: "github-models",
          purpose: "token",
          ref: "managed:github-models-token",
        },
      ],
    });

    expect(view.managedProviderIds).toEqual(["github-models"]);
    expect(view.managedProviders.map((provider) => provider.id)).toEqual([
      "github-models",
    ]);
    expect(view.unmanagedProviders.map((provider) => provider.id)).toEqual([
      "anthropic",
    ]);
    expect(view.managedLiveCatalogEntries.map((entry) => entry.ref)).toEqual([
      "github-models/openai/gpt-4.1",
    ]);
    expect(view.unmanagedLiveCatalogEntries.map((entry) => entry.ref)).toEqual([
      "anthropic/claude-sonnet-4-6",
    ]);
    expect(view.configuredOnlyCatalogEntries.map((entry) => entry.ref)).toEqual([
      "github-models/openai/gpt-4o",
    ]);
  });
});
