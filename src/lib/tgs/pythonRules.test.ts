// Executes the five built-in deterministic rules for real, through Pyodide's
// Node build (the same CPython/wasm runtime the browser worker loads from the
// CDN), against compliant and deliberately non-compliant TypeScript fixtures.
//
// Spec: docs/llm_generated/14-screen-validator.md §3.3.

import { beforeAll, describe, expect, it } from "vitest";
import { loadPyodide, type PyodideInterface } from "pyodide";

import { BUILTIN_PYTHON_RULES, DEFAULT_LLM_RUBRIC } from "@/lib/tgs/pythonRules";

// Mirrors the driver in pyodideWorker.ts: compile the rule in a private
// namespace, call validate(), hand back JSON.
const PYTHON_DRIVER = `
import json
import traceback


def _tgs_run_rule(filename, source, ts_code, config_json_text):
    config_json = json.loads(config_json_text)
    namespace = {"__name__": "__tgs_rule__", "__file__": filename, "__builtins__": __builtins__}
    try:
        exec(compile(source, filename, "exec"), namespace)
        outcome = namespace["validate"](ts_code, config_json)
    except BaseException:
        return json.dumps({"passed": False, "message": "", "error": traceback.format_exc()})
    return json.dumps({"passed": bool(outcome[0]), "message": str(outcome[1])})
`;

type RuleOutcome = { passed: boolean; message: string; error?: string };

let pyodide: PyodideInterface;
let driver: (filename: string, source: string, tsCode: string, configText: string) => string;

function ruleSource(filename: string): string {
  const rule = BUILTIN_PYTHON_RULES.find((r) => r.filename === filename);
  if (rule === undefined) throw new Error(`No built-in rule named ${filename}`);
  return rule.source;
}

function run(filename: string, tsCode: string, config: unknown): RuleOutcome {
  const raw = driver(filename, ruleSource(filename), tsCode, JSON.stringify(config));
  return JSON.parse(raw) as RuleOutcome;
}

function expectPass(filename: string, tsCode: string, config: unknown): RuleOutcome {
  const outcome = run(filename, tsCode, config);
  expect(outcome.passed, `${filename} should pass: ${outcome.error ?? outcome.message}`).toBe(true);
  expect(outcome.error).toBeUndefined();
  return outcome;
}

function expectFail(filename: string, tsCode: string, config: unknown): RuleOutcome {
  const outcome = run(filename, tsCode, config);
  expect(outcome.passed, `${filename} should fail but passed: ${outcome.message}`).toBe(false);
  expect(outcome.error).toBeUndefined();
  expect(outcome.message.length).toBeGreaterThan(0);
  return outcome;
}

// --- Fixtures ---------------------------------------------------------------

/** The compliant example from docs/llm_generated/02-tool-authoring-guide.md §4. */
const CALC_TS = `import { initToolConfig } from "/core/utils/initToolConfig.ts";
import type { ToolExecutionContext, ToolConfig } from "/core/contracts/ToolContract.ts";

// 1. Declarative Configuration
const baseConfig: Partial<ToolConfig> = {
  name: "calc",
  version: "1.1.0",
  description: "Performs basic mathematical operations safely.",

  secrets: {},                           // No external API keys needed
  tool_dependencies: [],                 // Does not call any sibling tools
  rateLimit: { requestsPerMinute: 300 }, // Prevent agent hallucination spam
  outputModality: ["text"],              // Pure JSON output

  signature: {
    inputs: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
        operation: { type: "string", enum: ["add", "subtract", "multiply", "divide"] }
      },
      required: ["a", "b", "operation"]
    },
    outputs: {
      type: "object",
      properties: { result: { type: "number" }, success: { type: "boolean" } }
    },
    errors: {
      "DIV_BY_ZERO": {
        description: "Attempted to divide by zero.",
        actionable_advice: "Check if the denominator 'b' is zero before calling."
      }
    }
  },
  tests: [
    {
      name: "Valid Addition",
      payload: { a: 5, b: 3, operation: "add" },
      expect: { status: 200, hasKey: "result" }
    },
    {
      name: "Divide by Zero Error Handling",
      payload: { a: 10, b: 0, operation: "divide" },
      expect: { status: 400, hasKey: "error" }
    }
  ]
};

export const config = await initToolConfig(import.meta.url, baseConfig) as ToolConfig;

// 2. Execution Logic
export default async function execute(
  request: Request,
  context: ToolExecutionContext
): Promise<Response> {
  try {
    const { a, b, operation } = await request.json();

    if (typeof a !== "number" || typeof b !== "number") {
      return Response.json({ error: "INVALID_INPUT" }, { status: 400 });
    }

    let result = 0;
    switch (operation) {
      case "add": result = a + b; break;
      case "subtract": result = a - b; break;
      case "multiply": result = a * b; break;
      case "divide":
        if (b === 0) return Response.json({ error: "DIV_BY_ZERO" }, { status: 400 });
        result = a / b;
        break;
      default:
        return Response.json({ error: "INVALID_OPERATION" }, { status: 400 });
    }

    // 3. Strict JSON Output
    return Response.json({ success: true, result });

  } catch (error) {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
`;

