/**
 * Tests for the shared Monaco subsystem.
 *
 * Monaco itself cannot mount under jsdom (it needs real layout, ResizeObserver
 * and web workers), so the editor is covered here in two ways:
 *   1. a real `renderToString` pass, which is exactly what the TanStack Start
 *      SSR server does — it proves the component never touches window/document
 *      and that the static fallback shows the code with line numbers;
 *   2. unit tests for the pure functions in `monacoSetup.ts` (the two spec'd
 *      linter warnings and the two JSON schemas), which need no Monaco at all.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";

import { MonacoEditor } from "./MonacoEditor";
import {
  buildCodeMask,
  buildCoreModuleMap,
  isNodeBuiltinSpecifier,
  nodeBuiltinMessage,
  TOOL_CONFIG_JSON_SCHEMA,
  TOOL_TESTS_JSON_SCHEMA,
  ZERO_TRUST_FETCH_MESSAGE,
  zeroTrustDiagnostics,
} from "./monacoSetup";

/* -------------------------------------------------------------------------- */
/* SSR safety                                                                  */
/* -------------------------------------------------------------------------- */

describe("MonacoEditor SSR", () => {
  const sample = [
    'import type { ToolExecutionContext } from "/core/contracts/ToolContract.ts";',
    "",
    "export default async function execute() {}",
  ].join("\n");

  it("server-renders without a window/document reference", () => {
    expect(typeof window).toBe("undefined");
    const html = renderToString(
      <MonacoEditor value={sample} language="typescript" path="weather_fetcher.ts" />,
    );
    expect(html).toContain("data-tgs-monaco-fallback");
  });

  it("shows the code and a line number per line in the static fallback", () => {
    const html = renderToString(<MonacoEditor value={sample} language="typescript" />);
    expect(html).toContain("ToolExecutionContext");
    // three lines of sample -> gutter numbers 1..3
    expect(html).toContain(">1</div>");
    expect(html).toContain(">3</div>");
    expect(html).not.toContain(">4</div>");
  });

  it("renders read-only markup when no onChange is supplied", () => {
    const html = renderToString(<MonacoEditor value={sample} language="json" />);
    expect(html).toContain("<pre");
    expect(html).not.toContain("<textarea");
  });

  it("honours the height prop", () => {
    expect(renderToString(<MonacoEditor value="x" language="ini" height={320} />)).toContain(
      "height:320px",
    );
    expect(renderToString(<MonacoEditor value="x" language="markdown" />)).toContain("height:60vh");
  });
});

/* -------------------------------------------------------------------------- */
/* Linter warning 1: zero-trust fetch                                          */
/* -------------------------------------------------------------------------- */

