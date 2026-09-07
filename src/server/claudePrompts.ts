// Pure prompt construction for the TGS Claude subsystem.
//
// Nothing in this file imports the Anthropic SDK, touches the network, or reads
// the environment — it is string assembly only, so it can be unit-tested
// directly and reused from either the validator pipeline or the AI assistant.
//
// Sources of truth:
//   docs/llm_generated/02-tool-authoring-guide.md  (§5 — the 7 authoring rules)
//   docs/llm_generated/11-screen-editor.md         (§3 — the CONFIG_STUB contract)
//   docs/llm_generated/12-screen-config.md         (§6 — config-store edits)
//   docs/llm_generated/14-screen-validator.md      (§4.3 — the validator payload)
//   docs/llm_generated/ToolContract.ts             (Tool Contract V2)

/** The read-only comment the Editor's AST engine substitutes for the config block. */
export const CONFIG_STUB = "/* [CONFIG_STUB]: Configuration managed in Config Tab */";

/** The tool context handed to the assistant / validator. Mirrors global tool state. */
export type ToolContextPayload = {
  toolName: string;
  /** The full recombined `[name].ts` (config block re-injected). */
  tsCode: string;
  /** The standalone `[name].json` config object. */
  configJson: unknown;
  rubricMarkdown?: string;
  pythonFindings?: { filename: string; passed: boolean; message: string }[];
  testResults?: { name: string; source: string; ok: boolean; detail: string }[];
};

/**
 * The 7 non-negotiable authoring rules from `02-tool-authoring-guide.md` §5,
 * kept as data so tests can assert every one of them reaches the model.
 */
export const AUTHORING_RULES: readonly string[] = [
  "1. Two Required Exports — every tool must export `config` (wrapped in `initToolConfig`) and a default `execute(request, context)` that returns a standard Web `Response`.",
  "2. Strict JSON Output — `execute` always returns strict, minimal JSON payloads via `Response.json(...)`, regardless of whether the caller is an internal Agent, an SDK REST client, or an MCP client. Presentation formatting belongs to the caller, never the tool.",
  "3. Explicit Tool Dependencies — never call `context.internalFetch()` blindly. Any sibling tool invoked MUST be declared in `config.tool_dependencies`, or the Deno router blocks the call.",
  "4. Secrets over Env — never use a flat `requiredEnv` array. Declare each secret in the `secrets` dictionary with a `description` and `isOptional`.",
  "5. Agent Error Handling — never throw an unhandled exception. Catch everything and return HTTP 4xx/5xx responses whose error keys match `config.signature.errors`, so the agent orchestrator can read `actionable_advice` and self-correct.",
  "6. Rate Limiting — always set a sensible `rateLimit.requestsPerMinute` (typically 60–600) to protect the ecosystem from LLM hallucination loops.",
  "7. Zero-Trust Network — never call the global `fetch()` inside a tool. Declare external endpoint prefixes in `config.network_requests` and proxy every external call through `dispatchToGateway(...)` or `context.useCoreTool('network_gateway', {...})`.",
] as const;

/**
 * System prompt for the persistent left-pane AI assistant.
 *
 * The assistant has global context access (01-system-overview.md §2): it reads
 * the current code and config, writes updates back through tools, and asks the
 * browser to trigger test / validation runs.
 */
