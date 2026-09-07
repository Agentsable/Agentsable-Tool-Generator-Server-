// @vitest-environment jsdom
/**
 * Behavioural tests for the [ Validator ] screen.
 * Spec: docs/llm_generated/14-screen-validator.md §1–§5.
 *
 * Monaco cannot mount under jsdom (it needs real layout + workers), so the
 * shared editor is replaced by a textarea that keeps the same contract. That is
 * enough to assert the invariant the spec actually cares about in §3.3: exactly
 * one editor instance exists at a time.
 */
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { ToolProvider, useTool } from "@/state/toolStore";
import { ValidatorScreen } from "@/screens/ValidatorScreen";
import {
  buildAutoFixPrompt,
  formatScoreBreakdown,
  formatStatusLine,
  parseConfigFieldRef,
  parseLineRef,
} from "@/screens/validator/ValidatorDashboard";
import { rubricDeclaresOutputFormat } from "@/screens/validator/LlmRulesPane";
import { BUILTIN_PYTHON_RULES } from "@/lib/tgs/pythonRules";
import { computeHealth } from "@/lib/tgs/health";

vi.mock("@/components/tgs/MonacoEditor", () => ({
  MonacoEditor: (props: {
    value: string;
    onChange?: (v: string) => void;
    language: string;
    path?: string;
    ariaLabel?: string;
  }) => (
    <textarea
      data-testid="monaco"
      data-language={props.language}
      data-path={props.path ?? ""}
      aria-label={props.ariaLabel ?? "editor"}
      value={props.value}
      onChange={(e) => props.onChange?.(e.target.value)}
    />
  ),
}));

function Harness({ claudeConfigured }: { claudeConfigured?: boolean }) {
  return (
    <ToolProvider>
      {claudeConfigured === undefined ? null : <SetClaude value={claudeConfigured} />}
      <ValidatorScreen />
    </ToolProvider>
  );
}

function SetClaude({ value }: { value: boolean }) {
  const { setClaudeConfigured } = useTool();
  useEffect(() => setClaudeConfigured(value), [setClaudeConfigured, value]);
  return null;
}

/**
 * Render inside `act` and flush the microtask that resolves
 * `isPyodideAvailable()`, so no state update lands outside act.
 */
async function renderScreen(props: { claudeConfigured?: boolean } = {}) {
  await act(async () => {
    render(<Harness {...props} />);
  });
}

/** Switching sub-views remounts a pane, so flush its mount effects too. */
async function openTab(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("tab", { name }));
  });
}

/* -------------------------------------------------------------------------- */
/* §1 sub-navigation                                                           */
/* -------------------------------------------------------------------------- */

