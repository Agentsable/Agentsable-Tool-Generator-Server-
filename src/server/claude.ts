// Server-only Anthropic client for the TGS Claude subsystem.
//
// IMPORTANT: this module reads ANTHROPIC_API_KEY. It must only ever be imported
// from inside a TanStack Start server-function handler (see tgsServerFns.ts,
// which loads it via `await import(...)` so it can never reach a client bundle).
//
// Architecture note — the specs name `@anthropic-ai/claude-agent-sdk`, but that
// package is the Claude Code harness: it spawns a CLI subprocess and drives
// filesystem/bash tools. The tool being authored here lives in browser state,
// not on disk, and both operations need a strict structured response. So we use
// the official Anthropic SDK server-side with our own tool-use loop instead.
//
// Contracts implemented:
//   docs/llm_generated/14-screen-validator.md §4.3 (validator payload + retry)
//   docs/llm_generated/14-screen-validator.md §5   (auto-remediation proposals)
//   docs/llm_generated/11-screen-editor.md §5      (Editor buffer edits)
//   docs/llm_generated/12-screen-config.md §6      (Config store edits)

import Anthropic from "@anthropic-ai/sdk";

import {
  ASSISTANT_SYSTEM_PROMPT,
  VALIDATOR_JSON_REMINDER,
  buildAssistantContextBlock,
  buildValidatorUserPrompt,
  type ToolContextPayload,
} from "./claudePrompts";

export type { ToolContextPayload };

/* ------------------------------------------------------------------------- */
/* Types                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Local copy of the shape owned by `src/lib/tgs/health.ts`. Declared here (not
 * imported) so this module has no dependency on that file's landing; the shape
 * is identical and must stay that way.
 */
export type LLMValidationResult = {
  rule: string;
  status: "pass" | "fail" | "warn";
  reasoning: string;
};

export type ClaudeAvailability = {
  configured: boolean;
  reason?: string;
  model: string;
};

/** A change the assistant wants applied. The browser owns application. */
export type AssistantEdit =
  | { kind: "logic"; logic: string; rationale: string }
  | { kind: "config"; patch: Record<string, unknown>; rationale: string }
  | { kind: "error_advice"; code: string; description: string; actionable_advice: string }
  | {
      kind: "test";
      target: "ts" | "json";
      test: { name: string; payload: unknown; expect: { status?: number; hasKey?: string } };
    }
  | { kind: "request_run"; what: "tests" | "validations" };

export type ClaudeErrorCode = "NO_API_KEY" | "AUTH" | "RATE_LIMIT" | "API" | "PARSE";

export type ClaudeFailure = { ok: false; error: string; code: string };

export type LlmValidationSuccess = { ok: true; results: LLMValidationResult[]; attempts: number };
export type AssistantTurnSuccess = { ok: true; reply: string; edits: AssistantEdit[] };

/* ------------------------------------------------------------------------- */
/* Configuration                                                              */
/* ------------------------------------------------------------------------- */

/** Spec reconciliation item #7: configurable app setting, this is the default. */
export const DEFAULT_CLAUDE_MODEL = "claude-opus-5";

/** Cap on server-driven tool-use iterations for one assistant turn. */
export const MAX_ASSISTANT_ITERATIONS = 8;

const MAX_TOKENS = 16000;

/**
 * `process` is not in this project's tsconfig `types` list, so read the
 * environment off globalThis rather than relying on Node globals being typed.
 * This also keeps Vite from statically inlining anything.
 */
function readEnv(name: string): string | undefined {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return g.process?.env?.[name];
}

function resolveModel(override?: string): string {
  const explicit = override?.trim();
  if (explicit !== undefined && explicit !== "") return explicit;
  const fromEnv = readEnv("TGS_CLAUDE_MODEL")?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return DEFAULT_CLAUDE_MODEL;
}

function readApiKey(): string | undefined {
  const key = readEnv("ANTHROPIC_API_KEY")?.trim();
  return key === undefined || key === "" ? undefined : key;
}

