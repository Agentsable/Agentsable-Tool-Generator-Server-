import { describe, expect, it } from "vitest";

import type { ToolConfig, ToolTest } from "@/lib/tgs/contract";
import { CONFIG_STUB, extractTool } from "@/lib/tgs/ast";
import { CALC_JSON_TESTS, CALC_TS_SOURCE, createDefaultBundle } from "@/lib/tgs/defaultTool";
import {
  allTests,
  configDiff,
  declaredSecretKeys,
  embeddedTests,
  fileNames,
  parseBundleFromFiles,
  parseBundleFromFilesDetailed,
  parseToolTs,
  renameTool,
  renderBundle,
  validateToolTest,
  type ToolBundle,
} from "@/lib/tgs/toolFiles";

describe("fileNames", () => {
  it("derives all four filenames from the tool name", () => {
    expect(fileNames("calc")).toEqual({
      ts: "calc.ts",
      json: "calc.json",
      env: "calc.env",
      tests: "calc_tests.json",
    });
    expect(fileNames("weather_fetcher").tests).toBe("weather_fetcher_tests.json");
  });

  it("falls back to a placeholder name for a blank tool name", () => {
    expect(fileNames("   ").ts).toBe("untitled_tool.ts");
  });
});

describe("the default calc bundle", () => {
  const bundle = createDefaultBundle();

  it("is seeded from the verbatim authoring-guide calc.ts", () => {
    expect(CALC_TS_SOURCE).toContain("const baseConfig: Partial<ToolConfig> = {");
    expect(bundle.name).toBe("calc");
    expect(bundle.logic).toContain(CONFIG_STUB);
    expect(bundle.logic).toContain("export default async function execute(");
    expect(bundle.config.version).toBe("1.1.0");
    expect(bundle.config.rateLimit?.requestsPerMinute).toBe(300);
  });

  it("starts with configJson as an independent copy of the embedded config", () => {
    expect(bundle.configJson).toEqual(bundle.config);
    expect(bundle.configJson).not.toBe(bundle.config);
    expect(configDiff(bundle.config, bundle.configJson)).toEqual([]);
  });

  it("carries the external Missing Payload test", () => {
    expect(bundle.jsonTests).toEqual(CALC_JSON_TESTS);
    expect(bundle.jsonTests[0]?.name).toBe("Missing Payload");
    expect(bundle.jsonTests[0]?.expect).toEqual({ status: 400, hasKey: "error" });
  });
});

describe("renderBundle", () => {
  const bundle = createDefaultBundle();

  it("renders the .ts by recombining logic with the embedded config", () => {
    const rendered = renderBundle(bundle);
    expect(rendered.ts).toContain(
      'import { initToolConfig } from "/core/utils/initToolConfig.ts";',
    );
    expect(rendered.ts).toContain("const baseConfig: Partial<ToolConfig> = {");
    expect(rendered.ts).toContain(
      "export const config = await initToolConfig(import.meta.url, baseConfig) as ToolConfig;",
    );
    expect(rendered.ts).toContain("export default async function execute(");
    expect(rendered.ts).not.toContain(CONFIG_STUB);
    expect(extractTool(rendered.ts).config).toEqual(bundle.config);
  });

  it("renders the standalone .json as pretty-printed JSON", () => {
    const rendered = renderBundle(bundle);
    expect(rendered.json).toBe(JSON.stringify(bundle.configJson, null, 2));
    expect(JSON.parse(rendered.json)).toEqual(bundle.config);
  });

  it("renders _tests.json from the external suite only", () => {
    const rendered = renderBundle(bundle);
    expect(JSON.parse(rendered.tests)).toEqual(CALC_JSON_TESTS);
    expect(rendered.tests).not.toContain("Valid Addition");
  });

  it("renders the .env from declared secrets, in declaration order", () => {
    const withSecrets: ToolBundle = {
      ...bundle,
      config: {
        ...bundle.config,
        secrets: {
          WEATHER_API_KEY: { description: "Key" },
          SLACK_WEBHOOK_URL: { description: "Hook", isOptional: true },
        },
      },
      secrets: {
        SLACK_WEBHOOK_URL: "https://hooks.example/abc",
        WEATHER_API_KEY: "sk-123",
        NOT_DECLARED: "leaked",
      },
    };
    expect(declaredSecretKeys(withSecrets.config)).toEqual([
      "WEATHER_API_KEY",
      "SLACK_WEBHOOK_URL",
    ]);
    expect(renderBundle(withSecrets).env).toBe(
      "WEATHER_API_KEY=sk-123\nSLACK_WEBHOOK_URL=https://hooks.example/abc\n",
    );
    expect(renderBundle(withSecrets).env).not.toContain("NOT_DECLARED");
  });

  it("renders an empty .env when the tool declares no secrets", () => {
    expect(renderBundle(bundle).env).toBe("");
  });
});

