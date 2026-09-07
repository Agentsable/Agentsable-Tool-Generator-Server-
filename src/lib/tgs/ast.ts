/**
 * TGS AST extraction / recombination engine.
 *
 * Implements `docs/llm_generated/11-screen-editor.md` §3: the Editor shows only
 * imperative logic, with the declarative `baseConfig` / `export const config`
 * block abstracted out behind a single comment stub. Saving recombines the
 * stored config object back into the exact position it came from.
 *
 * The TypeScript compiler API is the parser (it bundles into the browser, so the
 * same code runs in Monaco's host page and in Node tests). No `eval` is ever
 * used: config object literals are walked node-by-node and converted to plain
 * JavaScript values, and anything that is not a literal is preserved verbatim as
 * a `__raw` marker instead of being silently dropped.
 */

import * as ts from "typescript";
import type { ToolConfig } from "@/lib/tgs/contract";

/** The read-only comment that stands in for the config block in the Editor. */
export const CONFIG_STUB = "/* [CONFIG_STUB]: Configuration managed in Config Tab */";

/** Matches the stub even if the user reflowed the wording inside it. */
export const CONFIG_STUB_RE = /\/\*\s*\[CONFIG_STUB\][^*]*\*+(?:[^/*][^*]*\*+)*\//;

/** Module specifier used when re-emitting the `initToolConfig` import from scratch. */
export const DEFAULT_INIT_TOOL_CONFIG_IMPORT = "/core/utils/initToolConfig.ts";

/** Module specifier used when re-emitting the `ToolConfig` type import from scratch. */
export const DEFAULT_TOOL_CONTRACT_IMPORT = "/core/contracts/ToolContract.ts";

/** A config value that could not be evaluated: its source text, re-emitted verbatim. */
export type RawMarker = { __raw: string };

/**
 * A whole object-literal member that could not be evaluated (spread, method,
 * shorthand, accessor): its source text, re-emitted verbatim in place of
 * `key: value`. Stored under a synthetic `__rawProperty_N` key.
 */
export type RawPropertyMarker = { __rawProperty: string };

export type ExtractedTool = {
  /** The logic-only source shown in the Editor: config declarations replaced by CONFIG_STUB. */
  logic: string;
  /** The config object literal evaluated to a real JS object, or null when none was found. */
  config: Partial<ToolConfig> | null;
  /** Verbatim source text of the extracted config object literal (for lossless re-emit when unchanged). */
  configSource: string | null;
  /** True when the file used `export const config = await initToolConfig(import.meta.url, baseConfig)`. */
  usesInitToolConfig: boolean;
  /** Import specifier initToolConfig came from, so recombination re-emits it exactly. */
  initToolConfigImport: string | null;
  /** Import specifier the `ToolConfig` type came from, when it was dropped as unreferenced. */
  toolConfigTypeImport: string | null;
  diagnostics: string[];
};

export type RecombineOptions = {
  /** Emit the `baseConfig` + `initToolConfig` pair (default) or a bare `export const config`. */
  usesInitToolConfig?: boolean;
  /** Module specifier for the `initToolConfig` import. */
  initToolConfigImport?: string | null;
  /** Module specifier for the `ToolConfig` type import; `null` suppresses type annotations. */
  toolConfigTypeImport?: string | null;
  /** Verbatim object-literal source to re-emit instead of serializing `config`. */
  configSource?: string | null;
};

export type RecombineResult = {
  code: string;
  /** False when the user deleted the stub and the config had to be appended after the imports. */
  stubFound: boolean;
  diagnostics: string[];
};

/* ------------------------------------------------------------------ */
/* Raw markers                                                         */
/* ------------------------------------------------------------------ */

export function isRawMarker(value: unknown): value is RawMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { __raw?: unknown }).__raw === "string"
  );
}

export function isRawPropertyMarker(value: unknown): value is RawPropertyMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { __rawProperty?: unknown }).__rawProperty === "string"
  );
}

/* ------------------------------------------------------------------ */
/* Extraction                                                          */
/* ------------------------------------------------------------------ */

type RangeKind = "config" | "import";

type Range = {
  start: number;
  end: number;
  kind: RangeKind;
  /** True when `end` swallowed the statement's trailing newline. */
  consumedNewline: boolean;
};

type Edit = { start: number; end: number; text: string };

