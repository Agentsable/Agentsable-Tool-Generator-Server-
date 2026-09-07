import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearSecrets,
  clearWorkspace,
  loadSecrets,
  loadWorkspace,
  SECRETS_STORAGE_KEY,
  saveWorkspace,
  WORKSPACE_STORAGE_KEY,
  type PersistedWorkspace,
} from "./persist";

/** Minimal in-memory Storage. `failOnSet` simulates a quota-exceeded browser. */
function makeStorage(options?: { failOnSet?: boolean }): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (options?.failOnSet) {
        const e = new Error("QuotaExceededError");
        e.name = "QuotaExceededError";
        throw e;
      }
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
  } as Storage & { map: Map<string, string> };
}

const WORKSPACE: PersistedWorkspace = {
  version: 1,
  bundle: {
    name: "weather_fetcher",
    logic: "export default async function execute() {}",
    config: { name: "weather_fetcher", version: "1.1.0" },
    configJson: { name: "weather_fetcher", version: "1.1.0" },
    secrets: { WEATHER_API_KEY: "sk-secret", SLACK_WEBHOOK_URL: "" },
    jsonTests: [{ name: "happy path" }],
  },
  pythonRules: [{ filename: "no_node_builtins.py", source: "# check", builtin: true }],
  rubricMarkdown: "# sts_rules\n",
  activeTab: "raw-data",
  savedAt: "2026-09-07T00:00:00.000Z",
};

let storage: ReturnType<typeof makeStorage>;

