/**
 * TGS local session persistence.
 *
 * TGS is local-first and manages exactly one tool context at a time
 * (01-system-overview.md §1), so the whole workspace — bundle, Python rules, LLM rubric and
 * the active tab — is snapshotted into `localStorage` and restored on reload.
 *
 * SECRETS TRADEOFF (13-screen-secrets.md)
 * ---------------------------------------
 * Secret *values* are sensitive, but they are also local-testing-only: they are injected into
 * `context.env` by the local Deno server and are NEVER part of a publish bundle (the `.env` is
 * explicitly excluded from [ 🚀 Publish ]). Losing them on every reload would make the Runner
 * unusable, so we do persist them — but:
 *   - under a SEPARATE key (`tgs.secrets.v1`) from the rest of the workspace, so a caller can
 *     drop them without dropping the tool;
 *   - behind an explicit `includeSecrets` flag (default `true`) on both load and save;
 *   - with `clearSecrets()` to wipe just the values, leaving the workspace intact.
 * They live only in this browser profile, on this origin. They are never uploaded by this
 * module and never leave the machine.
 *
 * Every entry point is a no-op (or `null`) when `localStorage` is unavailable — server-side
 * rendering, private mode, disabled storage, quota exceeded. Nothing here ever throws.
 */

export const WORKSPACE_STORAGE_KEY = "tgs.workspace.v1";
export const SECRETS_STORAGE_KEY = "tgs.secrets.v1";
export const WORKSPACE_VERSION = 1 as const;

export type PersistedPythonRule = { filename: string; source: string; builtin: boolean };

export type PersistedBundle = {
  name: string;
  logic: string;
  config: unknown;
  configJson: unknown;
  secrets: Record<string, string>;
  jsonTests: unknown[];
};

export type PersistedWorkspace = {
  version: 1;
  bundle: PersistedBundle;
  pythonRules: PersistedPythonRule[];
  rubricMarkdown: string;
  activeTab: string;
  savedAt: string;
};

export type PersistOptions = { includeSecrets?: boolean };

/* ------------------------------------------------------------------ */

/** Storage handle, or `null` when storage is unavailable for any reason (never throws). */
function getStorage(): Storage | null {
  try {
    const storage = (globalThis as { localStorage?: Storage | null }).localStorage;
    if (!storage || typeof storage.getItem !== "function") return null;
    return storage;
  } catch {
    // Accessing localStorage itself throws when cookies/site data are blocked.
    return null;
  }
}

function readKey(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(storage: Storage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // QuotaExceededError / SecurityError — persistence is best effort by design.
  }
}

function removeKey(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    /* best effort */
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asStringRecord(v: unknown): Record<string, string> {
  if (!isRecord(v)) return {};
  const out: Record<string, string> = {};
  for (const key of Object.keys(v)) {
    const value = v[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function asPythonRules(v: unknown): PersistedPythonRule[] {
  if (!Array.isArray(v)) return [];
  const out: PersistedPythonRule[] = [];
  for (const item of v) {
    if (!isRecord(item)) continue;
    const filename = item["filename"];
    const source = item["source"];
    if (typeof filename !== "string" || typeof source !== "string") continue;
    out.push({ filename, source, builtin: item["builtin"] === true });
  }
  return out;
}

/** Validate + normalise a parsed payload. Returns `null` for an unknown or corrupt version. */
function parseWorkspace(raw: unknown): PersistedWorkspace | null {
  if (!isRecord(raw)) return null;
  if (raw["version"] !== WORKSPACE_VERSION) return null;
  const bundle = raw["bundle"];
  if (!isRecord(bundle)) return null;
  const name = bundle["name"];
  const logic = bundle["logic"];
  if (typeof name !== "string" || typeof logic !== "string") return null;

  return {
    version: WORKSPACE_VERSION,
    bundle: {
      name,
      logic,
      config: bundle["config"] ?? {},
      configJson: bundle["configJson"] ?? {},
      secrets: asStringRecord(bundle["secrets"]),
      jsonTests: Array.isArray(bundle["jsonTests"]) ? bundle["jsonTests"] : [],
    },
    pythonRules: asPythonRules(raw["pythonRules"]),
    rubricMarkdown: typeof raw["rubricMarkdown"] === "string" ? raw["rubricMarkdown"] : "",
    activeTab: typeof raw["activeTab"] === "string" ? raw["activeTab"] : "",
    savedAt: typeof raw["savedAt"] === "string" ? raw["savedAt"] : "",
  };
}

/* ------------------------------------------------------------------ */

/**
 * Restore the workspace, or `null` when there is nothing valid to restore
 * (no storage, absent, corrupt JSON, unknown version).
 * With `includeSecrets: false` the returned bundle has an empty `secrets` map.
 */
export function loadWorkspace(options?: PersistOptions): PersistedWorkspace | null {
  const includeSecrets = options?.includeSecrets ?? true;
  const storage = getStorage();
  if (!storage) return null;

  const rawWorkspace = readKey(storage, WORKSPACE_STORAGE_KEY);
  if (rawWorkspace === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawWorkspace);
  } catch {
    return null;
  }

  const workspace = parseWorkspace(parsed);
  if (!workspace) return null;

  workspace.bundle.secrets = includeSecrets ? loadSecrets() : {};
  return workspace;
}

/**
 * Persist the workspace. Safe to call from a debounced effect: it is synchronous, cheap and
 * swallows quota errors. Secret values are written to their own key, or removed entirely when
 * `includeSecrets` is `false`.
 */
export function saveWorkspace(workspace: PersistedWorkspace, options?: PersistOptions): void {
  const includeSecrets = options?.includeSecrets ?? true;
  const storage = getStorage();
  if (!storage) return;

  const payload: PersistedWorkspace = {
    ...workspace,
    version: WORKSPACE_VERSION,
    // Secret values never ride along in the workspace blob — they get their own key.
    bundle: { ...workspace.bundle, secrets: {} },
    savedAt: workspace.savedAt || new Date().toISOString(),
  };

  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return; // Unserializable state (cycles) — drop the snapshot rather than crash the app.
  }
  writeKey(storage, WORKSPACE_STORAGE_KEY, serialized);

  if (includeSecrets) {
    saveSecrets(workspace.bundle.secrets);
  } else {
    // Opting out must not leave a stale copy of the values behind.
    clearSecrets();
  }
}

/** Remove the persisted workspace AND its secrets. */
export function clearWorkspace(): void {
  const storage = getStorage();
  if (!storage) return;
  removeKey(storage, WORKSPACE_STORAGE_KEY);
  removeKey(storage, SECRETS_STORAGE_KEY);
}

/** Read just the secret values. `{}` when absent, corrupt or storage is unavailable. */
export function loadSecrets(): Record<string, string> {
  const storage = getStorage();
  if (!storage) return {};
  const raw = readKey(storage, SECRETS_STORAGE_KEY);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    if (parsed["version"] !== WORKSPACE_VERSION) return {};
    return asStringRecord(parsed["values"]);
  } catch {
    return {};
  }
}

/** Write just the secret values (versioned, under their own key). */
export function saveSecrets(secrets: Record<string, string>): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    writeKey(
      storage,
      SECRETS_STORAGE_KEY,
      JSON.stringify({ version: WORKSPACE_VERSION, values: asStringRecord(secrets) }),
    );
  } catch {
    /* best effort */
  }
}

/** Wipe the stored secret values, leaving the rest of the workspace intact. */
export function clearSecrets(): void {
  const storage = getStorage();
  if (!storage) return;
  removeKey(storage, SECRETS_STORAGE_KEY);
}
