import { describe, expect, it } from "vitest";

import {
  CONFIG_STUB,
  DEFAULT_INIT_TOOL_CONFIG_IMPORT,
  DEFAULT_TOOL_CONTRACT_IMPORT,
  extractTool,
  findConfigStub,
  recombineTool,
  recombineToolWithDiagnostics,
  serializeConfigLiteral,
  type ExtractedTool,
  type RecombineOptions,
} from "@/lib/tgs/ast";
import { CALC_TS_SOURCE } from "@/lib/tgs/defaultTool";
import type { ToolConfig } from "@/lib/tgs/contract";

/** Re-emit with exactly the shape the source file used. */
function optsFor(extracted: ExtractedTool): RecombineOptions {
  return {
    usesInitToolConfig: extracted.usesInitToolConfig,
    initToolConfigImport: extracted.initToolConfigImport,
    toolConfigTypeImport: extracted.toolConfigTypeImport,
  };
}

const EXPECTED_CALC_CONFIG: Partial<ToolConfig> = {
  name: "calc",
  version: "1.1.0",
  description: "Performs basic mathematical operations safely.",
  secrets: {},
  tool_dependencies: [],
  rateLimit: { requestsPerMinute: 300 },
  outputModality: ["text"],
  signature: {
    inputs: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
        operation: { type: "string", enum: ["add", "subtract", "multiply", "divide"] },
      },
      required: ["a", "b", "operation"],
    },
    outputs: {
      type: "object",
      properties: { result: { type: "number" }, success: { type: "boolean" } },
    },
    errors: {
      DIV_BY_ZERO: {
        description: "Attempted to divide by zero.",
        actionable_advice: "Check if the denominator 'b' is zero before calling.",
      },
    },
  },
  tests: [
    {
      name: "Valid Addition",
      payload: { a: 5, b: 3, operation: "add" },
      expect: { status: 200, hasKey: "result" },
    },
    {
      name: "Divide by Zero Error Handling",
      payload: { a: 10, b: 0, operation: "divide" },
      expect: { status: 400, hasKey: "error" },
    },
  ],
};

describe("extractTool — the canonical calc.ts", () => {
  const extracted = extractTool(CALC_TS_SOURCE);

  it("evaluates the config object literal without eval", () => {
    expect(extracted.diagnostics).toEqual([]);
    expect(extracted.config).toEqual(EXPECTED_CALC_CONFIG);
  });

  it("reads the individual fields the Config tab binds to", () => {
    const config = extracted.config;
    expect(config).not.toBeNull();
    expect(config?.name).toBe("calc");
    expect(config?.version).toBe("1.1.0");
    expect(config?.rateLimit?.requestsPerMinute).toBe(300);
    expect(config?.tests).toHaveLength(2);
    expect(config?.tests?.[0]?.name).toBe("Valid Addition");
    expect(config?.tests?.[1]?.expect.status).toBe(400);
    expect(config?.signature?.errors?.["DIV_BY_ZERO"]?.actionable_advice).toBe(
      "Check if the denominator 'b' is zero before calling.",
    );
  });

  it("hides the whole config block behind exactly one stub", () => {
    expect(extracted.logic).toContain(CONFIG_STUB);
    expect(extracted.logic.split(CONFIG_STUB)).toHaveLength(2);
    expect(extracted.logic).toContain("export default async function execute(");
    expect(extracted.logic).toContain('case "divide":');
    expect(extracted.logic).not.toContain("baseConfig");
    expect(extracted.logic).not.toContain("export const config");
  });

  it("strips the initToolConfig import and the now-unused ToolConfig type import", () => {
    expect(extracted.logic).not.toContain("initToolConfig");
    expect(extracted.logic).toContain(
      'import type { ToolExecutionContext } from "/core/contracts/ToolContract.ts";',
    );
    expect(extracted.logic).not.toContain("ToolConfig }");
    expect(extracted.usesInitToolConfig).toBe(true);
    expect(extracted.initToolConfigImport).toBe("/core/utils/initToolConfig.ts");
    expect(extracted.toolConfigTypeImport).toBe("/core/contracts/ToolContract.ts");
  });

  it("keeps the verbatim source of the config literal", () => {
    expect(extracted.configSource).toContain('name: "calc"');
    expect(extracted.configSource).toContain("// No external API keys needed");
  });
});

