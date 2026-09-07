/**
 * The four-file tool bundle (`docs/llm_generated/10-screen-raw-data.md`):
 *
 *   [name].ts          combined logic + config, produced by the AST engine
 *   [name].json        the standalone ToolConfig JSON — may legitimately diverge
 *                      from the config embedded in the .ts (12-screen-config.md §4)
 *   [name].env         local testing secrets, keyed by config.secrets
 *   [name]_tests.json  the external ToolTest suite (15-screen-runner.md §4.2)
 *
 * Renaming the tool renames all four files and updates `config.name`.
 */

import type { ToolConfig, ToolTest } from "@/lib/tgs/contract";
import { extractTool, recombineTool, type RecombineOptions } from "@/lib/tgs/ast";
import { parseEnv, renderEnv } from "@/lib/tgs/envFile";

export type ToolBundle = {
  /** The tool name; drives all four filenames. */
  name: string;
  /** Editor buffer (config replaced by the stub). */
  logic: string;
  /** Config extracted from / injected into the .ts. */
  config: Partial<ToolConfig>;
  /** The SEPARATE standalone `[name].json` file content. */
  configJson: Partial<ToolConfig>;
  /** Values for `[name].env`. */
  secrets: Record<string, string>;
  /** `[name]_tests.json`. */
  jsonTests: ToolTest[];
};

export type ToolFileNames = {
  ts: string;
  json: string;
  env: string;
  tests: string;
};

export type RenderedBundle = {
  ts: string;
  json: string;
  env: string;
  tests: string;
};

export type ToolFileContents = {
  ts?: string;
  json?: string;
  env?: string;
  tests?: string;
};

export const DEFAULT_TOOL_NAME = "untitled_tool";

/** The four filenames for a tool: `calc.ts`, `calc.json`, `calc.env`, `calc_tests.json`. */
export function fileNames(name: string): ToolFileNames {
  const base = name.trim() === "" ? DEFAULT_TOOL_NAME : name.trim();
  return {
    ts: `${base}.ts`,
    json: `${base}.json`,
    env: `${base}.env`,
    tests: `${base}_tests.json`,
  };
}

/** Declared secret keys, in `config.secrets` declaration order. */
export function declaredSecretKeys(config: Partial<ToolConfig>): string[] {
  return config.secrets ? Object.keys(config.secrets) : [];
}

/** Serialize a bundle to the exact text of its four files. */
export function renderBundle(b: ToolBundle, opts: RecombineOptions = {}): RenderedBundle {
  return {
    ts: recombineTool(b.logic, b.config, opts),
    json: JSON.stringify(b.configJson, null, 2),
    env: renderEnv(b.secrets, declaredSecretKeys(b.config)),
    tests: JSON.stringify(b.jsonTests, null, 2),
  };
}

/** Thin wrapper over the AST engine for callers that only need logic + config. */
export function parseToolTs(tsCode: string): {
  logic: string;
  config: Partial<ToolConfig>;
  diagnostics: string[];
} {
  const extracted = extractTool(tsCode);
  return {
    logic: extracted.logic,
    config: extracted.config ?? {},
    diagnostics: extracted.diagnostics,
  };
}

export type ParsedBundle = {
  bundle: ToolBundle;
  diagnostics: string[];
};