const CALC_CONFIG = {
  name: "calc",
  version: "1.1.0",
  description: "Performs basic mathematical operations safely.",
  tool_dependencies: [],
  network_requests: [],
  rateLimit: { requestsPerMinute: 300 },
};

/** A compliant gateway tool: template-literal URL, siblings, no bare fetch. */
const GATEWAY_TS = `import { initToolConfig } from "/core/utils/initToolConfig.ts";
import { dispatchToGateway } from "/core/network/network_gateway.ts";
import type { ToolExecutionContext, ToolConfig } from "/core/contracts/ToolContract.ts";

const baseConfig: Partial<ToolConfig> = {
  name: "weather_fetcher",
  tool_dependencies: ["network_gateway", "geocoder"],
  network_requests: ["https://api.open-meteo.com/v1/forecast"],
};

export const config = await initToolConfig(import.meta.url, baseConfig) as ToolConfig;

export default async function execute(
  request: Request,
  context: ToolExecutionContext
): Promise<Response> {
  const { city } = await request.json();
  // Never call fetch() directly — see https://internal.example.com/docs for why.
  const coords = await context.internalFetch("geocoder", { method: "POST" });
  const target = \`https://api.open-meteo.com/v1/forecast?city=\${city}\`;
  const data = await dispatchToGateway(
    { url: target, method: "GET" },
    { ...context, callerConfig: config }
  );
  return Response.json({ success: true, data, coords });
}
`;

const GATEWAY_CONFIG = {
  name: "weather_fetcher",
  tool_dependencies: ["network_gateway", "geocoder"],
  network_requests: ["https://api.open-meteo.com/v1/forecast"],
};

// --- Tests ------------------------------------------------------------------

beforeAll(async () => {
  pyodide = await loadPyodide();
  pyodide.runPython(PYTHON_DRIVER);
  driver = pyodide.globals["get"]("_tgs_run_rule") as typeof driver;
}, 180_000);

describe("BUILTIN_PYTHON_RULES", () => {
  it("ships the five rules from spec §3.3 with the exact filenames", () => {
    expect(BUILTIN_PYTHON_RULES.map((r) => r.filename)).toEqual([
      "rule_no_global_fetch.py",
      "rule_cf_worker_compat.py",
      "rule_has_required_exports.py",
      "rule_dependencies_declared.py",
      "rule_network_allowlist.py",
    ]);
    for (const rule of BUILTIN_PYTHON_RULES) {
      expect(rule.builtin).toBe(true);
      expect(rule.source).toContain("def validate(ts_code: str, config_json: dict)");
    }
  });

  it("keeps the LLM rubric's mandatory JSON output contract", () => {
    expect(DEFAULT_LLM_RUBRIC).toContain("## Mandatory Output Format");
    expect(DEFAULT_LLM_RUBRIC).toContain('"status": "pass" | "fail" | "warn"');
    expect(DEFAULT_LLM_RUBRIC).toContain("Actionable Advice");
    expect(DEFAULT_LLM_RUBRIC).toContain("Rate Limits");
  });
});

describe("compliant tools", () => {
  it("passes all five rules for the calc.ts example from the authoring guide", () => {
    for (const rule of BUILTIN_PYTHON_RULES) {
      expectPass(rule.filename, CALC_TS, CALC_CONFIG);
    }
  });

  it("passes all five rules for a gateway-routed external API tool", () => {
    for (const rule of BUILTIN_PYTHON_RULES) {
      expectPass(rule.filename, GATEWAY_TS, GATEWAY_CONFIG);
    }
  });
});

