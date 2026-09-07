/**
 * [ Secrets ] — docs/llm_generated/13-screen-secrets.md.
 *
 * A strictly mapped environment-variable manager for local testing. It renders
 * inputs ONLY from the tool's `config.secrets` dictionary (§3 Strict Mapping),
 * masks them by default, and fills blanks — never overwrites — from a `.env`.
 *
 * Values are serialized to `[tool_name].env` and injected into `context.env` by
 * the local Deno server during Runner executions. They are never published.
 */
import { useCallback, useRef, useState } from "react";
import { ClipboardPaste, Eye, EyeOff, KeyRound, ShieldCheck, Upload } from "lucide-react";
import { toast } from "sonner";

import type { ToolConfig } from "@/lib/tgs/contract";
import { useTool } from "@/state/toolStore";

/* ------------------------------------------------------------------ */
/* pure helper (unit-tested directly)                                   */
/* ------------------------------------------------------------------ */

export type SecretRow = {
  key: string;
  description: string;
  /** `isOptional` unset or false ⇒ Required (§3 Required vs. Optional). */
  required: boolean;
};

/**
 * One row per key declared in `config.secrets`, in declaration order.
 * Anything not declared there never reaches this screen.
 */
export function secretRows(config: Partial<ToolConfig>): SecretRow[] {
  const declared = config.secrets;
  if (!declared) return [];
  return Object.entries(declared).map(([key, entry]) => ({
    key,
    description: entry?.description ?? "",
    required: entry?.isOptional !== true,
  }));
}

/* ------------------------------------------------------------------ */
/* component                                                           */
/* ------------------------------------------------------------------ */

export function SecretsScreen() {
  const { bundle, setSecretValue, loadEnvText, requestFocus } = useTool();

  const rows = secretRows(bundle.config);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const applyEnv = useCallback(
    (text: string) => {
      if (text.trim() === "") {
        toast.error("That .env was empty — nothing to merge.");
        return;
      }
      const { filled, ignored } = loadEnvText(text);
      const parts: string[] = [];
      parts.push(
        filled.length
          ? `Filled ${filled.length} empty field${filled.length === 1 ? "" : "s"}: ${filled.join(", ")}.`
          : "No empty fields to fill — every declared secret already had a value.",
      );
      if (ignored.length) {
        parts.push(
          `Ignored ${ignored.length} key${ignored.length === 1 ? "" : "s"} not declared in config.secrets: ${ignored.join(", ")}.`,
        );
      }
      const description = parts.join(" ");
      if (filled.length) toast.success("Loaded .env", { description });
      else toast.message("Loaded .env", { description });
    },
    [loadEnvText],
  );

  return (
    <section className="panel">
      <div className="panel-head">
        <KeyRound className="h-4 w-4 text-primary" aria-hidden />
        <span>🔐 Secrets Configuration</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
            <Upload className="h-4 w-4" aria-hidden /> 📥 Load .env File
          </button>
          <span className="text-[0.7rem] normal-case text-muted-foreground">
            (Fills only missing values)
          </span>
          <button
            type="button"
            className="btn"
            aria-expanded={pasteOpen}
            onClick={() => setPasteOpen((v) => !v)}
          >
            <ClipboardPaste className="h-4 w-4" aria-hidden /> Paste .env
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".env,text/plain"
          className="hidden"
          data-testid="env-file-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            void file.text().then(applyEnv, () => toast.error("Could not read that file."));
          }}
        />
      </div>

      <div className="space-y-4 p-4">
        {pasteOpen ? (
          <div className="stat-card space-y-2">
            <label className="label" htmlFor="env-paste">
              Paste the contents of a .env file
            </label>
            <textarea
              id="env-paste"
              className="field min-h-[8rem]"
              spellCheck={false}
              placeholder={"WEATHER_API_KEY=sk-...\n# comments and undeclared keys are ignored"}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                applyEnv(pasteText);
                setPasteText("");
              }}
            >
              Merge into empty fields
            </button>
          </div>
        ) : null}

        <p className="text-xs text-muted-foreground">
          This form is generated strictly from <code className="font-mono">config.secrets</code>:
          undeclared variables are never shown, and loading a{" "}
          <code className="font-mono">.env</code> only fills fields that are currently empty — a
          value you typed is never overwritten.
        </p>

        {rows.length === 0 ? (
          <div className="finding" data-state="warn">
            <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
            <div className="space-y-2">
              <p>
                <strong>{bundle.name}</strong> declares no secrets, so there is nothing to
                configure. Secrets are declared in the tool&apos;s{" "}
                <code className="font-mono">config.secrets</code> dictionary — add one in the Config
                tab&apos;s secrets editor and it will appear here immediately.
              </p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => requestFocus("Config", { field: "secrets" })}
              >
                Open the Config tab&apos;s secrets editor
              </button>
            </div>
          </div>
        ) : null}

        {rows.map((row) => {
          const value = bundle.secrets[row.key] ?? "";
          const show = revealed[row.key] === true;
          const isSet = value !== "";
          return (
            <div key={row.key} className="stat-card space-y-2" data-testid={`secret-${row.key}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm text-primary">🔑 {row.key}</span>
                <span
                  className={`chip ${row.required ? "text-foreground" : "text-muted-foreground"}`}
                >
                  Status: {row.required ? "Required" : "Optional"}
                </span>
                <span
                  className={`chip ${
                    isSet
                      ? "text-success"
                      : row.required
                        ? "text-destructive"
                        : "text-muted-foreground"
                  }`}
                >
                  {isSet ? "set" : "empty"}
                </span>
              </div>
              {row.description ? (
                <p className="text-xs text-muted-foreground">{row.description}</p>
              ) : null}
              <div className="flex items-center gap-2">
                <input
                  className="field"
                  aria-label={`Value for ${row.key}`}
                  type={show ? "text" : "password"}
                  value={value}
                  placeholder={row.required ? "required for local runs" : "optional"}
                  onChange={(e) => setSecretValue(row.key, e.target.value)}
                />
                <button
                  type="button"
                  className="btn"
                  aria-pressed={show}
                  aria-label={show ? `Hide ${row.key}` : `Reveal ${row.key}`}
                  onClick={() => setRevealed((r) => ({ ...r, [row.key]: !r[row.key] }))}
                >
                  {show ? (
                    <EyeOff className="h-4 w-4" aria-hidden />
                  ) : (
                    <Eye className="h-4 w-4" aria-hidden />
                  )}
                  👁️
                </button>
              </div>
            </div>
          );
        })}

        <div className="finding">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>
              <strong className="text-foreground">Publish exclusion.</strong> [ 🚀 Publish ] bundles{" "}
              <code className="font-mono">{bundle.name}.ts</code>,{" "}
              <code className="font-mono">{bundle.name}.json</code> and{" "}
              <code className="font-mono">{bundle.name}_tests.json</code>. The{" "}
              <code className="font-mono">{bundle.name}.env</code> file is explicitly excluded —
              these values exist only for local testing and appear in the [ Raw Data ] tab&apos;s
              .env pane.
            </p>
            <p>
              <strong className="text-foreground">Runner interaction.</strong> The local Deno server
              builds a fresh <code className="font-mono">ToolExecutionContext</code> per request and
              injects these values into <code className="font-mono">context.env</code>. TGS does not
              block execution on an empty required secret: the tool&apos;s own validation is
              exercised exactly as it would be in production (commonly an HTTP 401).
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
