/* eslint-disable @typescript-eslint/no-explicit-any --
 * These tests reach into the captured params of a mocked Anthropic client to assert
 * the exact request shape. The SDK request type is a deep union, so indexing it
 * through `unknown` would need a cast at every step and hide what is being asserted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Anthropic SDK is mocked for every test in this file — nothing here may
// touch the real API. `vi.hoisted` gives the factory below access to the spy.
const mocks = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => {
  class APIError extends Error {
    status: number | undefined;
    constructor(message: string, status?: number) {
      super(message);
      this.status = status;
    }
  }
  class AuthenticationError extends APIError {}
  class RateLimitError extends APIError {}
  class BadRequestError extends APIError {}

  class MockAnthropic {
    static APIError = APIError;
    static AuthenticationError = AuthenticationError;
    static RateLimitError = RateLimitError;
    static BadRequestError = BadRequestError;
    messages = { create: mocks.create };
    constructor(public options?: unknown) {}
  }

  return { default: MockAnthropic };
});

import Anthropic from "@anthropic-ai/sdk";

import {
  DEFAULT_CLAUDE_MODEL,
  claudeAvailability,
  extractValidationArray,
  runAssistantTurn,
  runLlmValidation,
  type ToolContextPayload,
} from "./claude";
import { VALIDATOR_JSON_REMINDER, buildValidatorUserPrompt } from "./claudePrompts";

const RUBRIC = "# STS Tool Heuristic Validation Guidelines\n\n1. Actionable Advice\n";
const TS_CODE = "export default async function execute(){ return Response.json({ ok: true }); }";
const CONFIG = { name: "weather_fetcher", version: "1.0.0" };

const GOOD_RESULTS = [
  { rule: "Actionable Advice", status: "warn", reasoning: "CITY_NOT_FOUND lacks guidance." },
  { rule: "Description Clarity", status: "pass", reasoning: "Explains the output." },
];

type MockBlock =
  { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };

function reply(...content: MockBlock[]) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: DEFAULT_CLAUDE_MODEL,
    content,
    stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function textReply(text: string) {
  return reply({ type: "text", text });
}

/** Builds an SDK error instance. The runtime class comes from the mock above;
 *  the real SDK's declared constructor arity differs, hence the cast. */
function sdkError(Ctor: unknown, message: string, status: number): Error {
  const C = Ctor as new (message: string, status?: number) => Error;
  return new C(message, status);
}

/** The params object passed to messages.create on the nth (0-based) call. */
function callParams(n: number): Record<string, any> {
  const call = mocks.create.mock.calls[n];
  expect(call, `expected at least ${n + 1} API calls`).toBeDefined();
  return (call as unknown[])[0] as Record<string, any>;
}

