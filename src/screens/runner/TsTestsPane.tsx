/**
 * [ Runner ] › [ Tool TS Tests ] — docs/llm_generated/15-screen-runner.md §4.1.
 *
 * A structured read/write view of the embedded suite in `config.tests`, which
 * the AST engine extracted from `[tool_name].ts`. Saving injects the updated
 * array back into the `config` block WITHOUT disturbing the execution logic.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Code2, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";

import type { ToolTest } from "@/lib/tgs/contract";
import { useTool } from "@/state/toolStore";

/* ------------------------------------------------------------------ */
/* draft model (pure, unit-testable)                                    */
/* ------------------------------------------------------------------ */

export type TestDraft = {
  id: string;
  name: string;
  /** Raw text so an in-progress edit is never lost to a parse error. */
  payloadText: string;
  status: string;
  hasKey: string;
};

let draftSeq = 0;
const nextId = () => `t${(draftSeq += 1)}`;

export function toDraft(test: ToolTest): TestDraft {
  return {
    id: nextId(),
    name: test.name,
    payloadText: JSON.stringify(test.payload ?? {}, null, 2),
    status: test.expect.status === undefined ? "" : String(test.expect.status),
    hasKey: test.expect.hasKey ?? "",
  };
}

export function emptyDraft(): TestDraft {
  return { id: nextId(), name: "New test", payloadText: "{}", status: "", hasKey: "" };
}

/** A draft asserting neither status nor hasKey always passes — flag it (§3). */
export function draftIsVacuous(draft: TestDraft): boolean {
  return draft.status.trim() === "" && draft.hasKey.trim() === "";
}

