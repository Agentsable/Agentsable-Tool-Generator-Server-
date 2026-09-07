import { describe, expect, it } from "vitest";

import {
  ASSISTANT_SYSTEM_PROMPT,
  AUTHORING_RULES,
  CONFIG_STUB,
  VALIDATOR_JSON_REMINDER,
  buildAssistantContextBlock,
  buildValidatorUserPrompt,
  type ToolContextPayload,
} from "./claudePrompts";

const CTX: ToolContextPayload = {
  toolName: "weather_fetcher",
  tsCode: "export default async function execute(){}",
  configJson: { name: "weather_fetcher", rateLimit: { requestsPerMinute: 300 } },
};

describe("ASSISTANT_SYSTEM_PROMPT", () => {
  it("encodes all 7 authoring rules", () => {
    expect(AUTHORING_RULES).toHaveLength(7);
    for (const rule of AUTHORING_RULES) {
      expect(ASSISTANT_SYSTEM_PROMPT).toContain(rule);
    }
  });

  it("names each rule's key invariant", () => {
    const invariants = [
      "initToolConfig",
      "execute(request, context)",
      "tool_dependencies",
      "secrets",
      "actionable_advice",
      "rateLimit.requestsPerMinute",
      "network_gateway",
      "network_requests",
    ];
    for (const needle of invariants) {
      expect(ASSISTANT_SYSTEM_PROMPT).toContain(needle);
    }
  });

  it("explains the hidden config block and forbids re-emitting it", () => {
    expect(CONFIG_STUB).toBe("/* [CONFIG_STUB]: Configuration managed in Config Tab */");
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(CONFIG_STUB);
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("Do NOT re-emit");
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("replace_execution_logic");
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("patch_tool_config");
  });

  it("states the strict-JSON-via-Web-Response output contract", () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("Web `Response`");
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("strict, minimal JSON");
  });

  it("names the Tool Contract V2 surface and the Workers runtime constraints", () => {
    for (const needle of [
      "ToolConfig",
      "signature",
      "outputModality",
      "mcpResources",
      "ToolExecutionContext",
      "node:fs",
      "WinterCG",
    ]) {
      expect(ASSISTANT_SYSTEM_PROMPT).toContain(needle);
    }
  });
});

describe("buildAssistantContextBlock", () => {
  it("renders the code, config and active tab", () => {
    const block = buildAssistantContextBlock(CTX, "Editor");
    expect(block).toContain("Tool name: weather_fetcher");
    expect(block).toContain("Active tab: Editor");
    expect(block).toContain(CTX.tsCode);
    expect(block).toContain('"requestsPerMinute": 300');
  });

  it("renders Python findings and test results when present", () => {
    const block = buildAssistantContextBlock(
      {
        ...CTX,
        rubricMarkdown: "# rubric",
        pythonFindings: [
          { filename: "rule_cf_worker_compat.py", passed: false, message: "Found node:path" },
          { filename: "rule_no_global_fetch.py", passed: true, message: "ok" },
        ],
        testResults: [{ name: "Valid Addition", source: "config.tests", ok: true, detail: "200" }],
      },
      "Validator",
    );
    expect(block).toContain("[FAIL] rule_cf_worker_compat.py: Found node:path");
    expect(block).toContain("[PASS] rule_no_global_fetch.py: ok");
    expect(block).toContain("[PASS] Valid Addition (config.tests): 200");
    expect(block).toContain("# rubric");
  });

  it("says so explicitly when no findings or tests have been recorded", () => {
    const block = buildAssistantContextBlock(CTX, "Runner");
    expect(block).toContain("(none recorded — the Validator has not been run");
    expect(block).toContain("(none recorded — no run yet this session)");
  });

  it("never throws on an unserializable config", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() =>
      buildAssistantContextBlock({ ...CTX, configJson: cyclic }, "Config"),
    ).not.toThrow();
  });
});

describe("buildValidatorUserPrompt", () => {
  it("matches the shape mandated by 14-screen-validator.md §4.3", () => {
    const prompt = buildValidatorUserPrompt("CODE", { a: 1 });
    expect(prompt).toBe(
      "Evaluate this STS Tool:\n\n### TS Code\nCODE\n\n### Config\n" +
        JSON.stringify({ a: 1 }, null, 2),
    );
  });
});

describe("VALIDATOR_JSON_REMINDER", () => {
  it("demands a bare JSON array in the mandated shape", () => {
    expect(VALIDATOR_JSON_REMINDER).toContain('"status": "pass" | "fail" | "warn"');
    expect(VALIDATOR_JSON_REMINDER).toContain("ONLY a valid JSON array");
    expect(VALIDATOR_JSON_REMINDER).toContain("no markdown code fences");
  });
});
