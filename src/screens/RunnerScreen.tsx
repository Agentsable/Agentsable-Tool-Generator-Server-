import { useState } from "react";
import { Play, RotateCw, Rocket } from "lucide-react";
import { toast } from "sonner";
import { useTool } from "@/state/toolStore";

const VIEWS = ["Dashboard", "Tool TS Tests", "JSON Tests"] as const;

export function RunnerScreen() {
  const { tests, results, runTests, toolName } = useTool();
  const [view, setView] = useState<(typeof VIEWS)[number]>("Dashboard");

  const visible = tests.filter((t) =>
    view === "Dashboard" ? true : view === "Tool TS Tests" ? t.source === "ts" : t.source === "json",
  );
  const failed = tests.filter((t) => results[t.id] && results[t.id]!.status !== t.expectStatus);

  return (
    <section className="panel">
      <div className="panel-head">
        <Rocket className="h-4 w-4 text-primary" />
        <span>Runner</span>
        <div className="ml-2 flex gap-1">
          {VIEWS.map((v) => (
            <button key={v} className="tab" data-active={v === view} onClick={() => setView(v)}>
              {v}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="btn btn-primary"
            onClick={() => {
              runTests();
              toast.success("Tests fired at the local sandbox");
            }}
          >
            <Play className="h-4 w-4" /> Run all tests
          </button>
          <button className="btn" onClick={() => toast("Restarting the local sandbox...")}>
            <RotateCw className="h-4 w-4" /> Restart local sandbox
          </button>
          <span className="chip">http://localhost:8080/{toolName}</span>
          {Object.keys(results).length ? (
            <span className="chip" style={{ color: failed.length ? "var(--color-destructive)" : "var(--color-success)" }}>
              {tests.length - failed.length}/{tests.length} passing
            </span>
          ) : null}
        </div>

        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-code text-left text-xs uppercase tracking-widest text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">Test name</th>
                <th className="px-3 py-2">Payload</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((t) => {
                const r = results[t.id];
                const ok = r ? r.status === t.expectStatus : null;
                return (
                  <tr key={t.id} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                      {t.source === "ts" ? `${toolName}.ts` : `${toolName}_tests.json`}
                    </td>
                    <td className="px-3 py-2">{t.name}</td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                      {t.payload}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {r === undefined ? (
                        <span className="text-muted-foreground">not run</span>
                      ) : ok ? (
                        <span className="text-success">
                          {r.status} · {r.ms}ms
                        </span>
                      ) : (
                        <span className="text-destructive">
                          {r.status} · expected {t.expectStatus}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-muted-foreground">
          Tests are sent as plain HTTP requests to a local sandbox, never run inside this page — the
          same path production callers take.
        </p>
      </div>
    </section>
  );
}
