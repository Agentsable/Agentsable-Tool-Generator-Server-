/**
 * [ Runner ] — docs/llm_generated/15-screen-runner.md.
 *
 * §1 Sub-Navigation: the Runner is one screen with three sub-views —
 *   [ Dashboard ]      the unified execution matrix (§2)
 *   [ Tool TS Tests ]  the embedded `config.tests` suite from `[name].ts` (§4.1)
 *   [ JSON Tests ]     the external `[name]_tests.json` suite (§4.2)
 */
import { useState } from "react";
import { Rocket } from "lucide-react";

import { RunnerDashboard } from "@/screens/runner/RunnerDashboard";
import { TsTestsPane } from "@/screens/runner/TsTestsPane";
import { JsonTestsPane } from "@/screens/runner/JsonTestsPane";

export const RUNNER_VIEWS = ["Dashboard", "Tool TS Tests", "JSON Tests"] as const;
export type RunnerView = (typeof RUNNER_VIEWS)[number];

export function RunnerScreen() {
  const [view, setView] = useState<RunnerView>("Dashboard");

  return (
    <section className="panel">
      <div className="panel-head">
        <Rocket className="h-4 w-4 text-primary" aria-hidden />
        <span>🚀 Runner</span>
        <div
          role="tablist"
          aria-label="Runner sub-navigation"
          className="ml-2 flex flex-wrap gap-1"
        >
          {RUNNER_VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={v === view}
              className="subtab"
              data-active={v === view}
              onClick={() => setView(v)}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {view === "Dashboard" ? <RunnerDashboard /> : null}
      {view === "Tool TS Tests" ? <TsTestsPane /> : null}
      {view === "JSON Tests" ? <JsonTestsPane /> : null}
    </section>
  );
}
