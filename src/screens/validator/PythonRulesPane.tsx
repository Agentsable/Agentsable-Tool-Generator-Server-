/**
 * Validator → [ Python Rules ]  (Pyodide / Wasm engine)
 *
 * Spec: docs/llm_generated/14-screen-validator.md §3.
 *
 * The hard requirement here is the **single-active editor constraint** (§3.3):
 * exactly one rule may be expanded at a time, and opening another rule first
 * commits the buffer of the one being collapsed. That is implemented with a
 * single `openId` plus one draft buffer which is flushed on collapse, on
 * [ 💾 Save Rule ], and on unmount — so only one Monaco instance ever exists.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  Terminal,
  Trash2,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { MonacoEditor } from "@/components/tgs/MonacoEditor";
import { BUILTIN_PYTHON_RULES } from "@/lib/tgs/pythonRules";
import { isPythonWarning } from "@/lib/tgs/health";
import type { PythonRuleResult } from "@/lib/tgs/pythonEngine";
import { useTool, type PythonRule } from "@/state/toolStore";

const EXECUTION_CONTRACT = `def validate(ts_code: str, config_json: dict) -> tuple[bool, str]:
    """
    Returns:
        bool: True for Pass, False for Fail.
        str: Explanatory message or failure context.
    """`;

function builtinSourceFor(filename: string): string | null {
  return BUILTIN_PYTHON_RULES.find((r) => r.filename === filename)?.source ?? null;
}

export function PythonRulesPane() {
  const {
    pythonRules,
    addPythonRule,
    updatePythonRule,
    removePythonRule,
    validation,
    runPythonValidations,
  } = useTool();

  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [newName, setNewName] = useState<string | null>(null);

  // Refs so the flush closure never goes stale (it is also called on unmount).
  const rulesRef = useRef<PythonRule[]>(pythonRules);
  rulesRef.current = pythonRules;
  const openIdRef = useRef<string | null>(openId);
  openIdRef.current = openId;
  const draftRef = useRef<string | null>(draft);
  draftRef.current = draft;

  /** Commit the open rule's buffer into the store if it actually changed. */
  const flush = useCallback(() => {
    const id = openIdRef.current;
    const buffer = draftRef.current;
    if (id === null || buffer === null) return;
    const current = rulesRef.current.find((r) => r.id === id);
    if (current === undefined || current.source === buffer) return;
    updatePythonRule(id, buffer);
  }, [updatePythonRule]);

  const flushRef = useRef(flush);
  flushRef.current = flush;

  // Save on unmount — leaving the Validator tab must not drop an edit.
  useEffect(() => () => flushRef.current(), []);

  // Seed the buffer synchronously whenever the active rule changes (including a
  // brand new rule created by [ + New Rule ], which lands in the store in the
  // same tick). Done during render — not in an effect — so no frame ever shows
  // the previous rule's buffer under the newly opened rule's file name.
  const [seededId, setSeededId] = useState<string | null>(null);
  if (seededId !== openId) {
    setSeededId(openId);
    setDraft(openId === null ? null : (pythonRules.find((r) => r.id === openId)?.source ?? ""));
  }

  /** The single-active-accordion transition: commit, then switch. */
  const toggleRule = useCallback((id: string) => {
    flushRef.current();
    setOpenId((prev) => (prev === id ? null : id));
  }, []);

  const saveRule = useCallback(() => {
    if (openIdRef.current === null) {
      toast.error("Open a rule before saving.");
      return;
    }
    flushRef.current();
    toast.success("Rule saved.");
  }, []);

  const createRule = useCallback(
    (raw: string) => {
      const trimmed = raw.trim();
      if (trimmed === "") {
        toast.error("Give the rule a file name.");
        return;
      }
      const filename = trimmed.endsWith(".py") ? trimmed : `${trimmed}.py`;
      if (rulesRef.current.some((r) => r.filename === filename)) {
        toast.error(`${filename} already exists.`);
        return;
      }
      flushRef.current();
      const id = addPythonRule(filename);
      setNewName(null);
      setOpenId(id);
    },
    [addPythonRule],
  );

  const resetBuiltin = useCallback(
    (rule: PythonRule) => {
      const source = builtinSourceFor(rule.filename);
      if (source === null) {
        toast.error(`${rule.filename} has no built-in version to restore.`);
        return;
      }
      updatePythonRule(rule.id, source);
      if (openIdRef.current === rule.id) setDraft(source);
      toast.success(`${rule.filename} restored to the built-in source.`);
    },
    [updatePythonRule],
  );

  const deleteRule = useCallback(
    (rule: PythonRule) => {
      if (openIdRef.current === rule.id) {
        // Drop the buffer first so the unmount flush cannot resurrect it.
        draftRef.current = null;
        setDraft(null);
        setOpenId(null);
      }
      removePythonRule(rule.id);
      toast.success(`${rule.filename} deleted.`);
    },
    [removePythonRule],
  );

  const resultFor = (filename: string): PythonRuleResult | undefined =>
    validation.python.find((r) => r.filename === filename);

  return (
    <div className="space-y-4">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn"
          onClick={() => setNewName((v) => (v === null ? "" : null))}
        >
          <Plus className="h-4 w-4" aria-hidden /> + New Rule
        </button>
        <button type="button" className="btn" onClick={saveRule} disabled={openId === null}>
          <Save className="h-4 w-4" aria-hidden /> 💾 Save Rule
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={validation.pythonRunning}
          onClick={() => {
            flushRef.current();
            void runPythonValidations();
          }}
        >
          {validation.pythonRunning ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Terminal className="h-4 w-4" aria-hidden />
          )}
          ▶ Run Python Checks
        </button>
        <span className="chip text-muted-foreground">{pythonRules.length} rules</span>
      </div>

      {newName !== null ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            createRule(newName);
          }}
        >
          <div className="min-w-56 flex-1">
            <label className="label" htmlFor="new-python-rule">
              New rule file name
            </label>
            <input
              id="new-python-rule"
              className="field"
              autoFocus
              placeholder="rule_my_check.py"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </div>
          <button type="submit" className="btn btn-primary">
            Create rule
          </button>
          <button type="button" className="btn" onClick={() => setNewName(null)}>
            Cancel
          </button>
        </form>
      ) : null}

      {validation.pythonError ? (
        <div className="finding" data-state="fail" role="alert">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
          <p className="text-muted-foreground">{validation.pythonError}</p>
        </div>
      ) : null}

      {/* accordion */}
      <div className="space-y-2">
        {pythonRules.map((rule) => {
          const result = resultFor(rule.filename);
          const open = rule.id === openId;
          return (
            <RuleRow
              key={rule.id}
              rule={rule}
              result={result}
              open={open}
              draft={open ? (draft ?? rule.source) : rule.source}
              onToggle={() => toggleRule(rule.id)}
              onChange={setDraft}
              onReset={() => resetBuiltin(rule)}
              onDelete={() => deleteRule(rule)}
            />
          );
        })}
      </div>

      {/* execution contract (§3.3) */}
      <section className="panel">
        <div className="panel-head">Execution contract</div>
        <div className="p-3">
          <pre className="code-surface overflow-x-auto rounded-md p-3">{EXECUTION_CONTRACT}</pre>
          <p className="mt-2 text-xs text-muted-foreground">
            Every rule file is executed in its own namespace inside the Pyodide Web Worker and must
            expose <code className="font-mono">validate</code>. The host transfers the rendered{" "}
            <code className="font-mono">.ts</code> source and the serialized config across the
            worker boundary, so heavy AST or regex work never blocks the UI thread.
          </p>
        </div>
      </section>
    </div>
  );
}

