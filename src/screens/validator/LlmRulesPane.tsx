/**
 * Validator → [ LLM Rules ]  (Claude Agent SDK rubric)
 *
 * Spec: docs/llm_generated/14-screen-validator.md §4.
 *
 * The markdown authored here is persisted as `sts_rules.md` and used verbatim
 * as the SYSTEM prompt of the heuristic review; the tool's `.ts` and `.json`
 * form the USER prompt. The rubric's "Mandatory Output Format" section is what
 * makes the response parseable, so this pane warns when it goes missing.
 */
import { useMemo } from "react";
import {
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  Loader2,
  RotateCcw,
  Save,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { MonacoEditor } from "@/components/tgs/MonacoEditor";
import { DEFAULT_LLM_RUBRIC } from "@/lib/tgs/pythonRules";
import { useTool } from "@/state/toolStore";

/**
 * Default in `src/server/claude.ts` (`DEFAULT_CLAUDE_MODEL`), overridable with
 * the `TGS_CLAUDE_MODEL` environment variable — spec §4.3 calls the model a
 * configurable app setting.
 */
const DISPLAY_MODEL = "claude-opus-5";

const OUTPUT_SCHEMA = `interface LLMValidationResult {
  rule: string;
  status: "pass" | "fail" | "warn";
  reasoning: string;
}`;

/**
 * The rubric must still tell the model to answer with a JSON array carrying a
 * `status` field, otherwise `parseLLMValidationJson` has nothing to extract.
 */
export function rubricDeclaresOutputFormat(markdown: string): boolean {
  return /json/i.test(markdown) && /"status"/.test(markdown);
}

export function LlmRulesPane() {
  const { rubricMarkdown, setRubricMarkdown, validation, runLlmValidation, claudeConfigured } =
    useTool();

  const formatOk = useMemo(() => rubricDeclaresOutputFormat(rubricMarkdown), [rubricMarkdown]);
  const isDefault = rubricMarkdown === DEFAULT_LLM_RUBRIC;

  return (
    <div className="space-y-4">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-primary"
          disabled={validation.llmRunning}
          onClick={() => void runLlmValidation()}
        >
          {validation.llmRunning ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <BrainCircuit className="h-4 w-4" aria-hidden />
          )}
          ▶ Run LLM Validator
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            // The editor already writes straight through to the store; this
            // button is the explicit persist affordance from the spec's layout.
            setRubricMarkdown(rubricMarkdown);
            toast.success("sts_rules.md saved.");
          }}
        >
          <Save className="h-4 w-4" aria-hidden /> 💾 Save Markdown
        </button>
        <button
          type="button"
          className="btn"
          disabled={isDefault}
          onClick={() => {
            setRubricMarkdown(DEFAULT_LLM_RUBRIC);
            toast.success("Rubric reset to the default.");
          }}
        >
          <RotateCcw className="h-4 w-4" aria-hidden /> Reset to default rubric
        </button>
        <span className="chip text-muted-foreground">sts_rules.md</span>
      </div>

      {!formatOk ? (
        <div
          className="finding"
          data-state="warn"
          role="status"
          data-testid="rubric-format-warning"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <div>
            <p className="font-semibold text-warning">Mandatory output format is missing</p>
            <p className="text-muted-foreground">
              The rubric no longer instructs the model to return a JSON array of objects with a{" "}
              <code className="font-mono">&quot;status&quot;</code> field. Parsing the response will
              likely fail and the run will be retried once, then error.
            </p>
          </div>
        </div>
      ) : null}

      {claudeConfigured === false ? (
        <div className="finding" data-state="warn" role="status">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <p className="text-muted-foreground">
            Claude is not configured — set ANTHROPIC_API_KEY on the server to enable heuristic
            checks.
          </p>
        </div>
      ) : null}

      {validation.llmError ? (
        <div className="finding" data-state="fail" role="alert">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
          <p className="text-muted-foreground">{validation.llmError}</p>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {/* editor */}
        <section className="panel">
          <div className="panel-head">
            <span>sts_rules.md — qualitative rubric</span>
          </div>
          <div className="p-2">
            <MonacoEditor
              value={rubricMarkdown}
              onChange={setRubricMarkdown}
              language="markdown"
              path="sts_rules.md"
              height="60vh"
              ariaLabel="LLM validation rubric (sts_rules.md)"
            />
          </div>
        </section>

        {/* pipeline documentation */}
        <aside className="space-y-4">
          <section className="panel">
            <div className="panel-head">Claude Agent SDK pipeline</div>
            <ol className="space-y-2 p-3 text-sm text-muted-foreground">
              <li>
                <span className="font-semibold text-foreground">1. Payload assembly</span> — this
                markdown becomes the <span className="font-mono">systemPrompt</span>; the user
                prompt is the tool&apos;s <span className="font-mono">.ts</span> source plus its{" "}
                <span className="font-mono">.json</span> config schema.
              </li>
              <li>
                <span className="font-semibold text-foreground">2. SDK invocation</span> — the
                server runs an agent query through{" "}
                <span className="font-mono">@anthropic-ai/claude-agent-sdk</span>.
              </li>
              <li>
                <span className="font-semibold text-foreground">3. Structured parsing</span> — the
                JSON array is extracted and validated against the schema below. If the model answers
                with prose instead of raw JSON, the run is{" "}
                <span className="font-semibold text-foreground">retried once</span> under the same
                rubric before erroring.
              </li>
            </ol>
            <div className="border-t border-border p-3">
              <span className="label">Required output</span>
              <pre className="code-surface overflow-x-auto rounded-md p-3">{OUTPUT_SCHEMA}</pre>
            </div>
            <div className="border-t border-border p-3 text-xs text-muted-foreground">
              <span className="label">Model</span>
              <span className="chip">{DISPLAY_MODEL}</span>
              <p className="mt-2">
                Configurable app setting — the server default, overridable with{" "}
                <span className="font-mono">TGS_CLAUDE_MODEL</span>.
              </p>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">Last heuristic run</div>
            <div className="space-y-2 p-3">
              {validation.llm.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No heuristic results yet. Run the LLM validator.
                </p>
              ) : (
                validation.llm.map((r, i) => (
                  <div
                    key={`${r.rule}-${i}`}
                    className="finding"
                    data-state={r.status === "pass" ? undefined : r.status}
                  >
                    {r.status === "fail" ? (
                      <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
                    ) : r.status === "warn" ? (
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
                    ) : (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">{r.rule}</p>
                      <p className="text-xs text-muted-foreground">{r.reasoning}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
