/**
 * [ Runner ] › [ Dashboard ] — docs/llm_generated/15-screen-runner.md §2.
 *
 * The unified execution matrix. Every test in the bundle (embedded `.ts` suite
 * first, then the external `_tests.json` suite) gets one row, carrying its
 * Source Attribution so a failure is traceable to the file that must change.
 *
 * Zero-Trust Parity (§2, 01-system-overview.md §5): nothing here executes tool
 * TypeScript. `runAllTests()` mounts the tool on the local Deno server over HTTP
 * and fires one plain HTTP request per test.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ClipboardCopy, Play, RotateCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import type { ToolTest } from "@/lib/tgs/contract";
import type { RunnerStatus, RunnerTestResult } from "@/lib/tgs/runnerClient";
import { allTests, type ToolBundle } from "@/lib/tgs/toolFiles";
import { useTool } from "@/state/toolStore";

/* ------------------------------------------------------------------ */
/* pure helpers (unit-tested directly)                                 */
/* ------------------------------------------------------------------ */

/** The exact commands that start the local Deno sandbox. TGS cannot spawn it. */
export const DENO_SERVER_COMMANDS = [
  "bun run deno:server",
  "deno run --allow-net --allow-read --allow-env --allow-write local-deno-server/server.ts",
] as const;

export type MatrixRow = {
  key: string;
  source: "ts" | "json";
  /** `📄 calc.ts` or `📦 calc_tests.json` — the spec's Source Attribution. */
  sourceLabel: string;
  /** Position within its own source list — what `runSingleTest` indexes by. */
  indexWithinSource: number;
  name: string;
  test: ToolTest;
  result: RunnerTestResult | null;
};

/** `📄 calc.ts` for the embedded suite, `📦 calc_tests.json` for the external one. */
export function sourceLabel(source: "ts" | "json", toolName: string): string {
  return source === "ts" ? `📄 ${toolName}.ts` : `📦 ${toolName}_tests.json`;
}

/** A test that asserts neither `status` nor `hasKey` always passes — §3. */
export function isVacuousTest(test: ToolTest): boolean {
  return test.expect.status === undefined && test.expect.hasKey === undefined;
}

/** Human-readable expectation, mirroring runnerClient's `expected` string. */
export function describeExpect(expect: ToolTest["expect"]): string {
  const parts: string[] = [];
  if (expect.status !== undefined) parts.push(`status ${expect.status}`);
  if (expect.hasKey !== undefined) parts.push(`hasKey "${expect.hasKey}"`);
  return parts.length ? parts.join(", ") : "nothing asserted";
}

export type StatusCell = {
  /** `✅ 200`, `❌ 500`, `❌ —` or `· not run`. */
  badge: string;
  /** `Exp 400` when the run disagreed with the expectation. */
  expectedNote: string | null;
  tone: "success" | "destructive" | "muted";
};

/** The `[✅ 200]` / `[❌ 500] Exp 400` cell from the spec's ASCII layout. */
export function statusCell(row: MatrixRow): StatusCell {
  const { result, test } = row;
  if (!result) return { badge: "· not run", expectedNote: null, tone: "muted" };
  const code = result.actualStatus === null ? "—" : String(result.actualStatus);
  if (result.ok) return { badge: `✅ ${code}`, expectedNote: null, tone: "success" };
  return {
    badge: `❌ ${code}`,
    expectedNote:
      test.expect.status === undefined
        ? `Exp ${describeExpect(test.expect)}`
        : `Exp ${test.expect.status}`,
    tone: "destructive",
  };
}

/** Join the bundle's declared tests with the latest run results, in spec order. */
export function buildMatrixRows(bundle: ToolBundle, results: RunnerTestResult[]): MatrixRow[] {
  const perSource: Record<"ts" | "json", number> = { ts: 0, json: 0 };
  return allTests(bundle).map(({ source, test }) => {
    const indexWithinSource = perSource[source];
    perSource[source] += 1;
    const match = results.find((r) => r.source === source && r.name === test.name) ?? null;
    return {
      key: `${source}:${indexWithinSource}:${test.name}`,
      source,
      sourceLabel: sourceLabel(source, bundle.name),
      indexWithinSource,
      name: test.name,
      test,
      result: match,
    };
  });
}

export type MatrixSummary = {
  total: number;
  ran: number;
  passing: number;
  ts: { total: number; passing: number };
  json: { total: number; passing: number };
  vacuous: number;
};