function RuleRow({
  rule,
  result,
  open,
  draft,
  onToggle,
  onChange,
  onReset,
  onDelete,
}: {
  rule: PythonRule;
  result: PythonRuleResult | undefined;
  open: boolean;
  draft: string;
  onToggle: () => void;
  onChange: (v: string) => void;
  onReset: () => void;
  onDelete: () => void;
}) {
  const state =
    result === undefined
      ? "none"
      : !result.passed
        ? "fail"
        : isPythonWarning(result)
          ? "warn"
          : "pass";

  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left"
        aria-expanded={open}
        onClick={onToggle}
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />
        )}
        {state === "fail" ? (
          <XCircle className="h-4 w-4 shrink-0 text-destructive" aria-hidden />
        ) : state === "warn" ? (
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden />
        ) : state === "pass" ? (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden />
        ) : null}
        <span className="font-mono text-xs">
          {state === "fail"
            ? "[❌ Fail]"
            : state === "warn"
              ? "[⚠️ Warn]"
              : state === "pass"
                ? "[✅ Pass]"
                : "[ not run ]"}
        </span>
        <span className="font-mono text-sm">{rule.filename}</span>
        {rule.builtin ? <span className="chip">built-in</span> : null}
        {result ? (
          <span className="chip ml-auto text-muted-foreground">{result.durationMs} ms</span>
        ) : null}
      </button>

      {result && state !== "pass" ? (
        <p className="px-3 pb-2 pl-10 text-sm text-muted-foreground">
          {result.error ?? result.message}
        </p>
      ) : null}

      {open ? (
        <div className="border-t border-border p-3">
          <div className="mb-2 flex flex-wrap gap-2">
            {rule.builtin ? (
              <button type="button" className="btn" onClick={onReset}>
                <RotateCcw className="h-4 w-4" aria-hidden /> Reset to built-in
              </button>
            ) : (
              <button type="button" className="btn btn-danger" onClick={onDelete}>
                <Trash2 className="h-4 w-4" aria-hidden /> Delete rule
              </button>
            )}
          </div>
          <MonacoEditor
            value={draft}
            onChange={onChange}
            language="python"
            path={rule.filename}
            height={320}
            ariaLabel={`Python rule ${rule.filename}`}
          />
        </div>
      ) : null}
    </div>
  );
}