describe("round-trip guarantee", () => {
  it("extract -> recombine -> extract is stable for calc.ts", () => {
    const first = extractTool(CALC_TS_SOURCE);
    expect(first.config).not.toBeNull();

    const rebuilt = recombineTool(first.logic, first.config as Partial<ToolConfig>, optsFor(first));
    const second = extractTool(rebuilt);

    expect(second.logic).toBe(first.logic);
    expect(second.config).toEqual(first.config);
    expect(second.diagnostics).toEqual([]);
  });

  it("recombines the calc imports back exactly as the authoring guide has them", () => {
    const first = extractTool(CALC_TS_SOURCE);
    const rebuilt = recombineTool(first.logic, first.config as Partial<ToolConfig>, optsFor(first));

    expect(rebuilt).toContain(
      'import { initToolConfig } from "/core/utils/initToolConfig.ts";\n' +
        'import type { ToolExecutionContext, ToolConfig } from "/core/contracts/ToolContract.ts";',
    );
    expect(rebuilt).toContain("const baseConfig: Partial<ToolConfig> = {");
    expect(rebuilt).toContain(
      "export const config = await initToolConfig(import.meta.url, baseConfig) as ToolConfig;",
    );
    expect(rebuilt.match(/initToolConfig/g)).toHaveLength(3); // import, call, and the identifier in it
    expect(rebuilt).toContain("// 1. Declarative Configuration");
    expect(rebuilt).toContain("// 2. Execution Logic");
  });

  it("reaches a textual fixpoint on the second pass", () => {
    const first = extractTool(CALC_TS_SOURCE);
    const once = recombineTool(first.logic, first.config as Partial<ToolConfig>, optsFor(first));
    const second = extractTool(once);
    const twice = recombineTool(
      second.logic,
      second.config as Partial<ToolConfig>,
      optsFor(second),
    );
    expect(twice).toBe(once);
  });

  it("round-trips a file that uses `export const config = {...}` with no initToolConfig", () => {
    const source = [
      'import type { ToolExecutionContext } from "/core/contracts/ToolContract.ts";',
      "",
      "export const config = {",
      '  name: "echo",',
      '  version: "0.1.0",',
      '  description: "Echoes the payload back.",',
      "  signature: {",
      '    inputs: { type: "object", properties: {} },',
      '    outputs: { type: "object", properties: {} }',
      "  }",
      "};",
      "",
      "export default async function execute(request: Request, context: ToolExecutionContext) {",
      "  return Response.json(await request.json());",
      "}",
      "",
    ].join("\n");

    const first = extractTool(source);
    expect(first.usesInitToolConfig).toBe(false);
    expect(first.config?.name).toBe("echo");
    expect(first.logic).toContain(CONFIG_STUB);
    expect(first.logic).not.toContain("export const config");

    const rebuilt = recombineTool(first.logic, first.config as Partial<ToolConfig>, optsFor(first));
    expect(rebuilt).toContain("export const config");
    expect(rebuilt).not.toContain("initToolConfig");

    const second = extractTool(rebuilt);
    expect(second.logic).toBe(first.logic);
    expect(second.config).toEqual(first.config);
  });

  it("preserves logic the user edited around the stub", () => {
    const first = extractTool(CALC_TS_SOURCE);
    const editedLogic = first.logic
      .replace(CONFIG_STUB, `${CONFIG_STUB}\n\nconst EPSILON = 1e-9; // added by the developer`)
      .replace("let result = 0;", "let result = 0; // running total");

    const rebuilt = recombineTool(editedLogic, first.config as Partial<ToolConfig>, optsFor(first));
    expect(rebuilt).toContain("const EPSILON = 1e-9; // added by the developer");
    expect(rebuilt).toContain("let result = 0; // running total");

    const second = extractTool(rebuilt);
    expect(second.logic).toBe(editedLogic);
    expect(second.config).toEqual(first.config);
  });

  it("re-injects the config when the user deleted the stub", () => {
    const first = extractTool(CALC_TS_SOURCE);
    const withoutStub = first.logic.replace(`${CONFIG_STUB}\n`, "");
    expect(findConfigStub(withoutStub)).toBeNull();

    const result = recombineToolWithDiagnostics(
      withoutStub,
      first.config as Partial<ToolConfig>,
      optsFor(first),
    );
    expect(result.stubFound).toBe(false);
    expect(result.diagnostics.join(" ")).toContain("CONFIG_STUB");

    // Nothing is lost: the config comes back, after the import block.
    const second = extractTool(result.code);
    expect(second.config).toEqual(first.config);
    expect(second.logic).toContain("export default async function execute(");
    const importEnd = result.code.indexOf("/core/contracts/ToolContract.ts");
    expect(result.code.indexOf("const baseConfig")).toBeGreaterThan(importEnd);
    expect(result.code.indexOf("const baseConfig")).toBeLessThan(
      result.code.indexOf("export default async function execute("),
    );
  });
});