export function claudeAvailability(): ClaudeAvailability {
  const model = resolveModel();
  const key = readApiKey();
  if (key === undefined) {
    return {
      configured: false,
      reason:
        "ANTHROPIC_API_KEY is not set on the TGS server. Add it to your .env (see .env.example) and restart — the AI pane and the LLM validator are disabled until then.",
      model,
    };
  }
  return { configured: true, model };
}

function noApiKeyFailure(): ClaudeFailure {
  return {
    ok: false,
    code: "NO_API_KEY" satisfies ClaudeErrorCode,
    error:
      "ANTHROPIC_API_KEY is not configured on the server. Set it in .env and restart TGS to enable Claude features.",
  };
}

function createClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, maxRetries: 2 });
}

/** Maps a thrown SDK error onto the typed failure shape. Never rethrows. */
function toFailure(err: unknown): ClaudeFailure {
  if (err instanceof Anthropic.AuthenticationError) {
    return {
      ok: false,
      code: "AUTH" satisfies ClaudeErrorCode,
      error: `Anthropic rejected the API key (${err.status ?? 401}). Check ANTHROPIC_API_KEY.`,
    };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return {
      ok: false,
      code: "RATE_LIMIT" satisfies ClaudeErrorCode,
      error: "Anthropic rate limit reached (429). Wait a moment and try again.",
    };
  }
  if (err instanceof Anthropic.APIError) {
    return {
      ok: false,
      code: "API" satisfies ClaudeErrorCode,
      error: `Anthropic API error${err.status === undefined ? "" : ` ${err.status}`}: ${err.message}`,
    };
  }
  return {
    ok: false,
    code: "API" satisfies ClaudeErrorCode,
    error: err instanceof Error ? err.message : String(err),
  };
}

/* ------------------------------------------------------------------------- */
/* Response helpers                                                           */
/* ------------------------------------------------------------------------- */

function collectText(content: Anthropic.ContentBlock[]): string {
  const chunks: string[] = [];
  for (const block of content) {
    if (block.type === "text") chunks.push(block.text);
  }
  return chunks.join("\n").trim();
}

function collectToolUses(content: Anthropic.ContentBlock[]): Anthropic.ToolUseBlock[] {
  const uses: Anthropic.ToolUseBlock[] = [];
  for (const block of content) {
    if (block.type === "tool_use") uses.push(block);
  }
  return uses;
}

/* ------------------------------------------------------------------------- */
/* JSON extraction (validator)                                                */
/* ------------------------------------------------------------------------- */

const VALID_STATUSES = new Set(["pass", "fail", "warn"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceResults(parsed: unknown): LLMValidationResult[] | null {
  if (!Array.isArray(parsed)) return null;
  const out: LLMValidationResult[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) return null;
    const rule = entry["rule"];
    const status = entry["status"];
    const reasoning = entry["reasoning"];
    if (typeof rule !== "string" || typeof status !== "string") return null;
    if (!VALID_STATUSES.has(status)) return null;
    out.push({
      rule,
      status: status as LLMValidationResult["status"],
      reasoning: typeof reasoning === "string" ? reasoning : "",
    });
  }
  return out;
}

/**
 * Pulls the JSON array out of a model reply. Handles a bare array, a fenced
 * ```json block, and an array embedded in surrounding prose. Exported for tests.
 */
export function extractValidationArray(raw: string): LLMValidationResult[] | null {
  const text = raw.trim();
  if (text === "") return null;

  const candidates: string[] = [];

  // 1. The whole reply, if it is already JSON.
  candidates.push(text);

  // 2. Fenced code blocks, ```json first.
  const fenceRe = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g;
  let fence: RegExpExecArray | null = fenceRe.exec(text);
  while (fence !== null) {
    const body = fence[1];
    if (body !== undefined) candidates.push(body.trim());
    fence = fenceRe.exec(text);
  }

  // 3. Every balanced top-level [...] span in the raw text.
  for (const span of balancedArraySpans(text)) candidates.push(span);

  for (const candidate of candidates) {
    if (candidate === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const results = coerceResults(parsed);
    if (results !== null) return results;
  }
  return null;
}

/** Scans for balanced `[ ... ]` regions, ignoring brackets inside JSON strings. */
function balancedArraySpans(text: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "[") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === "]") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          spans.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return spans;
}

