/**
 * [ Validator ] — the quality gate before publishing to the Simple Tools Server.
 *
 * Spec: docs/llm_generated/14-screen-validator.md §1 — three sub-views behind a
 * secondary nav bar. The screen itself owns nothing but that navigation; all
 * behaviour lives in the three panes.
 */
import { useState } from "react";
import { ShieldCheck } from "lucide-react";

import { LlmRulesPane } from "@/screens/validator/LlmRulesPane";
import { PythonRulesPane } from "@/screens/validator/PythonRulesPane";
import { ValidatorDashboard } from "@/screens/validator/ValidatorDashboard";

export const VALIDATOR_VIEWS = ["Dashboard", "Python Rules", "LLM Rules"] as const;
export type ValidatorView = (typeof VALIDATOR_VIEWS)[number];

export function ValidatorScreen() {
  const [view, setView] = useState<ValidatorView>("Dashboard");

  return (
    <section className="panel">
      <div className="panel-head">
        <ShieldCheck className="h-4 w-4 text-primary" aria-hidden />
        <span>🛡️ Validator</span>
        <div className="ml-2 flex gap-1" role="tablist" aria-label="Validator sub-navigation">
          {VALIDATOR_VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              className="subtab"
              data-active={v === view}
              aria-selected={v === view}
              onClick={() => setView(v)}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      <div className="p-4">
        {view === "Dashboard" ? <ValidatorDashboard /> : null}
        {view === "Python Rules" ? <PythonRulesPane /> : null}
        {view === "LLM Rules" ? <LlmRulesPane /> : null}
      </div>
    </section>
  );
}