export const ASSISTANT_SYSTEM_PROMPT = `You are the TGS Assistant — the persistent AI pane inside the Tool Generator Server (TGS), a local-first workbench for authoring tools that are published to the Simple Tools Server (STS) at sts.agentsable.com.

You have global context access to exactly one tool at a time: its TypeScript source, its JSON configuration, its secrets schema, its embedded tests, and the latest validation findings. You do not edit files on disk and you have no shell — the tool being authored lives in browser state. You change it ONLY by calling the tools listed below. Never paste a full file into your prose and ask the user to copy it; call \`replace_execution_logic\` or \`patch_tool_config\` instead.

## Runtime target

Tools are stateless TypeScript modules executed on Deno / Cloudflare Workers (V8 isolates, WinterCG). There are no Node.js built-ins: \`node:fs\`, \`node:path\`, \`child_process\`, \`require()\` and CommonJS are all forbidden and will fail the deterministic Python validators.

## The 7 authoring rules (non-negotiable)

${AUTHORING_RULES.join("\n")}

## Tool Contract V2 shape

\`export const config\` conforms to the \`ToolConfig\` interface:
- \`name\`, \`version\`, \`description\` (required), optional \`icon\`, \`tags\`, \`mcpDescription\`.
- \`signature: { inputs, outputs, errors }\` — JSON Schema. \`errors\` maps an ERROR_CODE to \`{ description, actionable_advice }\`; \`actionable_advice\` must tell a calling agent which part of the payload to change and retry, not merely restate the failure.
- \`secrets: Record<string, { description, isOptional? }>\`.
- \`tool_dependencies: string[]\` — sibling tools this tool may reach.
- \`network_requests: string[]\` — absolute URL prefixes forming the egress allowlist.
- \`rateLimit: { requestsPerMinute }\`, \`timeoutMs\`, \`isIdempotent\`, \`cost\`, \`outputModality\`.
- \`tests: { name, payload, expect: { status?, hasKey? } }[]\` — embedded HTTP test cases.
- \`mcpResources\` / \`mcpPrompts\` — Model Context Protocol hooks.

\`execute\` receives \`(request: Request, context: ToolExecutionContext)\`, where the context carries \`userId\`, \`origin\` ("agent" | "sdk_rest" | "mcp_client"), \`env\`, \`internalFetch\`, \`useCoreTool\`, optional \`storage\`, and \`callerConfig\`.

## The Editor buffer and the CONFIG_STUB

The Editor tab does NOT show the configuration block. An AST pass strips the \`baseConfig\` declaration, the \`export const config = await initToolConfig(...)\` statement, and the \`initToolConfig\` import, replacing them in place with the read-only marker:

    ${CONFIG_STUB}

CRITICAL: when you call \`replace_execution_logic\` you must return the execution-logic view ONLY — imports the logic actually uses, the \`${CONFIG_STUB}\` line kept in position, and the \`export default async function execute(...)\`. Do NOT re-emit \`baseConfig\`, \`export const config\`, or the \`initToolConfig\` import: they are re-injected on recombination, and emitting them duplicates the config and corrupts the file. Configuration changes go through \`patch_tool_config\`, never through the code buffer.

## How to work

- Prefer the smallest edit that satisfies the request. State what you changed and why in plain prose after the tool calls.
- When a validator finding is present in context, address it directly; \`add_error_advice\` is the remediation path for a weak or missing \`actionable_advice\` (the Dashboard's [ Auto-Fix Advice ] action).
- After a code or config change that is worth verifying, call \`run_tests\` or \`run_validations\`. You do not execute anything yourself — those tools ask the browser to run the local Deno test harness and the Pyodide + LLM validators, and results arrive on a later turn.
- If a request would violate one of the 7 rules (for example "just call fetch() directly"), refuse the shortcut, explain which rule it breaks, and implement the compliant version.
- Be concise. No preamble, no restating the file back to the user.`;

/** Renders live tool state for the assistant: code, config, active tab, findings. */
export function buildAssistantContextBlock(ctx: ToolContextPayload, activeTab: string): string {
  const parts: string[] = [];

  parts.push("# Current tool context");
  parts.push(`Tool name: ${ctx.toolName || "(unnamed)"}`);
  parts.push(`Active tab: ${activeTab}`);

  parts.push(
    "\n## TypeScript source (recombined [tool_name].ts)\n```typescript\n" + ctx.tsCode + "\n```",
  );

  parts.push(
    "\n## Configuration ([tool_name].json)\n```json\n" + safeJson(ctx.configJson) + "\n```",
  );

  if (ctx.rubricMarkdown !== undefined && ctx.rubricMarkdown.trim() !== "") {
    parts.push(
      "\n## LLM validation rubric (sts_rules.md)\n```markdown\n" + ctx.rubricMarkdown + "\n```",
    );
  }

  const findings = ctx.pythonFindings ?? [];
  if (findings.length > 0) {
    const rows = findings
      .map((f) => `- [${f.passed ? "PASS" : "FAIL"}] ${f.filename}: ${f.message}`)
      .join("\n");
    parts.push("\n## Latest deterministic findings (Pyodide Python rules)\n" + rows);
  } else {
    parts.push(
      "\n## Latest deterministic findings (Pyodide Python rules)\n(none recorded — the Validator has not been run, or its results are stale)",
    );
  }

  const tests = ctx.testResults ?? [];
  if (tests.length > 0) {
    const rows = tests
      .map((t) => `- [${t.ok ? "PASS" : "FAIL"}] ${t.name} (${t.source}): ${t.detail}`)
      .join("\n");
    parts.push("\n## Latest test results (local Deno runner)\n" + rows);
  } else {
    parts.push(
      "\n## Latest test results (local Deno runner)\n(none recorded — no run yet this session)",
    );
  }

  return parts.join("\n");
}

/**
 * Validator user prompt, per 14-screen-validator.md §4.3. The exact shape matters:
 * the rubric is the system prompt and this is the entire user turn.
 */
export function buildValidatorUserPrompt(tsCode: string, configJson: unknown): string {
  return `Evaluate this STS Tool:\n\n### TS Code\n${tsCode}\n\n### Config\n${safeJson(configJson)}`;
}

/**
 * Appended to the user turn on the single retry when the first attempt came back
 * as prose instead of a JSON array. The rubric (system prompt) is unchanged.
 */
export const VALIDATOR_JSON_REMINDER = `IMPORTANT: your previous response could not be parsed. Return ONLY a valid JSON array and nothing else — no prose, no explanation, no markdown code fences. Each element must be an object of exactly this shape:

[
  {
    "rule": "Actionable Advice",
    "status": "pass" | "fail" | "warn",
    "reasoning": "Explanation of the evaluation..."
  }
]

Emit one object per rule defined in the guidelines. The first character of your response must be "[" and the last must be "]".`;

/** JSON.stringify that never throws on cycles or non-serializable values. */
function safeJson(value: unknown): string {
  try {
    const out = JSON.stringify(value, null, 2);
    return out === undefined ? "null" : out;
  } catch {
    return `"[unserializable config: ${String(value)}]"`;
  }
}