/* ------------------------------------------------------------------------- */
/* Operation 1 — the LLM validator                                            */
/* ------------------------------------------------------------------------- */

/**
 * Validator pipeline, 14-screen-validator.md §4.3.
 *
 * System prompt = the edited `sts_rules.md` rubric, verbatim.
 * User prompt   = the tool's TS code + JSON config.
 * Output        = a strict JSON array of LLMValidationResult.
 *
 * If the model answers with prose, the run is retried ONCE under the same
 * rubric with an explicit JSON-only instruction appended to the user turn.
 * Never throws — failures come back as a typed `{ ok: false }`.
 */
export async function runLlmValidation(input: {
  rubricMarkdown: string;
  tsCode: string;
  configJson: unknown;
  model?: string;
}): Promise<LlmValidationSuccess | ClaudeFailure> {
  const apiKey = readApiKey();
  if (apiKey === undefined) return noApiKeyFailure();

  const client = createClient(apiKey);
  const model = resolveModel(input.model);
  const userPrompt = buildValidatorUserPrompt(input.tsCode, input.configJson);

  let lastRaw = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const userContent = attempt === 1 ? userPrompt : `${userPrompt}\n\n${VALIDATOR_JSON_REMINDER}`;

    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        thinking: { type: "adaptive" },
        // The rubric is the system prompt, unchanged across both attempts.
        system: input.rubricMarkdown,
        messages: [{ role: "user", content: userContent }],
      });
    } catch (err) {
      return toFailure(err);
    }

    lastRaw = collectText(response.content);
    const results = extractValidationArray(lastRaw);
    if (results !== null) return { ok: true, results, attempts: attempt };
  }

  return {
    ok: false,
    code: "PARSE" satisfies ClaudeErrorCode,
    error:
      "The LLM validator did not return a parseable JSON array after two attempts under the same rubric. " +
      `Last reply began: ${JSON.stringify(lastRaw.slice(0, 240))}`,
  };
}

/* ------------------------------------------------------------------------- */
/* Operation 2 — the assistant turn                                           */
/* ------------------------------------------------------------------------- */

const NULLABLE_INT = { type: ["integer", "null"] } as const;
const NULLABLE_STR = { type: ["string", "null"] } as const;

/**
 * The tools the assistant may call. Each one produces an AssistantEdit that the
 * browser applies to global state — the server mutates nothing itself.
 *
 * `strict` is parameterised because a strict schema cannot always express the
 * free-form `patch` / `payload` objects; see createWithStrictFallback below.
 */
