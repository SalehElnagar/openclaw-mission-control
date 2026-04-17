import { customFetch } from "@/api/mutator";
import type { ProviderAuthMode } from "@/lib/provider-auth";

type ApiEnvelope<T> = {
  data: T;
  status: number;
  headers: Headers;
};

export type ToolchainCatalogModelPreset = {
  model_id: string;
  label: string;
  api_mode?: string | null;
  reasoning?: boolean | null;
  input_modalities?: string[];
  context_window?: number | null;
  max_tokens?: number | null;
  cost?: {
    input?: number | null;
    output?: number | null;
    cache_read?: number | null;
    cache_write?: number | null;
  } | null;
  enabled_by_default?: boolean;
};

export type ToolchainCatalogProviderPreset = {
  preset_id: string;
  provider_id: string;
  display_label: string;
  provider_type: string;
  node_classes: Array<"cloud" | "local">;
  supported_auth_modes: ProviderAuthMode[];
  default_base_url?: string | null;
  default_api_mode?: string | null;
  default_auth_header?: boolean | null;
  default_headers?: Record<string, string> | null;
  default_token_header_name?: string | null;
  default_token_header_prefix?: string | null;
  kind: "preset-only" | "advanced-capable" | "local-interactive";
  models: ToolchainCatalogModelPreset[];
};

export type ToolchainCatalogResponse = {
  providers: ToolchainCatalogProviderPreset[];
};

export const getToolchainCatalog = async (): Promise<
  ApiEnvelope<ToolchainCatalogResponse>
> =>
  customFetch<ApiEnvelope<ToolchainCatalogResponse>>("/api/v1/toolchain/catalog", {
    method: "GET",
  });