beforeEach(() => {
  mocks.create.mockReset();
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-key");
  vi.stubEnv("TGS_CLAUDE_MODEL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/* ------------------------------------------------------------------ */
/* Availability                                                        */
/* ------------------------------------------------------------------ */

describe("claudeAvailability", () => {
  it("reports configured when the key is present, with the default model", () => {
    expect(claudeAvailability()).toEqual({ configured: true, model: DEFAULT_CLAUDE_MODEL });
  });

  it("reports unconfigured with a reason when the key is missing", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const status = claudeAvailability();
    expect(status.configured).toBe(false);
    expect(status.reason).toContain("ANTHROPIC_API_KEY");
    expect(status.model).toBe(DEFAULT_CLAUDE_MODEL);
  });

  it("honours the TGS_CLAUDE_MODEL override", () => {
    vi.stubEnv("TGS_CLAUDE_MODEL", "claude-sonnet-5");
    expect(claudeAvailability().model).toBe("claude-sonnet-5");
  });
});

/* ------------------------------------------------------------------ */
/* Validator                                                           */
/* ------------------------------------------------------------------ */

describe("runLlmValidation", () => {
  it("fails with NO_API_KEY and never calls the API", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const result = await runLlmValidation({
      rubricMarkdown: RUBRIC,
      tsCode: TS_CODE,
      configJson: CONFIG,
    });
    expect(result).toEqual({ ok: false, code: "NO_API_KEY", error: expect.any(String) });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("parses a bare JSON array on the first attempt", async () => {
    mocks.create.mockResolvedValueOnce(textReply(JSON.stringify(GOOD_RESULTS)));
    const result = await runLlmValidation({
      rubricMarkdown: RUBRIC,
      tsCode: TS_CODE,
      configJson: CONFIG,
    });
    expect(result).toEqual({ ok: true, attempts: 1, results: GOOD_RESULTS });
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("sends the rubric as the system prompt and the spec'd user prompt", async () => {
    mocks.create.mockResolvedValueOnce(textReply(JSON.stringify(GOOD_RESULTS)));
    await runLlmValidation({ rubricMarkdown: RUBRIC, tsCode: TS_CODE, configJson: CONFIG });

    const params = callParams(0);
    expect(params["system"]).toBe(RUBRIC); // verbatim, per spec §4.3
    expect(params["model"]).toBe(DEFAULT_CLAUDE_MODEL);
    expect(params["max_tokens"]).toBe(16000);
    expect(params["thinking"]).toEqual({ type: "adaptive" });
    expect(params["messages"]).toEqual([
      { role: "user", content: buildValidatorUserPrompt(TS_CODE, CONFIG) },
    ]);
    expect(String(params["messages"][0].content)).toContain("Evaluate this STS Tool:");
  });

  it("parses a fenced ```json array", async () => {
    mocks.create.mockResolvedValueOnce(
      textReply("```json\n" + JSON.stringify(GOOD_RESULTS, null, 2) + "\n```"),
    );
    const result = await runLlmValidation({
      rubricMarkdown: RUBRIC,
      tsCode: TS_CODE,
      configJson: CONFIG,
    });
    expect(result).toMatchObject({ ok: true, attempts: 1 });
    expect(result.ok && result.results).toEqual(GOOD_RESULTS);
  });

  it("parses an array wrapped in prose", async () => {
    mocks.create.mockResolvedValueOnce(
      textReply(
        `Sure! Here are my findings.\n\n${JSON.stringify(GOOD_RESULTS)}\n\nLet me know if you want more.`,
      ),
    );
    const result = await runLlmValidation({
      rubricMarkdown: RUBRIC,
      tsCode: TS_CODE,
      configJson: CONFIG,
    });
    expect(result).toMatchObject({ ok: true, attempts: 1 });
    expect(result.ok && result.results).toEqual(GOOD_RESULTS);
  });

  it("retries once under the same rubric when the first reply is prose", async () => {
    mocks.create
      .mockResolvedValueOnce(textReply("I reviewed the tool and it looks mostly fine to me."))
      .mockResolvedValueOnce(textReply(JSON.stringify(GOOD_RESULTS)));

    const result = await runLlmValidation({
      rubricMarkdown: RUBRIC,
      tsCode: TS_CODE,
      configJson: CONFIG,
    });
    expect(result).toEqual({ ok: true, attempts: 2, results: GOOD_RESULTS });
    expect(mocks.create).toHaveBeenCalledTimes(2);

    const first = callParams(0);
    const second = callParams(1);
    expect(second["system"]).toBe(RUBRIC); // same rubric on the retry
    expect(second["system"]).toBe(first["system"]);
    expect(String(second["messages"][0].content)).toContain(VALIDATOR_JSON_REMINDER);
    expect(String(first["messages"][0].content)).not.toContain(VALIDATOR_JSON_REMINDER);
  });

  it("returns PARSE when both attempts fail to yield a JSON array", async () => {
    mocks.create
      .mockResolvedValueOnce(textReply("Looks good overall!"))
      .mockResolvedValueOnce(textReply("Still no JSON, sorry."));

    const result = await runLlmValidation({
      rubricMarkdown: RUBRIC,
      tsCode: TS_CODE,
      configJson: CONFIG,
    });
    expect(result).toMatchObject({ ok: false, code: "PARSE" });
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it("rejects an array whose status values are not pass/fail/warn", async () => {
    const bad = [{ rule: "R", status: "ok", reasoning: "x" }];
    mocks.create.mockResolvedValue(textReply(JSON.stringify(bad)));
    const result = await runLlmValidation({
      rubricMarkdown: RUBRIC,
      tsCode: TS_CODE,
      configJson: CONFIG,
    });
    expect(result).toMatchObject({ ok: false, code: "PARSE" });
  });

  it("maps SDK error classes to typed failures", async () => {
    mocks.create.mockRejectedValueOnce(sdkError(Anthropic.AuthenticationError, "bad key", 401));
    expect(
      await runLlmValidation({ rubricMarkdown: RUBRIC, tsCode: TS_CODE, configJson: CONFIG }),
    ).toMatchObject({ ok: false, code: "AUTH" });

    mocks.create.mockRejectedValueOnce(sdkError(Anthropic.RateLimitError, "slow down", 429));
    expect(
      await runLlmValidation({ rubricMarkdown: RUBRIC, tsCode: TS_CODE, configJson: CONFIG }),
    ).toMatchObject({ ok: false, code: "RATE_LIMIT" });

    mocks.create.mockRejectedValueOnce(sdkError(Anthropic.APIError, "boom", 500));
    expect(
      await runLlmValidation({ rubricMarkdown: RUBRIC, tsCode: TS_CODE, configJson: CONFIG }),
    ).toMatchObject({ ok: false, code: "API" });
  });

  it("uses the per-call model override", async () => {
    mocks.create.mockResolvedValueOnce(textReply(JSON.stringify(GOOD_RESULTS)));
    await runLlmValidation({
      rubricMarkdown: RUBRIC,
      tsCode: TS_CODE,
      configJson: CONFIG,
      model: "claude-sonnet-5",
    });
    expect(callParams(0)["model"]).toBe("claude-sonnet-5");
  });
});

describe("extractValidationArray", () => {
  it("returns null for prose", () => {
    expect(extractValidationArray("There is no JSON here.")).toBeNull();
  });

  it("ignores brackets inside strings", () => {
    const payload = [{ rule: "A]B", status: "pass", reasoning: "contains ] and [" }];
    expect(extractValidationArray(`prefix ${JSON.stringify(payload)} suffix`)).toEqual(payload);
  });

  it("defaults a missing reasoning to an empty string", () => {
    expect(extractValidationArray('[{"rule":"R","status":"fail"}]')).toEqual([
      { rule: "R", status: "fail", reasoning: "" },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Assistant                                                           */
/* ------------------------------------------------------------------ */

const CTX: ToolContextPayload = {
  toolName: "weather_fetcher",
  tsCode: TS_CODE,
  configJson: CONFIG,
  pythonFindings: [{ filename: "rule_cf_worker_compat.py", passed: false, message: "node:path" }],
};

describe("runAssistantTurn", () => {
  it("fails with NO_API_KEY and never calls the API", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const result = await runAssistantTurn({
      messages: [{ role: "user", content: "hi" }],
      context: CTX,
      activeTab: "Editor",
    });
    expect(result).toMatchObject({ ok: false, code: "NO_API_KEY" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("turns a replace_execution_logic tool call into a logic edit", async () => {
    mocks.create
      .mockResolvedValueOnce(
        reply(
          { type: "text", text: "Rewriting the handler." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "replace_execution_logic",
            input: {
              logic: "export default async function execute(){}",
              rationale: "adds a 404 guard",
            },
          },
        ),
      )
      .mockResolvedValueOnce(textReply("Done — the handler now guards against 404."));

    const result = await runAssistantTurn({
      messages: [{ role: "user", content: "Guard the API call against 404" }],
      context: CTX,
      activeTab: "Editor",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.edits).toEqual([
      {
        kind: "logic",
        logic: "export default async function execute(){}",
        rationale: "adds a 404 guard",
      },
    ]);
    expect(result.reply).toContain("Done");
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it("sends the assistant system prompt plus a live context block, and strict tools", async () => {
    mocks.create.mockResolvedValueOnce(textReply("Nothing to change."));
    await runAssistantTurn({
      messages: [{ role: "user", content: "status?" }],
      context: CTX,
      activeTab: "Validator",
    });

    const params = callParams(0);
    const system = params["system"] as { type: string; text: string }[];
    expect(system).toHaveLength(2);
    expect(system[0]?.text).toContain("[CONFIG_STUB]");
    expect(system[1]?.text).toContain("Active tab: Validator");
    expect(system[1]?.text).toContain("rule_cf_worker_compat.py");

    const tools = params["tools"] as { name: string; strict?: boolean; input_schema: any }[];
    expect(tools.map((t) => t.name)).toEqual([
      "replace_execution_logic",
      "patch_tool_config",
      "add_error_advice",
      "add_test",
      "run_tests",
      "run_validations",
    ]);
    for (const tool of tools) {
      expect(tool.strict).toBe(true);
      expect(tool.input_schema.additionalProperties).toBe(false);
      expect(Array.isArray(tool.input_schema.required)).toBe(true);
    }
  });

  it("returns all tool_result blocks for one turn in a single user message", async () => {
    mocks.create
      .mockResolvedValueOnce(
        reply(
          {
            type: "tool_use",
            id: "toolu_a",
            name: "patch_tool_config",
            input: { patch: { rateLimit: { requestsPerMinute: 300 } }, rationale: "cap it" },
          },
          { type: "tool_use", id: "toolu_b", name: "run_validations", input: {} },
        ),
      )
      .mockResolvedValueOnce(textReply("Queued a config patch and asked for a re-validation."));

    const result = await runAssistantTurn({
      messages: [{ role: "user", content: "set a rate limit then revalidate" }],
      context: CTX,
      activeTab: "Config",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.edits).toEqual([
      { kind: "config", patch: { rateLimit: { requestsPerMinute: 300 } }, rationale: "cap it" },
      { kind: "request_run", what: "validations" },
    ]);

    const followUp = callParams(1)["messages"] as { role: string; content: any }[];
    const userTurns = followUp.filter((m) => m.role === "user");
    // original user prompt + exactly one message carrying both tool_results
    expect(userTurns).toHaveLength(2);
    const resultsTurn = userTurns[1]?.content as { type: string; tool_use_id: string }[];
    expect(resultsTurn.map((b) => b.tool_use_id)).toEqual(["toolu_a", "toolu_b"]);
    expect(resultsTurn.every((b) => b.type === "tool_result")).toBe(true);
  });

  it("normalises add_test nulls into optional expect fields", async () => {
    mocks.create
      .mockResolvedValueOnce(
        reply({
          type: "tool_use",
          id: "toolu_t",
          name: "add_test",
          input: {
            name: "Divide by zero",
            payload: { a: 1, b: 0 },
            expect: { status: 400, hasKey: null },
            target: "ts",
          },
        }),
      )
      .mockResolvedValueOnce(textReply("Added."));

    const result = await runAssistantTurn({
      messages: [{ role: "user", content: "add a divide-by-zero test" }],
      context: CTX,
      activeTab: "Runner",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.edits[0]).toEqual({
      kind: "test",
      target: "ts",
      test: { name: "Divide by zero", payload: { a: 1, b: 0 }, expect: { status: 400 } },
    });
  });

  it("maps add_error_advice onto the auto-fix remediation edit", async () => {
    mocks.create
      .mockResolvedValueOnce(
        reply({
          type: "tool_use",
          id: "toolu_e",
          name: "add_error_advice",
          input: {
            code: "CITY_NOT_FOUND",
            description: "The city name did not resolve.",
            actionable_advice: "Re-send with a full 'city, country' string.",
          },
        }),
      )
      .mockResolvedValueOnce(textReply("Advice added."));

    const result = await runAssistantTurn({
      messages: [{ role: "user", content: "fix the advice" }],
      context: CTX,
      activeTab: "Validator",
    });
    expect(result.ok && result.edits[0]).toMatchObject({
      kind: "error_advice",
      code: "CITY_NOT_FOUND",
    });
  });

  it("caps the tool-use loop at 8 iterations", async () => {
    mocks.create.mockResolvedValue(
      reply({ type: "tool_use", id: "toolu_loop", name: "run_tests", input: {} }),
    );
    const result = await runAssistantTurn({
      messages: [{ role: "user", content: "loop forever" }],
      context: CTX,
      activeTab: "Runner",
    });
    expect(mocks.create).toHaveBeenCalledTimes(8);
    expect(result.ok && result.edits).toHaveLength(8);
  });

  it("retries without strict schemas when the API rejects them", async () => {
    mocks.create
      .mockRejectedValueOnce(sdkError(Anthropic.BadRequestError, "strict schema unsupported", 400))
      .mockResolvedValueOnce(textReply("ok"));

    const result = await runAssistantTurn({
      messages: [{ role: "user", content: "hello" }],
      context: CTX,
      activeTab: "Editor",
    });

    expect(result).toMatchObject({ ok: true, edits: [] });
    const retried = callParams(1)["tools"] as { strict?: boolean }[];
    expect(retried.every((t) => t.strict === undefined)).toBe(true);
  });

  it("surfaces an API failure that happens before any progress", async () => {
    mocks.create.mockRejectedValueOnce(sdkError(Anthropic.RateLimitError, "429", 429));
    const result = await runAssistantTurn({
      messages: [{ role: "user", content: "hello" }],
      context: CTX,
      activeTab: "Editor",
    });
    expect(result).toMatchObject({ ok: false, code: "RATE_LIMIT" });
  });
});