export function summarize(rows: MatrixRow[]): MatrixSummary {
  const summary: MatrixSummary = {
    total: rows.length,
    ran: 0,
    passing: 0,
    ts: { total: 0, passing: 0 },
    json: { total: 0, passing: 0 },
    vacuous: 0,
  };
  for (const row of rows) {
    const bucket = row.source === "ts" ? summary.ts : summary.json;
    bucket.total += 1;
    if (row.result) summary.ran += 1;
    if (row.result?.ok) {
      summary.passing += 1;
      bucket.passing += 1;
    }
    if (isVacuousTest(row.test) || row.result?.vacuous) summary.vacuous += 1;
  }
  return summary;
}

function statusChipTone(status: RunnerStatus): string {
  if (status.state === "up") return "text-success";
  if (status.state === "down") return "text-destructive";
  return "text-muted-foreground";
}

function truncate(text: string, max = 160): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/* ------------------------------------------------------------------ */
/* component                                                           */
/* ------------------------------------------------------------------ */

export function RunnerDashboard() {
  const {
    bundle,
    runnerUrl,
    setRunnerUrl,
    runnerStatus,
    runnerResults,
    runnerBusy,
    checkRunner,
    runAllTests,
    runSingleTest,
  } = useTool();

  const rows = buildMatrixRows(bundle, runnerResults);
  const summary = summarize(rows);

  // Probe once on mount (§2: the dashboard reports live sandbox reachability).
  const probed = useRef(false);
  useEffect(() => {
    if (probed.current) return;
    probed.current = true;
    void checkRunner();
  }, [checkRunner]);

  const [reconnecting, setReconnecting] = useState(false);

  const reconnect = useCallback(async () => {
    setReconnecting(true);
    try {
      await checkRunner();
    } finally {
      setReconnecting(false);
    }
  }, [checkRunner]);

  const copyCommand = useCallback(async (command: string) => {
    try {
      const clipboard = navigator.clipboard as Clipboard | undefined;
      if (!clipboard?.writeText) throw new Error("clipboard unavailable");
      await clipboard.writeText(command);
      toast.success("Command copied to the clipboard");
    } catch {
      toast.message("Copy it manually", { description: command });
    }
  }, []);

  return (
    <div className="space-y-4 p-4">
      {/* --------------------------- toolbar --------------------------- */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-primary"
          disabled={runnerBusy}
          onClick={() => void runAllTests()}
        >
          <Play className="h-4 w-4" aria-hidden /> ▶ Run All Tests
        </button>
        <button
          type="button"
          className="btn"
          disabled={runnerBusy || reconnecting}
          onClick={() => void reconnect()}
        >
          <RotateCw className="h-4 w-4" aria-hidden /> ↻ Reconnect / Restart Local Deno Server
        </button>
        {summary.ran > 0 ? (
          <span
            className={`chip ${summary.passing === summary.total ? "text-success" : "text-destructive"}`}
          >
            {summary.passing}/{summary.total} passing
          </span>
        ) : (
          <span className="chip text-muted-foreground">{summary.total} tests · not run</span>
        )}
        <span className="chip">
          📄 {bundle.name}.ts {summary.ts.passing}/{summary.ts.total}
        </span>
        <span className="chip">
          📦 {bundle.name}_tests.json {summary.json.passing}/{summary.json.total}
        </span>
      </div>

      {/* ------------------------ url + status ------------------------ */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[18rem] flex-1">
          <label className="label" htmlFor="runner-url">
            Local Deno server URL
          </label>
          <input
            id="runner-url"
            className="field"
            value={runnerUrl}
            spellCheck={false}
            onChange={(e) => setRunnerUrl(e.target.value)}
            onBlur={() => void checkRunner()}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 pb-1">
          <span className={`chip ${statusChipTone(runnerStatus)}`} data-testid="runner-status">
            {runnerStatus.state === "up"
              ? `● up · v${runnerStatus.version}`
              : runnerStatus.state === "down"
                ? "● down"
                : "● unknown"}
          </span>
          {runnerStatus.state === "up" ? (
            <span className="chip text-muted-foreground">
              mounted:{" "}
              {runnerStatus.mounted.length ? runnerStatus.mounted.join(", ") : "nothing yet"}
            </span>
          ) : null}
        </div>
      </div>

      {runnerStatus.state === "down" ? (
        <p className="text-xs text-destructive">{runnerStatus.message}</p>
      ) : null}

      {/* ------------------- honest restart explainer ------------------- */}
      {runnerStatus.state !== "up" ? (
        <div className="finding" data-state="warn">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <div className="space-y-2">
            <p>
              <strong>↻ Reconnect / Restart Local Deno Server</strong> re-probes{" "}
              <code className="font-mono">{runnerUrl}/health</code>. TGS runs in your browser and
              did not spawn the sandbox, so it cannot restart a process it does not own — start or
              restart it yourself in a terminal at the repository root:
            </p>
            {DENO_SERVER_COMMANDS.map((command) => (
              <div key={command} className="flex flex-wrap items-center gap-2">
                <code className="code-surface break-all rounded-md border border-border px-2 py-1">
                  {command}
                </code>
                <button
                  type="button"
                  className="btn"
                  aria-label={`Copy command: ${command}`}
                  onClick={() => void copyCommand(command)}
                >
                  <ClipboardCopy className="h-3.5 w-3.5" aria-hidden /> Copy
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* ------------------------ execution matrix ---------------------- */}
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <caption className="sr-only">Execution Results Dashboard</caption>
          <thead className="bg-code text-left text-xs uppercase tracking-widest text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2">
                Source
              </th>
              <th scope="col" className="px-3 py-2">
                Test Name
              </th>
              <th scope="col" className="px-3 py-2">
                Status
              </th>
              <th scope="col" className="px-3 py-2">
                Details
              </th>
              <th scope="col" className="px-3 py-2">
                Run
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="px-3 py-4 text-muted-foreground" colSpan={5}>
                  No tests yet. Add them in [ Tool TS Tests ] or [ JSON Tests ].
                </td>
              </tr>
            ) : null}
            {rows.map((row) => {
              const cell = statusCell(row);
              const vacuous = isVacuousTest(row.test) || row.result?.vacuous === true;
              return (
                <tr key={row.key} className="border-t border-border align-top">
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {row.sourceLabel}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span>{row.name}</span>
                      {vacuous ? (
                        <span className="chip text-warning">
                          asserts nothing — authoring mistake
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 font-mono text-[0.7rem] text-muted-foreground">
                      expects {describeExpect(row.test.expect)}
                    </div>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    <span
                      className={
                        cell.tone === "success"
                          ? "text-success"
                          : cell.tone === "destructive"
                            ? "text-destructive"
                            : "text-muted-foreground"
                      }
                    >
                      {cell.badge}
                    </span>
                    {cell.expectedNote ? (
                      <span className="ml-2 text-muted-foreground">{cell.expectedNote}</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    {row.result ? (
                      <div className="space-y-1">
                        <div className="text-xs text-muted-foreground">{row.result.detail}</div>
                        {row.result.actualBody ? (
                          <pre className="code-surface max-w-[32rem] overflow-x-auto rounded-md border border-border px-2 py-1 text-[0.7rem]">
                            {truncate(row.result.actualBody)}
                          </pre>
                        ) : null}
                        <div className="font-mono text-[0.7rem] text-muted-foreground">
                          {row.result.durationMs}ms
                        </div>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      className="btn"
                      disabled={runnerBusy}
                      aria-label={`Re-run ${row.name}`}
                      onClick={() => void runSingleTest(row.source, row.indexWithinSource)}
                    >
                      ▶
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ------------------------- guarantees --------------------------- */}
      <div className="finding">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>
            <strong className="text-foreground">Zero-Trust Parity.</strong> The browser never
            executes this tool&apos;s TypeScript. TGS mounts the tool on the local Deno server (PUT{" "}
            <code className="font-mono">/tools/{bundle.name}</code>) and then fires plain HTTP POSTs
            at{" "}
            <code className="font-mono">
              {runnerUrl}/{bundle.name}
            </code>{" "}
            — the same path a production caller takes against the Simple Tools Server.
          </p>
          <p>
            <strong className="text-foreground">Context Injection.</strong> The local server builds
            a fresh <code className="font-mono">ToolExecutionContext</code> per request and injects
            the values from the [ Secrets ] tab into <code className="font-mono">context.env</code>.
            An empty required secret is not blocked here: the tool&apos;s own validation runs
            exactly as it would in production.
          </p>
        </div>
      </div>
    </div>
  );
}
