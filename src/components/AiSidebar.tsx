/**
 * The persistent left AI pane — docs/llm_generated/01-system-overview.md §2.
 *
 * "The assistant has global context access: it reads the current code, writes
 * updates, and triggers test executions."
 *
 * Every turn ships the whole tool context (source, config, rubric, deterministic
 * findings, test results) plus the active tab, and every edit the model returns is
 * applied to the real store and then announced — never silently:
 *   logic        -> setLogic                     (11-screen-editor.md §5)
 *   config       -> configDraft + saveFormToTool (12-screen-config.md §6)
 *   error_advice -> config.signature.errors[code]
 *   test         -> saveEmbeddedTests / saveJsonTests
 *   request_run  -> runAllTests / runAllValidations
 *
 * The Validator's [ Auto-Fix ] buttons drive this pane by dispatching a
 * `tgs:ai-submit` CustomEvent (14-screen-validator.md §5). Those dispatchers log
 * the user turn themselves, so the listener submits without echoing it again.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, CornerDownLeft, Sparkles, TriangleAlert, Wrench } from "lucide-react";
import { toast } from "sonner";

import type { ToolConfig, ToolTest } from "@/lib/tgs/contract";
import type { AssistantEdit } from "@/rpc/tgsServerFns";
import { getClaudeStatus, postAssistantTurn } from "@/rpc/tgsServerFns";
import { useTool, type WorkspaceTab } from "@/state/toolStore";

/** The event the Validator (and any other screen) dispatches to drive this pane. */
export const AI_SUBMIT_EVENT = "tgs:ai-submit";

const NOT_CONFIGURED =
  "Claude is not configured. Set ANTHROPIC_API_KEY in the server environment and restart.";

const STARTERS: Record<WorkspaceTab, string[]> = {
  "Raw Data": [
    "Explain what each of the four files contains.",
    "Is anything in this bundle inconsistent between the .ts and the .json?",
    "Summarise this tool's contract in three lines.",
    "Give the tool a clearer description.",
  ],
  Editor: [
    "Wrap the outbound call in an error check for status 404.",
    "Validate every required input before doing any work.",
    "Replace any direct fetch() with context.useCoreTool('network_gateway', {...}).",
    "Return a structured JSON error instead of throwing.",
  ],
  Config: [
    "Add a required string parameter 'units' with enum 'metric' or 'imperial'.",
    "Set a sensible rate limit between 60 and 600 requests per minute.",
    "Describe every declared secret so an operator knows what to supply.",
    "Document the outputs in the signature.",
  ],
  Secrets: [
    "Declare an API key secret with a clear description.",
    "Which secrets does this tool actually need?",
    "Mark the optional secrets as optional in the config.",
  ],
  Validator: [
    "Fix every deterministic failure on the dashboard.",
    "Rewrite the error advice so an agent can self-correct.",
    "Run all validations.",
    "Explain the current health score.",
  ],
  Runner: [
    "Add an edge-case test for a missing required parameter.",
    "Why did the failing test fail?",
    "Run the tests.",
    "Add a test that asserts a 400 for bad input.",
  ],
};

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursive merge; arrays and scalars from the patch replace the base. */
function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in out ? deepMerge(out[key], value) : value;
  }
  return out;
}

/** Let React flush the state writes from the previous edit before the next one reads them. */
function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function errorMessage(e: unknown): string {
  return e instanceof Error && e.message ? e.message : String(e);
}

/* ------------------------------------------------------------------ */