describe("Validator sub-navigation", () => {
  it("renders the three sub-tabs and switches between them", async () => {
    await renderScreen();

    for (const name of ["Dashboard", "Python Rules", "LLM Rules"]) {
      expect(screen.getByRole("tab", { name })).toBeTruthy();
    }

    // Dashboard is the landing view.
    expect(screen.getByTestId("health-score")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Dashboard" }).getAttribute("aria-selected")).toBe(
      "true",
    );

    await openTab("Python Rules");
    expect(screen.queryByTestId("health-score")).toBeNull();
    expect(screen.getByText("Execution contract")).toBeTruthy();

    await openTab("LLM Rules");
    expect(screen.getByText("Claude Agent SDK pipeline")).toBeTruthy();
    expect(screen.getByTestId("monaco").getAttribute("data-language")).toBe("markdown");
    expect(screen.getByTestId("monaco").getAttribute("data-path")).toBe("sts_rules.md");

    await openTab("Dashboard");
    expect(screen.getByTestId("health-score")).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* §3 Python Rules pane                                                        */
/* -------------------------------------------------------------------------- */

describe("Python Rules pane", () => {
  it("lists the five built-in rule filenames", async () => {
    await renderScreen();
    await openTab("Python Rules");

    expect(BUILTIN_PYTHON_RULES).toHaveLength(5);
    for (const rule of BUILTIN_PYTHON_RULES) {
      expect(screen.getByText(rule.filename)).toBeTruthy();
    }
  });

  it("documents the execution contract", async () => {
    await renderScreen();
    await openTab("Python Rules");
    expect(
      screen.getByText(/def validate\(ts_code: str, config_json: dict\) -> tuple\[bool, str\]/),
    ).toBeTruthy();
  });

  it("keeps exactly one editor open — expanding rule B collapses rule A", async () => {
    await renderScreen();
    await openTab("Python Rules");

    // Nothing is expanded initially.
    expect(screen.queryAllByTestId("monaco")).toHaveLength(0);

    const first = BUILTIN_PYTHON_RULES[0]!;
    const second = BUILTIN_PYTHON_RULES[1]!;

    fireEvent.click(screen.getByText(first.filename));
    let editors = screen.getAllByTestId("monaco");
    expect(editors).toHaveLength(1);
    expect(editors[0]!.getAttribute("data-path")).toBe(first.filename);
    expect(editors[0]!.getAttribute("data-language")).toBe("python");

    fireEvent.click(screen.getByText(second.filename));
    editors = screen.getAllByTestId("monaco");
    expect(editors).toHaveLength(1); // rule A was collapsed, not stacked
    expect(editors[0]!.getAttribute("data-path")).toBe(second.filename);

    // Clicking the open rule again collapses it.
    fireEvent.click(screen.getByText(second.filename));
    expect(screen.queryAllByTestId("monaco")).toHaveLength(0);
  });

  it("commits the previous rule's buffer when another rule is expanded", async () => {
    await renderScreen();
    await openTab("Python Rules");

    const first = BUILTIN_PYTHON_RULES[0]!;
    const second = BUILTIN_PYTHON_RULES[1]!;

    fireEvent.click(screen.getByText(first.filename));
    fireEvent.change(screen.getByTestId("monaco"), {
      target: { value: "# edited buffer\n" },
    });

    // Switching rules must flush, not discard.
    fireEvent.click(screen.getByText(second.filename));
    expect(screen.getByTestId("monaco").getAttribute("data-path")).toBe(second.filename);

    fireEvent.click(screen.getByText(first.filename));
    expect((screen.getByTestId("monaco") as HTMLTextAreaElement).value).toBe("# edited buffer\n");
  });

  it("creates a rule from the inline filename input and opens it", async () => {
    await renderScreen();
    await openTab("Python Rules");

    fireEvent.click(screen.getByRole("button", { name: /New Rule/ }));
    fireEvent.change(screen.getByLabelText("New rule file name"), {
      target: { value: "rule_custom" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create rule" }));

    expect(screen.getByText("rule_custom.py")).toBeTruthy();
    const editors = screen.getAllByTestId("monaco");
    expect(editors).toHaveLength(1);
    expect(editors[0]!.getAttribute("data-path")).toBe("rule_custom.py");
    // Only non-builtin rules are deletable.
    expect(screen.getByRole("button", { name: /Delete rule/ })).toBeTruthy();
  });

  it("marks built-ins and offers reset instead of delete", async () => {
    await renderScreen();
    await openTab("Python Rules");

    const first = BUILTIN_PYTHON_RULES[0]!;
    fireEvent.click(screen.getByText(first.filename));
    expect(screen.getByRole("button", { name: /Reset to built-in/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Delete rule/ })).toBeNull();
    expect(screen.getAllByText("built-in").length).toBe(BUILTIN_PYTHON_RULES.length);
  });
});

/* -------------------------------------------------------------------------- */
/* §2 Dashboard                                                                */
/* -------------------------------------------------------------------------- */

describe("Validator dashboard", () => {
  it("starts stale with a zero-run message and a blocked publish gate", async () => {
    await renderScreen();

    expect(screen.getByTestId("stale-banner").textContent).toContain("Stale — re-run validations");
    expect(screen.getByTestId("stale-banner").textContent).toContain(
      "No validation has been run for this tool yet",
    );
    expect(screen.getByTestId("health-status").textContent).toContain("Not run yet");

    // computeHealth([], []) === 100 with zero failures, so the empty state is
    // "ready"; what tells the user not to trust it is the stale banner.
    const gate = screen.getByTestId("publish-gate");
    expect(gate.textContent).toContain("Ready to publish");
    expect(within(gate).getByText(/Score ≥ 90/)).toBeTruthy();

    expect(screen.getByTestId("deterministic-findings").textContent).toContain(
      "No deterministic results yet",
    );
    expect(screen.getByTestId("heuristic-findings").textContent).toContain(
      "No heuristic results yet",
    );
  });

  it("shows the Claude-not-configured message instead of a fake pass", async () => {
    await renderScreen({ claudeConfigured: false });

    expect(
      await screen.findByText(
        /Claude is not configured — set ANTHROPIC_API_KEY on the server to enable heuristic checks\./,
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("heuristic-findings").textContent).toContain(
      "Heuristic checks are unavailable until Claude is configured",
    );
  });

  it("hides the not-configured message when Claude is available", async () => {
    await renderScreen({ claudeConfigured: true });
    expect(screen.queryByTestId("claude-unconfigured")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* §2.3 pure helpers                                                           */
/* -------------------------------------------------------------------------- */

describe("formatScoreBreakdown", () => {
  it("renders the spec's worked example: 1 deterministic failure + 1 warning ⇒ 70", () => {
    const health = computeHealth(
      [
        { filename: "rule_cf_worker_compat.py", passed: false, message: "bad", durationMs: 3 },
        { filename: "rule_no_global_fetch.py", passed: true, message: "ok", durationMs: 1 },
      ],
      [{ rule: "Actionable Error Advice", status: "warn", reasoning: "weak" }],
    );
    expect(health.score).toBe(70);
    expect(formatScoreBreakdown(health)).toBe("1 deterministic failure ×−25, 1 warning ×−5 ⇒ 70");
  });

  it("pluralises and includes qualitative failures", () => {
    const health = computeHealth(
      [
        { filename: "a.py", passed: false, message: "", durationMs: 1 },
        { filename: "b.py", passed: false, message: "", durationMs: 1 },
      ],
      [
        { rule: "r1", status: "fail", reasoning: "" },
        { rule: "r2", status: "warn", reasoning: "" },
        { rule: "r3", status: "warn", reasoning: "" },
      ],
    );
    expect(health.score).toBe(25); // 100 - 50 - 15 - 10
    expect(formatScoreBreakdown(health)).toBe(
      "2 deterministic failures ×−25, 1 qualitative failure ×−15, 2 warnings ×−5 ⇒ 25",
    );
  });

  it("reports no deductions for a clean run", () => {
    const health = computeHealth(
      [{ filename: "a.py", passed: true, message: "ok", durationMs: 1 }],
      [{ rule: "r", status: "pass", reasoning: "" }],
    );
    expect(formatScoreBreakdown(health)).toBe("No deductions ⇒ 100");
  });
});

describe("publish gate arithmetic", () => {
  it("is blocked by a deterministic failure and ready at >= 90 with none", () => {
    const blocked = computeHealth(
      [{ filename: "a.py", passed: false, message: "boom", durationMs: 1 }],
      [],
    );
    expect(blocked.canPublish).toBe(false);
    expect(blocked.blockers.length).toBeGreaterThan(0);

    const ready = computeHealth(
      [{ filename: "a.py", passed: true, message: "ok", durationMs: 1 }],
      [{ rule: "r", status: "warn", reasoning: "" }],
    );
    expect(ready.score).toBe(95);
    expect(ready.canPublish).toBe(true);
    expect(ready.blockers).toEqual([]);
  });
});

describe("formatStatusLine", () => {
  it("matches the spec's `⚠️ 1 Failure, 1 Warning` shape", () => {
    const health = computeHealth(
      [{ filename: "a.py", passed: false, message: "x", durationMs: 1 }],
      [{ rule: "r", status: "warn", reasoning: "" }],
    );
    expect(formatStatusLine(health, true)).toBe("❌ 1 Failure, 1 Warning");
    expect(formatStatusLine(health, false)).toContain("Not run yet");
  });

  it("reports a clean pass", () => {
    const health = computeHealth(
      [{ filename: "a.py", passed: true, message: "", durationMs: 1 }],
      [],
    );
    expect(formatStatusLine(health, true)).toBe("✅ All checks passed");
  });
});

describe("finding jump targets", () => {
  it("parses a line reference out of a rule message", () => {
    expect(parseLineRef("Line 14: Found prohibited module 'node:path'.")).toBe(14);
    expect(parseLineRef("illegal import on line 7")).toBe(7);
    expect(parseLineRef("no reference here")).toBeNull();
  });

  it("parses a config field reference out of heuristic reasoning", () => {
    expect(parseConfigFieldRef("config.rate_limit is unlimited")).toBe("rate_limit");
    expect(parseConfigFieldRef("nothing to see")).toBeNull();
  });
});

describe("buildAutoFixPrompt", () => {
  it("names the finding so the AI sidebar has concrete context", () => {
    const prompt = buildAutoFixPrompt("python", "rule_cf_worker_compat.py", "Line 14: node:path");
    expect(prompt).toContain("rule_cf_worker_compat.py");
    expect(prompt).toContain("Line 14: node:path");
    expect(prompt).toContain("deterministic Python (Pyodide) validator rule");
  });
});

/* -------------------------------------------------------------------------- */
/* §4 LLM Rules pane                                                           */
/* -------------------------------------------------------------------------- */

describe("rubricDeclaresOutputFormat", () => {
  it("accepts the default rubric and rejects one missing the JSON contract", async () => {
    await renderScreen();
    await openTab("LLM Rules");
    expect(screen.queryByTestId("rubric-format-warning")).toBeNull();

    fireEvent.change(screen.getByTestId("monaco"), {
      target: { value: "# Just some prose guidelines\n" },
    });
    expect(screen.getByTestId("rubric-format-warning")).toBeTruthy();

    expect(rubricDeclaresOutputFormat('return JSON with "status"')).toBe(true);
    expect(rubricDeclaresOutputFormat("return a JSON array")).toBe(false);
    expect(rubricDeclaresOutputFormat("no format at all")).toBe(false);
  });
});
