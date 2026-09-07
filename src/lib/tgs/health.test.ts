import { describe, expect, it } from "vitest";

import {
  MIN_PUBLISHABLE_SCORE,
  computeHealth,
  parseLLMValidationJson,
  type LLMValidationResult,
} from "@/lib/tgs/health";
import type { PythonRuleResult } from "@/lib/tgs/pythonEngine";

function pythonResult(filename: string, passed: boolean, message = ""): PythonRuleResult {
  return { filename, passed, message, durationMs: 1 };
}

function llmResult(rule: string, status: LLMValidationResult["status"]): LLMValidationResult {
  return { rule, status, reasoning: `${rule}: ${status}` };
}

describe("computeHealth", () => {
  it("scores the spec's dashboard example: 1 deterministic failure + 1 warning = 70/100", () => {
    // docs/llm_generated/14-screen-validator.md §2.3 — the formula (-25 / -5)
    // is authoritative over the source doc's 82, per reconciliation entry #10.
    const python: PythonRuleResult[] = [
      pythonResult("rule_no_global_fetch.py", true),
      pythonResult("rule_has_required_exports.py", true),
      pythonResult(
        "rule_cf_worker_compat.py",
        false,
        "Line 14: Found prohibited module 'node:path'.",
      ),
      pythonResult("rule_dependencies_declared.py", true),
      pythonResult("rule_network_allowlist.py", true),
    ];
    const llm: LLMValidationResult[] = [
      llmResult("Clear & Concise Description", "pass"),
      llmResult("Actionable Error Advice", "warn"),
      llmResult("Sensible Rate Limits", "pass"),
    ];

    const health = computeHealth(python, llm);

    expect(health.score).toBe(70);
    expect(health.deterministicFailures).toBe(1);
    expect(health.qualitativeFailures).toBe(0);
    expect(health.warnings).toBe(1);
    expect(health.canPublish).toBe(false);
    expect(health.blockers.join(" ")).toContain("deterministic");
  });

  it("gives a clean run a perfect score and allows publishing", () => {
    const health = computeHealth(
      [pythonResult("rule_no_global_fetch.py", true)],
      [llmResult("Description Clarity", "pass")],
    );
    expect(health.score).toBe(100);
    expect(health.canPublish).toBe(true);
    expect(health.blockers).toEqual([]);
  });

  it("applies -15 per qualitative failure", () => {
    const health = computeHealth(
      [pythonResult("rule_no_global_fetch.py", true)],
      [llmResult("Actionable Advice", "fail"), llmResult("Rate Limits", "fail")],
    );
    expect(health.score).toBe(70);
    expect(health.qualitativeFailures).toBe(2);
    expect(health.deterministicFailures).toBe(0);
    expect(health.canPublish).toBe(false);
  });

  it("gates publishing at the 90 boundary", () => {
    expect(MIN_PUBLISHABLE_SCORE).toBe(90);

    // Two warnings land exactly on the threshold: 100 - 5 - 5 = 90 -> publishable.
    const onBoundary = computeHealth(
      [pythonResult("rule_network_allowlist.py", true)],
      [llmResult("Actionable Advice", "warn"), llmResult("Rate Limits", "warn")],
    );
    expect(onBoundary.score).toBe(90);
    expect(onBoundary.canPublish).toBe(true);

    // One warning more drops below the gate (the penalties are multiples of 5,
    // so 89 itself is unreachable — 85 is the first score under the bar).
    const belowBoundary = computeHealth(
      [pythonResult("rule_network_allowlist.py", true)],
      [
        llmResult("Actionable Advice", "warn"),
        llmResult("Rate Limits", "warn"),
        llmResult("Description Clarity", "warn"),
      ],
    );
    expect(belowBoundary.score).toBe(85);
    expect(belowBoundary.score).toBeLessThan(MIN_PUBLISHABLE_SCORE);
    expect(belowBoundary.canPublish).toBe(false);
    expect(belowBoundary.blockers.join(" ")).toContain("85/100");
  });

  it("never blocks on a warning-free deterministic pass but always blocks on a deterministic failure", () => {
    const health = computeHealth(
      [
        pythonResult("rule_cf_worker_compat.py", false, "Line 14: prohibited module"),
        pythonResult("rule_no_global_fetch.py", true),
      ],
      [],
    );
    expect(health.score).toBe(75);
    expect(health.canPublish).toBe(false);
  });

  it("counts a WARN:-prefixed python message as a warning, not a failure", () => {
    const health = computeHealth(
      [
        pythonResult(
          "rule_dependencies_declared.py",
          true,
          "WARN: line 12 builds the tool name dynamically and cannot be verified.",
        ),
      ],
      [],
    );
    expect(health.warnings).toBe(1);
    expect(health.deterministicFailures).toBe(0);
    expect(health.score).toBe(95);
    expect(health.canPublish).toBe(true);
  });

  it("floors the score at 0", () => {
    const python = Array.from({ length: 5 }, (_, i) => pythonResult(`rule_${i}.py`, false, "boom"));
    const llm = [llmResult("Actionable Advice", "fail"), llmResult("Rate Limits", "warn")];
    const health = computeHealth(python, llm);
    expect(health.score).toBe(0);
    expect(health.deterministicFailures).toBe(5);
    expect(health.canPublish).toBe(false);
  });

  it("returns 100 with no results at all", () => {
    const health = computeHealth([], []);
    expect(health.score).toBe(100);
    expect(health.canPublish).toBe(true);
  });
});

