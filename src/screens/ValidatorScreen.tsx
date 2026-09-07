import { useState } from "react";
import { AlertTriangle, CheckCircle2, ShieldCheck } from "lucide-react";
import { CodePane } from "@/components/CodePane";

const VIEWS = ["Dashboard", "Python Rules", "LLM Rules"] as const;

type Check = { id: string; label: string; engine: "Wasm" | "LLM"; state: "pass" | "warn" };

const CHECKS: Check[] = [
  { id: "1", label: "rule_no_global_fetch.py", engine: "Wasm", state: "pass" },
  { id: "2", label: "rule_no_node_builtins.py", engine: "Wasm", state: "pass" },
  { id: "3", label: "rule_single_default_export.py", engine: "Wasm", state: "pass" },
  { id: "4", label: "rule_network_prefix_declared.py", engine: "Wasm", state: "pass" },
  { id: "5", label: "Responses are pure JSON data", engine: "LLM", state: "pass" },
  { id: "6", label: "Error description lacks actionable advice", engine: "LLM", state: "warn" },
];

const RULES_MD = `# LLM heuristic rubric

1. Every declared error MUST carry actionable_advice an agent can follow.
2. Responses MUST be pure data — no prose, no HTML, no streaming.
3. Secrets MUST be read from context.secrets, never inlined.
4. Output MUST be a JSON array of { rule, status, note }.`;

const PY_RULE = `import ast

def check(tree: ast.AST) -> list[dict]:
    findings = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and getattr(node.func, "id", "") == "fetch":
            findings.append({"rule": "no_global_fetch", "line": node.lineno})
    return findings`;

function Row({ c }: { c: Check }) {
  const pass = c.state === "pass";
  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-code px-3 py-2">
      {pass ? (
        <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
      ) : (
        <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
      )}
      <span className="text-sm">{c.label}</span>
      <span className="chip ml-auto">{c.engine}</span>
    </div>
  );
}

export function ValidatorScreen() {
  const [view, setView] = useState<(typeof VIEWS)[number]>("Dashboard");
  const warnings = CHECKS.filter((c) => c.state === "warn").length;
  const score = 100 - warnings * 15;

  return (
    <section className="panel">
      <div className="panel-head">
        <ShieldCheck className="h-4 w-4 text-primary" />
        <span>Validator</span>
        <div className="ml-2 flex gap-1">
          {VIEWS.map((v) => (
            <button key={v} className="tab" data-active={v === view} onClick={() => setView(v)}>
              {v}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-4 p-4">
        {view === "Dashboard" ? (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-md border border-border bg-code p-4">
                <span className="label">Health score</span>
                <p className="font-mono text-3xl text-primary">{score}/100</p>
              </div>
              <div className="rounded-md border border-border bg-code p-4">
                <span className="label">Status</span>
                <p className="mt-1 text-sm text-warning">
                  {warnings} warning{warnings === 1 ? "" : "s"}, 0 blockers
                </p>
              </div>
              <div className="rounded-md border border-border bg-code p-4">
                <span className="label">Engines</span>
                <p className="mt-1 text-sm">Structural checks + heuristic review</p>
              </div>
            </div>
            <div className="space-y-2">
              {CHECKS.map((c) => (
                <Row key={c.id} c={c} />
              ))}
            </div>
          </>
        ) : null}

        {view === "Python Rules" ? (
          <>
            <div className="space-y-2">
              {CHECKS.filter((c) => c.engine === "Wasm").map((c) => (
                <Row key={c.id} c={c} />
              ))}
            </div>
            <CodePane value={PY_RULE} readOnly />
          </>
        ) : null}

        {view === "LLM Rules" ? (
          <>
            <div className="space-y-2">
              {CHECKS.filter((c) => c.engine === "LLM").map((c) => (
                <Row key={c.id} c={c} />
              ))}
            </div>
            <CodePane value={RULES_MD} readOnly />
          </>
        ) : null}
      </div>
    </section>
  );
}
