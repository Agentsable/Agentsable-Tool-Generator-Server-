/**
 * Shared field primitives for the [ Config ] Form Editor
 * (docs/llm_generated/12-screen-config.md §2 "Fields & Form Controls").
 *
 * `TagListField` is the chip list used by `tool_dependencies`, `network_requests`,
 * `tags` and `permissions.read` / `permissions.write`.
 *
 * `useDraftValue` is the row-buffer used by every editor that turns an *ordered
 * object* (`signature.inputs.properties`, `signature.errors`, `config.secrets`)
 * into editable rows: renaming a key one character at a time must not drop the
 * row, so the rows are held locally and only re-seeded when the config changes
 * from the outside (a [ 📥 Load from Tool ] / [ 📥 Load from Config ] press, or a
 * JSON pane save).
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";

export type TagListFieldProps = {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  /** Return an error message for an invalid entry, or `null` when it is fine. */
  validate?: (value: string) => string | null;
  hint?: string;
};

export function TagListField({
  label,
  values,
  onChange,
  placeholder,
  validate,
  hint,
}: TagListFieldProps) {
  const [draft, setDraft] = useState("");

  const draftError = validate && draft.trim() !== "" ? validate(draft.trim()) : null;
  const invalid = validate
    ? values
        .map((value) => ({ value, error: validate(value) }))
        .filter((entry): entry is { value: string; error: string } => entry.error !== null)
    : [];

  const commit = (raw: string) => {
    const value = raw.trim();
    if (value === "") return;
    setDraft("");
    if (values.includes(value)) return;
    onChange([...values, value]);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit(draft);
    } else if (event.key === "Backspace" && draft === "" && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };

  return (
    <div>
      <span className="label">{label}</span>
      <div className="flex flex-wrap items-center gap-2">
        {values.map((value) => (
          <span
            key={value}
            className="chip"
            data-invalid={invalid.some((entry) => entry.value === value)}
          >
            {value}
            <button
              type="button"
              aria-label={`Remove ${value} from ${label}`}
              onClick={() => onChange(values.filter((entry) => entry !== value))}
            >
              <X className="h-3 w-3 text-muted-foreground" />
            </button>
          </span>
        ))}
        <input
          className="field w-64"
          aria-label={`Add ${label}`}
          placeholder={placeholder ?? "type a value, press Enter"}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => commit(draft)}
        />
      </div>

      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}

      {draftError ? (
        <p className="mt-1 text-xs text-warning" role="status">
          {draftError}
        </p>
      ) : null}

      {invalid.map((entry) => (
        <p key={entry.value} className="mt-1 text-xs text-warning" role="status">
          <span className="font-mono">{entry.value}</span> — {entry.error}
        </p>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* useDraftRows                                                        */
/* ------------------------------------------------------------------ */

export type DraftValue<Value> = {
  value: Value;
  /** Replace the local working copy without touching the store. */
  setValue: (next: Value) => void;
  /** Record what we just wrote upstream, so the re-seed effect does not fight it. */
  markEmitted: (emitted: unknown) => void;
};

/**
 * Local, order-preserving row buffer over a value owned by the store.
 *
 * `source` is re-read (and the rows rebuilt) only when it changes to something
 * other than what this component last emitted.
 */
export function useDraftValue<Value, Source>(
  source: Source,
  derive: (source: Source) => Value,
): DraftValue<Value> {
  const deriveRef = useRef(derive);
  deriveRef.current = derive;

  const [value, setValue] = useState<Value>(() => derive(source));
  const lastSeen = useRef<string>(stableKey(source));

  useEffect(() => {
    const incoming = stableKey(source);
    if (incoming === lastSeen.current) return;
    lastSeen.current = incoming;
    setValue(deriveRef.current(source));
  }, [source]);

  const markEmitted = useCallback((emitted: unknown) => {
    lastSeen.current = stableKey(emitted);
  }, []);

  return { value, setValue, markEmitted };
}

function stableKey(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? "undefined";
  } catch {
    return String(value);
  }
}