describe("rule_no_global_fetch.py", () => {
  const FILE = "rule_no_global_fetch.py";

  it("fails on a bare fetch() call and reports its line", () => {
    const code = `export const config = {};

export default async function execute(request, context) {
  const res = await fetch("https://api.example.com/v1/items");
  return Response.json(await res.json());
}
`;
    const outcome = expectFail(FILE, code, { network_requests: [] });
    expect(outcome.message).toContain("line 4");
    expect(outcome.message).toContain("dispatchToGateway");
  });

  it("flags globalThis.fetch() too", () => {
    const code = `export const config = {};
export default async function execute() { return globalThis.fetch("/x"); }
`;
    expect(run(FILE, code, {}).passed).toBe(false);
  });

  it("does not false-positive on internalFetch, member .fetch, comments or strings", () => {
    const code = `import { internalFetch } from "/core/utils/internalFetch.ts";
import { dispatchToGateway } from "/core/network/network_gateway.ts";

export const config = {};

// This comment mentions fetch( on purpose and must not trip the rule.
/* neither must a block comment saying await fetch("https://x.example.com") */
const note = "the string literal fetch( is also harmless";

export default async function execute(request, context) {
  await context.internalFetch("sibling_tool");
  await internalFetch("sibling_tool");
  await httpClient.fetch("/relative");
  await dispatchToGateway({ url: "https://ok.example.com/v1" }, context);
  return Response.json({ ok: true });
}
`;
    expectPass(FILE, code, {
      tool_dependencies: ["sibling_tool", "network_gateway"],
      network_requests: ["https://ok.example.com/"],
    });
  });
});

describe("rule_cf_worker_compat.py", () => {
  const FILE = "rule_cf_worker_compat.py";

  it("fails on node: built-in imports and names the module and line", () => {
    const code = `import { initToolConfig } from "/core/utils/initToolConfig.ts";
import fs from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const config = {};
export default async function execute() { return Response.json({}); }
`;
    const outcome = expectFail(FILE, code, {});
    expect(outcome.message).toContain("node:fs");
    expect(outcome.message).toContain("node:path");
    expect(outcome.message).toContain("node:crypto");
    expect(outcome.message).toContain("Line 2");
  });

  it("fails on bare Node built-ins", () => {
    const code = `import fs from "fs";
import path from "path";
import { spawn } from "child_process";
export const config = {};
`;
    const outcome = expectFail(FILE, code, {});
    expect(outcome.message).toContain("child_process");
  });

  it("fails on CommonJS require()", () => {
    const code = `const helper = require("some-helper");
export const config = {};
`;
    const outcome = expectFail(FILE, code, {});
    expect(outcome.message).toContain("require()");
  });

  it("does not false-positive on /core/ paths or npm packages containing those substrings", () => {
    const code = `import { initToolConfig } from "/core/utils/initToolConfig.ts";
import type { ToolConfig } from "/core/contracts/ToolContract.ts";
import { pathToRegexp } from "path-to-regexp";
import { z } from "zod";
import { streamText } from "ai-stream-helpers";
import local from "./fs-helpers.ts";
// require("fs") inside a comment is fine
const label = "require(\\"fs\\")";
export const config = {};
`;
    expectPass(FILE, code, {});
  });
});

describe("rule_has_required_exports.py", () => {
  const FILE = "rule_has_required_exports.py";

  it("fails when the default execute export is missing", () => {
    const code = `export const config = await initToolConfig(import.meta.url, baseConfig) as ToolConfig;

async function execute(request, context) {
  return Response.json({});
}
`;
    const outcome = expectFail(FILE, code, {});
    expect(outcome.message).toContain("execute");
  });

  it("fails when config is missing", () => {
    const code = `const config = {};
export default async function execute(request, context) { return Response.json({}); }
`;
    const outcome = expectFail(FILE, code, {});
    expect(outcome.message).toContain("config");
  });

  it("accepts a multi-line execute signature", () => {
    const code = `export const config = await initToolConfig(import.meta.url, baseConfig) as ToolConfig;

export default async function execute(
  request: Request,
  context: ToolExecutionContext
): Promise<Response> {
  return Response.json({});
}
`;
    expectPass(FILE, code, {});
  });

  it("accepts `export default execute`", () => {
    const code = `export const config = {};
async function execute(request, context) { return Response.json({}); }
export default execute;
`;
    expectPass(FILE, code, {});
  });

  it("is not fooled by the exports appearing inside a string or comment", () => {
    const code = `export const config = {};
const docs = "export default async function execute(request, context) {}";
// export default async function execute(request, context) {}
`;
    expectFail(FILE, code, {});
  });
});