function parse(code: string): ts.SourceFile {
  return ts.createSourceFile("tool.ts", code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

/** Extend `end` past trailing horizontal whitespace and at most one newline. */
function consumeToLineEnd(text: string, end: number): { end: number; consumedNewline: boolean } {
  let i = end;
  while (i < text.length) {
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === "\r") i += 1;
    else break;
  }
  if (text[i] === "\n") return { end: i + 1, consumedNewline: true };
  return { end, consumedNewline: false };
}

/** Peel `as X`, `satisfies X`, `<X>expr` and parentheses off an expression. */
function unwrap(node: ts.Expression): ts.Expression {
  let current: ts.Expression = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) current = current.expression;
    else if (ts.isAsExpression(current)) current = current.expression;
    else if (ts.isSatisfiesExpression(current)) current = current.expression;
    else if (ts.isTypeAssertionExpression(current)) current = current.expression;
    else if (ts.isNonNullExpression(current)) current = current.expression;
    else if (ts.isAwaitExpression(current)) current = current.expression;
    else return current;
  }
}

function calleeName(expr: ts.Expression): string | null {
  const callee = unwrap(expr);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

function namedImportSpecifiers(node: ts.ImportDeclaration): ts.ImportSpecifier[] {
  const bindings = node.importClause?.namedBindings;
  if (bindings && ts.isNamedImports(bindings)) return [...bindings.elements];
  return [];
}

function moduleSpecifierText(node: ts.ImportDeclaration): string | null {
  return ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
}

/**
 * Split a tool source file into logic (with the config block replaced by
 * `CONFIG_STUB`) and the config object as a plain JavaScript value.
 */
export function extractTool(tsCode: string): ExtractedTool {
  const sf = parse(tsCode);
  const diagnostics: string[] = [];

  let baseConfigStmt: ts.VariableStatement | null = null;
  let configStmt: ts.VariableStatement | null = null;
  let baseConfigLiteral: ts.ObjectLiteralExpression | null = null;
  let configLiteralFromConfigStmt: ts.ObjectLiteralExpression | null = null;
  let usesInitToolConfig = false;

  let initImportDecl: ts.ImportDeclaration | null = null;
  let initImportSpec: ts.ImportSpecifier | null = null;
  let initToolConfigImport: string | null = null;

  let toolConfigImportDecl: ts.ImportDeclaration | null = null;
  let toolConfigImportSpec: ts.ImportSpecifier | null = null;
  let toolConfigTypeImportSpecifier: string | null = null;

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      for (const spec of namedImportSpecifiers(stmt)) {
        const localName = spec.name.text;
        const importedName = spec.propertyName?.text ?? localName;
        if (importedName === "initToolConfig" && initImportSpec === null) {
          initImportDecl = stmt;
          initImportSpec = spec;
          initToolConfigImport = moduleSpecifierText(stmt);
        }
        if (importedName === "ToolConfig" && toolConfigImportSpec === null) {
          toolConfigImportDecl = stmt;
          toolConfigImportSpec = spec;
          toolConfigTypeImportSpecifier = moduleSpecifierText(stmt);
        }
      }
      continue;
    }

    if (!ts.isVariableStatement(stmt)) continue;
    const decls = stmt.declarationList.declarations;
    const decl = decls[0];
    if (!decl || !ts.isIdentifier(decl.name)) continue;
    const name = decl.name.text;
    if (name !== "baseConfig" && name !== "config") continue;
    if (decls.length > 1) {
      diagnostics.push(
        `Declaration "${name}" shares a variable statement with other declarations; skipped.`,
      );
      continue;
    }

    const init = decl.initializer ? unwrap(decl.initializer) : undefined;

    if (name === "baseConfig") {
      if (baseConfigStmt !== null) {
        diagnostics.push('Multiple "baseConfig" declarations found; using the first.');
        continue;
      }
      baseConfigStmt = stmt;
      if (init && ts.isObjectLiteralExpression(init)) baseConfigLiteral = init;
      else diagnostics.push('"baseConfig" is not initialised with an object literal.');
      continue;
    }

    if (configStmt !== null) {
      diagnostics.push('Multiple "config" declarations found; using the first.');
      continue;
    }
    configStmt = stmt;
    if (init && ts.isCallExpression(init) && calleeName(init.expression) === "initToolConfig") {
      usesInitToolConfig = true;
      for (const arg of init.arguments) {
        const unwrapped = unwrap(arg);
        if (ts.isObjectLiteralExpression(unwrapped)) {
          configLiteralFromConfigStmt = unwrapped;
          break;
        }
      }
    } else if (init && ts.isObjectLiteralExpression(init)) {
      configLiteralFromConfigStmt = init;
    } else if (init) {
      diagnostics.push('"config" is not initialised with an object literal or initToolConfig().');
    }
  }

  const configLiteral = baseConfigLiteral ?? configLiteralFromConfigStmt;
  const removedStatements: ts.VariableStatement[] = [];
  if (baseConfigStmt) removedStatements.push(baseConfigStmt);
  if (configStmt) removedStatements.push(configStmt);

  if (removedStatements.length === 0) {
    diagnostics.push("No `baseConfig` or `config` declaration found; source left untouched.");
    return {
      logic: tsCode,
      config: null,
      configSource: null,
      usesInitToolConfig: false,
      initToolConfigImport,
      toolConfigTypeImport: null,
      diagnostics,
    };
  }

  const configRanges: Range[] = removedStatements
    .map((stmt) => {
      const start = stmt.getStart(sf, false);
      const consumed = consumeToLineEnd(tsCode, stmt.getEnd());
      return {
        start,
        end: consumed.end,
        kind: "config" as const,
        consumedNewline: consumed.consumedNewline,
      };
    })
    .sort((a, b) => a.start - b.start);

  const mergedConfigRanges = mergeAdjacent(tsCode, configRanges);
  if (mergedConfigRanges.length > 1) {
    diagnostics.push(
      "The baseConfig and config declarations are not adjacent; the stub marks the first of them.",
    );
  }

  const edits: Edit[] = [];
  mergedConfigRanges.forEach((range, index) => {
    edits.push({
      start: range.start,
      end: range.end,
      text: index === 0 ? CONFIG_STUB + (range.consumedNewline ? "\n" : "") : "",
    });
  });

  // The initToolConfig import exists only to serve the removed statement.
  if (initImportDecl && initImportSpec) {
    edits.push(removeImportSpecifierEdit(tsCode, sf, initImportDecl, initImportSpec));
  }

  // `ToolConfig` is usually only referenced by the removed config block; drop it
  // from its type import when nothing in the remaining logic still uses it.
  let toolConfigTypeImport: string | null = null;
  if (toolConfigImportDecl && toolConfigImportSpec) {
    const stillReferenced = hasIdentifierOutside(sf, "ToolConfig", mergedConfigRanges);
    if (!stillReferenced) {
      toolConfigTypeImport = toolConfigTypeImportSpecifier;
      edits.push(removeImportSpecifierEdit(tsCode, sf, toolConfigImportDecl, toolConfigImportSpec));
    }
  }

  const logic = applyEdits(tsCode, edits);

  const config = configLiteral
    ? (objectLiteralToValue(configLiteral, sf, [], diagnostics) as unknown as Partial<ToolConfig>)
    : null;
  if (!configLiteral)
    diagnostics.push("Config declaration found but no object literal to extract.");

  return {
    logic,
    config,
    configSource: configLiteral ? configLiteral.getText(sf) : null,
    usesInitToolConfig,
    initToolConfigImport,
    toolConfigTypeImport,
    diagnostics,
  };
}