beforeEach(() => {
  storage = makeStorage();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("round-trip", () => {
  it("restores everything, secrets included, by default", () => {
    saveWorkspace(WORKSPACE);
    expect(loadWorkspace()).toEqual(WORKSPACE);
  });

  it("keeps secret VALUES out of the workspace blob and in their own key", () => {
    saveWorkspace(WORKSPACE);

    const workspaceBlob = storage.map.get(WORKSPACE_STORAGE_KEY) ?? "";
    expect(workspaceBlob).not.toContain("sk-secret");
    expect(JSON.parse(workspaceBlob).bundle.secrets).toEqual({});

    const secretsBlob = storage.map.get(SECRETS_STORAGE_KEY) ?? "";
    expect(secretsBlob).toContain("sk-secret");
    expect(loadSecrets()).toEqual(WORKSPACE.bundle.secrets);
  });

  it("stamps savedAt when the caller leaves it blank", () => {
    saveWorkspace({ ...WORKSPACE, savedAt: "" });
    expect(loadWorkspace()?.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns null when nothing has been saved", () => {
    expect(loadWorkspace()).toBeNull();
  });
});

describe("includeSecrets", () => {
  it("omits secret values on load when includeSecrets is false", () => {
    saveWorkspace(WORKSPACE);
    const loaded = loadWorkspace({ includeSecrets: false });

    expect(loaded?.bundle.secrets).toEqual({});
    expect(loaded?.bundle.name).toBe("weather_fetcher");
    // The stored values are untouched — a later load can still get them.
    expect(loadWorkspace()?.bundle.secrets).toEqual(WORKSPACE.bundle.secrets);
  });

  it("never writes secret values when saving with includeSecrets false", () => {
    saveWorkspace(WORKSPACE, { includeSecrets: false });

    expect(storage.map.has(SECRETS_STORAGE_KEY)).toBe(false);
    expect([...storage.map.values()].join("")).not.toContain("sk-secret");
    expect(loadWorkspace()?.bundle.secrets).toEqual({});
    expect(loadWorkspace()?.bundle.logic).toBe(WORKSPACE.bundle.logic);
  });

  it("drops previously stored values when a later save opts out", () => {
    saveWorkspace(WORKSPACE);
    expect(loadSecrets()).not.toEqual({});
    saveWorkspace(WORKSPACE, { includeSecrets: false });
    expect(loadSecrets()).toEqual({});
  });
});

describe("clearing", () => {
  it("clearSecrets wipes only the values, leaving the workspace intact", () => {
    saveWorkspace(WORKSPACE);
    clearSecrets();

    expect(storage.map.has(SECRETS_STORAGE_KEY)).toBe(false);
    const loaded = loadWorkspace();
    expect(loaded?.bundle.secrets).toEqual({});
    expect(loaded?.bundle.logic).toBe(WORKSPACE.bundle.logic);
    expect(loaded?.pythonRules).toEqual(WORKSPACE.pythonRules);
    expect(loaded?.rubricMarkdown).toBe(WORKSPACE.rubricMarkdown);
  });

  it("clearWorkspace removes both keys", () => {
    saveWorkspace(WORKSPACE);
    clearWorkspace();

    expect(storage.map.size).toBe(0);
    expect(loadWorkspace()).toBeNull();
  });
});

describe("corrupt or unknown payloads", () => {
  it("returns null for corrupt JSON", () => {
    storage.map.set(WORKSPACE_STORAGE_KEY, "{not json");
    expect(loadWorkspace()).toBeNull();
  });

  it("returns null for an unknown version", () => {
    storage.map.set(WORKSPACE_STORAGE_KEY, JSON.stringify({ ...WORKSPACE, version: 2 }));
    expect(loadWorkspace()).toBeNull();
  });

  it("returns null for a structurally wrong payload", () => {
    storage.map.set(WORKSPACE_STORAGE_KEY, JSON.stringify({ version: 1, bundle: { name: 5 } }));
    expect(loadWorkspace()).toBeNull();

    storage.map.set(WORKSPACE_STORAGE_KEY, JSON.stringify(["not", "an", "object"]));
    expect(loadWorkspace()).toBeNull();
  });

  it("ignores corrupt secrets without losing the workspace", () => {
    saveWorkspace(WORKSPACE);
    storage.map.set(SECRETS_STORAGE_KEY, "}}broken");

    expect(loadSecrets()).toEqual({});
    expect(loadWorkspace()?.bundle.logic).toBe(WORKSPACE.bundle.logic);
  });

  it("drops non-string secret values and malformed python rules", () => {
    storage.map.set(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        bundle: { name: "t", logic: "", jsonTests: "nope" },
        pythonRules: [{ filename: "ok.py", source: "x" }, { filename: 7 }, "junk"],
      }),
    );
    storage.map.set(
      SECRETS_STORAGE_KEY,
      JSON.stringify({ version: 1, values: { GOOD: "v", BAD: 42 } }),
    );

    const loaded = loadWorkspace();
    expect(loaded?.bundle.jsonTests).toEqual([]);
    expect(loaded?.bundle.secrets).toEqual({ GOOD: "v" });
    expect(loaded?.pythonRules).toEqual([{ filename: "ok.py", source: "x", builtin: false }]);
    expect(loaded?.activeTab).toBe("");
  });
});

describe("storage unavailable", () => {
  it("returns null and never throws when localStorage is absent (SSR / private mode)", () => {
    vi.unstubAllGlobals();
    expect(typeof (globalThis as { localStorage?: unknown }).localStorage).toBe("undefined");

    expect(loadWorkspace()).toBeNull();
    expect(loadSecrets()).toEqual({});
    expect(() => saveWorkspace(WORKSPACE)).not.toThrow();
    expect(() => clearWorkspace()).not.toThrow();
    expect(() => clearSecrets()).not.toThrow();
  });

  it("returns null when touching localStorage throws (blocked site data)", () => {
    vi.stubGlobal("localStorage", {
      get getItem(): never {
        throw new Error("SecurityError");
      },
    });
    expect(loadWorkspace()).toBeNull();
    expect(() => saveWorkspace(WORKSPACE)).not.toThrow();
  });

  it("swallows quota errors on save", () => {
    vi.stubGlobal("localStorage", makeStorage({ failOnSet: true }));
    expect(() => saveWorkspace(WORKSPACE)).not.toThrow();
    expect(loadWorkspace()).toBeNull();
  });
});
