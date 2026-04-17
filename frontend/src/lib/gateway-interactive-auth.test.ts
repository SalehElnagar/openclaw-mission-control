import { describe, expect, it } from "vitest";

import type { GatewayProviderAuthConfig } from "@/api/generated/model";
import type { GatewayRuntimeProviderSummary } from "@/api/runtime-control";
import {
  buildGatewayConnectRedirectPath,
  findPendingInteractiveProviderIds,
  readPendingInteractiveProviderIds,
} from "./gateway-interactive-auth";

const interactiveConfig = (
  providerId: string,
  authMode: "oauth" | "login",
): GatewayProviderAuthConfig => ({
  provider_id: providerId,
  auth_mode: authMode,
  profile_id: `${providerId}:managed`,
  display_label: providerId,
  secret_refs: [],
});

const runtimeProvider = (
  providerId: string,
  overrides: Partial<GatewayRuntimeProviderSummary> = {},
): GatewayRuntimeProviderSummary => ({
  id: providerId,
  provider_type: providerId,
  label: providerId,
  auth_mode: "login",
  auth_state: "verified",
  requires_login: false,
  verification_state: "runtime",
  configured_model_count: 1,
  verified_model_count: 1,
  ...overrides,
});

describe("gateway interactive auth helpers", () => {
  it("queues new interactive providers and ignores service-auth providers", () => {
    const nextAuthConfigs: GatewayProviderAuthConfig[] = [
      interactiveConfig("google-gemini-cli", "login"),
      interactiveConfig("github-copilot", "oauth"),
      {
        provider_id: "anthropic",
        auth_mode: "api-key",
        profile_id: null,
        display_label: "anthropic",
        secret_refs: [],
      },
    ];

    expect(
      findPendingInteractiveProviderIds({
        nextAuthConfigs,
      }),
    ).toEqual(["google-gemini-cli", "github-copilot"]);
  });

  it("skips unchanged interactive providers that are already verified", () => {
    const nextAuthConfigs = [interactiveConfig("github-copilot", "oauth")];

    expect(
      findPendingInteractiveProviderIds({
        nextAuthConfigs,
        previousAuthConfigs: [interactiveConfig("github-copilot", "oauth")],
        runtimeProviders: [
          runtimeProvider("github-copilot", { auth_mode: "oauth" }),
        ],
      }),
    ).toEqual([]);
  });

  it("re-queues interactive providers that still require login", () => {
    const nextAuthConfigs = [interactiveConfig("github-copilot", "oauth")];

    expect(
      findPendingInteractiveProviderIds({
        nextAuthConfigs,
        previousAuthConfigs: [interactiveConfig("github-copilot", "oauth")],
        runtimeProviders: [
          runtimeProvider("github-copilot", {
            auth_mode: "oauth",
            auth_state: "requires-login",
            requires_login: true,
            verification_state: "configured",
            verified_model_count: 0,
          }),
        ],
      }),
    ).toEqual(["github-copilot"]);
  });

  it("round-trips pending provider ids through the gateway detail URL", () => {
    const path = buildGatewayConnectRedirectPath("gateway-123", [
      "google-gemini-cli",
      "github-copilot",
      "google-gemini-cli",
    ]);
    const params = new URL(path, "https://example.test").searchParams;

    expect(readPendingInteractiveProviderIds(params)).toEqual([
      "google-gemini-cli",
      "github-copilot",
    ]);
  });
});