export function payloadError(draft: TestDraft): string | null {
  if (draft.payloadText.trim() === "") return null;
  try {
    JSON.parse(draft.payloadText);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

export type DraftConversion = { ok: true; tests: ToolTest[] } | { ok: false; error: string };

/** Drafts → `ToolTest[]`, refusing to commit anything that would not round-trip. */
export function draftsToTests(drafts: TestDraft[]): DraftConversion {
  const tests: ToolTest[] = [];
  for (const [index, draft] of drafts.entries()) {
    const label = draft.name.trim() === "" ? `test #${index + 1}` : `"${draft.name.trim()}"`;
    if (draft.name.trim() === "") {
      return { ok: false, error: `Test #${index + 1} needs a name.` };
    }
    let payload: unknown = {};
    if (draft.payloadText.trim() !== "") {
      try {
        payload = JSON.parse(draft.payloadText);
      } catch (e) {
        return {
          ok: false,
          error: `Payload of ${label} is not valid JSON: ${(e as Error).message}`,
        };
      }
    }
    const statusText = draft.status.trim();
    let status: number | undefined;
    if (statusText !== "") {
      const parsed = Number(statusText);
      if (!Number.isInteger(parsed) || parsed < 100 || parsed > 599) {
        return { ok: false, error: `Expected status of ${label} must be an HTTP code (100-599).` };
      }
      status = parsed;
    }
    const hasKey = draft.hasKey.trim();
    tests.push({
      name: draft.name.trim(),
      payload,
      expect: {
        ...(status === undefined ? {} : { status }),
        ...(hasKey === "" ? {} : { hasKey }),
      },
    });
  }
  return { ok: true, tests };
}

/* ------------------------------------------------------------------ */
/* component                                                           */
/* ------------------------------------------------------------------ */

export function TsTestsPane() {
  const { bundle, saveEmbeddedTests } = useTool();

  const storeTests = useMemo(() => bundle.config.tests ?? [], [bundle.config.tests]);
  const storeSerialized = useMemo(() => JSON.stringify(storeTests), [storeTests]);

  const [drafts, setDrafts] = useState<TestDraft[]>(() => storeTests.map(toDraft));
  const [syncedFrom, setSyncedFrom] = useState(storeSerialized);
  const [rawMode, setRawMode] = useState(false);
  const [rawBuffer, setRawBuffer] = useState(() => JSON.stringify(storeTests, null, 2));
  const [rawError, setRawError] = useState<string | null>(null);
  const dirtyRef = useRef(false);

  // Resync when the embedded suite changes outside this pane (AI edit, file load).
  if (storeSerialized !== syncedFrom && !dirtyRef.current) {
    setSyncedFrom(storeSerialized);
    setDrafts(storeTests.map(toDraft));
    setRawBuffer(JSON.stringify(storeTests, null, 2));
  }

  const patch = useCallback((id: string, next: Partial<TestDraft>) => {
    dirtyRef.current = true;
    setDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, ...next } : d)));
  }, []);

  const move = useCallback((index: number, delta: number) => {
    dirtyRef.current = true;
    setDrafts((ds) => {
      const target = index + delta;
      if (target < 0 || target >= ds.length) return ds;
      const next = [...ds];
      const a = next[index];
      const b = next[target];
      if (!a || !b) return ds;
      next[index] = b;
      next[target] = a;
      return next;
    });
  }, []);

  const commit = useCallback(
    (tests: ToolTest[]) => {
      saveEmbeddedTests(tests);
      dirtyRef.current = false;
      const serialized = JSON.stringify(tests);
      setSyncedFrom(serialized);
      setRawBuffer(JSON.stringify(tests, null, 2));
      toast.success(
        `Saved ${tests.length} embedded test${tests.length === 1 ? "" : "s"} into ${bundle.name}.ts`,
        {
          description: "The AST engine rewrote the config block only — execution logic untouched.",
        },
      );
    },
    [saveEmbeddedTests, bundle.name],
  );

  const saveStructured = useCallback(() => {
    const converted = draftsToTests(drafts);
    if (!converted.ok) {
      toast.error(converted.error);
      return;
    }
    commit(converted.tests);
  }, [drafts, commit]);

  const saveRaw = useCallback(() => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBuffer);
    } catch (e) {
      setRawError((e as Error).message);
      return;
    }
    if (!Array.isArray(parsed)) {
      setRawError("The embedded suite must be a JSON array of ToolTest objects.");
      return;
    }
    for (const [index, entry] of parsed.entries()) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        setRawError(`Entry #${index + 1} is not an object.`);
        return;
      }
      const record = entry as Record<string, unknown>;
      if (typeof record["name"] !== "string") {
        setRawError(`Entry #${index + 1} needs a string "name".`);
        return;
      }
      const expect = record["expect"];
      if (typeof expect !== "object" || expect === null || Array.isArray(expect)) {
        setRawError(`Entry #${index + 1} needs an "expect" object.`);
        return;
      }
    }
    setRawError(null);
    const tests = parsed as ToolTest[];
    setDrafts(tests.map(toDraft));
    commit(tests);
  }, [rawBuffer, commit]);

  const vacuousCount = drafts.filter(draftIsVacuous).length;

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary" onClick={saveStructured}>
          <Save className="h-4 w-4" aria-hidden /> 💾 Save to Tool (.ts)
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            dirtyRef.current = true;
            setDrafts((ds) => [...ds, emptyDraft()]);
          }}
        >
          <Plus className="h-4 w-4" aria-hidden /> Add test
        </button>
        <button
          type="button"
          className="btn"
          aria-pressed={rawMode}
          onClick={() => {
            if (!rawMode) {
              const converted = draftsToTests(drafts);
              if (converted.ok) setRawBuffer(JSON.stringify(converted.tests, null, 2));
            }
            setRawMode((v) => !v);
          }}
        >
          <Code2 className="h-4 w-4" aria-hidden /> {rawMode ? "Structured view" : "Raw JSON view"}
        </button>
        <span className="chip">
          {drafts.length} embedded test{drafts.length === 1 ? "" : "s"}
        </span>
      </div>

      <p className="text-xs text-muted-foreground">
        These tests live in the <code className="font-mono">tests</code> array of the{" "}
        <code className="font-mono">baseConfig</code> block inside{" "}
        <code className="font-mono">{bundle.name}.ts</code>. Saving uses the AST engine to inject
        the updated JSON array back into that block without disturbing the execution logic.
      </p>

      {vacuousCount > 0 ? (
        <div className="finding" data-state="warn">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <span>
            {vacuousCount} test{vacuousCount === 1 ? "" : "s"} assert neither{" "}
            <code className="font-mono">status</code> nor <code className="font-mono">hasKey</code>{" "}
            — such a test always passes and is treated as an authoring mistake.
          </span>
        </div>
      ) : null}

      {rawMode ? (
        <div className="space-y-2">
          <label className="label" htmlFor="ts-tests-raw">
            Raw <code className="font-mono">config.tests</code> array
          </label>
          <textarea
            id="ts-tests-raw"
            className="field min-h-[22rem]"
            spellCheck={false}
            value={rawBuffer}
            onChange={(e) => {
              setRawBuffer(e.target.value);
              setRawError(null);
            }}
          />
          {rawError ? <p className="text-xs text-destructive">{rawError}</p> : null}
          <button type="button" className="btn btn-primary" onClick={saveRaw}>
            <Save className="h-4 w-4" aria-hidden /> 💾 Save to Tool (.ts)
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {drafts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              The embedded suite is empty. Add a test, or build a large bank in [ JSON Tests ].
            </p>
          ) : null}
          {drafts.map((draft, index) => {
            const parseError = payloadError(draft);
            const vacuous = draftIsVacuous(draft);
            return (
              <div key={draft.id} className="stat-card space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="chip">#{index + 1}</span>
                  <input
                    className="field max-w-[22rem]"
                    aria-label={`Test ${index + 1} name`}
                    value={draft.name}
                    onChange={(e) => patch(draft.id, { name: e.target.value })}
                  />
                  {vacuous ? (
                    <span className="chip text-warning">asserts nothing — authoring mistake</span>
                  ) : null}
                  <div className="ml-auto flex gap-1">
                    <button
                      type="button"
                      className="btn"
                      aria-label={`Move ${draft.name} up`}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="btn"
                      aria-label={`Move ${draft.name} down`}
                      disabled={index === drafts.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger"
                      aria-label={`Remove ${draft.name}`}
                      onClick={() => {
                        dirtyRef.current = true;
                        setDrafts((ds) => ds.filter((d) => d.id !== draft.id));
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </div>
                </div>

                <div>
                  <label className="label" htmlFor={`payload-${draft.id}`}>
                    Payload (JSON request body)
                  </label>
                  <textarea
                    id={`payload-${draft.id}`}
                    className="field min-h-[7rem]"
                    spellCheck={false}
                    value={draft.payloadText}
                    onChange={(e) => patch(draft.id, { payloadText: e.target.value })}
                  />
                  {parseError ? (
                    <p className="mt-1 text-xs text-destructive">Invalid JSON: {parseError}</p>
                  ) : null}
                </div>

                <div className="flex flex-wrap gap-3">
                  <div>
                    <label className="label" htmlFor={`status-${draft.id}`}>
                      expect.status
                    </label>
                    <input
                      id={`status-${draft.id}`}
                      className="field w-32"
                      inputMode="numeric"
                      placeholder="200"
                      value={draft.status}
                      onChange={(e) => patch(draft.id, { status: e.target.value })}
                    />
                  </div>
                  <div className="flex-1">
                    <label className="label" htmlFor={`haskey-${draft.id}`}>
                      expect.hasKey
                    </label>
                    <input
                      id={`haskey-${draft.id}`}
                      className="field"
                      placeholder="result"
                      value={draft.hasKey}
                      onChange={(e) => patch(draft.id, { hasKey: e.target.value })}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
