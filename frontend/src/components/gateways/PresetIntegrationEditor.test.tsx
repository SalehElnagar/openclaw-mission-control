import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type {
  GatewayModelDefinition,
  GatewayProviderAuthConfig,
  GatewayProviderConfig,
  GatewayProviderSecretInput,
  GatewayProviderSecretRef,
} from "@/api/generated/model";
import type { ToolchainCatalogProviderPreset } from "@/api/toolchain";
import { PresetIntegrationEditor } from "./PresetIntegrationEditor";

function Harness({
  nodeClass = "cloud",
  catalog,
}: {
  nodeClass?: "cloud" | "local";
  catalog: ToolchainCatalogProviderPreset[];
}) {
  const [providerConfigs, setProviderConfigs] = useState<
    GatewayProviderConfig[]
  >([]);
  const [providerAuthConfigs, setProviderAuthConfigs] = useState<
    GatewayProviderAuthConfig[]
  >([]);
  const [modelDefinitions, setModelDefinitions] = useState<
    GatewayModelDefinition[]
  >([]);
  const [providerSecretRefs, setProviderSecretRefs] = useState<
    GatewayProviderSecretRef[]
  >([]);
  const [providerSecretInputs, setProviderSecretInputs] = useState<
    GatewayProviderSecretInput[]
  >([]);
  const [enabledModelRefs, setEnabledModelRefs] = useState<string[]>([]);

  return (
    <PresetIntegrationEditor
      nodeClass={nodeClass}
      toolchainCatalog={catalog}
      providerConfigs={providerConfigs}
      providerAuthConfigs={providerAuthConfigs}
      modelDefinitions={modelDefinitions}
      providerSecretRefs={providerSecretRefs}
      providerSecretInputs={providerSecretInputs}
      enabledModelRefs={enabledModelRefs}
      isLoading={false}
      onProviderConfigsChange={setProviderConfigs}
      onProviderAuthConfigsChange={setProviderAuthConfigs}
      onModelDefinitionsChange={setModelDefinitions}
      onProviderSecretRefsChange={setProviderSecretRefs}
      onProviderSecretInputsChange={setProviderSecretInputs}
      onEnabledModelRefsChange={setEnabledModelRefs}
    />
  );
}

const claudeCodePreset: ToolchainCatalogProviderPreset = {
  preset_id: "claude-code",
  provider_id: "claude-cli",
  display_label: "Claude Code",
  provider_type: "claude-cli",
  product_line: "CLI sign-in",
  summary: "Uses a signed-in Claude Code session on the selected node.",
  node_classes: ["cloud", "local"],
  supported_auth_modes: ["login"],
  kind: "local-interactive",
  models: [
    {
      model_id: "claude-sonnet-4-6",
      label: "Claude Sonnet 4.6",
    },
    {
      model_id: "claude-opus-4-6",
      label: "Claude Opus 4.6",
      enabled_by_default: false,
    },
  ],
};

const githubCopilotPreset: ToolchainCatalogProviderPreset = {
  preset_id: "github-copilot",
  provider_id: "github-copilot",
  display_label: "GitHub Copilot",
  provider_type: "github-copilot",
  product_line: "Developer seat",
  summary: "Uses a signed-in GitHub Copilot seat on the selected node.",
  node_classes: ["cloud", "local"],
  supported_auth_modes: ["oauth", "login"],
  kind: "local-interactive",
  models: [
    {
      model_id: "gpt-5",
      label: "GPT-5",
    },
    {
      model_id: "gpt-5.4",
      label: "GPT-5.4",
    },
  ],
};

const azureFoundryPreset: ToolchainCatalogProviderPreset = {
  preset_id: "microsoft-foundry",
  provider_id: "microsoft-foundry",
  display_label: "Azure Foundry",
  provider_type: "microsoft-foundry",
  product_line: "Hosted API",
  summary: "Azure-hosted model endpoint for managed service-auth nodes.",
  node_classes: ["cloud", "local"],
  supported_auth_modes: ["api-key"],
  kind: "preset-only",
  models: [
    {
      model_id: "model-router",
      label: "Model Router (Azure Foundry)",
      enabled_by_default: false,
    },
    {
      model_id: "gpt-5.4-mini",
      label: "GPT-5.4 Mini (Azure Foundry)",
    },
  ],
};

describe("PresetIntegrationEditor", () => {
  it("keeps a new integration in draft until the dialog is confirmed", async () => {
    const user = userEvent.setup();
    render(<Harness catalog={[claudeCodePreset]} />);

    expect(
      screen.getByText(/No preset integrations configured yet/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add and configure" }));

    expect(
      screen.getByRole("heading", { name: "Configure Claude Code" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No preset integrations configured yet/i),
    ).toBeInTheDocument();
    expect(screen.getByText("2 available")).toBeInTheDocument();
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    expect(screen.getByText("1 enabled")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(
      screen.getByText(/No preset integrations configured yet/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Configure" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add and configure" }));
    await user.click(screen.getByRole("button", { name: "Add integration" }));

    expect(
      screen.queryByText(/No preset integrations configured yet/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Configure" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Sign-in required after node save/i),
    ).toBeInTheDocument();
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    expect(screen.getByText("1 enabled")).toBeInTheDocument();
  });

  it("surfaces cloud interactive auth modes for compatible presets", async () => {
    const user = userEvent.setup();
    render(<Harness catalog={[githubCopilotPreset]} />);

    await user.click(screen.getByRole("button", { name: "Add and configure" }));

    expect(
      screen.getByRole("heading", { name: "Configure GitHub Copilot" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("OAuth").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Login").length).toBeGreaterThan(0);
    expect(screen.queryByText("Unavailable")).not.toBeInTheDocument();
  });

  it("renders every preset model option while only enabling defaults initially", async () => {
    const user = userEvent.setup();
    render(<Harness catalog={[azureFoundryPreset]} />);

    await user.click(screen.getByRole("button", { name: "Add and configure" }));

    expect(
      screen.getByRole("heading", { name: "Configure Azure Foundry" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Model Router (Azure Foundry)"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("GPT-5.4 Mini (Azure Foundry)"),
    ).toBeInTheDocument();
    expect(screen.getByText("2 available")).toBeInTheDocument();
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    expect(screen.getByText("1 enabled")).toBeInTheDocument();
  });
});
