/**
 * One-time Monaco workspace configuration for the TGS workbench.
 *
 * Everything in this module is either a pure function or takes the Monaco
 * namespace as a parameter. It NEVER imports `monaco-editor` at runtime, so it
 * is safe to import from SSR code and from a plain Node test runner. The
 * browser-only wiring lives in `MonacoEditor.tsx`, which dynamically imports
 * Monaco and then calls `configureMonaco(monaco)`.
 *
 * Requirements implemented here come from:
 *   docs/llm_generated/11-screen-editor.md §4  (language/target, injected types,
 *                                               the two linter warnings)
 *   docs/llm_generated/12-screen-config.md §3  (JSON schema validation)
 *   docs/llm_generated/10-screen-raw-data.md   (per-file-type panes)
 */

import type * as MonacoNs from "monaco-editor";

// Kept in sync with the real contract by construction: the source file itself is
// inlined as a string at build time and handed to Monaco as an extra lib.
import contractSource from "../../lib/tgs/contract.ts?raw";

export type MonacoApi = typeof MonacoNs;

/** Theme registered by {@link defineTgsTheme} and used by `<MonacoEditor />`. */
export const TGS_THEME_NAME = "tgs-light";

/** Marker owner for the built-in zero-trust / isolate lint. */
export const TGS_DIAGNOSTICS_OWNER = "tgs-zero-trust";

/** Marker owner for markers pushed in through the `markers` prop (Validator findings). */
export const TGS_EXTERNAL_MARKER_OWNER = "tgs-external";

/** Path the ToolContract source is registered under, per 11-screen-editor.md §4. */
export const CONTRACT_LIB_PATH = "file:///core/contracts/ToolContract.ts";
export const INIT_TOOL_CONFIG_LIB_PATH = "file:///core/utils/initToolConfig.ts";
export const NETWORK_GATEWAY_LIB_PATH = "file:///core/network/network_gateway.ts";
export const MODULE_MAP_LIB_PATH = "file:///core/tgs-core-modules.d.ts";

/** The raw `ToolContract.ts` source that is injected into Monaco. */
export const CONTRACT_SOURCE = contractSource;

/* -------------------------------------------------------------------------- */
/* 1. Zero-trust / isolate diagnostics (pure, unit-testable without Monaco)     */
/* -------------------------------------------------------------------------- */

export const ZERO_TRUST_FETCH_MESSAGE =
  "Zero-Trust Violation: Use dispatchToGateway() or context.useCoreTool('network_gateway') instead";

export function nodeBuiltinMessage(moduleSpecifier: string): string {
  return `Cloudflare Worker isolate violation: Node.js built-in '${moduleSpecifier}' is not available`;
}

export type TgsDiagnostic = {
  line: number;
  column: number;
  endColumn: number;
  message: string;
  severity: "warning";
};

/** Node core modules that do not exist in a Cloudflare Worker isolate. */
const NODE_BUILTINS = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "sys",
  "timers",
  "timers/promises",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

/** True when the specifier names a Node.js built-in module. */
export function isNodeBuiltinSpecifier(specifier: string): boolean {
  if (specifier.startsWith("node:")) return true;
  return NODE_BUILTINS.has(specifier);
}

type ScanMode = "code" | "line" | "block" | "sq" | "dq" | "tpl" | "regex";

const REGEX_ALLOWED_AFTER = new Set([
  "",
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "~",
  "^",
  "<",
  ">",
]);

/**
 * Marks every character of `code` as real code (1) or comment/string/regex
 * content (0). Exported for tests — the lint rules use it to avoid firing on
 * text inside comments and string literals.
 */
