/**
 * [ Config ] → Form Editor → Signature Builder
 * (docs/llm_generated/12-screen-config.md §2 "Signature Builder (JSON Schema)").
 *
 *   > Inputs            [ + Add Field ]
 *   > Outputs           [ + Add Field ]
 *   > Actionable Errors [ + Add Error ]
 *
 * Writes `signature.inputs.properties` / `.required`, `signature.outputs.properties`
 * and `signature.errors`. `actionable_advice` is mandatory (02-tool-authoring-guide.md
 * §3.A: agents read it to self-correct), so an empty one is flagged inline.
 */

import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";

import type { ToolSignature } from "@/lib/tgs/contract";
import { useDraftValue } from "@/screens/config/TagListField";

export const FIELD_TYPES = ["string", "number", "boolean", "object", "array"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

type FieldRow = {
  key: string;
  type: FieldType;
  description: string;
  enumText: string;
  required: boolean;
  /** Any other JSON-Schema keys on the property, preserved verbatim. */
  extra: Record<string, unknown>;
};

type ErrorRow = {
  code: string;
  description: string;
  advice: string;
  extra: Record<string, unknown>;
};

type Rows = { inputs: FieldRow[]; outputs: FieldRow[]; errors: ErrorRow[] };

export const EMPTY_SIGNATURE: ToolSignature = {
  inputs: { type: "object", properties: {} },
  outputs: { type: "object", properties: {} },
};

export function SignatureBuilder({
  signature,
  onChange,
}: {
  signature: ToolSignature | undefined;
  onChange: (next: ToolSignature) => void;
}) {
  const {
    value: rows,
    setValue: setRows,
    markEmitted,
  } = useDraftValue<Rows, ToolSignature | undefined>(signature, toRows);

  const [open, setOpen] = useState({ inputs: true, outputs: true, errors: true });

  const emit = (next: Rows) => {
    setRows(next);
    const built = buildSignature(next);
    markEmitted(built);
    onChange(built);
  };

  const patchField = (group: "inputs" | "outputs", index: number, patch: Partial<FieldRow>) => {
    emit({
      ...rows,
      [group]: rows[group].map((row, i) => (i === index ? { ...row, ...patch } : row)),
    });
  };

  const removeField = (group: "inputs" | "outputs", index: number) => {
    emit({ ...rows, [group]: rows[group].filter((_, i) => i !== index) });
  };

  const addField = (group: "inputs" | "outputs") => {
    emit({
      ...rows,
      [group]: [
        ...rows[group],
        {
          key: uniqueKey(
            rows[group].map((r) => r.key),
            group === "inputs" ? "new_input" : "new_output",
          ),
          type: "string",
          description: "",
          enumText: "",
          required: false,
          extra: {},
        },
      ],
    });
  };

  const duplicates = (group: "inputs" | "outputs") => {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const row of rows[group]) {
      if (seen.has(row.key)) dupes.add(row.key);
      seen.add(row.key);
    }
    return dupes;
  };

  return (
    <div className="space-y-3">
      <Group
        title="Inputs"
        count={rows.inputs.length}
        open={open.inputs}
        onToggle={() => setOpen((o) => ({ ...o, inputs: !o.inputs }))}
        action={
          <button type="button" className="btn" onClick={() => addField("inputs")}>
            <Plus className="h-3.5 w-3.5" /> Add Field
          </button>
        }
      >
        <FieldRows
          group="inputs"
          rows={rows.inputs}
          duplicates={duplicates("inputs")}
          showRequired
          onPatch={(i, patch) => patchField("inputs", i, patch)}
          onRemove={(i) => removeField("inputs", i)}
        />
      </Group>

      <Group
        title="Outputs"
        count={rows.outputs.length}
        open={open.outputs}
        onToggle={() => setOpen((o) => ({ ...o, outputs: !o.outputs }))}
        action={
          <button type="button" className="btn" onClick={() => addField("outputs")}>
            <Plus className="h-3.5 w-3.5" /> Add Field
          </button>
        }
      >
        <FieldRows
          group="outputs"
          rows={rows.outputs}
          duplicates={duplicates("outputs")}
          showRequired={false}
          onPatch={(i, patch) => patchField("outputs", i, patch)}
          onRemove={(i) => removeField("outputs", i)}
        />
      </Group>

      <Group
        title="Actionable Errors"
        count={rows.errors.length}
        open={open.errors}
        onToggle={() => setOpen((o) => ({ ...o, errors: !o.errors }))}
        action={
          <button
            type="button"
            className="btn"
            onClick={() =>
              emit({
                ...rows,
                errors: [
                  ...rows.errors,
                  {
                    code: uniqueKey(
                      rows.errors.map((r) => r.code),
                      "NEW_ERROR",
                    ),
                    description: "",
                    advice: "",
                    extra: {},
                  },
                ],
              })
            }
          >
            <Plus className="h-3.5 w-3.5" /> Add Error
          </button>
        }
      >
        {rows.errors.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No declared errors. Agents can only self-correct from codes you declare here.
          </p>
        ) : null}

        <div className="space-y-3">
          {rows.errors.map((row, index) => (
            <div key={index} className="rounded-md border border-border bg-code p-3">
              <div className="grid gap-3 md:grid-cols-[minmax(0,14rem)_1fr]">
                <input
                  className="field"
                  aria-label={`Error code ${index + 1}`}
                  placeholder="ERROR_CODE"
                  value={row.code}
                  onChange={(e) =>
                    emit({
                      ...rows,
                      errors: rows.errors.map((r, i) =>
                        i === index ? { ...r, code: e.target.value } : r,
                      ),
                    })
                  }
                />
                <input
                  className="field"
                  aria-label={`Error description ${index + 1}`}
                  placeholder="What went wrong"
                  value={row.description}
                  onChange={(e) =>
                    emit({
                      ...rows,
                      errors: rows.errors.map((r, i) =>
                        i === index ? { ...r, description: e.target.value } : r,
                      ),
                    })
                  }
                />
              </div>

              <input
                className="field mt-3"
                aria-label={`Actionable advice ${index + 1}`}
                placeholder="actionable_advice — the next step an agent should take"
                value={row.advice}
                onChange={(e) =>
                  emit({
                    ...rows,
                    errors: rows.errors.map((r, i) =>
                      i === index ? { ...r, advice: e.target.value } : r,
                    ),
                  })
                }
              />

              {row.advice.trim() === "" ? (
                <p className="finding mt-2 text-warning" data-state="warn" role="status">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Missing actionable_advice for{" "}
                    <span className="font-mono">{row.code || "this error"}</span> — the LLM rubric
                    fails tools without it.
                  </span>
                </p>
              ) : null}

              <button
                type="button"
                className="btn mt-3"
                aria-label={`Remove error ${row.code || index + 1}`}
                onClick={() => emit({ ...rows, errors: rows.errors.filter((_, i) => i !== index) })}
              >
                <Trash2 className="h-3.5 w-3.5" /> Remove
              </button>
            </div>
          ))}
        </div>
      </Group>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* pieces                                                              */
/* ------------------------------------------------------------------ */

function Group({
  title,
  count,
  open,
  onToggle,
  action,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  action: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border border-border">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          className="flex items-center gap-1 text-sm font-semibold text-foreground"
          aria-expanded={open}
          onClick={onToggle}
        >
          {open ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
          {title}
        </button>
        <span className="chip">{count}</span>
        <span className="ml-auto">{action}</span>
      </div>
      {open ? <div className="space-y-3 p-3">{children}</div> : null}
    </section>
  );
}

function FieldRows({
  group,
  rows,
  duplicates,
  showRequired,
  onPatch,
  onRemove,
}: {
  group: "inputs" | "outputs";
  rows: FieldRow[];
  duplicates: Set<string>;
  showRequired: boolean;
  onPatch: (index: number, patch: Partial<FieldRow>) => void;
  onRemove: (index: number) => void;
}) {
  const noun = group === "inputs" ? "input" : "output";

  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">No {noun} fields declared yet.</p>;
  }

  return (
    <div className="space-y-3">
      {rows.map((row, index) => {
        const supportsEnum = row.type === "string" || row.type === "number";
        return (
          <div key={index} className="rounded-md border border-border bg-code p-3">
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="field w-48"
                aria-label={`${noun} name ${index + 1}`}
                placeholder="field_name"
                value={row.key}
                onChange={(e) => onPatch(index, { key: e.target.value })}
              />
              <select
                className="field w-36"
                aria-label={`${noun} type ${index + 1}`}
                value={row.type}
                onChange={(e) => onPatch(index, { type: e.target.value as FieldType })}
              >
                {FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>

              {showRequired ? (
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    aria-label={`${noun} ${index + 1} required`}
                    checked={row.required}
                    onChange={(e) => onPatch(index, { required: e.target.checked })}
                  />
                  required
                </label>
              ) : null}

              <button
                type="button"
                className="btn ml-auto"
                aria-label={`Remove ${noun} ${row.key || index + 1}`}
                onClick={() => onRemove(index)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="mt-2 grid gap-2 md:grid-cols-2">
              <input
                className="field"
                aria-label={`${noun} description ${index + 1}`}
                placeholder="description (optional)"
                value={row.description}
                onChange={(e) => onPatch(index, { description: e.target.value })}
              />
              {supportsEnum ? (
                <input
                  className="field"
                  aria-label={`${noun} enum ${index + 1}`}
                  placeholder="enum: add, subtract, multiply"
                  value={row.enumText}
                  onChange={(e) => onPatch(index, { enumText: e.target.value })}
                />
              ) : null}
            </div>

            {row.key.trim() === "" ? (
              <p className="mt-2 text-xs text-warning" role="status">
                This field has no name and will be dropped on save.
              </p>
            ) : null}
            {duplicates.has(row.key) ? (
              <p className="mt-2 text-xs text-warning" role="status">
                Duplicate field name <span className="font-mono">{row.key}</span> — only the last
                one survives serialization.
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* signature <-> rows                                                  */
/* ------------------------------------------------------------------ */

function toRows(signature: ToolSignature | undefined): Rows {
  const requiredList = signature?.inputs?.required;
  const required = new Set<string>(Array.isArray(requiredList) ? requiredList : []);
  return {
    inputs: propertyRows(signature?.inputs?.properties, required),
    outputs: propertyRows(signature?.outputs?.properties, new Set()),
    errors: errorRows(signature?.errors),
  };
}

function propertyRows(
  properties: Record<string, unknown> | undefined,
  required: Set<string>,
): FieldRow[] {
  if (!properties || typeof properties !== "object") return [];
  return Object.entries(properties).map(([key, raw]) => {
    const prop = isRecord(raw) ? raw : {};
    const { type, description, enum: enumValues, ...extra } = prop;
    return {
      key,
      type: FIELD_TYPES.includes(type as FieldType) ? (type as FieldType) : "string",
      description: typeof description === "string" ? description : "",
      enumText: Array.isArray(enumValues) ? enumValues.map((v) => String(v)).join(", ") : "",
      required: required.has(key),
      extra,
    };
  });
}

function errorRows(errors: ToolSignature["errors"]): ErrorRow[] {
  if (!errors || typeof errors !== "object") return [];
  return Object.entries(errors).map(([code, raw]) => {
    const value: Record<string, unknown> = isRecord(raw) ? raw : {};
    const { description, actionable_advice, ...extra } = value;
    return {
      code,
      description: typeof description === "string" ? description : "",
      advice: typeof actionable_advice === "string" ? actionable_advice : "",
      extra,
    };
  });
}

export function buildSignature(rows: Rows): ToolSignature {
  const inputProperties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const row of rows.inputs) {
    const key = row.key.trim();
    if (key === "") continue;
    inputProperties[key] = buildProperty(row);
    if (row.required) required.push(key);
  }

  const outputProperties: Record<string, unknown> = {};
  for (const row of rows.outputs) {
    const key = row.key.trim();
    if (key === "") continue;
    outputProperties[key] = buildProperty(row);
  }

  const errors: Record<string, { description: string; actionable_advice?: string }> = {};
  for (const row of rows.errors) {
    const code = row.code.trim();
    if (code === "") continue;
    errors[code] = {
      ...row.extra,
      description: row.description,
      ...(row.advice.trim() === "" ? {} : { actionable_advice: row.advice }),
    };
  }

  return {
    inputs: {
      type: "object",
      properties: inputProperties,
      ...(required.length > 0 ? { required } : {}),
    },
    outputs: { type: "object", properties: outputProperties },
    ...(rows.errors.length > 0 ? { errors } : {}),
  };
}

function buildProperty(row: FieldRow): Record<string, unknown> {
  const prop: Record<string, unknown> = { ...row.extra, type: row.type };
  if (row.description.trim() !== "") prop["description"] = row.description;
  if (row.type === "string" || row.type === "number") {
    const items = row.enumText
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");
    if (items.length > 0) {
      prop["enum"] = row.type === "number" ? items.map((item) => Number(item)) : items;
    }
  }
  return prop;
}

function uniqueKey(existing: string[], base: string): string {
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