export function AiSidebar() {
  const store = useTool();
  const { chat, activeTab, claudeConfigured, setClaudeConfigured } = store;

  // The window listener and the async turn must always see the newest store.
  const storeRef = useRef(store);
  storeRef.current = store;

  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [model, setModel] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  /* ------------------------- availability ------------------------- */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await getClaudeStatus();
        if (cancelled) return;
        setClaudeConfigured(status.configured);
        setModel(status.model);
        setReason(status.reason ?? null);
      } catch (e) {
        if (cancelled) return;
        setClaudeConfigured(false);
        setReason(errorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // setClaudeConfigured is a stable useCallback-free setter on the store value;
    // this must run exactly once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* -------------------------- auto-scroll -------------------------- */
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat, pending]);

  /* ------------------------- edit application ---------------------- */

  /**
   * Apply one assistant edit to the real store and return the sentence that
   * will be shown to the user. Reads the store through the ref so a batch of
   * edits sees the previous one's writes.
   */
  const applyEdit = useCallback(async (edit: AssistantEdit): Promise<string> => {
    const s = storeRef.current;
    switch (edit.kind) {
      case "logic": {
        s.setLogic(edit.logic);
        const lines = edit.logic.split("\n").length;
        return `Rewrote the execution logic in the [ Editor ] buffer (${lines} lines): ${edit.rationale}`;
      }
      case "config": {
        const merged = deepMerge(s.configDraft, edit.patch) as Partial<ToolConfig>;
        s.setConfigDraft(merged);
        await nextTick();
        storeRef.current.saveFormToTool();
        const touched = Object.keys(edit.patch).join(", ") || "(nothing)";
        return `Patched the config and saved it into the tool (${touched}): ${edit.rationale}`;
      }
      case "error_advice": {
        const draftConfig = s.configDraft;
        const signature = isPlainObject(draftConfig.signature)
          ? (draftConfig.signature as unknown as Record<string, unknown>)
          : {};
        const existingErrors = isPlainObject(signature["errors"]) ? signature["errors"] : {};
        const patch = {
          signature: {
            ...signature,
            errors: {
              ...existingErrors,
              [edit.code]: {
                description: edit.description,
                actionable_advice: edit.actionable_advice,
              },
            },
          },
        };
        const merged = deepMerge(draftConfig, patch) as Partial<ToolConfig>;
        s.setConfigDraft(merged);
        await nextTick();
        storeRef.current.saveFormToTool();
        return `Gave the error "${edit.code}" actionable advice: ${edit.actionable_advice}`;
      }
      case "test": {
        if (edit.target === "ts") {
          const existing = s.bundle.config.tests ?? [];
          s.saveEmbeddedTests([...existing, edit.test as ToolTest]);
          return `Added the embedded test "${edit.test.name}" to config.tests in the .ts file.`;
        }
        const next = [...s.bundle.jsonTests, edit.test as ToolTest];
        const result = s.saveJsonTests(JSON.stringify(next, null, 2));
        return result.ok
          ? `Added the test "${edit.test.name}" to the external test suite.`
          : `Could not add the test "${edit.test.name}": ${result.error ?? "invalid JSON"}`;
      }
      case "request_run": {
        if (edit.what === "tests") {
          void s.runAllTests();
          return "Triggered [ ▶ Run All Tests ] against the local Deno runner.";
        }
        void s.runAllValidations();
        return "Triggered [ ▶ Run All Validations ] (Pyodide + Claude heuristics).";
      }
      default:
        return "Ignored an edit of an unknown kind.";
    }
  }, []);

  /* ------------------------------ turn ----------------------------- */

  /**
   * `echoUserTurn: false` is for callers that already put the user's turn in the
   * chat log themselves — the Validator's [ Auto-Fix ] buttons do exactly that
   * before dispatching `tgs:ai-submit`. The transcript sent to Claude is deduped
   * either way, because that `appendChat` may not have flushed yet when the
   * synchronously-dispatched event reaches us.
   */
  const submit = useCallback(
    async (prompt: string, options?: { echoUserTurn?: boolean }) => {
      const text = prompt.trim();
      if (text === "" || pendingRef.current) return;
      const s = storeRef.current;
      if (s.claudeConfigured === false) {
        toast.error(NOT_CONFIGURED);
        return;
      }

      // Build the transcript BEFORE appending, and start it on a user turn.
      const history = s.chat
        .filter((m) => (m.role === "user" || m.role === "assistant") && m.pending !== true)
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.text }));
      const firstUser = history.findIndex((m) => m.role === "user");
      const trimmed = firstUser === -1 ? [] : history.slice(firstUser);
      const last = trimmed[trimmed.length - 1];
      const messages =
        last && last.role === "user" && last.content === text
          ? trimmed
          : [...trimmed, { role: "user" as const, content: text }];

      if (options?.echoUserTurn !== false) s.appendChat({ role: "user", text });
      const pendingId = s.appendChat({ role: "assistant", text: "Thinking…", pending: true });
      pendingRef.current = true;
      setPending(true);

      const tsFile = s.files.find((f) => f.kind === "ts");
      const context = {
        toolName: s.bundle.name,
        tsCode: tsFile?.content ?? "",
        configJson: s.bundle.configJson,
        rubricMarkdown: s.rubricMarkdown,
        pythonFindings: s.validation.python.map((r) => ({
          filename: r.filename,
          passed: r.passed,
          message: r.message,
        })),
        testResults: s.runnerResults.map((r) => ({
          name: r.name,
          source: r.source,
          ok: r.ok,
          detail: r.detail,
        })),
      };

      try {
        const res = await postAssistantTurn({
          data: { messages, context, activeTab: s.activeTab },
        });

        if (!res.ok) {
          storeRef.current.updateChat(pendingId, {
            text: res.error,
            pending: false,
            error: true,
          });
          toast.error(`Claude request failed (${res.code})`, { description: res.error });
          return;
        }

        storeRef.current.updateChat(pendingId, {
          text: res.reply,
          pending: false,
          error: false,
        });

        const applied: string[] = [];
        for (const edit of res.edits) {
          applied.push(await applyEdit(edit));
          await nextTick();
        }

        if (applied.length > 0) {
          const summary = applied.map((line) => `• ${line}`).join("\n");
          storeRef.current.appendChat({
            role: "system",
            text: `Applied ${applied.length} change${applied.length === 1 ? "" : "s"} to the tool:\n${summary}`,
          });
          toast.success(
            `Applied ${applied.length} change${applied.length === 1 ? "" : "s"} from the assistant`,
            { description: applied.join(" ") },
          );
        }
      } catch (e) {
        storeRef.current.updateChat(pendingId, {
          text: `The assistant request failed: ${errorMessage(e)}`,
          pending: false,
          error: true,
        });
        toast.error(`The assistant request failed: ${errorMessage(e)}`);
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [applyEdit],
  );

  // Keep the window listener pointed at the newest `submit`.
  const submitRef = useRef(submit);
  submitRef.current = submit;

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ prompt?: string }>).detail;
      const prompt = detail?.prompt;
      if (typeof prompt === "string" && prompt.trim() !== "") {
        // The dispatcher (e.g. the Validator's [ Auto-Fix ]) has already put the
        // user turn in the chat log — submit it, do not echo it a second time.
        void submitRef.current(prompt, { echoUserTurn: false });
      }
    };
    window.addEventListener(AI_SUBMIT_EVENT, handler);
    return () => window.removeEventListener(AI_SUBMIT_EVENT, handler);
  }, []);

  /* ----------------------------- render ---------------------------- */

  const disabled = claudeConfigured === false || pending;
  const starters = STARTERS[activeTab];

  return (
    <aside className="flex h-full w-full min-h-0 flex-col border-b border-border bg-surface lg:border-b-0 lg:border-r">
      <div className="panel-head border-b">
        <Bot className="h-4 w-4 text-primary" />
        <span>AI Assistant</span>
        <span className="chip ml-auto" title="The assistant is aware of the active tab">
          {activeTab}
        </span>
        {model ? (
          <span className="chip" title="Model used for this workspace">
            {model}
          </span>
        ) : null}
      </div>

      {claudeConfigured === false ? (
        <div className="m-3 rounded-md border border-border-strong bg-code p-3 text-sm">
          <p className="mb-1 flex items-center gap-1.5 font-semibold text-destructive">
            <TriangleAlert className="h-4 w-4" /> Assistant unavailable
          </p>
          <p className="text-sm leading-relaxed">{NOT_CONFIGURED}</p>
          {reason ? <p className="mt-2 text-xs text-muted-foreground">{reason}</p> : null}
        </div>
      ) : null}

      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto p-3">
        {chat.map((m) => (
          <div
            key={m.id}
            data-role={m.role}
            className={
              m.role === "user"
                ? "rounded-md border border-border-strong bg-surface-raised p-3 text-sm leading-relaxed"
                : m.role === "system"
                  ? "rounded-md border border-border bg-surface-raised p-3 text-sm leading-relaxed"
                  : "rounded-md border border-border bg-code p-3 text-sm leading-relaxed"
            }
          >
            <div className="mb-1 flex items-center gap-1.5 text-[0.68rem] uppercase tracking-widest text-muted-foreground">
              {m.role === "assistant" ? <Sparkles className="h-3 w-3 text-primary" /> : null}
              {m.role === "system" ? <Wrench className="h-3 w-3 text-secondary" /> : null}
              {m.role === "assistant"
                ? "agentsable agent"
                : m.role === "system"
                  ? "applied to the tool"
                  : "you"}
              {m.pending ? <span className="animate-pulse">thinking…</span> : null}
              {m.error ? <span className="text-destructive">error</span> : null}
            </div>
            <p className="whitespace-pre-wrap">{m.text}</p>
          </div>
        ))}
      </div>

      {claudeConfigured !== false ? (
        <div className="flex flex-wrap gap-1.5 border-t border-border px-3 pt-2">
          {starters.map((prompt) => (
            <button
              key={prompt}
              className="subtab text-left"
              disabled={disabled}
              onClick={() => void submit(prompt)}
              title={prompt}
            >
              {prompt.length > 42 ? `${prompt.slice(0, 41)}…` : prompt}
            </button>
          ))}
        </div>
      ) : null}

      <form
        className="flex items-center gap-2 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          const text = draft.trim();
          if (text === "") return;
          setDraft("");
          void submit(text);
        }}
      >
        <input
          className="field"
          placeholder={claudeConfigured === false ? "Assistant unavailable" : "Type a command..."}
          aria-label="Type a command"
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="submit"
          className="btn btn-primary"
          aria-label="Send command"
          disabled={disabled}
        >
          <CornerDownLeft className="h-4 w-4" />
        </button>
      </form>
    </aside>
  );
}