describe("parseLLMValidationJson", () => {
  const array = `[
    { "rule": "Actionable Advice", "status": "warn", "reasoning": "CITY_NOT_FOUND lacks guidance." },
    { "rule": "Description Clarity", "status": "pass", "reasoning": "States what it returns." }
  ]`;

  it("parses a bare JSON array", () => {
    const parsed = parseLLMValidationJson(array);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({
      rule: "Actionable Advice",
      status: "warn",
      reasoning: "CITY_NOT_FOUND lacks guidance.",
    });
  });

  it("parses an array inside a ```json fence", () => {
    const parsed = parseLLMValidationJson(["```json", array, "```"].join("\n"));
    expect(parsed.map((r) => r.status)).toEqual(["warn", "pass"]);
  });

  it("parses an array embedded in conversational prose", () => {
    const raw = `Sure — here is my audit of the tool.\n\n${array}\n\nLet me know if you want fixes.`;
    const parsed = parseLLMValidationJson(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[1]?.rule).toBe("Description Clarity");
  });

  it("parses a single-line array with nested quotes", () => {
    const parsed = parseLLMValidationJson(
      'Result: [{"rule":"Rate Limits","status":"fail","reasoning":"Uses \\"unlimited\\" [sic]"}] done',
    );
    expect(parsed).toEqual([
      { rule: "Rate Limits", status: "fail", reasoning: 'Uses "unlimited" [sic]' },
    ]);
  });

  it("throws when the response contains no JSON array", () => {
    expect(() => parseLLMValidationJson("The tool looks fine to me!")).toThrow(
      /No JSON array found/,
    );
  });

  it("throws on an empty response", () => {
    expect(() => parseLLMValidationJson("   ")).toThrow(/empty/);
  });

  it("throws on a malformed array", () => {
    expect(() => parseLLMValidationJson('[{"rule": "A", "status":')).toThrow();
  });

  it("throws when an entry has an invalid status", () => {
    expect(() =>
      parseLLMValidationJson('[{"rule":"A","status":"maybe","reasoning":"hm"}]'),
    ).toThrow(/invalid "status"/);
  });

  it("throws when an entry is missing reasoning", () => {
    expect(() => parseLLMValidationJson('[{"rule":"A","status":"pass"}]')).toThrow(/reasoning/);
  });
});