export function buildCodeMask(code: string): Uint8Array {
  const mask = new Uint8Array(code.length);
  let mode: ScanMode = "code";
  const templateBraceDepths: number[] = [];
  let braceDepth = 0;
  let prev = "";

  for (let i = 0; i < code.length; i++) {
    const c = code[i] as string;
    const n = i + 1 < code.length ? (code[i + 1] as string) : "";

    if (mode === "code") {
      if (c === "/" && n === "/") {
        mode = "line";
        continue;
      }
      if (c === "/" && n === "*") {
        mode = "block";
        i++;
        continue;
      }
      if (c === '"') {
        mode = "dq";
        continue;
      }
      if (c === "'") {
        mode = "sq";
        continue;
      }
      if (c === "`") {
        mode = "tpl";
        continue;
      }
      if (c === "/" && REGEX_ALLOWED_AFTER.has(prev)) {
        mode = "regex";
        continue;
      }
      if (c === "{") {
        braceDepth++;
      } else if (c === "}") {
        braceDepth--;
        const top = templateBraceDepths[templateBraceDepths.length - 1];
        if (top !== undefined && braceDepth === top) {
          templateBraceDepths.pop();
          mode = "tpl";
          continue;
        }
      }
      mask[i] = 1;
      if (!/\s/.test(c)) prev = c;
      continue;
    }

    // Non-code modes: everything stays masked out.
    switch (mode) {
      case "line":
        if (c === "\n") {
          mode = "code";
          prev = "";
        }
        break;
      case "block":
        if (c === "*" && n === "/") {
          i++;
          mode = "code";
          prev = ")"; // a block comment behaves like a value boundary
        }
        break;
      case "sq":
      case "dq":
      case "regex":
        if (c === "\\") {
          i++;
        } else if (c === "\n") {
          mode = "code";
          prev = "";
        } else if (
          (mode === "sq" && c === "'") ||
          (mode === "dq" && c === '"') ||
          (mode === "regex" && c === "/")
        ) {
          mode = "code";
          prev = ")";
        }
        break;
      case "tpl":
        if (c === "\\") {
          i++;
        } else if (c === "`") {
          mode = "code";
          prev = ")";
        } else if (c === "$" && n === "{") {
          i++;
          templateBraceDepths.push(braceDepth);
          braceDepth++;
          mode = "code";
          prev = "{";
        }
        break;
      default:
        break;
    }
  }

  return mask;
}