describe("raw markers for non-literal config values", () => {
  const source = [
    'import { initToolConfig } from "/core/utils/initToolConfig.ts";',
    'import type { ToolConfig } from "/core/contracts/ToolContract.ts";',
    "",
    "const DEFAULTS = { cost: 1 };",
    "const TIMEOUT = 5000;",
    "",
    "const baseConfig: Partial<ToolConfig> = {",
    '  name: "raw_demo",',
    '  version: "1.0.0",',
    "  ...DEFAULTS,",
    "  timeoutMs: TIMEOUT * 2,",
    "  cost: computeCost(),",
    "  signature: {",
    '    inputs: { type: "object", properties: {} },',
    '    outputs: { type: "object", properties: {} }',
    "  }",
    "};",
    "",
    "export const config = await initToolConfig(import.meta.url, baseConfig) as ToolConfig;",
    "",
    "export default async function execute() {",
    "  return Response.json({});",
    "}",
    "",
  ].join("\n");

  it("records diagnostics instead of dropping the properties", () => {
    const extracted = extractTool(source);
    expect(extracted.diagnostics.length).toBeGreaterThanOrEqual(3);
    const config = extracted.config as Record<string, unknown>;
    expect(config["timeoutMs"]).toEqual({ __raw: "TIMEOUT * 2" });
    expect(config["cost"]).toEqual({ __raw: "computeCost()" });
    expect(config["__rawProperty_0"]).toEqual({ __rawProperty: "...DEFAULTS" });
  });

  it("re-emits raw markers verbatim and survives a round trip", () => {
    const first = extractTool(source);
    const literal = serializeConfigLiteral(first.config as Partial<ToolConfig>);
    expect(literal).toContain("timeoutMs: TIMEOUT * 2");
    expect(literal).toContain("cost: computeCost()");
    expect(literal).toContain("...DEFAULTS");
    expect(literal).not.toContain("__raw");

    const rebuilt = recombineTool(first.logic, first.config as Partial<ToolConfig>, optsFor(first));
    const second = extractTool(rebuilt);
    expect(second.config).toEqual(first.config);
    expect(second.logic).toBe(first.logic);
  });
});

