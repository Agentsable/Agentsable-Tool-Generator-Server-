// Validator health score and publish gate.
// Spec: docs/llm_generated/14-screen-validator.md §2.3 (weights) and §4.3
// (parsing the Claude Agent SDK response).
//
// Weights (§2.3, authoritative per reconciliation entry #10 in 00-INDEX.md):
//   deterministic (Python) failure  -25 each  — blocks publishing outright
//   qualitative  (LLM) failure      -15 each
//   warning from either engine       -5 each
// Score is clamped to [0, 100]; publishing needs >= 90 AND zero deterministic
// failures.

import type { PythonRuleResult } from "@/lib/tgs/pythonEngine";

export const DETERMINISTIC_FAILURE_PENALTY = 25;
export const QUALITATIVE_FAILURE_PENALTY = 15;
export const WARNING_PENALTY = 5;
export const MIN_PUBLISHABLE_SCORE = 90;

/** One finding from the qualitative (Claude Agent SDK) pass — spec §4.3. */
export type LLMValidationResult = {
  rule: string;
  status: "pass" | "fail" | "warn";
  reasoning: string;
};

export type HealthReport = {
  /** 0-100, clamped. */
  score: number;
  deterministicFailures: number;
  qualitativeFailures: number;
  warnings: number;
  /** `score >= 90 && deterministicFailures === 0`. */
  canPublish: boolean;
  /** Human-readable reasons publishing is blocked; empty when `canPublish`. */
  blockers: string[];
};

/**
 * A Python rule result can carry a warning instead of a hard failure by
 * prefixing its message with `WARN:` (the rule still returns True, since the
 * contract is a boolean). Anything else that passes is a clean pass.
 */
const WARN_PREFIX = /^\s*(warn|warning)\s*[::]/i;

export function isPythonWarning(result: PythonRuleResult): boolean {
  return result.passed && WARN_PREFIX.test(result.message);
}

export function computeHealth(
  python: readonly PythonRuleResult[],
  llm: readonly LLMValidationResult[],
): HealthReport {
  const deterministicFailures = python.filter((r) => !r.passed).length;
  const qualitativeFailures = llm.filter((r) => r.status === "fail").length;
  const warnings =
    python.filter((r) => isPythonWarning(r)).length + llm.filter((r) => r.status === "warn").length;

  const raw =
    100 -
    deterministicFailures * DETERMINISTIC_FAILURE_PENALTY -
    qualitativeFailures * QUALITATIVE_FAILURE_PENALTY -
    warnings * WARNING_PENALTY;

  const score = Math.max(0, Math.min(100, raw));

  const blockers: string[] = [];
  if (deterministicFailures > 0) {
    blockers.push(
      `${deterministicFailures} deterministic ${
        deterministicFailures === 1 ? "failure" : "failures"
      } must be fixed before publishing.`,
    );
  }
  if (score < MIN_PUBLISHABLE_SCORE) {
    blockers.push(`Health score ${score}/100 is below the required ${MIN_PUBLISHABLE_SCORE}/100.`);
  }

  return {
    score,
    deterministicFailures,
    qualitativeFailures,
    warnings,
    canPublish: score >= MIN_PUBLISHABLE_SCORE && deterministicFailures === 0,
    blockers,
  };
}

const VALID_STATUSES = new Set(["pass", "fail", "warn"]);

/**
 * Extract the JSON array of `LLMValidationResult` from a model response that
 * may be a bare array, wrapped in a ```json fence, or embedded in prose.
 * Throws a descriptive error when nothing usable is found — the caller retries
 * the run under the same rubric (spec §4.3).
 */
export function parseLLMValidationJson(raw: string): LLMValidationResult[] {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("LLM validation response was empty; expected a JSON array.");
  }

  const candidates = collectArrayCandidates(raw);
  if (candidates.length === 0) {
    throw new Error(
      `No JSON array found in the LLM validation response. Received: ${preview(raw)}`,
    );
  }

  let lastError = "";
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      continue;
    }
    if (!Array.isArray(parsed)) {
      lastError = "parsed value was not an array";
      continue;
    }
    return parsed.map((entry, index) => validateEntry(entry, index));
  }

  throw new Error(
    `Could not parse a JSON array from the LLM validation response (${lastError}). Received: ${preview(raw)}`,
  );
}

function validateEntry(entry: unknown, index: number): LLMValidationResult {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(
      `LLM validation result [${index}] is not an object: ${preview(JSON.stringify(entry) ?? String(entry))}`,
    );
  }
  const record = entry as Record<string, unknown>;
  const rule = record["rule"];
  const status = record["status"];
  const reasoning = record["reasoning"];

  if (typeof rule !== "string" || rule.trim() === "") {
    throw new Error(`LLM validation result [${index}] is missing a "rule" string.`);
  }
  if (typeof status !== "string" || !VALID_STATUSES.has(status)) {
    throw new Error(
      `LLM validation result [${index}] has an invalid "status" (${JSON.stringify(status)}); expected "pass", "fail" or "warn".`,
    );
  }
  if (typeof reasoning !== "string") {
    throw new Error(`LLM validation result [${index}] is missing a "reasoning" string.`);
  }

  return { rule, status: status as LLMValidationResult["status"], reasoning };
}

/**
 * Candidate JSON array substrings, most likely first: fenced blocks, then
 * balanced bracket spans found in the surrounding prose.
 */
function collectArrayCandidates(raw: string): string[] {
  const candidates: string[] = [];

  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null = fence.exec(raw);
  while (match !== null) {
    const body = (match[1] ?? "").trim();
    if (body.startsWith("[")) candidates.push(body);
    match = fence.exec(raw);
  }

  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== "[") continue;
    const end = findBalancedEnd(raw, i);
    if (end !== -1) {
      candidates.push(raw.slice(i, end + 1));
      break; // the first balanced array wins; later ones are prose examples
    }
  }

  return candidates;
}

function findBalancedEnd(raw: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i += 1) {
    const char = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

function preview(raw: string): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}