function mergeAdjacent(text: string, ranges: Range[]): Range[] {
  const out: Range[] = [];
  for (const range of ranges) {
    const previous = out[out.length - 1];
    if (
      previous &&
      previous.kind === range.kind &&
      text.slice(previous.end, range.start).trim() === ""
    ) {
      previous.end = range.end;
      previous.consumedNewline = range.consumedNewline;
      continue;
    }
    out.push({ ...range });
  }
  return out;
}

/**
 * Remove one named binding from an import. When it is the only binding the whole
 * import statement (and its line) goes; otherwise the sibling bindings survive.
 */
function removeImportSpecifierEdit(
  text: string,
  sf: ts.SourceFile,
  decl: ts.ImportDeclaration,
  spec: ts.ImportSpecifier,
): Edit {
  const specifiers = namedImportSpecifiers(decl);
  const hasDefault = decl.importClause?.name !== undefined;
  if (specifiers.length === 1 && !hasDefault) {
    const consumed = consumeToLineEnd(text, decl.getEnd());
    return { start: decl.getStart(sf, false), end: consumed.end, text: "" };
  }
  const index = specifiers.indexOf(spec);
  const previous = index > 0 ? specifiers[index - 1] : undefined;
  if (previous) return { start: previous.getEnd(), end: spec.getEnd(), text: "" };
  const next = specifiers[index + 1];
  if (next) return { start: spec.getStart(sf, false), end: next.getStart(sf, false), text: "" };
  return { start: spec.getStart(sf, false), end: spec.getEnd(), text: "" };
}