function lineStarts(code: string): number[] {
  const starts = [0];
  for (let i = 0; i < code.length; i++) {
    if (code[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function positionAt(starts: number[], offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] as number) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - (starts[lo] as number) + 1 };
}

const FETCH_RE = /\bfetch\s*\(/g;

// Module specifier forms we understand. Each regex captures the quote in group 1
// and the specifier in group 2; `index` points at the keyword so the mask check
// is done on real code and not on text inside a comment.
const SPECIFIER_RES: RegExp[] = [
  /\bfrom\s*(["'])([^"'\n]+)\1/g, //          import x from "y" / export * from "y"
  /\bimport\s*(["'])([^"'\n]+)\1/g, //        import "y"
  /\bimport\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g, // import("y")
  /\brequire\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g, // require("y")
];

/**
 * The two linter warnings required by 11-screen-editor.md §4, as a pure
 * function over source text.
 *
 * 1. A direct global `fetch(` call — but never `internalFetch(`,
 *    `context.internalFetch(`, `.fetch(`, or an occurrence inside a comment or
 *    a string literal.
 * 2. An import of a Node.js core module (`node:fs`, `fs`, `child_process`, ...).
 */
export function zeroTrustDiagnostics(code: string): TgsDiagnostic[] {
  if (!code) return [];
  const mask = buildCodeMask(code);
  const starts = lineStarts(code);
  const found: TgsDiagnostic[] = [];
  const seen = new Set<string>();

  const push = (offset: number, length: number, message: string): void => {
    const { line, column } = positionAt(starts, offset);
    const key = `${line}:${column}:${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ line, column, endColumn: column + length, message, severity: "warning" });
  };

  // --- Rule 1: direct global fetch() -----------------------------------------
  FETCH_RE.lastIndex = 0;
  for (let m = FETCH_RE.exec(code); m !== null; m = FETCH_RE.exec(code)) {
    const start = m.index;
    if (mask[start] !== 1) continue; // inside a comment or a string
    const before = start > 0 ? (code[start - 1] as string) : "";
    if (before === "." || before === "#") continue; // .fetch( / #fetch(
    push(start, "fetch".length, ZERO_TRUST_FETCH_MESSAGE);
  }

  // --- Rule 2: Node.js core module imports ------------------------------------
  for (const re of SPECIFIER_RES) {
    re.lastIndex = 0;
    for (let m = re.exec(code); m !== null; m = re.exec(code)) {
      const keywordStart = m.index;
      if (mask[keywordStart] !== 1) continue;
      const specifier = m[2];
      if (specifier === undefined || !isNodeBuiltinSpecifier(specifier)) continue;
      const quoteOffset = code.indexOf(m[1] as string, keywordStart);
      if (quoteOffset < 0) continue;
      push(quoteOffset, specifier.length + 2, nodeBuiltinMessage(specifier));
    }
  }

  found.sort((a, b) => a.line - b.line || a.column - b.column);
  return found;
}

/* -------------------------------------------------------------------------- */
/* 2. JSON schemas (12-screen-config.md §3)                                    */
/* -------------------------------------------------------------------------- */

const SIGNATURE_SCHEMA = {
  type: "object",
  required: ["inputs", "outputs"],
  additionalProperties: false,
  properties: {
    inputs: {
      type: "object",
      required: ["type", "properties"],
      properties: {
        type: { const: "object" },
        properties: { type: "object" },
        required: { type: "array", items: { type: "string" } },
      },
    },
    outputs: {
      type: "object",
      required: ["type", "properties"],
      properties: {
        type: { const: "object" },
        properties: { type: "object" },
      },
    },
    errors: {
      type: "object",
      description: "Error codes surfaced to the agent, each with actionable advice.",
      additionalProperties: {
        type: "object",
        required: ["description"],
        additionalProperties: false,
        properties: {
          description: { type: "string" },
          actionable_advice: { type: "string" },
        },
      },
    },
  },
} as const;

const TOOL_TEST_SCHEMA = {
  type: "object",
  required: ["name", "payload", "expect"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1 },
    payload: { description: "Request body posted to the tool." },
    expect: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: { type: "integer", minimum: 100, maximum: 599 },
        hasKey: { type: "string" },
      },
    },
  },
} as const;

/** JSON Schema for `ToolConfig` — bound to the `*.json` config panes. */
export const TOOL_CONFIG_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://tgs.agentsable.local/schemas/tool-config.json",
  title: "ToolConfig",
  type: "object",
  required: ["name", "version", "description", "signature"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, pattern: "^[a-z0-9_]+$" },
    version: { type: "string", minLength: 1 },
    icon: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    description: { type: "string", minLength: 1 },
    mcpDescription: { type: "string" },
    secrets: {
      type: "object",
      description: "V2 secrets dictionary — replaces the flat requiredEnv array.",
      additionalProperties: {
        type: "object",
        required: ["description"],
        additionalProperties: false,
        properties: {
          description: { type: "string" },
          isOptional: { type: "boolean" },
        },
      },
    },
    tool_dependencies: { type: "array", items: { type: "string" } },
    network_requests: {
      type: "array",
      items: { type: "string" },
      description: "Egress allowlist as absolute URL prefixes.",
    },
    permissions: {
      type: "object",
      additionalProperties: false,
      properties: {
        read: { type: "array", items: { type: "string" } },
        write: { type: "array", items: { type: "string" } },
      },
    },
    timeoutMs: { type: "number", minimum: 0 },
    isIdempotent: { type: "boolean" },
    cost: { type: "number", minimum: 0 },
    rateLimit: {
      type: "object",
      required: ["requestsPerMinute"],
      additionalProperties: false,
      properties: { requestsPerMinute: { type: "number", minimum: 0 } },
    },
    outputModality: {
      type: "array",
      items: { enum: ["text", "image", "application/pdf", "binary"] },
    },
    mcpResources: {
      type: "array",
      items: {
        type: "object",
        required: ["uri", "name"],
        additionalProperties: false,
        properties: {
          uri: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
        },
      },
    },
    mcpPrompts: {
      type: "array",
      items: {
        type: "object",
        required: ["name"],
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          arguments: { type: "array" },
        },
      },
    },
    tests: { type: "array", items: TOOL_TEST_SCHEMA },
    signature: SIGNATURE_SCHEMA,
  },
} as const;

/** JSON Schema for `[tool_name]_tests.json` — an array of `ToolTest`. */
export const TOOL_TESTS_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://tgs.agentsable.local/schemas/tool-tests.json",
  title: "ToolTest[]",
  type: "array",
  items: TOOL_TEST_SCHEMA,
} as const;

/* -------------------------------------------------------------------------- */
/* 3. Injected type libraries                                                  */
/* -------------------------------------------------------------------------- */

const INIT_TOOL_CONFIG_SOURCE = `// /core/utils/initToolConfig.ts (declaration stub injected by TGS)
import type { ToolConfig } from "/core/contracts/ToolContract.ts";

/** Finalizes a baseConfig into a fully resolved ToolConfig at module load. */
export declare function initToolConfig(
  metaUrl: string,
  baseConfig: Partial<ToolConfig>,
): Promise<ToolConfig>;
`;

const NETWORK_GATEWAY_SOURCE = `// /core/network/network_gateway.ts (declaration stub injected by TGS)
import type { ToolExecutionContext } from "/core/contracts/ToolContract.ts";

export interface GatewayRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/** Zero-Trust egress: validates \`url\` against the caller's network_requests. */
export declare function dispatchToGateway(
  request: GatewayRequest,
  context: ToolExecutionContext,
): Promise<any>;
`;

/**
 * Indent a source block so it can live inside `declare module { ... }`, and drop
 * the `declare` modifier — TS1038 forbids it in an already-ambient context.
 */
function indent(source: string): string {
  return source
    .replace(/\bexport declare\b/g, "export")
    .split("\n")
    .map((l) => (l.length > 0 ? `  ${l}` : l))
    .join("\n");
}

/**
 * Ambient module declarations so `import ... from "/core/contracts/ToolContract.ts"`
 * RESOLVES inside a standalone tool file (Monaco has no real file system rooted
 * at `/core`). Both the extension-ful and extension-less specifiers are mapped.
 */
export function buildCoreModuleMap(contract: string = contractSource): string {
  const contractBody = indent(contract);
  const initBody = indent(INIT_TOOL_CONFIG_SOURCE);
  const gatewayBody = indent(NETWORK_GATEWAY_SOURCE);

  const specifiers: Array<[string, string]> = [];
  for (const suffix of [".ts", ""]) {
    specifiers.push([`/core/contracts/ToolContract${suffix}`, contractBody]);
    specifiers.push([`/core/utils/initToolConfig${suffix}`, initBody]);
    specifiers.push([`/core/network/network_gateway${suffix}`, gatewayBody]);
  }

  return specifiers
    .map(([specifier, body]) => `declare module "${specifier}" {\n${body}\n}`)
    .join("\n\n");
}

/* -------------------------------------------------------------------------- */
/* 4. Monaco wiring (browser only — every function takes the namespace)        */
/* -------------------------------------------------------------------------- */

/** `ts.ScriptTarget.ES2022` — monaco's shipped enum only goes to ES2020. */
const ES2022_SCRIPT_TARGET = 9 as unknown as MonacoNs.typescript.ScriptTarget;
/** `ts.ModuleResolutionKind.Bundler` — monaco's shipped enum only has Classic/NodeJs. */
const BUNDLER_MODULE_RESOLUTION = 100 as unknown as MonacoNs.typescript.ModuleResolutionKind;

/**
 * TypeScript defaults: ES2022 / WinterCG-ish Worker environment.
 * `2307`/`2792` are suppressed because `/core/...` modules are supplied as
 * ambient declarations rather than real files on disk.
 */
export function configureTypeScriptDefaults(monaco: MonacoApi): void {
  // monaco 0.56 moved these off `monaco.languages.*` to top-level namespaces.
  const ts = monaco.typescript;

  ts.typescriptDefaults.setCompilerOptions({
    // monaco's bundled enums stop at ES2020 / NodeJs; the worker runs a real
    // TypeScript 5.x, whose numeric values for ES2022 and Bundler are these.
    target: ES2022_SCRIPT_TARGET,
    module: ts.ModuleKind.ESNext,
    moduleResolution: BUNDLER_MODULE_RESOLUTION,
    // Lowercase: the worker maps "es2022" -> "lib.es2022.d.ts".
    lib: ["es2022", "dom", "dom.iterable"],
    strict: true,
    noImplicitAny: true,
    strictNullChecks: true,
    allowNonTsExtensions: true,
    allowJs: false,
    esModuleInterop: true,
    skipLibCheck: true,
    noEmit: true,
  });

  ts.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: false,
    diagnosticCodesToIgnore: [
      2307, // Cannot find module '...' — /core/* is ambient, not on disk
      2792, // Cannot find module. Did you mean to set 'moduleResolution' to 'node'?
      1375, // 'await' at the top level of a module (config = await initToolConfig)
      1378,
      1323, // Dynamic imports are only supported when '--module' is ...
      6133, // '...' is declared but its value is never read
    ],
  });

  ts.typescriptDefaults.setEagerModelSync(true);
}

/** Registers the ToolContract + `/core/*` stubs as Monaco extra libs. */
export function configureExtraLibs(monaco: MonacoApi): void {
  const ts = monaco.typescript;
  const libs = [
    { content: contractSource, path: CONTRACT_LIB_PATH },
    { content: INIT_TOOL_CONFIG_SOURCE, path: INIT_TOOL_CONFIG_LIB_PATH },
    { content: NETWORK_GATEWAY_SOURCE, path: NETWORK_GATEWAY_LIB_PATH },
    { content: buildCoreModuleMap(), path: MODULE_MAP_LIB_PATH },
  ];
  // setExtraLibs replaces the whole set, so this stays idempotent.
  ts.typescriptDefaults.setExtraLibs(libs);
  ts.javascriptDefaults.setExtraLibs(libs);
}

/**
 * JSON schema validation. The ToolConfig schema is bound to every `*.json`
 * pane EXCEPT `*_tests.json`, which validates against the ToolTest array.
 */
export function configureJsonDefaults(monaco: MonacoApi): void {
  monaco.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: false,
    enableSchemaRequest: false,
    schemaValidation: "error",
    schemas: [
      {
        uri: TOOL_TESTS_JSON_SCHEMA.$id,
        fileMatch: ["*_tests.json", "*/*_tests.json"],
        schema: TOOL_TESTS_JSON_SCHEMA,
      },
      {
        uri: TOOL_CONFIG_JSON_SCHEMA.$id,
        fileMatch: ["*.json", "!*_tests.json"],
        schema: TOOL_CONFIG_JSON_SCHEMA,
      },
    ],
  });
}

/* --- Theme ---------------------------------------------------------------- */

/**
 * Resolves any CSS color (including the app's `oklch(...)` tokens) to a
 * `#rrggbb` string, which is the only format Monaco themes accept.
 * Uses a canvas as the color parser; returns `fallback` if anything fails.
 */
export function cssColorToHex(value: string, fallback: string): string {
  const input = value.trim();
  if (!input) return fallback;
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(input)) return input;
  if (typeof document === "undefined") return fallback;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) return fallback;
    ctx.fillStyle = "#000000";
    ctx.fillStyle = input;
    const resolved = ctx.fillStyle;
    if (typeof resolved === "string" && /^#[0-9a-f]{6}$/i.test(resolved)) return resolved;
    if (typeof resolved === "string") {
      const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(resolved);
      if (rgb) {
        const hex = [rgb[1], rgb[2], rgb[3]]
          .map((c) => Math.max(0, Math.min(255, Math.round(Number(c)))))
          .map((c) => c.toString(16).padStart(2, "0"))
          .join("");
        return `#${hex}`;
      }
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/** Reads a design token off `:root`, resolved to hex. */
export function readToken(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
    return cssColorToHex(raw, fallback);
  } catch {
    return fallback;
  }
}

/**
 * Registers `tgs-light`: a light theme built from the app's design tokens so the
 * editor sits inside the workbench instead of looking like stock VS Dark.
 */
export function defineTgsTheme(monaco: MonacoApi): void {
  const codeBg = readToken("--code-bg", "#eff1f5");
  const foreground = readToken("--foreground", "#231a33");
  const muted = readToken("--muted", "#e3e7ee");
  const mutedForeground = readToken("--muted-foreground", "#6a6a85");
  const gutter = readToken("--gutter", "#7c7c9c");
  const border = readToken("--border", "#c9cede");
  const primary = readToken("--primary", "#5b34c9");
  const secondary = readToken("--secondary", "#3b76d8");
  const accent = readToken("--accent", "#d97536");
  const destructive = readToken("--destructive", "#d1394b");
  const warning = readToken("--warning", "#d97536");
  const surface = readToken("--surface", "#f8f9fc");

  monaco.editor.defineTheme(TGS_THEME_NAME, {
    base: "vs",
    inherit: true,
    rules: [
      { token: "", foreground: foreground.slice(1) },
      { token: "comment", foreground: mutedForeground.slice(1), fontStyle: "italic" },
      { token: "keyword", foreground: primary.slice(1), fontStyle: "bold" },
      { token: "string", foreground: accent.slice(1) },
      { token: "number", foreground: secondary.slice(1) },
      { token: "type", foreground: secondary.slice(1) },
      { token: "type.identifier", foreground: secondary.slice(1) },
      { token: "identifier", foreground: foreground.slice(1) },
      { token: "delimiter", foreground: mutedForeground.slice(1) },
      { token: "tag", foreground: primary.slice(1) },
      { token: "attribute.name", foreground: secondary.slice(1) },
      { token: "key", foreground: primary.slice(1) },
      { token: "invalid", foreground: destructive.slice(1) },
    ],
    colors: {
      "editor.background": codeBg,
      "editor.foreground": foreground,
      "editorLineNumber.foreground": gutter,
      "editorLineNumber.activeForeground": primary,
      "editorGutter.background": codeBg,
      "editorCursor.foreground": primary,
      "editor.lineHighlightBackground": `${muted}80`,
      "editor.selectionBackground": `${secondary}33`,
      "editor.inactiveSelectionBackground": `${secondary}1f`,
      "editor.rangeHighlightBackground": `${accent}33`,
      "editorIndentGuide.background1": border,
      "editorIndentGuide.activeBackground1": gutter,
      "editorWhitespace.foreground": border,
      "editorWidget.background": surface,
      "editorWidget.border": border,
      "editorSuggestWidget.background": surface,
      "editorSuggestWidget.border": border,
      "editorHoverWidget.background": surface,
      "editorHoverWidget.border": border,
      "editorError.foreground": destructive,
      "editorWarning.foreground": warning,
      "editorOverviewRuler.border": border,
      "scrollbarSlider.background": `${gutter}33`,
      "scrollbarSlider.hoverBackground": `${gutter}55`,
      "scrollbarSlider.activeBackground": `${gutter}77`,
    },
  });
}

/* --- Diagnostics provider ------------------------------------------------- */

export function toMonacoMarkers(
  monaco: MonacoApi,
  diagnostics: readonly TgsDiagnostic[],
): MonacoNs.editor.IMarkerData[] {
  return diagnostics.map((d) => ({
    severity: monaco.MarkerSeverity.Warning,
    message: d.message,
    startLineNumber: d.line,
    startColumn: d.column,
    endLineNumber: d.line,
    endColumn: d.endColumn,
    source: "tgs",
  }));
}

const SEVERITY_KEYS = {
  error: "Error",
  warning: "Warning",
  info: "Info",
} as const;

export type ExternalMarker = {
  line: number;
  column?: number;
  message: string;
  severity: "error" | "warning" | "info";
};

/** Maps `<MonacoEditor markers={...} />` entries onto whole-line Monaco markers. */
export function externalMarkersToMonaco(
  monaco: MonacoApi,
  markers: readonly ExternalMarker[],
  model: MonacoNs.editor.ITextModel | null,
): MonacoNs.editor.IMarkerData[] {
  const lineCount = model?.getLineCount() ?? Number.MAX_SAFE_INTEGER;
  return markers.map((m) => {
    const line = Math.min(Math.max(1, Math.floor(m.line)), Math.max(1, lineCount));
    const startColumn = Math.max(1, Math.floor(m.column ?? 1));
    const endColumn = model ? model.getLineMaxColumn(line) : startColumn + 1;
    return {
      severity: monaco.MarkerSeverity[SEVERITY_KEYS[m.severity]],
      message: m.message,
      startLineNumber: line,
      startColumn,
      endLineNumber: line,
      endColumn: Math.max(endColumn, startColumn + 1),
      source: "tgs",
    };
  });
}

const trackedModels = new WeakSet<object>();

/** Runs {@link zeroTrustDiagnostics} over one TypeScript model. */
export function lintModel(monaco: MonacoApi, model: MonacoNs.editor.ITextModel): void {
  if (model.isDisposed()) return;
  const language = model.getLanguageId();
  if (language !== "typescript" && language !== "javascript") return;
  monaco.editor.setModelMarkers(
    model,
    TGS_DIAGNOSTICS_OWNER,
    toMonacoMarkers(monaco, zeroTrustDiagnostics(model.getValue())),
  );
}

/**
 * Attaches the lint to every current and future model. Idempotent: a model is
 * only ever subscribed once.
 */
export function attachZeroTrustDiagnostics(monaco: MonacoApi): void {
  const track = (model: MonacoNs.editor.ITextModel): void => {
    if (trackedModels.has(model)) return;
    trackedModels.add(model);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changeSub = model.onDidChangeContent(() => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => lintModel(monaco, model), 200);
    });
    const disposeSub = model.onWillDispose(() => {
      if (timer !== undefined) clearTimeout(timer);
      changeSub.dispose();
      disposeSub.dispose();
    });
    lintModel(monaco, model);
  };

  monaco.editor.getModels().forEach(track);
  monaco.editor.onDidCreateModel(track);
}

/* --- Entry point ---------------------------------------------------------- */

let configuredFor: MonacoApi | null = null;

/** One-time, idempotent configuration of a Monaco namespace. */
export function configureMonaco(monaco: MonacoApi): void {
  if (configuredFor === monaco) return;
  configuredFor = monaco;
  configureTypeScriptDefaults(monaco);
  configureExtraLibs(monaco);
  configureJsonDefaults(monaco);
  defineTgsTheme(monaco);
  attachZeroTrustDiagnostics(monaco);
}

/** Test-only escape hatch so `configureMonaco` can be re-run against a fake. */
export function resetMonacoConfigurationForTests(): void {
  configuredFor = null;
}
