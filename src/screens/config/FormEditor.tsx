/**
 * [ Config ] → Sub-view 1: the Form Editor
 * (docs/llm_generated/12-screen-config.md §2).
 *
 * Every control edits `configDraft` through `setConfigDraft`; nothing is written
 * to a file until one of the four action buttons runs a synchronization-matrix
 * action (§5). `configOrigin` says which of the two stores the form is currently
 * reflecting, and `configDivergence` lists the dotted paths where the embedded
 * `.ts` config and the standalone `.json` disagree.
 */

import { useState } from "react";
import {
  AlertTriangle,
  Braces,
  Download,
  FileJson2,
  KeyRound,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import type { ToolConfig } from "@/lib/tgs/contract";
import { useTool } from "@/state/toolStore";
import { TagListField, useDraftValue } from "@/screens/config/TagListField";
import { SignatureBuilder } from "@/screens/config/SignatureBuilder";

const MODALITIES = ["text", "image", "application/pdf", "binary"] as const;
type Modality = (typeof MODALITIES)[number];

/** The window the LLM rubric treats as sane for `rateLimit.requestsPerMinute`. */
export const RPM_MIN = 60;
export const RPM_MAX = 600;

export function isAbsoluteUrlPrefix(value: string): string | null {
  return /^https?:\/\/.+/i.test(value)
    ? null
    : "must be an absolute URL prefix starting with http:// or https://";
}

export function FormEditor() {
  const {
    bundle,
    configDraft,
    setConfigDraft,
    configOrigin,
    configDivergence,
    loadFormFromTool,
    loadFormFromConfig,
    saveFormToTool,
    saveFormToConfig,
  } = useTool();

  const draft = configDraft;
  const patch = (next: Partial<ToolConfig>) => setConfigDraft(next);

  const rpm = draft.rateLimit?.requestsPerMinute;
  const rpmOutOfRange = typeof rpm === "number" && (rpm < RPM_MIN || rpm > RPM_MAX);
  const modalities = draft.outputModality ?? [];

  /** Copy one diverged path from a file into the form (§2 conflict resolution). */
  const takePath = (path: string, from: "tool" | "config") => {
    const source = from === "tool" ? bundle.config : bundle.configJson;
    const label = from === "tool" ? ".ts" : ".json";
    if (path === "<root>") {
      if (from === "tool") loadFormFromTool();
      else loadFormFromConfig();
      toast.success(`Form reloaded from the ${label} config.`);
      return;
    }
    const segments = path.split(".");
    const root = segments[0] as string;
    const rest = segments.slice(1);
    const incoming = getAtPath(source, segments);
    const nextRoot =
      rest.length === 0
        ? incoming
        : setAtPath((draft as Record<string, unknown>)[root], rest, incoming);
    setConfigDraft({ [root]: nextRoot } as Partial<ToolConfig>);
    toast.success(`Took ${path} from the ${label} config — save to Tool or Config to commit it.`);
  };

  return (
    <div className="space-y-5">
      {/* ---------------- the 4 action buttons (§2) ---------------- */}
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn"
            onClick={() => {
              loadFormFromTool();
              toast.success("Form loaded from the config embedded in the .ts file.");
            }}
          >
            <Download className="h-4 w-4" /> 📥 Load from Tool
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              loadFormFromConfig();
              toast.success(`Form loaded from ${bundle.name}.json.`);
            }}
          >
            <Download className="h-4 w-4" /> 📥 Load from Config
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              saveFormToTool();
              toast.success(`Form written into the baseConfig of ${bundle.name}.ts.`);
            }}
          >
            <Save className="h-4 w-4" /> 💾 Save to Tool
          </button>
          <button
            type="button"
            className="btn btn-accent"
            onClick={() => {
              saveFormToConfig();
              toast.success(`Form written to ${bundle.name}.json.`);
            }}
          >
            <Save className="h-4 w-4" /> 💾 Save to Config
          </button>
        </div>

        <p className="text-xs text-muted-foreground">
          Reflecting:{" "}
          <span className="chip" data-origin={configOrigin}>
            {configOrigin === "tool" ? `${bundle.name}.ts` : `${bundle.name}.json`}
          </span>{" "}
          {configOrigin === "tool"
            ? "— the config embedded in the TypeScript file."
            : "— the standalone JSON config file."}
        </p>
      </div>

      {/* ---------------- conflict resolution (§2) ---------------- */}
      {configDivergence.length > 0 ? (
        <section className="stat-card border-warning/40" aria-label="Config divergence">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-warning" />
            <span className="text-sm font-semibold text-foreground">
              {configDivergence.length === 1
                ? "1 value differs"
                : `${configDivergence.length} values differ`}{" "}
              between {bundle.name}.ts and {bundle.name}.json
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            The two files may legitimately diverge. Take a side per path, then save the form to the
            file you want to change.
          </p>
          <ul className="mt-3 space-y-2">
            {configDivergence.map((path) => (
              <li key={path} className="rounded-md border border-border bg-code p-2">
                <div className="font-mono text-xs text-foreground">{path}</div>
                <div className="mt-2 grid gap-2 md:grid-cols-2">
                  <div>
                    <span className="label mb-1">.ts</span>
                    <code className="block break-all text-xs text-muted-foreground">
                      {preview(getAtPath(bundle.config, path.split(".")))}
                    </code>
                    <button
                      type="button"
                      className="btn mt-1"
                      onClick={() => takePath(path, "tool")}
                    >
                      take .ts
                    </button>
                  </div>
                  <div>
                    <span className="label mb-1">.json</span>
                    <code className="block break-all text-xs text-muted-foreground">
                      {preview(getAtPath(bundle.configJson, path.split(".")))}
                    </code>
                    <button
                      type="button"
                      className="btn mt-1"
                      onClick={() => takePath(path, "config")}
                    >
                      take .json
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ---------------- 1. general metadata ---------------- */}
      <section className="space-y-3">
        <h3 className="flex items-center gap-2 text-xs font-bold uppercase text-muted-foreground">
          <Braces className="h-4 w-4 text-primary" /> General metadata
        </h3>

        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <span className="label">Name</span>
            <input
              className="field"
              aria-label="Name"
              value={draft.name ?? ""}
              readOnly
              title="Rename the tool in the top action bar"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Renaming happens in the top action bar — it renames all four files.
            </p>
          </div>
          <div>
            <span className="label">Version</span>
            <input
              className="field"
              aria-label="Version"
              placeholder="1.1.0"
              value={draft.version ?? ""}
              onChange={(e) => patch({ version: e.target.value })}
            />
          </div>
        </div>

        <div>
          <span className="label">Description</span>
          <textarea
            className="field min-h-20"
            aria-label="Description"
            placeholder="What this tool does, in one or two sentences."
            value={draft.description ?? ""}
            onChange={(e) => patch({ description: e.target.value })}
          />
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          <div>
            <span className="label">Icon</span>
            <input
              className="field"
              aria-label="Icon"
              maxLength={4}
              placeholder="🌤️"
              value={draft.icon ?? ""}
              onChange={(e) => patch({ icon: e.target.value })}
            />
          </div>
          <div>
            <span className="label">Cost</span>
            <input
              className="field"
              type="number"
              aria-label="Cost"
              min={0}
              value={draft.cost ?? 0}
              onChange={(e) => patch({ cost: toNumber(e.target.value, 0) })}
            />
          </div>
          <div>
            <span className="label">Timeout (ms)</span>
            <input
              className="field"
              type="number"
              aria-label="Timeout (ms)"
              min={0}
              value={draft.timeoutMs ?? 0}
              onChange={(e) => patch({ timeoutMs: toNumber(e.target.value, 0) })}
            />
          </div>
          <label className="flex items-end gap-2 pb-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              aria-label="Is idempotent"
              checked={draft.isIdempotent === true}
              onChange={(e) => patch({ isIdempotent: e.target.checked })}
            />
            Is idempotent (safe to retry)
          </label>
        </div>

        <TagListField
          label="Tags"
          values={draft.tags ?? []}
          onChange={(tags) => patch({ tags })}
          placeholder="weather + Enter"
        />

        <div>
          <span className="label">MCP description (optional)</span>
          <textarea
            className="field min-h-16"
            aria-label="MCP description"
            placeholder="Override the description shown to MCP clients."
            value={draft.mcpDescription ?? ""}
            onChange={(e) => patch({ mcpDescription: e.target.value })}
          />
        </div>
      </section>

      {/* ---------------- 2. security & zero-trust ---------------- */}
      <section className="space-y-3">
        <h3 className="flex items-center gap-2 text-xs font-bold uppercase text-muted-foreground">
          <ShieldCheck className="h-4 w-4 text-primary" /> Security &amp; zero-trust allowlisting
        </h3>

        <TagListField
          label="Tool dependencies"
          values={draft.tool_dependencies ?? []}
          onChange={(tool_dependencies) => patch({ tool_dependencies })}
          placeholder="network_gateway + Enter"
          hint="Sibling tools this tool may reach through internalFetch / useCoreTool."
        />

        <TagListField
          label="Network requests"
          values={draft.network_requests ?? []}
          onChange={(network_requests) => patch({ network_requests })}
          placeholder="https://api.openweathermap.org/data/2.5/weather + Enter"
          hint="Egress allowlist: absolute URL prefixes the gateway will let through."
          validate={isAbsoluteUrlPrefix}
        />

        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <span className="label">Rate limit (RPM)</span>
            <input
              className="field"
              type="number"
              aria-label="Rate limit (requests per minute)"
              min={0}
              value={rpm ?? 0}
              onChange={(e) =>
                patch({ rateLimit: { requestsPerMinute: toNumber(e.target.value, 0) } })
              }
            />
            {rpmOutOfRange ? (
              <p className="mt-1 text-xs text-warning" role="status">
                {rpm} RPM is outside the recommended {RPM_MIN}–{RPM_MAX} range the LLM rubric flags.
              </p>
            ) : null}
          </div>

          <div>
            <span className="label">Output modality</span>
            <div className="flex flex-wrap gap-3">
              {MODALITIES.map((modality) => (
                <label
                  key={modality}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground"
                >
                  <input
                    type="checkbox"
                    aria-label={`Output modality ${modality}`}
                    checked={modalities.includes(modality)}
                    onChange={(e) =>
                      patch({
                        outputModality: e.target.checked
                          ? [...modalities, modality]
                          : modalities.filter((m: Modality) => m !== modality),
                      })
                    }
                  />
                  {modality}
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <TagListField
            label="Permissions: read"
            values={draft.permissions?.read ?? []}
            onChange={(read) => patch({ permissions: { ...draft.permissions, read } })}
            placeholder="file_space/reports/* + Enter"
          />
          <TagListField
            label="Permissions: write"
            values={draft.permissions?.write ?? []}
            onChange={(write) => patch({ permissions: { ...draft.permissions, write } })}
            placeholder="file_space/outbox/* + Enter"
          />
        </div>
      </section>

      {/* ---------------- 3. secrets ---------------- */}
      <section className="space-y-3">
        <h3 className="flex items-center gap-2 text-xs font-bold uppercase text-muted-foreground">
          <KeyRound className="h-4 w-4 text-primary" /> Secrets
        </h3>
        <p className="text-xs text-muted-foreground">
          Declared here, filled in on the [ Secrets ] screen. The server validates every
          non-optional secret before it will execute the tool.
        </p>
        <SecretsEditor secrets={draft.secrets} onChange={(secrets) => patch({ secrets })} />
      </section>

      {/* ---------------- 4. signature builder ---------------- */}
      <section className="space-y-3">
        <h3 className="flex items-center gap-2 text-xs font-bold uppercase text-muted-foreground">
          <FileJson2 className="h-4 w-4 text-primary" /> Signature builder
        </h3>
        <SignatureBuilder
          signature={draft.signature}
          onChange={(signature) => patch({ signature })}
        />
      </section>

      {/* ---------------- 5. MCP hooks ---------------- */}
      <section className="grid gap-3 md:grid-cols-2">
        <JsonArrayField
          label="MCP resources"
          value={draft.mcpResources}
          placeholder='[{ "uri": "sts://reports", "name": "Reports" }]'
          onChange={(next) =>
            patch({ mcpResources: next as NonNullable<ToolConfig["mcpResources"]> })
          }
        />
        <JsonArrayField
          label="MCP prompts"
          value={draft.mcpPrompts}
          placeholder='[{ "name": "summarize", "description": "…" }]'
          onChange={(next) => patch({ mcpPrompts: next as NonNullable<ToolConfig["mcpPrompts"]> })}
        />
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* secrets editor                                                      */
/* ------------------------------------------------------------------ */

type SecretMap = NonNullable<ToolConfig["secrets"]>;
type SecretRow = { key: string; description: string; isOptional: boolean };

function SecretsEditor({
  secrets,
  onChange,
}: {
  secrets: SecretMap | undefined;
  onChange: (next: SecretMap) => void;
}) {
  const {
    value: rows,
    setValue: setRows,
    markEmitted,
  } = useDraftValue<SecretRow[], SecretMap | undefined>(secrets, toSecretRows);

  const emit = (next: SecretRow[]) => {
    setRows(next);
    const built = buildSecrets(next);
    markEmitted(built);
    onChange(built);
  };

  const duplicates = new Set(
    rows
      .map((row) => row.key)
      .filter((key, index, all) => key !== "" && all.indexOf(key) !== index),
  );

  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No secrets declared. This tool runs without any API keys.
        </p>
      ) : null}

      {rows.map((row, index) => (
        <div key={index} className="rounded-md border border-border bg-code p-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="field w-56"
              aria-label={`Secret name ${index + 1}`}
              placeholder="OPENWEATHER_API_KEY"
              value={row.key}
              onChange={(e) =>
                emit(rows.map((r, i) => (i === index ? { ...r, key: e.target.value } : r)))
              }
            />
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                aria-label={`Secret ${index + 1} optional`}
                checked={row.isOptional}
                onChange={(e) =>
                  emit(
                    rows.map((r, i) => (i === index ? { ...r, isOptional: e.target.checked } : r)),
                  )
                }
              />
              Optional
            </label>
            <button
              type="button"
              className="btn ml-auto"
              aria-label={`Remove secret ${row.key || index + 1}`}
              onClick={() => emit(rows.filter((_, i) => i !== index))}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>

          <input
            className="field mt-2"
            aria-label={`Secret description ${index + 1}`}
            placeholder="What this key is for and where to get it."
            value={row.description}
            onChange={(e) =>
              emit(rows.map((r, i) => (i === index ? { ...r, description: e.target.value } : r)))
            }
          />

          {row.key.trim() === "" ? (
            <p className="mt-2 text-xs text-warning" role="status">
              This secret has no name and will be dropped on save.
            </p>
          ) : null}
          {duplicates.has(row.key) ? (
            <p className="mt-2 text-xs text-warning" role="status">
              Duplicate secret name <span className="font-mono">{row.key}</span>.
            </p>
          ) : null}
        </div>
      ))}

      <button
        type="button"
        className="btn"
        onClick={() =>
          emit([
            ...rows,
            {
              key: uniqueSecretKey(rows.map((r) => r.key)),
              description: "",
              isOptional: false,
            },
          ])
        }
      >
        <Plus className="h-3.5 w-3.5" /> Add Secret
      </button>
    </div>
  );
}

function toSecretRows(secrets: SecretMap | undefined): SecretRow[] {
  if (!secrets || typeof secrets !== "object") return [];
  return Object.entries(secrets).map(([key, value]) => ({
    key,
    description: typeof value?.description === "string" ? value.description : "",
    isOptional: value?.isOptional === true,
  }));
}

function buildSecrets(rows: SecretRow[]): SecretMap {
  const out: SecretMap = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key === "") continue;
    out[key] = { description: row.description, isOptional: row.isOptional };
  }
  return out;
}

function uniqueSecretKey(existing: string[]): string {
  const base = "NEW_SECRET";
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

/* ------------------------------------------------------------------ */
/* mcpResources / mcpPrompts                                           */
/* ------------------------------------------------------------------ */

function JsonArrayField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: unknown[] | undefined;
  placeholder: string;
  onChange: (next: unknown[]) => void;
}) {
  const formatted = value === undefined ? "" : JSON.stringify(value, null, 2);
  const [buffer, setBuffer] = useState(formatted);
  const [seen, setSeen] = useState(formatted);
  const [error, setError] = useState<string | null>(null);

  // Re-seed when the store changed underneath us (a load, or a JSON pane save).
  if (formatted !== seen) {
    setSeen(formatted);
    setBuffer(formatted);
    setError(null);
  }

  const onEdit = (text: string) => {
    setBuffer(text);
    if (text.trim() === "") {
      setError(null);
      setSeen("");
      onChange([]);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        setError("Must be a JSON array.");
        return;
      }
      setError(null);
      setSeen(JSON.stringify(parsed, null, 2));
      onChange(parsed);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div>
      <span className="label">{label}</span>
      <textarea
        className="field min-h-24"
        aria-label={label}
        spellCheck={false}
        placeholder={placeholder}
        value={buffer}
        onChange={(e) => onEdit(e.target.value)}
      />
      {error ? (
        <p className="mt-1 text-xs text-destructive" role="status">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* dotted-path helpers (divergence)                                    */
/* ------------------------------------------------------------------ */

export function getAtPath(source: unknown, segments: string[]): unknown {
  let current: unknown = source;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else if (typeof current === "object" && current !== null) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

export function setAtPath(target: unknown, segments: string[], value: unknown): unknown {
  const [head, ...rest] = segments;
  if (head === undefined) return value;

  const index = Number(head);
  if (Array.isArray(target) && Number.isInteger(index)) {
    const next = [...target];
    next[index] = rest.length === 0 ? value : setAtPath(target[index], rest, value);
    return next;
  }

  const base =
    typeof target === "object" && target !== null && !Array.isArray(target)
      ? (target as Record<string, unknown>)
      : {};
  return {
    ...base,
    [head]: rest.length === 0 ? value : setAtPath(base[head], rest, value),
  };
}

function preview(value: unknown): string {
  if (value === undefined) return "— absent —";
  const text = JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

function toNumber(raw: string, fallback: number): number {
  if (raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