/** True when `name` appears outside every removed range and outside import statements. */
function hasIdentifierOutside(sf: ts.SourceFile, name: string, removed: Range[]): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node) && node.text === name) {
      const pos = node.getStart(sf, false);
      const inside = removed.some((range) => pos >= range.start && pos < range.end);
      if (!inside) {
        found = true;
        return;
      }
    }
    node.forEachChild(visit);
  };
  sf.forEachChild(visit);
  return found;
}

function applyEdits(text: string, edits: Edit[]): string {
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  let out = text;
  for (const edit of ordered) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Object literal -> plain JavaScript value                            */
/* ------------------------------------------------------------------ */

function propertyKey(name: ts.PropertyName, sf: ts.SourceFile): string | null {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const expr = unwrap(name.expression);
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
    if (ts.isNumericLiteral(expr)) return expr.text;
  }
  void sf;
  return null;
}

function pathLabel(path: string[]): string {
  return path.length > 0 ? path.join(".") : "<root>";
}

export function objectLiteralToValue(
  node: ts.ObjectLiteralExpression,
  sf: ts.SourceFile,
  path: string[],
  diagnostics: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let rawIndex = 0;
  for (const prop of node.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const key = propertyKey(prop.name, sf);
      if (key === null) {
        const synthetic = `__rawProperty_${rawIndex}`;
        rawIndex += 1;
        out[synthetic] = { __rawProperty: prop.getText(sf) };
        diagnostics.push(
          `Computed property name at "${pathLabel(path)}" preserved verbatim as raw source.`,
        );
        continue;
      }
      out[key] = expressionToValue(prop.initializer, sf, [...path, key], diagnostics);
      continue;
    }
    const synthetic = `__rawProperty_${rawIndex}`;
    rawIndex += 1;
    out[synthetic] = { __rawProperty: prop.getText(sf) };
    diagnostics.push(
      `Unsupported object member (${ts.SyntaxKind[prop.kind]}) at "${pathLabel(
        path,
      )}" preserved verbatim as raw source.`,
    );
  }
  return out;
}

export function expressionToValue(
  node: ts.Expression,
  sf: ts.SourceFile,
  path: string[],
  diagnostics: string[],
): unknown {
  const expr = unwrap(node);

  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expr.kind === ts.SyntaxKind.NullKeyword) return null;

  if (ts.isPrefixUnaryExpression(expr)) {
    const operand = unwrap(expr.operand);
    if (ts.isNumericLiteral(operand)) {
      if (expr.operator === ts.SyntaxKind.MinusToken) return -Number(operand.text);
      if (expr.operator === ts.SyntaxKind.PlusToken) return Number(operand.text);
    }
  }

  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements.map((element, index) => {
      if (ts.isSpreadElement(element)) {
        diagnostics.push(
          `Spread element at "${pathLabel([...path, String(index)])}" preserved verbatim as raw source.`,
        );
        return { __raw: element.getText(sf) };
      }
      if (element.kind === ts.SyntaxKind.OmittedExpression) return null;
      return expressionToValue(element, sf, [...path, String(index)], diagnostics);
    });
  }

  if (ts.isObjectLiteralExpression(expr)) return objectLiteralToValue(expr, sf, path, diagnostics);

  diagnostics.push(
    `Unsupported expression (${ts.SyntaxKind[expr.kind]}) at "${pathLabel(
      path,
    )}" preserved verbatim as raw source.`,
  );
  return { __raw: expr.getText(sf) };
}

/* ------------------------------------------------------------------ */
/* Serialization                                                       */
/* ------------------------------------------------------------------ */

/** Canonical top-level key order for a serialized `ToolConfig` literal. */
export const CANONICAL_CONFIG_KEY_ORDER: readonly string[] = [
  "name",
  "version",
  "icon",
  "tags",
  "description",
  "mcpDescription",
  "secrets",
  "tool_dependencies",
  "network_requests",
  "permissions",
  "timeoutMs",
  "isIdempotent",
  "cost",
  "rateLimit",
  "outputModality",
  "mcpResources",
  "mcpPrompts",
  "tests",
  "signature",
];

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const INLINE_WIDTH = 72;

