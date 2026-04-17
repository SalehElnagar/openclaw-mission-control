"""Managed provider/model presets for the Mission Control node editor."""

from __future__ import annotations

from functools import lru_cache

from app.schemas.gateway_runtime import (
    GatewayModelCost,
    ToolchainCatalogModelPreset,
    ToolchainCatalogProviderPreset,
    ToolchainCatalogResponse,
)


@lru_cache(maxsize=1)
def toolchain_catalog() -> ToolchainCatalogResponse:
    """Return the curated preset catalog used by the node toolchain editor."""

    return ToolchainCatalogResponse(
        providers=[
            ToolchainCatalogProviderPreset(
                preset_id="microsoft-foundry",
                provider_id="microsoft-foundry",
                display_label="Azure Foundry",
                provider_type="microsoft-foundry",
                product_line="Hosted API",
                summary=(
                    "Azure-hosted model endpoint for managed service-auth nodes. "
                    "Use an API key on cloud or local nodes."
                ),
                node_classes=["cloud", "local"],
                supported_auth_modes=["api-key"],
                default_base_url="https://ai-foundry-advanced-claw.cognitiveservices.azure.com/openai/v1",
                default_api_mode="openai-completions",
                default_auth_header=False,
                kind="preset-only",
                models=[
                    ToolchainCatalogModelPreset(
                        model_id="gpt-5.4-mini",
                        label="GPT-5.4 Mini (Azure Foundry)",
                        api_mode="openai-completions",
                        input_modalities=["text"],
                        context_window=128000,
                        max_tokens=16384,
                        cost=GatewayModelCost(
                            input=0.75,
                            output=4.5,
                            cache_read=0.075,
                            cache_write=0.75,
                        ),
                    ),
                ],
            ),
            ToolchainCatalogProviderPreset(
                preset_id="anthropic-claude",
                provider_id="anthropic",
                display_label="Anthropic Claude",
                provider_type="anthropic",
                product_line="Hosted API",
                summary=(
                    "Anthropic's hosted Claude API for managed service-auth nodes. "
                    "Use an API key; this is separate from any local Claude CLI sign-in flow."
                ),
                node_classes=["cloud", "local"],
                supported_auth_modes=["api-key"],
                kind="advanced-capable",
                models=[
                    ToolchainCatalogModelPreset(
                        model_id="claude-sonnet-4-6",
                        label="Claude Sonnet 4.6",
                        input_modalities=["text"],
                        cost=GatewayModelCost(
                            input=3.0,
                            output=15.0,
                        ),
                    ),
                    ToolchainCatalogModelPreset(
                        model_id="claude-opus-4-6",
                        label="Claude Opus 4.6",
                        input_modalities=["text"],
                        cost=GatewayModelCost(
                            input=15.0,
                            output=75.0,
                        ),
                        enabled_by_default=False,
                    ),
                ],
            ),
            ToolchainCatalogProviderPreset(
                preset_id="google-gemini",
                provider_id="google-gemini",
                display_label="Google Gemini",
                provider_type="google-gemini",
                product_line="Hosted API",
                summary=(
                    "Google's hosted Gemini API for managed service-auth nodes. "
                    "Use an API key; this is not the local Gemini CLI flow."
                ),
                node_classes=["cloud", "local"],
                supported_auth_modes=["api-key"],
                default_base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
                default_api_mode="openai-completions",
                default_auth_header=True,
                kind="advanced-capable",
                models=[
                    ToolchainCatalogModelPreset(
                        model_id="gemini-2.5-flash",
                        label="Gemini 2.5 Flash",
                        api_mode="openai-completions",
                        input_modalities=["text"],
                    ),
                    ToolchainCatalogModelPreset(
                        model_id="gemini-2.5-pro",
                        label="Gemini 2.5 Pro",
                        api_mode="openai-completions",
                        input_modalities=["text"],
                    ),
                ],
            ),
            ToolchainCatalogProviderPreset(
                preset_id="github-models",
                provider_id="github-models",
                display_label="GitHub Models",
                provider_type="github-models",
                product_line="Hosted API",
                summary=(
                    "GitHub-hosted inference API for managed service use. "
                    "Bring a GitHub token; this is separate from a Copilot seat."
                ),
                node_classes=["cloud", "local"],
                supported_auth_modes=["token"],
                default_base_url="https://models.github.ai/inference",
                default_api_mode="openai-completions",
                default_auth_header=True,
                default_headers={
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2026-03-10",
                },
                default_token_header_name="Authorization",
                default_token_header_prefix="Bearer",
                kind="advanced-capable",
                models=[
                    ToolchainCatalogModelPreset(
                        model_id="openai/gpt-4.1",
                        label="OpenAI GPT-4.1",
                        api_mode="openai-completions",
                        input_modalities=["text"],
                    ),
                    ToolchainCatalogModelPreset(
                        model_id="openai/gpt-4o",
                        label="OpenAI GPT-4o",
                        api_mode="openai-completions",
                        input_modalities=["text"],
                    ),
                ],
            ),
            ToolchainCatalogProviderPreset(
                preset_id="github-copilot",
                provider_id="github-copilot",
                display_label="GitHub Copilot",
                provider_type="github-copilot",
                product_line="Developer seat",
                summary=(
                    "Uses a signed-in GitHub Copilot seat on a local node. "
                    "Connect with OAuth or login after saving the node; this is not the GitHub Models token API."
                ),
                node_classes=["local"],
                supported_auth_modes=["oauth", "login"],
                kind="local-interactive",
                models=[
                    ToolchainCatalogModelPreset(
                        model_id="gpt-5",
                        label="GPT-5",
                        input_modalities=["text"],
                    ),
                    ToolchainCatalogModelPreset(
                        model_id="gpt-5.4",
                        label="GPT-5.4",
                        input_modalities=["text"],
                    ),
                ],
            ),
            ToolchainCatalogProviderPreset(
                preset_id="google-gemini-cli",
                provider_id="google-gemini-cli",
                display_label="Google Gemini CLI",
                provider_type="google-gemini-cli",
                product_line="CLI sign-in",
                summary=(
                    "Uses a locally signed-in Gemini CLI session on a local node. "
                    "Choose login after save; this is separate from the hosted Gemini API key flow."
                ),
                node_classes=["local"],
                supported_auth_modes=["login"],
                kind="local-interactive",
                models=[
                    ToolchainCatalogModelPreset(
                        model_id="gemini-3.1-pro-preview",
                        label="Gemini 3.1 Pro Preview",
                        input_modalities=["text"],
                    ),
                ],
            ),
        ],
    )


def provider_preset_by_id(preset_id: str | None) -> ToolchainCatalogProviderPreset | None:
    """Return one provider preset by preset id or provider id."""

    if not preset_id:
        return None
    normalized = preset_id.strip().lower()
    if not normalized:
        return None
    for provider in toolchain_catalog().providers:
        if provider.preset_id == normalized or provider.provider_id == normalized:
            return provider
    return None