/** Load a bundle from whatever subset of the four files is available on disk. */
export function parseBundleFromFilesDetailed(
  files: ToolFileContents,
  fallbackName?: string,
): ParsedBundle {
  const diagnostics: string[] = [];

  let logic = "";
  let config: Partial<ToolConfig> = {};
  if (files.ts !== undefined) {
    const parsed = parseToolTs(files.ts);
    logic = parsed.logic;
    config = parsed.config;
    diagnostics.push(...parsed.diagnostics);
  }

  let configJson: Partial<ToolConfig> = {};
  if (files.json !== undefined && files.json.trim() !== "") {
    const parsed = safeJsonParse(files.json);
    if (!parsed.ok) {
      diagnostics.push(`Could not parse the standalone config JSON: ${parsed.error}`);
    } else if (isPlainObject(parsed.value)) {
      configJson = parsed.value as Partial<ToolConfig>;
    } else {
      diagnostics.push("Could not parse the standalone config JSON: not a JSON object.");
    }
  }

  let jsonTests: ToolTest[] = [];
  if (files.tests !== undefined && files.tests.trim() !== "") {
    const parsed = safeJsonParse(files.tests);
    if (!parsed.ok) {
      diagnostics.push(`Could not parse the tests JSON as an array of ToolTest: ${parsed.error}`);
    } else if (Array.isArray(parsed.value)) {
      jsonTests = parsed.value.filter((entry): entry is ToolTest => {
        const valid = validateToolTest(entry);
        if (!valid) diagnostics.push("Dropped an entry in the tests JSON that is not a ToolTest.");
        return valid;
      });
    } else {
      diagnostics.push("Could not parse the tests JSON as an array of ToolTest: not an array.");
    }
  }

  const secrets = files.env !== undefined ? parseEnv(files.env) : {};

  const name = firstNonEmpty(config.name, configJson.name, fallbackName) ?? DEFAULT_TOOL_NAME;

  return {
    bundle: { name, logic, config, configJson, secrets, jsonTests },
    diagnostics,
  };
}

/** Load a bundle from whatever subset of the four files is available on disk. */
export function parseBundleFromFiles(files: ToolFileContents, fallbackName?: string): ToolBundle {
  return parseBundleFromFilesDetailed(files, fallbackName).bundle;
}

/** The embedded suite: `config.tests` from the `.ts` file. */
export function embeddedTests(b: ToolBundle): ToolTest[] {
  return (b.config.tests ?? []).filter(validateToolTest);
}

/** The Runner dashboard's unified matrix: embedded tests first, then the JSON suite. */
export function allTests(b: ToolBundle): { source: "ts" | "json"; test: ToolTest }[] {
  return [
    ...embeddedTests(b).map((test) => ({ source: "ts" as const, test })),
    ...b.jsonTests.filter(validateToolTest).map((test) => ({ source: "json" as const, test })),
  ];
}

/**
 * Dotted paths at which two configs differ — the Config tab's divergence
 * indicator between the embedded `.ts` config and the standalone `.json`.
 */
export function configDiff(a: unknown, b: unknown): string[] {
  const out: string[] = [];
  diffInto(a, b, [], out);
  return out.sort();
}

function diffInto(a: unknown, b: unknown, path: string[], out: string[]): void {
  if (Object.is(a, b)) return;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push(pathString(path));
      return;
    }
    a.forEach((item, index) => diffInto(item, b[index], [...path, String(index)], out));
    return;
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) diffInto(a[key], b[key], [...path, key], out);
    return;
  }

  if (a === b) return;
  out.push(pathString(path));
}

function pathString(path: string[]): string {
  return path.length === 0 ? "<root>" : path.join(".");
}

/** Structural check for the `ToolTest` interface (15-screen-runner.md §3). */
export function validateToolTest(t: unknown): t is ToolTest {
  if (!isPlainObject(t)) return false;
  if (typeof t["name"] !== "string") return false;
  const expect = t["expect"];
  if (!isPlainObject(expect)) return false;
  const status = expect["status"];
  if (status !== undefined && typeof status !== "number") return false;
  const hasKey = expect["hasKey"];
  if (hasKey !== undefined && typeof hasKey !== "string") return false;
  return true;
}

/** Rename the tool: all four filenames plus `config.name` (and `configJson.name`). */
export function renameTool(b: ToolBundle, newName: string): ToolBundle {
  const name = newName.trim() === "" ? DEFAULT_TOOL_NAME : newName.trim();
  const config: Partial<ToolConfig> = { ...b.config, name };
  const configJson: Partial<ToolConfig> =
    Object.keys(b.configJson).length === 0 ? { ...b.configJson } : { ...b.configJson, name };
  return { ...b, name, config, configJson };
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function safeJsonParse(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
