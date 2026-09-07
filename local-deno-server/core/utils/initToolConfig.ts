// /core/utils/initToolConfig.ts
//
// Fills a tool's `baseConfig` out into a complete `ToolConfig`, applying the
// STS defaults. Every tool's `export const config` is produced by this call, so
// the router can rely on every field being present.

import type { ToolConfig, ToolSignature } from "../contracts/ToolContract.ts";

/** STS defaults applied to any field the tool did not declare. */
export const TOOL_CONFIG_DEFAULTS = {
  version: "0.0.0",
  description: "",
  cost: 0,
  timeoutMs: 15000,
  isIdempotent: false,
  requestsPerMinute: 60,
  outputModality: ["text"] as ("text" | "image" | "application/pdf" | "binary")[],
};

const EMPTY_SIGNATURE: ToolSignature = {
  inputs: { type: "object", properties: {}, required: [] },
  outputs: { type: "object", properties: {} },
  errors: {},
};

/**
 * Derive a tool name from its module URL basename:
 *   file:///.../tools/weather_fetcher.ts -> "weather_fetcher"
 */
export function toolNameFromModuleUrl(metaUrl: string): string {
  try {
    const path = new URL(metaUrl).pathname;
    const base = path.split("/").pop() ?? "";
    return base.replace(/\.[tj]sx?$/, "") || "unnamed_tool";
  } catch {
    const base = String(metaUrl).split("/").pop() ?? "";
    return base.replace(/\.[tj]sx?$/, "") || "unnamed_tool";
  }
}

/**
 * @param metaUrl  Always `import.meta.url` from the calling tool file.
 * @param baseConfig  The tool's declarative block.
 */
export async function initToolConfig(
  metaUrl: string,
  baseConfig: Partial<ToolConfig>,
): Promise<ToolConfig> {
  // async purely so the contract (`await initToolConfig(...)`) is stable if a
  // future backend needs to resolve remote schema fragments here.
  await Promise.resolve();

  const signature: ToolSignature = baseConfig.signature
    ? {
      inputs: baseConfig.signature.inputs ?? EMPTY_SIGNATURE.inputs,
      outputs: baseConfig.signature.outputs ?? EMPTY_SIGNATURE.outputs,
      errors: baseConfig.signature.errors ?? {},
    }
    : { ...EMPTY_SIGNATURE };

  const config: ToolConfig = {
    ...baseConfig,

    name: baseConfig.name ?? toolNameFromModuleUrl(metaUrl),
    version: baseConfig.version ?? TOOL_CONFIG_DEFAULTS.version,
    description: baseConfig.description ?? TOOL_CONFIG_DEFAULTS.description,

    secrets: baseConfig.secrets ?? {},
    tool_dependencies: baseConfig.tool_dependencies ?? [],
    network_requests: baseConfig.network_requests ?? [],

    timeoutMs: baseConfig.timeoutMs ?? TOOL_CONFIG_DEFAULTS.timeoutMs,
    isIdempotent: baseConfig.isIdempotent ?? TOOL_CONFIG_DEFAULTS.isIdempotent,
    cost: baseConfig.cost ?? TOOL_CONFIG_DEFAULTS.cost,

    rateLimit: baseConfig.rateLimit ??
      { requestsPerMinute: TOOL_CONFIG_DEFAULTS.requestsPerMinute },

    outputModality: baseConfig.outputModality ??
      [...TOOL_CONFIG_DEFAULTS.outputModality],

    tests: baseConfig.tests ?? [],

    signature,
  };

  return config;
}

export default initToolConfig;