describe("rule_dependencies_declared.py", () => {
  const FILE = "rule_dependencies_declared.py";

  it("fails when an internalFetch target is not declared", () => {
    const code = `export const config = {};
export default async function execute(request, context) {
  const res = await context.internalFetch("secret_tool", { method: "POST" });
  return Response.json(await res.json());
}
`;
    const outcome = expectFail(FILE, code, { tool_dependencies: ["other_tool"] });
    expect(outcome.message).toContain("secret_tool");
    expect(outcome.message).toContain("Line 3");
  });

  it("fails when useCoreTool targets an undeclared tool (single quotes too)", () => {
    const code = `export const config = {};
export default async function execute(request, context) {
  return context.useCoreTool('fs_writer', { key: "a.txt" });
}
`;
    const outcome = expectFail(FILE, code, { tool_dependencies: [] });
    expect(outcome.message).toContain("fs_writer");
  });

  it("requires network_gateway to be declared when dispatchToGateway is used", () => {
    const code = `import { dispatchToGateway } from "/core/network/network_gateway.ts";
export const config = {};
export default async function execute(request, context) {
  return dispatchToGateway({ url: "https://api.example.com/v1" }, context);
}
`;
    const outcome = expectFail(FILE, code, {
      tool_dependencies: [],
      network_requests: ["https://api.example.com/"],
    });
    expect(outcome.message).toContain("network_gateway");
  });

  it("passes when every target is declared", () => {
    const code = `export const config = {};
export default async function execute(request, context) {
  await context.internalFetch("geocoder");
  await context.useCoreTool("network_gateway", { url: "https://api.example.com/v1" });
  return Response.json({});
}
`;
    expectPass(FILE, code, {
      tool_dependencies: ["geocoder", "network_gateway"],
      network_requests: ["https://api.example.com/"],
    });
  });
});

describe("rule_network_allowlist.py", () => {
  const FILE = "rule_network_allowlist.py";

  it("fails on a URL outside network_requests", () => {
    const code = `export const config = {};
export default async function execute(request, context) {
  const target = "https://evil.example.com/steal";
  return dispatchToGateway({ url: target }, context);
}
`;
    const outcome = expectFail(FILE, code, {
      tool_dependencies: ["network_gateway"],
      network_requests: ["https://api.open-meteo.com/v1/forecast"],
    });
    expect(outcome.message).toContain("https://evil.example.com/steal");
    expect(outcome.message).toContain("Line 3");
  });

  it("fails when network_requests is empty but the tool targets a URL", () => {
    const code = `export const config = {};
const target = "http://insecure.example.com/data";
`;
    expectFail(FILE, code, { network_requests: [] });
  });

  it("covers a URL by prefix", () => {
    const code = `export const config = {};
const target = "https://api.open-meteo.com/v1/forecast?latitude=1&longitude=2";
`;
    expectPass(FILE, code, {
      network_requests: ["https://api.open-meteo.com/v1/forecast"],
    });
  });

  it("ignores URLs that only appear in comments", () => {
    const code = `// See https://docs.example.com/reference for the payload shape.
/* Related: http://old.example.com/v0 (deprecated) */
export const config = {};
export default async function execute() { return Response.json({}); }
`;
    expectPass(FILE, code, { network_requests: [] });
  });

  it("ignores /core/ and remote import specifiers", () => {
    const code = `import { initToolConfig } from "/core/utils/initToolConfig.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
export const config = {};
`;
    expectPass(FILE, code, { network_requests: [] });
  });
});

describe("rule execution contract", () => {
  it("reports a rule that raises as a failure with an error, without throwing", () => {
    const broken = `def validate(ts_code, config_json):\n    raise ValueError("kaboom")\n`;
    const raw = driver("rule_broken.py", broken, "export const config = {};", "{}");
    const outcome = JSON.parse(raw) as RuleOutcome;
    expect(outcome.passed).toBe(false);
    expect(outcome.error).toContain("kaboom");
  });

  it("reports a rule that does not compile as a failure with an error", () => {
    const broken = `def validate(ts_code, config_json)\n    return True, "oops"\n`;
    const raw = driver("rule_syntax.py", broken, "", "{}");
    const outcome = JSON.parse(raw) as RuleOutcome;
    expect(outcome.passed).toBe(false);
    expect(outcome.error).toContain("SyntaxError");
  });
});