describe("zeroTrustDiagnostics — global fetch", () => {
  it("flags a direct fetch() call", () => {
    const found = zeroTrustDiagnostics('const r = await fetch("https://x.dev");');
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toBe(ZERO_TRUST_FETCH_MESSAGE);
    expect(found[0]?.severity).toBe("warning");
    expect(found[0]?.line).toBe(1);
    expect(found[0]?.column).toBe(17);
    expect(found[0]?.endColumn).toBe(22);
  });

  it("reports the right line in a multi-line file", () => {
    const code = ["// header", "", "async function go() {", "  return fetch(url);", "}"].join("\n");
    const found = zeroTrustDiagnostics(code);
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(4);
    expect(found[0]?.column).toBe(10);
  });

  it("does NOT flag internalFetch(", () => {
    expect(zeroTrustDiagnostics('const r = await internalFetch("tool");')).toEqual([]);
  });

  it("does NOT flag context.internalFetch(", () => {
    expect(
      zeroTrustDiagnostics("await context.internalFetch('calc', { method: 'POST' });"),
    ).toEqual([]);
  });

  it("does NOT flag a .fetch( member call", () => {
    expect(zeroTrustDiagnostics("await gateway.fetch(req);")).toEqual([]);
    expect(zeroTrustDiagnostics("await env.SERVICE?.fetch(req);")).toEqual([]);
  });

  it("does NOT flag occurrences inside line comments", () => {
    expect(zeroTrustDiagnostics("// never call fetch(url) directly")).toEqual([]);
  });

  it("does NOT flag occurrences inside block comments", () => {
    expect(zeroTrustDiagnostics("/**\n * Do not use fetch(url).\n */\nconst a = 1;")).toEqual([]);
  });

  it("does NOT flag occurrences inside string or template literals", () => {
    expect(zeroTrustDiagnostics('const msg = "call fetch(x) instead";')).toEqual([]);
    expect(zeroTrustDiagnostics("const msg = 'fetch(x)';")).toEqual([]);
    expect(zeroTrustDiagnostics("const msg = `no fetch(x) here`;")).toEqual([]);
  });

  it("still flags a fetch inside a template interpolation (real code)", () => {
    const found = zeroTrustDiagnostics("const msg = `result: ${await fetch(url)}`;");
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toBe(ZERO_TRUST_FETCH_MESSAGE);
  });

  it("does not double-report the same position", () => {
    const found = zeroTrustDiagnostics("fetch(a);\nfetch(b);");
    expect(found.map((d) => d.line)).toEqual([1, 2]);
  });

  it("accepts the gateway pattern with no warnings", () => {
    const code = [
      'import { dispatchToGateway } from "/core/network/network_gateway.ts";',
      "const result = await dispatchToGateway({ url: target, method: 'GET' }, context);",
      "const other = await context.useCoreTool('network_gateway', { url: target });",
    ].join("\n");
    expect(zeroTrustDiagnostics(code)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Linter warning 2: Node core modules                                         */
/* -------------------------------------------------------------------------- */

describe("zeroTrustDiagnostics — Node.js built-ins", () => {
  it("flags a node: prefixed import", () => {
    const found = zeroTrustDiagnostics('import fs from "node:fs";');
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toBe(nodeBuiltinMessage("node:fs"));
    expect(found[0]?.message).toContain("Cloudflare Worker isolate violation");
    // range covers the quoted specifier
    expect(found[0]?.column).toBe(16);
    expect(found[0]?.endColumn).toBe(25);
  });

  it("flags bare built-ins", () => {
    for (const mod of ["fs", "path", "child_process", "os", "crypto"]) {
      const found = zeroTrustDiagnostics(`import x from "${mod}";`);
      expect(found.map((d) => d.message)).toEqual([nodeBuiltinMessage(mod)]);
    }
  });

  it("flags side-effect imports, dynamic imports and require()", () => {
    expect(zeroTrustDiagnostics('import "node:path";')).toHaveLength(1);
    expect(zeroTrustDiagnostics('const p = await import("node:path");')).toHaveLength(1);
    expect(zeroTrustDiagnostics('const p = require("child_process");')).toHaveLength(1);
  });

  it("flags a re-export from a built-in", () => {
    expect(zeroTrustDiagnostics('export { join } from "path";')).toHaveLength(1);
  });

  it("does NOT flag /core/ imports or npm packages", () => {
    const code = [
      'import type { ToolExecutionContext } from "/core/contracts/ToolContract.ts";',
      'import { initToolConfig } from "/core/utils/initToolConfig.ts";',
      'import { z } from "zod";',
      'import { pathToThing } from "./pathHelpers.ts";',
    ].join("\n");
    expect(zeroTrustDiagnostics(code)).toEqual([]);
  });

  it("does NOT flag a built-in name mentioned in a comment or a string", () => {
    expect(zeroTrustDiagnostics('// import fs from "node:fs" is banned')).toEqual([]);
    expect(zeroTrustDiagnostics('const doc = "import fs from \\"node:fs\\";";')).toEqual([]);
  });

  it("classifies specifiers correctly", () => {
    expect(isNodeBuiltinSpecifier("node:anything")).toBe(true);
    expect(isNodeBuiltinSpecifier("fs/promises")).toBe(true);
    expect(isNodeBuiltinSpecifier("zod")).toBe(false);
    expect(isNodeBuiltinSpecifier("./path")).toBe(false);
  });

  it("reports both rules together, sorted by position", () => {
    const code = ['import fs from "node:fs";', "", "const r = await fetch(url);"].join("\n");
    const found = zeroTrustDiagnostics(code);
    expect(found.map((d) => d.line)).toEqual([1, 3]);
  });
});

describe("buildCodeMask", () => {
  it("masks comments and strings but keeps real code", () => {
    const code = 'a; // b\n"c";';
    const mask = buildCodeMask(code);
    expect(mask[0]).toBe(1); // a
    expect(mask[3]).toBe(0); // '/'
    expect(mask[6]).toBe(0); // b
    expect(mask[9]).toBe(0); // c inside the string
    expect(mask[11]).toBe(1); // trailing ';'
  });

  it("handles escapes and unterminated strings without hanging", () => {
    expect(() => buildCodeMask('const a = "x\\"y"; const b = \'z')).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* JSON schemas                                                                */
/* -------------------------------------------------------------------------- */

describe("TOOL_CONFIG_JSON_SCHEMA", () => {
  it("requires the ToolConfig identity fields", () => {
    expect([...TOOL_CONFIG_JSON_SCHEMA.required]).toEqual([
      "name",
      "version",
      "description",
      "signature",
    ]);
  });

  it("models secrets as a dictionary of { description, isOptional }", () => {
    const secrets = TOOL_CONFIG_JSON_SCHEMA.properties.secrets;
    expect(secrets.type).toBe("object");
    expect(secrets.additionalProperties.properties.description.type).toBe("string");
    expect(secrets.additionalProperties.properties.isOptional.type).toBe("boolean");
    expect([...secrets.additionalProperties.required]).toEqual(["description"]);
  });

  it("models tool_dependencies and network_requests as string arrays", () => {
    expect(TOOL_CONFIG_JSON_SCHEMA.properties.tool_dependencies.items.type).toBe("string");
    expect(TOOL_CONFIG_JSON_SCHEMA.properties.network_requests.items.type).toBe("string");
  });

  it("types rateLimit.requestsPerMinute as a number", () => {
    expect(TOOL_CONFIG_JSON_SCHEMA.properties.rateLimit.properties.requestsPerMinute.type).toBe(
      "number",
    );
  });

  it("constrains outputModality to the contract's enum", () => {
    expect([...TOOL_CONFIG_JSON_SCHEMA.properties.outputModality.items.enum]).toEqual([
      "text",
      "image",
      "application/pdf",
      "binary",
    ]);
  });

  it("describes the signature's inputs/outputs/errors", () => {
    const signature = TOOL_CONFIG_JSON_SCHEMA.properties.signature;
    expect([...signature.required]).toEqual(["inputs", "outputs"]);
    expect(signature.properties.inputs.properties.properties.type).toBe("object");
    expect(signature.properties.errors.additionalProperties.properties.actionable_advice.type).toBe(
      "string",
    );
  });

  it("embeds the same ToolTest shape as the tests schema", () => {
    expect(TOOL_CONFIG_JSON_SCHEMA.properties.tests.items).toBe(TOOL_TESTS_JSON_SCHEMA.items);
  });
});

describe("TOOL_TESTS_JSON_SCHEMA", () => {
  it("is an array of ToolTest", () => {
    expect(TOOL_TESTS_JSON_SCHEMA.type).toBe("array");
    expect([...TOOL_TESTS_JSON_SCHEMA.items.required]).toEqual(["name", "payload", "expect"]);
  });

  it("allows only status and hasKey in expect", () => {
    const expected = TOOL_TESTS_JSON_SCHEMA.items.properties.expect;
    expect(Object.keys(expected.properties)).toEqual(["status", "hasKey"]);
    expect(expected.additionalProperties).toBe(false);
  });

  it("has a distinct $id from the config schema", () => {
    expect(TOOL_TESTS_JSON_SCHEMA.$id).not.toBe(TOOL_CONFIG_JSON_SCHEMA.$id);
  });
});

/* -------------------------------------------------------------------------- */
/* Injected types                                                              */
/* -------------------------------------------------------------------------- */

describe("buildCoreModuleMap", () => {
  const map = buildCoreModuleMap();

  it("declares the /core modules with and without the .ts extension", () => {
    for (const specifier of [
      "/core/contracts/ToolContract.ts",
      "/core/contracts/ToolContract",
      "/core/utils/initToolConfig.ts",
      "/core/network/network_gateway.ts",
    ]) {
      expect(map).toContain(`declare module "${specifier}"`);
    }
  });

  it("carries the real contract types for autocomplete", () => {
    for (const symbol of [
      "ToolExecutionContext",
      "ToolStorage",
      "ToolConfig",
      "useCoreTool",
      "internalFetch",
      "callerConfig",
    ]) {
      expect(map).toContain(symbol);
    }
  });

  it("declares the initToolConfig and dispatchToGateway stubs", () => {
    expect(map).toContain("function initToolConfig(");
    expect(map).toContain("function dispatchToGateway(");
  });

  it("never emits `declare` inside an already-ambient block (TS1038)", () => {
    expect(map).not.toContain("export declare");
  });
});