/** Canonical keys first, in spec order; everything else after, alphabetically. */
export function orderConfigKeys(keys: string[]): string[] {
  const canonical = CANONICAL_CONFIG_KEY_ORDER.filter((key) => keys.includes(key));
  const rest = keys.filter((key) => !CANONICAL_CONFIG_KEY_ORDER.includes(key)).sort();
  return [...canonical, ...rest];
}

function formatKey(key: string): string {
  return IDENTIFIER_RE.test(key) ? key : JSON.stringify(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrimitive(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    isRawMarker(value)
  );
}

function formatPrimitive(value: unknown): string {
  if (isRawMarker(value)) return value.__raw;
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : String(value);
  return JSON.stringify(value) ?? "null";
}

function serializeValue(value: unknown, indent: number, canonical: boolean): string {
  const pad = " ".repeat(indent);
  const inner = " ".repeat(indent + 2);

  if (isRawMarker(value)) return value.__raw;
  if (isPrimitive(value)) return formatPrimitive(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every(isPrimitive)) {
      const single = `[${value.map(formatPrimitive).join(", ")}]`;
      if (single.length + indent <= INLINE_WIDTH && !single.includes("\n")) return single;
    }
    const items = value.map((item) => inner + serializeValue(item, indent + 2, false));
    return `[\n${items.join(",\n")}\n${pad}]`;
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return "{}";
    const keys = canonical
      ? orderConfigKeys(entries.map(([key]) => key))
      : entries.map(([key]) => key);
    const ordered = keys.map((key) => [key, value[key]] as const);

    const inlineable = ordered.every(
      ([, v]) =>
        isPrimitive(v) && !isRawPropertyMarker(v) && !(isRawMarker(v) && v.__raw.includes("\n")),
    );
    if (inlineable) {
      const single = `{ ${ordered
        .map(([key, v]) => `${formatKey(key)}: ${formatPrimitive(v)}`)
        .join(", ")} }`;
      if (single.length + indent <= INLINE_WIDTH && !single.includes("\n")) return single;
    }

    const lines = ordered.map(([key, v]) => {
      if (isRawPropertyMarker(v)) return inner + v.__rawProperty;
      return `${inner}${formatKey(key)}: ${serializeValue(v, indent + 2, false)}`;
    });
    return `{\n${lines.join(",\n")}\n${pad}}`;
  }

  return "undefined";
}

/**
 * Emit a stable, 2-space-indented TypeScript object literal for a tool config.
 * Top-level keys follow `CANONICAL_CONFIG_KEY_ORDER`, unknown keys alphabetically
 * after them; nested objects keep their own key order.
 */
export function serializeConfigLiteral(config: Partial<ToolConfig>): string {
  return serializeValue(config as unknown as Record<string, unknown>, 0, true);
}

/* ------------------------------------------------------------------ */
/* Recombination                                                       */
/* ------------------------------------------------------------------ */

/** Locate the config stub in an Editor buffer. Returns null when the user deleted it. */
export function findConfigStub(logic: string): { start: number; end: number } | null {
  const exact = logic.indexOf(CONFIG_STUB);
  if (exact >= 0) return { start: exact, end: exact + CONFIG_STUB.length };
  const match = CONFIG_STUB_RE.exec(logic);
  if (match) return { start: match.index, end: match.index + match[0].length };
  return null;
}

function lineBounds(text: string, start: number, end: number): { start: number; end: number } {
  let lineStart = start;
  while (lineStart > 0 && text[lineStart - 1] !== "\n") lineStart -= 1;
  // Only swallow the leading whitespace of the line, never other code.
  if (text.slice(lineStart, start).trim() !== "") lineStart = start;
  let lineEnd = end;
  while (lineEnd < text.length && text[lineEnd] !== "\n") lineEnd += 1;
  if (text.slice(end, lineEnd).trim() !== "") lineEnd = end;
  return { start: lineStart, end: lineEnd };
}

function buildConfigBlock(literal: string, usesInit: boolean, annotate: boolean): string {
  if (usesInit) {
    const declaration = annotate
      ? `const baseConfig: Partial<ToolConfig> = ${literal};`
      : `const baseConfig = ${literal};`;
    const exported = annotate
      ? "export const config = await initToolConfig(import.meta.url, baseConfig) as ToolConfig;"
      : "export const config = await initToolConfig(import.meta.url, baseConfig);";
    return `${declaration}\n\n${exported}`;
  }
  return annotate
    ? `export const config: Partial<ToolConfig> = ${literal};`
    : `export const config = ${literal};`;
}

