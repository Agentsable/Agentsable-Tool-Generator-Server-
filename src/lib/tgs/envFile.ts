/**
 * `[tool_name].env` parsing, rendering and the non-destructive merge described in
 * `docs/llm_generated/13-screen-secrets.md` §3.
 *
 * The Secrets screen renders inputs strictly from `config.secrets`, so rendering
 * is always driven by a declared-key list: undeclared keys never reach the file,
 * and an incoming `.env` may only fill blanks — it can never overwrite a value
 * the developer already typed.
 */

const UNQUOTED_UNSAFE_RE = /[\n\r"'#\\]/;

/**
 * Parse `.env` text into a flat map.
 *
 * Handles `export KEY=value`, `#` comments (whole-line and trailing on unquoted
 * values), blank lines, `=` inside values, single quotes (literal) and double
 * quotes (with `\n`, `\r`, `\t`, `\"`, `\\` escapes).
 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const source = text.replace(/^\uFEFF/, "");
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (key === "") continue;

    let value = withoutExport.slice(eq + 1).trim();

    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = unescapeDoubleQuoted(value.slice(1, -1));
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      const comment = value.search(/\s#/);
      if (comment >= 0) value = value.slice(0, comment);
      value = value.trim();
    }

    out[key] = value;
  }
  return out;
}

function unescapeDoubleQuoted(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch !== "\\") {
      out += ch ?? "";
      continue;
    }
    const next = value[i + 1];
    if (next === undefined) {
      out += "\\";
      break;
    }
    i += 1;
    switch (next) {
      case "n":
        out += "\n";
        break;
      case "r":
        out += "\r";
        break;
      case "t":
        out += "\t";
        break;
      case '"':
        out += '"';
        break;
      case "'":
        out += "'";
        break;
      case "\\":
        out += "\\";
        break;
      default:
        out += `\\${next}`;
        break;
    }
  }
  return out;
}

function renderValue(value: string): string {
  if (value === "") return "";
  if (UNQUOTED_UNSAFE_RE.test(value) || value !== value.trim()) {
    const escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    return `"${escaped}"`;
  }
  return value;
}

/**
 * Render one `KEY=value` line per declared key, in declaration order. Keys with
 * no value render empty; keys not declared in `config.secrets` are omitted.
 */
export function renderEnv(values: Record<string, string>, declaredKeys: string[]): string {
  if (declaredKeys.length === 0) return "";
  const lines = declaredKeys.map((key) => {
    const raw = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined;
    return `${key}=${renderValue(raw ?? "")}`;
  });
  return `${lines.join("\n")}\n`;
}

export type EnvMergeResult = {
  merged: Record<string, string>;
  /** Declared keys that were empty/absent and got a value from `incoming`. */
  filled: string[];
  /** Incoming keys that are not declared in `config.secrets`, and were dropped. */
  ignored: string[];
};

/**
 * `[ 📥 Load .env File ]`: fills only blanks, never overwrites a value already
 * present, and ignores keys the tool does not declare.
 */
export function mergeEnvNonDestructive(
  current: Record<string, string>,
  incoming: Record<string, string>,
  declaredKeys: string[],
): EnvMergeResult {
  const declared = new Set(declaredKeys);
  const merged: Record<string, string> = { ...current };
  const filled: string[] = [];
  const ignored: string[] = [];

  for (const [key, value] of Object.entries(incoming)) {
    if (!declared.has(key)) {
      ignored.push(key);
      continue;
    }
    const existing = Object.prototype.hasOwnProperty.call(merged, key) ? merged[key] : undefined;
    const isBlank = existing === undefined || existing === "";
    if (!isBlank) continue;
    if (value === "") continue;
    merged[key] = value;
    filled.push(key);
  }

  return { merged, filled, ignored };
}
