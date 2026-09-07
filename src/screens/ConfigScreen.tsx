import { useState } from "react";
import { Plus, Settings2, X } from "lucide-react";
import { CodePane } from "@/components/CodePane";
import { useTool, type ErrorSpec } from "@/state/toolStore";

const VIEWS = ["Form Editor", "Tool JSON", "Config JSON"] as const;

function ListField({
  label,
  items,
  onChange,
  placeholder,
}: {
  label: string;
  items: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div>
      <span className="label">{label}</span>
      <div className="flex flex-wrap items-center gap-2">
        {items.map((it) => (
          <span key={it} className="chip">
            {it}
            <button
              onClick={() => onChange(items.filter((x) => x !== it))}
              aria-label={`Remove ${it}`}
            >
              <X className="h-3 w-3 text-muted-foreground" />
            </button>
          </span>
        ))}
        <input
          className="field w-56"
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) {
              e.preventDefault();
              onChange([...items, draft.trim()]);
              setDraft("");
            }
          }}
        />
      </div>
    </div>
  );
}

export function ConfigScreen() {
  const { config, setConfig, files } = useTool();
  const [view, setView] = useState<(typeof VIEWS)[number]>("Form Editor");

  const updateError = (i: number, patch: Partial<ErrorSpec>) =>
    setConfig({ errors: config.errors.map((e, idx) => (idx === i ? { ...e, ...patch } : e)) });

  return (
    <section className="panel">
      <div className="panel-head">
        <Settings2 className="h-4 w-4 text-primary" />
        <span>Configuration</span>
        <div className="ml-2 flex gap-1">
          {VIEWS.map((v) => (
            <button key={v} className="tab" data-active={v === view} onClick={() => setView(v)}>
              {v}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-5 p-4">
        {view === "Tool JSON" ? <CodePane value={files[1]!.content} readOnly /> : null}
        {view === "Config JSON" ? (
          <CodePane value={files[0]!.content.split("\n\n")[0] ?? ""} readOnly />
        ) : null}

        {view === "Form Editor" ? (
          <>
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <span className="label">Description</span>
                <input
                  className="field"
                  value={config.description}
                  onChange={(e) => setConfig({ description: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <span className="label">Version</span>
                  <input
                    className="field"
                    value={config.version}
                    onChange={(e) => setConfig({ version: e.target.value })}
                  />
                </div>
                <div>
                  <span className="label">Rate limit (rpm)</span>
                  <input
                    className="field"
                    type="number"
                    value={config.rate_limit_rpm}
                    onChange={(e) => setConfig({ rate_limit_rpm: Number(e.target.value) })}
                  />
                </div>
              </div>
            </div>

            <ListField
              label="Tool dependencies"
              items={config.tool_dependencies}
              onChange={(v) => setConfig({ tool_dependencies: v })}
              placeholder="network_gateway + Enter"
            />
            <ListField
              label="Allowed network requests"
              items={config.network_requests}
              onChange={(v) => setConfig({ network_requests: v })}
              placeholder="https://api.example.com + Enter"
            />

            <div>
              <div className="mb-2 flex items-center gap-2">
                <span className="label mb-0">Actionable errors</span>
                <button
                  className="btn ml-auto"
                  onClick={() =>
                    setConfig({
                      errors: [
                        ...config.errors,
                        { code: "NEW_ERROR", message: "", actionable_advice: "" },
                      ],
                    })
                  }
                >
                  <Plus className="h-4 w-4" /> Add error
                </button>
              </div>
              <div className="space-y-3">
                {config.errors.map((err, i) => (
                  <div key={i} className="rounded-md border border-border bg-code p-3">
                    <div className="grid gap-3 md:grid-cols-2">
                      <input
                        className="field"
                        value={err.code}
                        onChange={(e) => updateError(i, { code: e.target.value })}
                        placeholder="ERROR_CODE"
                      />
                      <input
                        className="field"
                        value={err.message}
                        onChange={(e) => updateError(i, { message: e.target.value })}
                        placeholder="message shown to the caller"
                      />
                    </div>
                    <input
                      className="field mt-3"
                      value={err.actionable_advice}
                      onChange={(e) => updateError(i, { actionable_advice: e.target.value })}
                      placeholder="actionable advice so an agent can self-correct"
                    />
                    <button
                      className="btn mt-3"
                      onClick={() => setConfig({ errors: config.errors.filter((_, x) => x !== i) })}
                    >
                      <X className="h-4 w-4" /> Remove
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