/**
 * Inject the config block back into an Editor buffer at the stub position,
 * restoring the `initToolConfig` import and the `ToolConfig` type import.
 */
export function recombineToolWithDiagnostics(
  logic: string,
  config: Partial<ToolConfig>,
  opts: RecombineOptions = {},
): RecombineResult {
  const diagnostics: string[] = [];
  const usesInit = opts.usesInitToolConfig ?? true;
  const initImport =
    opts.initToolConfigImport === undefined || opts.initToolConfigImport === null
      ? DEFAULT_INIT_TOOL_CONFIG_IMPORT
      : opts.initToolConfigImport;
  const typeImport =
    opts.toolConfigTypeImport === undefined
      ? DEFAULT_TOOL_CONTRACT_IMPORT
      : opts.toolConfigTypeImport;
  const annotate = typeImport !== null;

  const literal = opts.configSource ?? serializeConfigLiteral(config);
  const block = buildConfigBlock(literal, usesInit, annotate);

  const stub = findConfigStub(logic);
  let code: string;
  let stubFound: boolean;
  if (stub) {
    stubFound = true;
    const line = lineBounds(logic, stub.start, stub.end);
    code = logic.slice(0, line.start) + block + logic.slice(line.end);
  } else {
    stubFound = false;
    diagnostics.push(
      "CONFIG_STUB marker not found in the editor buffer; config appended after the last import.",
    );
    code = appendAfterImports(logic, block);
  }

  code = ensureImports(code, { usesInit, initImport, typeImport, annotate });
  return { code, stubFound, diagnostics };
}

/** Convenience wrapper matching the Editor's save path. */
export function recombineTool(
  logic: string,
  config: Partial<ToolConfig>,
  opts: RecombineOptions = {},
): string {
  return recombineToolWithDiagnostics(logic, config, opts).code;
}

function appendAfterImports(logic: string, block: string): string {
  const sf = parse(logic);
  let anchor = 0;
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) anchor = consumeToLineEnd(logic, stmt.getEnd()).end;
  }
  if (anchor === 0) {
    const suffix = logic.startsWith("\n") ? "" : "\n";
    return `${block}\n${suffix}${logic}`;
  }
  const rest = logic.slice(anchor);
  const separator = rest.startsWith("\n") ? "" : "\n";
  return `${logic.slice(0, anchor)}\n${block}\n${separator}${rest}`;
}

function ensureImports(
  code: string,
  opts: { usesInit: boolean; initImport: string; typeImport: string | null; annotate: boolean },
): string {
  const sf = parse(code);
  const imports = sf.statements.filter(ts.isImportDeclaration);

  let hasInit = false;
  let hasToolConfig = false;
  let typeImportDecl: ts.ImportDeclaration | null = null;
  for (const decl of imports) {
    const specifiers = namedImportSpecifiers(decl);
    for (const spec of specifiers) {
      const imported = spec.propertyName?.text ?? spec.name.text;
      if (imported === "initToolConfig") hasInit = true;
      if (imported === "ToolConfig") hasToolConfig = true;
    }
    if (
      typeImportDecl === null &&
      opts.typeImport !== null &&
      moduleSpecifierText(decl) === opts.typeImport &&
      specifiers.length > 0
    ) {
      typeImportDecl = decl;
    }
  }

  const edits: Edit[] = [];
  const newLines: string[] = [];

  if (opts.usesInit && !hasInit) {
    newLines.push(`import { initToolConfig } from ${JSON.stringify(opts.initImport)};`);
  }

  if (opts.annotate && !hasToolConfig && opts.typeImport !== null) {
    if (typeImportDecl) {
      const specifiers = namedImportSpecifiers(typeImportDecl);
      const last = specifiers[specifiers.length - 1];
      if (last) edits.push({ start: last.getEnd(), end: last.getEnd(), text: ", ToolConfig" });
    } else {
      newLines.push(`import type { ToolConfig } from ${JSON.stringify(opts.typeImport)};`);
    }
  }

  if (newLines.length > 0) {
    const first = imports[0];
    const anchor = first ? first.getStart(sf, false) : 0;
    edits.push({ start: anchor, end: anchor, text: `${newLines.join("\n")}\n` });
  }

  return applyEdits(code, edits);
}
