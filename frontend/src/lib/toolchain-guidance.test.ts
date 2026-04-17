import { describe, expect, it } from "vitest";

import type { ToolchainCatalogProviderPreset } from "@/api/toolchain";

import {
  getPresetAllowedAuthModes,
  getPresetProductLine,
  getPresetScopeLabel,
  getPresetSummary,
  getToolchainAuthGuide,
} from "./toolchain-guidance";

const basePreset: ToolchainCatalogProviderPreset = {
  preset_id: "github-copilot",
  provider_id: "github-copilot",
  display_label: "GitHub Copilot",
  provider_type: "github-copilot",
  product_line: "Developer seat",
  summary: "Uses a signed-in Copilot seat on the selected node.",
  node_classes: ["cloud", "local"],
  supported_auth_modes: ["oauth", "login"],
  kind: "local-interactive",
  models: [],
};

describe("getToolchainAuthGuide", () => {
  it("marks every auth path as available on cloud nodes", () => {
    expect(
      getToolchainAuthGuide("cloud").map((item) => [item.mode, item.available]),
    ).toEqual([
      ["api-key", true],
      ["token", true],
      ["oauth", true],
      ["login", true],
    ]);
  });

  it("marks every auth path as available on local nodes", () => {
    expect(
      getToolchainAuthGuide("local").map((item) => [item.mode, item.available]),
    ).toEqual([
      ["api-key", true],
      ["token", true],
      ["oauth", true],
      ["login", true],
    ]);
  });
});

describe("toolchain preset helpers", () => {
  it("keeps preset product metadata readable", () => {
    expect(getPresetProductLine(basePreset)).toBe("Developer seat");
    expect(getPresetScopeLabel(basePreset)).toBe("Cloud + local");
    expect(getPresetSummary(basePreset)).toBe(
      "Uses a signed-in Copilot seat on the selected node.",
    );
  });

  it("keeps preset auth modes intact for every compatible node class", () => {
    expect(getPresetAllowedAuthModes(basePreset, "local")).toEqual([
      "oauth",
      "login",
    ]);
    expect(getPresetAllowedAuthModes(basePreset, "cloud")).toEqual([
      "oauth",
      "login",
    ]);
  });
});