describe("parseToolTs / parseBundleFromFiles", () => {
  it("wraps the AST engine and never returns a null config", () => {
    const parsed = parseToolTs(
      "export default async function execute() { return Response.json({}); }",
    );
    expect(parsed.config).toEqual({});
    expect(parsed.diagnostics.length).toBeGreaterThan(0);
  });

  it("round-trips a whole bundle through its four files", () => {
    const bundle = createDefaultBundle();
    const rendered = renderBundle(bundle);
    const reloaded = parseBundleFromFiles({
      ts: rendered.ts,
      json: rendered.json,
      env: rendered.env,
      tests: rendered.tests,
    });

    expect(reloaded.name).toBe("calc");
    expect(reloaded.config).toEqual(bundle.config);
    expect(reloaded.configJson).toEqual(bundle.configJson);
    expect(reloaded.jsonTests).toEqual(bundle.jsonTests);
    expect(reloaded.secrets).toEqual({});
    expect(reloaded.logic).toBe(bundle.logic);
  });

  it("reads secrets out of the .env file", () => {
    const reloaded = parseBundleFromFiles({
      ts: CALC_TS_SOURCE,
      env: "WEATHER_API_KEY=sk-live\n# comment\nEMPTY=\n",
    });
    expect(reloaded.secrets).toEqual({ WEATHER_API_KEY: "sk-live", EMPTY: "" });
  });

  it("falls back through config.name, configJson.name, then the supplied name", () => {
    expect(parseBundleFromFiles({ json: '{"name":"from_json"}' }).name).toBe("from_json");
    expect(parseBundleFromFiles({}, "fallback").name).toBe("fallback");
    expect(parseBundleFromFiles({}).name).toBe("untitled_tool");
  });

  it("reports bad JSON instead of throwing, and drops malformed tests", () => {
    const parsed = parseBundleFromFilesDetailed({
      json: "{ not json",
      tests: '[{"name":"ok","payload":{},"expect":{"status":200}}, {"nope":true}]',
    });
    expect(parsed.bundle.configJson).toEqual({});
    expect(parsed.bundle.jsonTests).toHaveLength(1);
    expect(parsed.diagnostics.join(" ")).toContain("Could not parse the standalone config JSON");
    expect(parsed.diagnostics.join(" ")).toContain("not a ToolTest");
  });
});

describe("test suites", () => {
  const bundle = createDefaultBundle();

  it("splits embedded and external tests, attributing each source", () => {
    expect(embeddedTests(bundle).map((t) => t.name)).toEqual([
      "Valid Addition",
      "Divide by Zero Error Handling",
    ]);
    expect(allTests(bundle)).toEqual([
      { source: "ts", test: bundle.config.tests?.[0] },
      { source: "ts", test: bundle.config.tests?.[1] },
      { source: "json", test: bundle.jsonTests[0] },
    ]);
  });

  it("validates the ToolTest shape", () => {
    expect(validateToolTest({ name: "n", payload: {}, expect: { status: 200 } })).toBe(true);
    expect(validateToolTest({ name: "n", payload: {}, expect: { hasKey: "error" } })).toBe(true);
    expect(validateToolTest({ name: "n", payload: {}, expect: {} })).toBe(true);
    expect(validateToolTest({ payload: {}, expect: {} })).toBe(false);
    expect(validateToolTest({ name: "n", payload: {} })).toBe(false);
    expect(validateToolTest({ name: "n", expect: { status: "200" } })).toBe(false);
    expect(validateToolTest({ name: "n", expect: { hasKey: 1 } })).toBe(false);
    expect(validateToolTest(null)).toBe(false);
    expect(validateToolTest([])).toBe(false);
  });
});

describe("configDiff", () => {
  it("reports the dotted paths where the .ts and .json configs diverge", () => {
    const bundle = createDefaultBundle();
    const diverged: ToolBundle = {
      ...bundle,
      configJson: { ...bundle.configJson, cost: 10, timeoutMs: 20000 },
    };
    // 12-screen-config.md §4: the standalone file is allowed to override.
    expect(configDiff(diverged.config, diverged.configJson)).toEqual(["cost", "timeoutMs"]);
    expect(renderBundle(diverged).json).toContain('"cost": 10');
    expect(renderBundle(diverged).ts).not.toContain("cost");
  });

  it("descends into nested objects and arrays", () => {
    const a = { signature: { inputs: { required: ["a", "b"] } }, tests: [{ name: "x" }] };
    const b = { signature: { inputs: { required: ["a", "c"] } }, tests: [{ name: "y" }] };
    expect(configDiff(a, b)).toEqual(["signature.inputs.required.1", "tests.0.name"]);
  });

  it("reports the array path itself when lengths differ", () => {
    expect(configDiff({ tags: ["a"] }, { tags: ["a", "b"] })).toEqual(["tags"]);
  });

  it("reports a missing key as a difference", () => {
    expect(configDiff({ a: 1 }, {})).toEqual(["a"]);
    expect(configDiff({ a: 1 }, { a: 1 })).toEqual([]);
  });
});

describe("renameTool", () => {
  it("renames all four files and the config name", () => {
    const bundle = createDefaultBundle();
    const renamed = renameTool(bundle, "super_calc");

    expect(renamed.name).toBe("super_calc");
    expect(renamed.config.name).toBe("super_calc");
    expect(renamed.configJson.name).toBe("super_calc");
    expect(fileNames(renamed.name)).toEqual({
      ts: "super_calc.ts",
      json: "super_calc.json",
      env: "super_calc.env",
      tests: "super_calc_tests.json",
    });
    expect(renderBundle(renamed).ts).toContain('name: "super_calc"');
    expect(renderBundle(renamed).json).toContain('"name": "super_calc"');

    // The original bundle is untouched.
    expect(bundle.config.name).toBe("calc");
  });

  it("leaves an empty standalone config empty rather than inventing a name", () => {
    const bundle: ToolBundle = {
      name: "a",
      logic: "",
      config: {} as Partial<ToolConfig>,
      configJson: {} as Partial<ToolConfig>,
      secrets: {},
      jsonTests: [] as ToolTest[],
    };
    expect(renameTool(bundle, "b").configJson).toEqual({});
    expect(renameTool(bundle, "b").config).toEqual({ name: "b" });
  });
});
