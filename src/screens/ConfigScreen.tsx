/**
 * [ Config ] — schema builder and dual-file JSON synchronizer
 * (docs/llm_generated/12-screen-config.md).
 *
 *   ⚙️ CONFIGURATION: [ Form Editor ] [ Tool JSON ] [ Config JSON ]
 *
 * §2 Form Editor  — the interactive builder, in FormEditor.tsx.
 * §3 Tool JSON    — live projection of the `baseConfig` embedded in `[name].ts`.
 * §4 Config JSON  — the standalone `[name].json`, which may legitimately diverge.
 *
 * All three write through the synchronization-matrix actions on the store (§5);
 * this screen never mutates the bundle itself.
 */

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Download, Save, Settings2 } from "lucide-react";
import { toast } from "sonner";

import { MonacoEditor } from "@/components/tgs/MonacoEditor";
import { useTool } from "@/state/toolStore";
import { FormEditor } from "@/screens/config/FormEditor";

const SUB_VIEWS = ["Form Editor", "Tool JSON", "Config JSON"] as const;
type SubView = (typeof SUB_VIEWS)[number];

const format = (value: unknown): string => `${JSON.stringify(value ?? {}, null, 2)}\n`;

export function ConfigScreen() {
  const [view, setView] = useState<SubView>("Form Editor");
  const { configDivergence, bundle } = useTool();

  return (
    <section className="panel">
      <div className="panel-head">
        <Settings2 className="h-4 w-4 text-primary" />
        <span>⚙️ Configuration</span>
        <div className="ml-2 flex gap-1" role="tablist" aria-label="Configuration sub-views">
          {SUB_VIEWS.map((v) => (
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
        {configDivergence.length > 0 ? (
          <span className="chip ml-auto text-warning" title={configDivergence.join(", ")}>
            <AlertTriangle className="h-3 w-3" /> {configDivergence.length} diverged
          </span>
        ) : (
          <span className="chip ml-auto">.ts and .json agree</span>
        )}
      </div>

      <div className="p-4">
        {view === "Form Editor" ? <FormEditor /> : null}
        {view === "Tool JSON" ? <ToolJsonPane /> : null}
        {view === "Config JSON" ? <ConfigJsonPane /> : null}
      </div>

      <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
        Editing <span className="font-mono">{bundle.name}.ts</span> and{" "}
        <span className="font-mono">{bundle.name}.json</span>. Nothing reaches disk until [ 💾 Save
        ] in the top action bar.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* §3 — Raw Tool JSON                                                  */
/* ------------------------------------------------------------------ */

function ToolJsonPane() {
  const { bundle, saveToolJsonBuffer } = useTool();
  const external = useMemo(() => format(bundle.config), [bundle.config]);

  const [buffer, setBuffer] = useState(external);
  const [error, setError] = useState<string | null>(null);

  // The store changed underneath us (a form save, a load, the AI) — re-seed.
  useEffect(() => {
    setBuffer(external);
    setError(null);
  }, [external]);

  const modified = buffer !== external;

  const save = () => {
    const result = saveToolJsonBuffer(buffer);
    if (!result.ok) {
      setError(result.error ?? "Invalid JSON.");
      toast.error("That JSON does not parse — the .ts file was left untouched.");
      return;
    }
    setError(null);
    toast.success(`baseConfig rewritten in ${bundle.name}.ts.`);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary" onClick={save}>
          <Save className="h-4 w-4" /> 💾 Save to Tool (.ts file)
        </button>
        {modified ? (
          <span className="chip text-warning">modified — not saved</span>
        ) : (
          <span className="chip">in sync with {bundle.name}.ts</span>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        A live projection of the <span className="font-mono">baseConfig</span> object inside{" "}
        <span className="font-mono">{bundle.name}.ts</span>. Saving rewrites only that declaration —
        the <span className="font-mono">execute</span> block is never touched.
      </p>

      {error ? (
        <p className="finding text-destructive" data-state="fail" role="alert">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}

      <div className="overflow-hidden rounded-md border border-border">
        <MonacoEditor
          value={buffer}
          onChange={setBuffer}
          language="json"
          height={460}
          path={`tool-config-${bundle.name}.json`}
          ariaLabel="Tool JSON"
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* §4 — Raw Config JSON                                                */
/* ------------------------------------------------------------------ */

function ConfigJsonPane() {
  const { bundle, saveConfigJsonBuffer } = useTool();
  const external = useMemo(() => format(bundle.configJson), [bundle.configJson]);
  const fromTool = useMemo(() => format(bundle.config), [bundle.config]);

  const [buffer, setBuffer] = useState(external);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBuffer(external);
    setError(null);
  }, [external]);

  const modified = buffer !== external;

  const save = () => {
    const result = saveConfigJsonBuffer(buffer);
    if (!result.ok) {
      setError(result.error ?? "Invalid JSON.");
      toast.error("That JSON does not parse — the .json file was left untouched.");
      return;
    }
    setError(null);
    toast.success(`${bundle.name}.json committed.`);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn"
          onClick={() => {
            setBuffer(fromTool);
            setError(null);
            toast.success("Buffer replaced with the config from the .ts file.");
          }}
        >
          <Download className="h-4 w-4" /> 📥 Load from Tool (.ts)
        </button>
        <button type="button" className="btn btn-accent" onClick={save}>
          <Save className="h-4 w-4" /> 💾 Save to Config (.json)
        </button>
        {modified ? (
          <span className="chip text-warning">modified — not saved</span>
        ) : (
          <span className="chip">in sync with {bundle.name}.json</span>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        This is the standalone <span className="font-mono">{bundle.name}.json</span>. It may
        legitimately diverge from the config embedded in the <span className="font-mono">.ts</span>{" "}
        — an external override is a valid deployment pattern — so saving here never touches the
        TypeScript file.
      </p>

      {error ? (
        <p className="finding text-destructive" data-state="fail" role="alert">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}

      <div className="overflow-hidden rounded-md border border-border">
        <MonacoEditor
          value={buffer}
          onChange={setBuffer}
          language="json"
          height={460}
          path={`standalone-config-${bundle.name}.json`}
          ariaLabel="Config JSON"
        />
      </div>
    </div>
  );
}