function assistantTools(strict: boolean): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [
    {
      name: "replace_execution_logic",
      description:
        "Rewrite the Editor buffer with new execution logic. Send ONLY the logic view: the imports the logic uses, the /* [CONFIG_STUB]: Configuration managed in Config Tab */ marker in position, and `export default async function execute(request, context)`. Never include baseConfig, `export const config`, or the initToolConfig import — they are re-injected on recombination.",
      input_schema: {
        type: "object",
        properties: {
          logic: {
            type: "string",
            description: "The complete new contents of the Editor buffer (logic view only).",
          },
          rationale: {
            type: "string",
            description: "One or two sentences on what changed and why.",
          },
        },
        required: ["logic", "rationale"],
        additionalProperties: false,
      },
    },
    {
      name: "patch_tool_config",
      description:
        "Deep-merge a partial ToolConfig into the Config store. Send only the keys that change (e.g. { rateLimit: { requestsPerMinute: 300 } } or a nested signature.inputs.properties entry). Both the Form and Raw JSON sub-views refresh from this.",
      input_schema: {
        type: "object",
        properties: {
          patch: {
            type: "object",
            description: "Partial ToolConfig object to deep-merge into the current config.",
            additionalProperties: true,
          },
          rationale: { type: "string", description: "Why this config change is needed." },
        },
        required: ["patch", "rationale"],
        additionalProperties: false,
      },
    },
    {
      name: "add_error_advice",
      description:
        "Add or replace an entry in config.signature.errors so a failing agent can self-correct. This backs the Validator Dashboard's [ Auto-Fix Advice ] remediation. actionable_advice must say which part of the payload to change and retry — not merely restate the failure.",
      input_schema: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "The SCREAMING_SNAKE_CASE error code, e.g. CITY_NOT_FOUND.",
          },
          description: { type: "string", description: "What went wrong." },
          actionable_advice: {
            type: "string",
            description: "Concrete next step the calling agent should take to succeed on retry.",
          },
        },
        required: ["code", "description", "actionable_advice"],
        additionalProperties: false,
      },
    },
    {
      name: "add_test",
      description:
        "Append an HTTP-driven test case. target 'ts' writes into config.tests (embedded in the tool file); target 'json' writes into the sibling [tool_name]_tests.json file. Use null for an expectation you are not asserting.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Human-readable test name." },
          payload: {
            type: "object",
            description: "Request body posted to the tool.",
            additionalProperties: true,
          },
          expect: {
            type: "object",
            properties: {
              status: { ...NULLABLE_INT, description: "Expected HTTP status, or null." },
              hasKey: { ...NULLABLE_STR, description: "Key expected in the JSON body, or null." },
            },
            required: ["status", "hasKey"],
            additionalProperties: false,
          },
          target: { type: "string", enum: ["ts", "json"] },
        },
        required: ["name", "payload", "expect", "target"],
        additionalProperties: false,
      },
    },
    {
      name: "run_tests",
      description:
        "Ask the browser to execute the tool's test suite against the local Deno server. The server does not run them; results arrive on a later turn.",
      input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
    {
      name: "run_validations",
      description:
        "Ask the browser to re-run all validations (Pyodide deterministic rules + the LLM rubric). The server does not run them; results arrive on a later turn.",
      input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
  ];

  return strict ? tools.map((tool) => ({ ...tool, strict: true })) : tools;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Translates one tool_use block into an AssistantEdit, or null if unusable. */
function toEdit(name: string, input: unknown): AssistantEdit | null {
  const args = isRecord(input) ? input : {};
  switch (name) {
    case "replace_execution_logic": {
      const logic = args["logic"];
      if (typeof logic !== "string") return null;
      return { kind: "logic", logic, rationale: asString(args["rationale"]) };
    }
    case "patch_tool_config": {
      const patch = args["patch"];
      if (!isRecord(patch)) return null;
      return { kind: "config", patch, rationale: asString(args["rationale"]) };
    }
    case "add_error_advice": {
      const code = args["code"];
      if (typeof code !== "string" || code === "") return null;
      return {
        kind: "error_advice",
        code,
        description: asString(args["description"]),
        actionable_advice: asString(args["actionable_advice"]),
      };
    }
    case "add_test": {
      const testName = args["name"];
      if (typeof testName !== "string" || testName === "") return null;
      const rawExpect = isRecord(args["expect"]) ? args["expect"] : {};
      const status = optionalNumber(rawExpect["status"]);
      const hasKey = optionalString(rawExpect["hasKey"]);
      const expect: { status?: number; hasKey?: string } = {};
      if (status !== undefined) expect.status = status;
      if (hasKey !== undefined) expect.hasKey = hasKey;
      const target = args["target"] === "json" ? "json" : "ts";
      return { kind: "test", target, test: { name: testName, payload: args["payload"], expect } };
    }
    case "run_tests":
      return { kind: "request_run", what: "tests" };
    case "run_validations":
      return { kind: "request_run", what: "validations" };
    default:
      return null;
  }
}

function resultTextFor(edit: AssistantEdit | null, name: string): string {
  if (edit === null) {
    return `Rejected: the arguments for \`${name}\` were malformed and nothing was queued. Fix the arguments and call it again.`;
  }
  switch (edit.kind) {
    case "logic":
      return "Queued: the Editor buffer will be replaced with your logic when the user applies this turn's edits. The config block stays hidden behind the CONFIG_STUB.";
    case "config":
      return "Queued: the config patch will be deep-merged into the Config store when the user applies this turn's edits.";
    case "error_advice":
      return `Queued: error \`${edit.code}\` will be added to config.signature.errors when the user applies this turn's edits.`;
    case "test":
      return `Queued: test "${edit.test.name}" will be added to the ${edit.target === "ts" ? "embedded config.tests array" : "sibling tests JSON file"} when the user applies this turn's edits.`;
    case "request_run":
      return `Queued: the browser has been asked to run ${edit.what}. Results are not available in this turn — summarise what you changed and stop.`;
    default:
      return "Queued.";
  }
}

/**
 * Issues one request, retrying without `strict` if the API rejects the strict
 * schemas (the free-form `patch` / `payload` objects cannot always be expressed
 * under constrained decoding).
 */
async function createWithStrictFallback(
  client: Anthropic,
  params: Omit<Anthropic.MessageCreateParamsNonStreaming, "tools">,
  strictState: { strict: boolean },
): Promise<Anthropic.Message> {
  try {
    return await client.messages.create({ ...params, tools: assistantTools(strictState.strict) });
  } catch (err) {
    if (strictState.strict && err instanceof Anthropic.BadRequestError) {
      strictState.strict = false;
      return await client.messages.create({ ...params, tools: assistantTools(false) });
    }
    throw err;
  }
}

/**
 * One assistant turn with server-side tool use, per 01-system-overview.md §2 and
 * 11/12-screen-*.md §5/§6. The assistant reads the current code and config,
 * proposes edits through tools, and can ask the browser to run tests or
 * validations. Every tool call is collected as an AssistantEdit for the client
 * to apply; the server mutates nothing. Never throws.
 */
export async function runAssistantTurn(input: {
  messages: { role: "user" | "assistant"; content: string }[];
  context: ToolContextPayload;
  activeTab: string;
  model?: string;
}): Promise<AssistantTurnSuccess | ClaudeFailure> {
  const apiKey = readApiKey();
  if (apiKey === undefined) return noApiKeyFailure();

  const client = createClient(apiKey);
  const model = resolveModel(input.model);

  const conversation: Anthropic.MessageParam[] = input.messages
    .filter((m) => m.content.trim() !== "")
    .map((m) => ({ role: m.role, content: m.content }));

  if (conversation.length === 0) {
    return {
      ok: false,
      code: "API" satisfies ClaudeErrorCode,
      error: "Cannot start an assistant turn with an empty message list.",
    };
  }

  const system: Anthropic.TextBlockParam[] = [
    // Stable prefix first so the cache breakpoint lands on the frozen prompt.
    { type: "text", text: ASSISTANT_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    { type: "text", text: buildAssistantContextBlock(input.context, input.activeTab) },
  ];

  const edits: AssistantEdit[] = [];
  const replies: string[] = [];
  const strictState = { strict: true };

  for (let iteration = 0; iteration < MAX_ASSISTANT_ITERATIONS; iteration += 1) {
    let response: Anthropic.Message;
    try {
      response = await createWithStrictFallback(
        client,
        {
          model,
          max_tokens: MAX_TOKENS,
          thinking: { type: "adaptive" },
          system,
          messages: conversation,
        },
        strictState,
      );
    } catch (err) {
      // Partial progress is still worth returning to the UI if we have any.
      const failure = toFailure(err);
      if (edits.length === 0 && replies.length === 0) return failure;
      return {
        ok: true,
        reply: `${replies.join("\n\n")}\n\n(Stopped early: ${failure.error})`.trim(),
        edits,
      };
    }

    const text = collectText(response.content);
    if (text !== "") replies.push(text);

    const toolUses = collectToolUses(response.content);
    if (toolUses.length === 0) break;

    conversation.push({ role: "assistant", content: response.content });

    // Parallel tool use: ALL tool_result blocks go back in ONE user message.
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const edit = toEdit(use.name, use.input);
      if (edit !== null) edits.push(edit);
      const block: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: use.id,
        content: resultTextFor(edit, use.name),
      };
      if (edit === null) block.is_error = true;
      results.push(block);
    }
    conversation.push({ role: "user", content: results });

    if (iteration === MAX_ASSISTANT_ITERATIONS - 1) {
      replies.push(
        `(Stopped after ${MAX_ASSISTANT_ITERATIONS} tool-use rounds. The edits above are queued; ask me to continue if more is needed.)`,
      );
    }
  }

  return { ok: true, reply: replies.join("\n\n").trim(), edits };
}
