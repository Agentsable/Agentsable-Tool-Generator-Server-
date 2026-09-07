/**
 * Validator → [ Dashboard ]
 *
 * Spec: docs/llm_generated/14-screen-validator.md §2 (health score arithmetic,
 * findings tree, click-to-jump) and §5 (staleness + AI auto-remediation).
 *
 * This screen NEVER fabricates a result. When an engine cannot run (no Web
 * Workers, no ANTHROPIC_API_KEY) it says so — a fake pass would silently defeat
 * the publish gate defined in §2.3.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Ban,
  Bot,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  Play,
  RefreshCw,
  ShieldCheck,
  Terminal,
  XCircle,
} from "lucide-react";

import {
  DETERMINISTIC_FAILURE_PENALTY,
  MIN_PUBLISHABLE_SCORE,
  QUALITATIVE_FAILURE_PENALTY,
  WARNING_PENALTY,
  isPythonWarning,
  type HealthReport,
  type LLMValidationResult,
} from "@/lib/tgs/health";
import { isPyodideAvailable, type PythonRuleResult } from "@/lib/tgs/pythonEngine";
import { useTool } from "@/state/toolStore";

/* ------------------------------------------------------------------ */
/* pure helpers (unit-tested directly)                                 */
/* ------------------------------------------------------------------ */

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * The explicit arithmetic behind the score, e.g.
 *   `1 deterministic failure ×−25, 1 warning ×−5 ⇒ 70`
 *
 * The formula (not the source doc's hand-computed 82) is authoritative — see
 * reconciliation entry #10 in docs/llm_generated/00-INDEX.md.
 */
export function formatScoreBreakdown(health: HealthReport): string {
  const parts: string[] = [];
  if (health.deterministicFailures > 0) {
    parts.push(
      `${health.deterministicFailures} deterministic ${plural(
        health.deterministicFailures,
        "failure",
        "failures",
      )} ×−${DETERMINISTIC_FAILURE_PENALTY}`,
    );
  }
  if (health.qualitativeFailures > 0) {
    parts.push(
      `${health.qualitativeFailures} qualitative ${plural(
        health.qualitativeFailures,
        "failure",
        "failures",
      )} ×−${QUALITATIVE_FAILURE_PENALTY}`,
    );
  }
  if (health.warnings > 0) {
    parts.push(
      `${health.warnings} ${plural(health.warnings, "warning", "warnings")} ×−${WARNING_PENALTY}`,
    );
  }
  if (parts.length === 0) return `No deductions ⇒ ${health.score}`;
  return `${parts.join(", ")} ⇒ ${health.score}`;
}

/** The `Status: ⚠️ 1 Failure, 1 Warning` line from the spec's ASCII layout. */
export function formatStatusLine(health: HealthReport, hasRun: boolean): string {
  if (!hasRun) return "Not run yet — no findings to report.";
  const failures = health.deterministicFailures + health.qualitativeFailures;
  if (failures === 0 && health.warnings === 0) return "✅ All checks passed";
  const icon = failures > 0 ? "❌" : "⚠️";
  const bits: string[] = [];
  if (failures > 0) bits.push(`${failures} ${plural(failures, "Failure", "Failures")}`);
  if (health.warnings > 0) {
    bits.push(`${health.warnings} ${plural(health.warnings, "Warning", "Warnings")}`);
  }
  return `${icon} ${bits.join(", ")}`;
}

/**
 * Pull a 1-based source line out of a rule message so the finding can jump into
 * the Editor (spec §2.3: "Clicking any failing finding highlights the exact
 * line"). Matches `Line 14:`, `line 14`, `(line 14)`.
 */
export function parseLineRef(message: string): number | null {
  const match = /\bline\s*[:#]?\s*(\d+)/i.exec(message);
  if (!match) return null;
  const raw = match[1];
  if (raw === undefined) return null;
  const line = Number.parseInt(raw, 10);
  return Number.isFinite(line) && line > 0 ? line : null;
}

/** A config field name mentioned by a heuristic finding, for the Config jump. */
export function parseConfigFieldRef(text: string): string | null {
  const match = /\bconfig(?:_json)?\.([A-Za-z_][A-Za-z0-9_]*)/.exec(text);
  return match?.[1] ?? null;
}

/**
 * The remediation prompt handed to the persistent AI Assistant (spec §5).
 * The Dashboard never calls a model itself — it only queues the request.
 */
export function buildAutoFixPrompt(kind: "python" | "llm", title: string, detail: string): string {
  const engine =
    kind === "python"
      ? "deterministic Python (Pyodide) validator rule"
      : "heuristic Claude Agent SDK rubric rule";
  return [
    `Auto-fix the validator finding from the ${engine} "${title}".`,
    "",
    "Finding:",
    detail,
    "",
    kind === "python"
      ? "Rewrite the tool's execution logic (or its config) so this rule passes, then explain the change in one sentence."
      : "Update the tool's config/description/error advice so this rubric rule passes, then explain the change in one sentence.",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* component                                                           */
/* ------------------------------------------------------------------ */

export function ValidatorDashboard() {
  const {
    validation,
    runAllValidations,
    runPythonValidations,
    runLlmValidation,
    requestFocus,
    appendChat,
    claudeConfigured,
  } = useTool();

  const [showDeterministic, setShowDeterministic] = useState(true);
  const [showHeuristic, setShowHeuristic] = useState(true);
  const [pyodideOk, setPyodideOk] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    void isPyodideAvailable().then((ok) => {
      if (live) setPyodideOk(ok);
    });
    return () => {
      live = false;
    };
  }, []);

  const { health, python, llm, pythonRunning, llmRunning, stale, lastRunAt } = validation;
  const busy = pythonRunning || llmRunning;
  const hasRun = python.length > 0 || llm.length > 0 || lastRunAt !== null;

  /**
   * Auto-remediation hand-off (spec §5). The Dashboard owns no AI transport:
   * it appends the user turn to the shared chat log and fires a DOM event that
   * the persistent left AI Assistant listens for. Keeping the submit path in
   * the sidebar means there is exactly one place that talks to Claude.
   */
  const autoFix = useCallback(
    (kind: "python" | "llm", title: string, detail: string) => {
      const prompt = buildAutoFixPrompt(kind, title, detail);
      appendChat({ role: "user", text: prompt });
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("tgs:ai-submit", { detail: { prompt } }));
      }
    },
    [appendChat],
  );

  const deterministicSummary = useMemo(() => {
    const failed = python.filter((r) => !r.passed).length;
    const warned = python.filter((r) => isPythonWarning(r)).length;
    return { failed, warned, total: python.length };
  }, [python]);

  const heuristicSummary = useMemo(() => {
    const failed = llm.filter((r) => r.status === "fail").length;
    const warned = llm.filter((r) => r.status === "warn").length;
    return { failed, warned, total: llm.length };
  }, [llm]);

  return (
    <div className="space-y-4">
      {/* ---------------------------------------------------------- */}
      {/* actions                                                     */}
      {/* ---------------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void runAllValidations()}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Play className="h-4 w-4" aria-hidden />
          )}
          ▶ Run All Validations
        </button>
        <button
          type="button"
          className="btn"
          disabled={pythonRunning}
          onClick={() => void runPythonValidations()}
        >
          {pythonRunning ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Terminal className="h-4 w-4" aria-hidden />
          )}
          ▶ Run Python Checks
        </button>
        <button
          type="button"
          className="btn"
          disabled={llmRunning}
          onClick={() => void runLlmValidation()}
        >
          {llmRunning ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <BrainCircuit className="h-4 w-4" aria-hidden />
          )}
          ▶ Run LLM Validator
        </button>
        {busy ? (
          <span className="chip text-muted-foreground" role="status">
            {pythonRunning && llmRunning
              ? "Both engines running…"
              : pythonRunning
                ? "Pyodide worker running…"
                : "Claude reviewing…"}
          </span>
        ) : null}
        {lastRunAt ? (
          <span className="chip text-muted-foreground">
            <Clock className="h-3 w-3" aria-hidden /> Last run{" "}
            {new Date(lastRunAt).toLocaleString()}
          </span>
        ) : null}
      </div>

      {/* ---------------------------------------------------------- */}
      {/* staleness banner (§5 live re-validation)                     */}
      {/* ---------------------------------------------------------- */}
      {stale && !busy ? (
        <div className="finding" data-state="warn" role="status" data-testid="stale-banner">
          <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <div>
            <p className="font-semibold text-warning">Stale — re-run validations</p>
            <p className="text-muted-foreground">
              {hasRun
                ? "The tool code, config or rule set changed since the last run. These findings no longer describe the current tool."
                : "No validation has been run for this tool yet. Run the engines to produce a health score."}
            </p>
          </div>
        </div>
      ) : null}

      {/* ---------------------------------------------------------- */}
      {/* health score widget (§2.3)                                   */}
      {/* ---------------------------------------------------------- */}
      <div className="grid gap-3 md:grid-cols-3">
        <div className="stat-card" data-testid="health-score">
          <span className="label">Health Score</span>
          <p className="font-mono text-4xl text-primary">
            {health.score} <span className="text-xl text-muted-foreground">/ 100</span>
          </p>
          <p className="mt-1 text-sm" data-testid="health-status">
            {formatStatusLine(health, hasRun)}
          </p>
        </div>

        <div className="stat-card">
          <span className="label">Score arithmetic</span>
          <p className="code-surface mt-1 whitespace-pre-wrap" data-testid="score-breakdown">
            {formatScoreBreakdown(health)}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Deterministic failure −{DETERMINISTIC_FAILURE_PENALTY} · qualitative failure −
            {QUALITATIVE_FAILURE_PENALTY} · warning −{WARNING_PENALTY}, clamped to 0–100.
          </p>
        </div>

        <div className="stat-card" data-testid="publish-gate">
          <span className="label">Publish gate</span>
          {health.canPublish ? (
            <p className="mt-1 flex items-center gap-2 text-sm font-semibold text-success">
              <ShieldCheck className="h-4 w-4" aria-hidden /> Ready to publish
            </p>
          ) : (
            <p className="mt-1 flex items-center gap-2 text-sm font-semibold text-destructive">
              <Ban className="h-4 w-4" aria-hidden /> Publish blocked
            </p>
          )}
          {health.canPublish ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Score ≥ {MIN_PUBLISHABLE_SCORE} and zero deterministic failures.
            </p>
          ) : (
            <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
              {health.blockers.map((b) => (
                <li key={b}>• {b}</li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* ---------------------------------------------------------- */}
      {/* engine availability / errors — never faked                   */}
      {/* ---------------------------------------------------------- */}
      {validation.pythonError ? (
        <div className="finding" data-state="fail" role="alert">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
          <div>
            <p className="font-semibold text-destructive">Python engine error</p>
            <p className="text-muted-foreground">{validation.pythonError}</p>
          </div>
        </div>
      ) : null}

      {pyodideOk === false ? (
        <div className="finding" data-state="warn" role="status">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <div>
            <p className="font-semibold text-warning">Python engine unavailable</p>
            <p className="text-muted-foreground">
              Web Workers are not available here, so the deterministic Pyodide rules cannot run. No
              results are shown rather than assumed passes.
            </p>
          </div>
        </div>
      ) : null}

      {claudeConfigured === false ? (
        <div className="finding" data-state="warn" role="status" data-testid="claude-unconfigured">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <div>
            <p className="font-semibold text-warning">Heuristic checks disabled</p>
            <p className="text-muted-foreground">
              Claude is not configured — set ANTHROPIC_API_KEY on the server to enable heuristic
              checks.
            </p>
          </div>
        </div>
      ) : null}

      {validation.llmError ? (
        <div className="finding" data-state="fail" role="alert">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
          <div>
            <p className="font-semibold text-destructive">LLM validator error</p>
            <p className="text-muted-foreground">{validation.llmError}</p>
          </div>
        </div>
      ) : null}

      {/* ---------------------------------------------------------- */}
      {/* findings tree (§2.3)                                         */}
      {/* ---------------------------------------------------------- */}
      <section className="space-y-2">
        <button
          type="button"
          className="flex w-full items-center gap-2 text-left text-xs font-bold uppercase text-muted-foreground"
          aria-expanded={showDeterministic}
          onClick={() => setShowDeterministic((v) => !v)}
        >
          {showDeterministic ? (
            <ChevronDown className="h-4 w-4" aria-hidden />
          ) : (
            <ChevronRight className="h-4 w-4" aria-hidden />
          )}
          DETERMINISTIC CHECKS (Python Wasm)
          <span className="chip ml-2">
            {deterministicSummary.total} rules · {deterministicSummary.failed} fail ·{" "}
            {deterministicSummary.warned} warn
          </span>
        </button>

        {showDeterministic ? (
          <div className="space-y-2" data-testid="deterministic-findings">
            {python.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No deterministic results yet. Run the Python checks.
              </p>
            ) : (
              python.map((result) => (
                <PythonFinding
                  key={result.filename}
                  result={result}
                  onJump={(line) => requestFocus("Editor", { line })}
                  onAutoFix={() =>
                    autoFix("python", result.filename, result.error ?? result.message)
                  }
                />
              ))
            )}
          </div>
        ) : null}

        <button
          type="button"
          className="flex w-full items-center gap-2 text-left text-xs font-bold uppercase text-muted-foreground"
          aria-expanded={showHeuristic}
          onClick={() => setShowHeuristic((v) => !v)}
        >
          {showHeuristic ? (
            <ChevronDown className="h-4 w-4" aria-hidden />
          ) : (
            <ChevronRight className="h-4 w-4" aria-hidden />
          )}
          HEURISTIC CHECKS (Claude Agent SDK)
          <span className="chip ml-2">
            {heuristicSummary.total} rules · {heuristicSummary.failed} fail ·{" "}
            {heuristicSummary.warned} warn
          </span>
        </button>

        {showHeuristic ? (
          <div className="space-y-2" data-testid="heuristic-findings">
            {llm.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {claudeConfigured === false
                  ? "Heuristic checks are unavailable until Claude is configured."
                  : "No heuristic results yet. Run the LLM validator."}
              </p>
            ) : (
              llm.map((result, index) => (
                <LlmFinding
                  key={`${result.rule}-${index}`}
                  result={result}
                  onJumpConfig={(field) =>
                    requestFocus("Config", field === null ? undefined : { field })
                  }
                  onAutoFix={() => autoFix("llm", result.rule, result.reasoning)}
                />
              ))
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* rows                                                                */
/* ------------------------------------------------------------------ */

function PythonFinding({
  result,
  onJump,
  onAutoFix,
}: {
  result: PythonRuleResult;
  onJump: (line: number) => void;
  onAutoFix: () => void;
}) {
  const warn = isPythonWarning(result);
  const state = !result.passed ? "fail" : warn ? "warn" : "pass";
  const line = parseLineRef(result.error ?? result.message);
  const clickable = state !== "pass" && line !== null;

  return (
    <div className="finding" data-state={state === "pass" ? undefined : state}>
      {state === "fail" ? (
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
      ) : state === "warn" ? (
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
      ) : (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
      )}

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs">
            {state === "fail" ? "[❌ FAIL]" : state === "warn" ? "[⚠️ WARN]" : "[✅ PASS]"}
          </span>
          {clickable ? (
            <button
              type="button"
              className="font-mono text-sm text-primary underline underline-offset-2"
              onClick={() => onJump(line)}
              title={`Jump to line ${line} in the Editor`}
            >
              {result.filename}
            </button>
          ) : (
            <span className="font-mono text-sm">{result.filename}</span>
          )}
          <span className="chip ml-auto text-muted-foreground">{result.durationMs} ms</span>
        </div>

        {state !== "pass" || result.message ? (
          <p className="mt-1 pl-1 text-muted-foreground">{result.message}</p>
        ) : null}
        {result.error ? (
          <pre className="code-surface mt-1 overflow-x-auto rounded-md p-2 text-destructive">
            {result.error}
          </pre>
        ) : null}

        {state !== "pass" ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {line !== null ? (
              <button type="button" className="btn" onClick={() => onJump(line)}>
                Show line {line} in Editor
              </button>
            ) : null}
            <button type="button" className="btn btn-accent" onClick={onAutoFix}>
              <Bot className="h-4 w-4" aria-hidden /> Auto-Fix
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function LlmFinding({
  result,
  onJumpConfig,
  onAutoFix,
}: {
  result: LLMValidationResult;
  onJumpConfig: (field: string | null) => void;
  onAutoFix: () => void;
}) {
  const state = result.status === "pass" ? "pass" : result.status === "warn" ? "warn" : "fail";
  const field = parseConfigFieldRef(result.reasoning);

  return (
    <div className="finding" data-state={state === "pass" ? undefined : state}>
      {state === "fail" ? (
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
      ) : state === "warn" ? (
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
      ) : (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
      )}

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs">
            {state === "fail" ? "[❌ FAIL]" : state === "warn" ? "[⚠️ WARN]" : "[✅ PASS]"}
          </span>
          <span className="text-sm font-semibold">{result.rule}</span>
        </div>
        <p className="mt-1 pl-1 text-muted-foreground">{result.reasoning}</p>

        {state !== "pass" ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="btn" onClick={() => onJumpConfig(field)}>
              {field === null ? "Open Config" : `Open Config → ${field}`}
            </button>
            <button type="button" className="btn btn-accent" onClick={onAutoFix}>
              <Bot className="h-4 w-4" aria-hidden /> Auto-Fix
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