describe("serializeConfigLiteral", () => {
  it("emits canonical key order with unknown keys alphabetically after", () => {
    const literal = serializeConfigLiteral({
      signature: {
        inputs: { type: "object", properties: {} },
        outputs: { type: "object", properties: {} },
      },
      version: "2.0.0",
      name: "ordered",
      zzz: 1,
      aaa: 2,
      description: "d",
    } as unknown as Partial<ToolConfig>);

    const keyOrder = [...literal.matchAll(/^ {2}([A-Za-z_$][\w$]*):/gm)].map((m) => m[1]);
    expect(keyOrder).toEqual(["name", "version", "description", "signature", "aaa", "zzz"]);
  });

  it("quotes keys only when they are not valid identifiers", () => {
    const literal = serializeConfigLiteral({
      name: "q",
      signature: {
        inputs: {
          type: "object",
          properties: { "not-an-ident": { type: "string" }, ok$1: { type: "string" } },
        },
        outputs: { type: "object", properties: {} },
      },
    } as unknown as Partial<ToolConfig>);
    expect(literal).toContain('"not-an-ident":');
    expect(literal).toContain("ok$1:");
  });

  it("indents with two spaces and keeps empty containers compact", () => {
    const literal = serializeConfigLiteral({
      name: "n",
      secrets: {},
      tool_dependencies: [],
      tags: ["a", "b"],
    } as unknown as Partial<ToolConfig>);
    expect(literal).toContain("  secrets: {}");
    expect(literal).toContain("  tool_dependencies: []");
    expect(literal).toContain('  tags: ["a", "b"]');
    expect(literal.startsWith('{\n  name: "n"')).toBe(true);
  });
});

describe("edge cases", () => {
  it("keeps sibling named imports when initToolConfig is not alone", () => {
    const source = [
      'import { initToolConfig, somethingElse } from "/core/utils/initToolConfig.ts";',
      "",
      'const baseConfig = { name: "x", version: "1", description: "d", signature: { inputs: { type: "object", properties: {} }, outputs: { type: "object", properties: {} } } };',
      "",
      "export const config = await initToolConfig(import.meta.url, baseConfig);",
      "",
      "export default async function execute() { return Response.json({ ok: somethingElse }); }",
      "",
    ].join("\n");

    const extracted = extractTool(source);
    expect(extracted.logic).toContain(
      'import { somethingElse } from "/core/utils/initToolConfig.ts";',
    );
    expect(extracted.logic).not.toContain("{ initToolConfig");
    expect(extracted.config?.name).toBe("x");
  });

  it("keeps the ToolConfig type import when the logic still references it", () => {
    const source = [
      'import { initToolConfig } from "/core/utils/initToolConfig.ts";',
      'import type { ToolConfig } from "/core/contracts/ToolContract.ts";',
      "",
      'const baseConfig: Partial<ToolConfig> = { name: "x", version: "1", description: "d", signature: { inputs: { type: "object", properties: {} }, outputs: { type: "object", properties: {} } } };',
      "",
      "export const config = await initToolConfig(import.meta.url, baseConfig) as ToolConfig;",
      "",
      "export function describeConfig(c: ToolConfig): string { return c.name; }",
      "",
    ].join("\n");

    const extracted = extractTool(source);
    expect(extracted.logic).toContain(
      'import type { ToolConfig } from "/core/contracts/ToolContract.ts";',
    );
    expect(extracted.toolConfigTypeImport).toBeNull();
  });

  it("leaves a file with no config declaration untouched", () => {
    const source = "export default async function execute() { return Response.json({}); }\n";
    const extracted = extractTool(source);
    expect(extracted.logic).toBe(source);
    expect(extracted.config).toBeNull();
    expect(extracted.configSource).toBeNull();
    expect(extracted.diagnostics.join(" ")).toContain("No `baseConfig` or `config` declaration");
  });

  it("falls back to the default import specifiers when none were recorded", () => {
    const logic = `${CONFIG_STUB}\n\nexport default async function execute() {\n  return Response.json({});\n}\n`;
    const code = recombineTool(logic, { name: "fresh" } as Partial<ToolConfig>);
    expect(code).toContain(`import { initToolConfig } from "${DEFAULT_INIT_TOOL_CONFIG_IMPORT}";`);
    expect(code).toContain(`import type { ToolConfig } from "${DEFAULT_TOOL_CONTRACT_IMPORT}";`);
    expect(extractTool(code).config).toEqual({ name: "fresh" });
  });

  it("re-emits a verbatim configSource when asked to", () => {
    const first = extractTool(CALC_TS_SOURCE);
    const code = recombineTool(first.logic, first.config as Partial<ToolConfig>, {
      ...optsFor(first),
      configSource: first.configSource,
    });
    expect(code).toBe(CALC_TS_SOURCE);
  });
});
