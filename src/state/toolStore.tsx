/**
 * TGS global state — the Single Source of Truth for exactly one tool context,
 * shared by all six workspace screens (docs/llm_generated/01-system-overview.md §2).
 *
 * The synchronization matrix in docs/llm_generated/12-screen-config.md §5 is
 * implemented by the named actions below; each one states which target it writes
 * and whether it needs an AST pass.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { ToolConfig, ToolTest } from "@/lib/tgs/contract";
import { extractTool, recombineTool } from "@/lib/tgs/ast";
import {
  allTests,
  configDiff,
  fileNames,
  parseBundleFromFiles,
  renameTool,
  renderBundle,
  type ToolBundle,
} from "@/lib/tgs/toolFiles";
import { createDefaultBundle } from "@/lib/tgs/defaultTool";
import { mergeEnvNonDestructive, parseEnv } from "@/lib/tgs/envFile";
import { BUILTIN_PYTHON_RULES, DEFAULT_LLM_RUBRIC } from "@/lib/tgs/pythonRules";
import { computeHealth, type LLMValidationResult, type HealthReport } from "@/lib/tgs/health";
import type { PythonRuleResult } from "@/lib/tgs/pythonEngine";
import { loadWorkspace, saveWorkspace, type PersistedWorkspace } from "@/lib/tgs/persist";
import type { MountedDirectory } from "@/lib/tgs/fsAccess";
import type { RunnerTestResult, RunnerStatus } from "@/lib/tgs/runnerClient";

export type WorkspaceTab = "Raw Data" | "Editor" | "Config" | "Secrets" | "Validator" | "Runner";

export const WORKSPACE_TABS: WorkspaceTab[] = [
  "Raw Data",
  "Editor",
  "Config",
  "Secrets",
  "Validator",
  "Runner",
];

export type PythonRule = {
  id: string;
  filename: string;
  source: string;
  builtin: boolean;
};

export type ChatMessage = {
  id: string;
  role: "assistant" | "user" | "system";
  text: string;
  pending?: boolean;
  error?: boolean;
};

/** Which of the two config stores the Form Editor is currently reflecting. */
export type ConfigOrigin = "tool" | "config";

export type ValidationState = {
  python: PythonRuleResult[];
  llm: LLMValidationResult[];
  health: HealthReport;
  stale: boolean;
  pythonRunning: boolean;
  llmRunning: boolean;
  pythonError: string | null;
  llmError: string | null;
  lastRunAt: string | null;
};

const uid = () => Math.random().toString(36).slice(2, 10);

const EMPTY_HEALTH: HealthReport = computeHealth([], []);

/**
 * Where the Runner fires its HTTP tests (01-system-overview.md §5). Overridable
 * at build time with `VITE_TGS_RUNNER_URL`; the field in the Runner tab overrides
 * it at runtime.
 */
const DEFAULT_RUNNER_URL =
  (import.meta.env["VITE_TGS_RUNNER_URL"] as string | undefined) ?? "http://localhost:8080";

type Store = {
  /* ---------------- bundle ---------------- */
  bundle: ToolBundle;
  files: { name: string; language: string; content: string; kind: FileKind }[];
  dirty: boolean;
  markSaved: () => void;

  setToolName: (name: string) => void;
  /** Editor buffer (logic only; config lives behind the CONFIG_STUB). */
  setLogic: (logic: string) => void;
  /** Form Editor field writes — stage into the form, not yet committed to a file. */
  setConfigDraft: (patch: Partial<ToolConfig>) => void;
  configDraft: Partial<ToolConfig>;
  configOrigin: ConfigOrigin;
  configDivergence: string[];

  /* ------------- sync matrix (12-screen-config.md §5) ------------- */
  loadFormFromTool: () => void;
  loadFormFromConfig: () => void;
  saveFormToTool: () => void;
  saveFormToConfig: () => void;
  saveToolJsonBuffer: (json: string) => { ok: boolean; error?: string };
  saveConfigJsonBuffer: (json: string) => { ok: boolean; error?: string };
  saveEmbeddedTests: (tests: ToolTest[]) => void;
  saveJsonTests: (json: string) => { ok: boolean; error?: string };

  /* ---------------- secrets ---------------- */
  setSecretValue: (key: string, value: string) => void;
  loadEnvText: (text: string) => { filled: string[]; ignored: string[] };
  declaredSecretKeys: string[];

  /* ---------------- validator ---------------- */
  pythonRules: PythonRule[];
  addPythonRule: (filename: string) => string;
  updatePythonRule: (id: string, source: string) => void;
  removePythonRule: (id: string) => void;
  rubricMarkdown: string;
  setRubricMarkdown: (md: string) => void;
  validation: ValidationState;
  runPythonValidations: () => Promise<void>;
  runLlmValidation: () => Promise<void>;
  runAllValidations: () => Promise<void>;

  /* ---------------- runner ---------------- */
  runnerUrl: string;
  setRunnerUrl: (url: string) => void;
  runnerStatus: RunnerStatus;
  runnerResults: RunnerTestResult[];
  runnerBusy: boolean;
  checkRunner: () => Promise<void>;
  runAllTests: () => Promise<void>;
  runSingleTest: (source: "ts" | "json", index: number) => Promise<void>;

  /* ---------------- workspace / fs ---------------- */
  mountedDir: MountedDirectory | null;
  setMountedDir: (dir: MountedDirectory | null) => void;
  loadBundleFromFiles: (
    files: { ts?: string; json?: string; env?: string; tests?: string },
    fallbackName?: string,
  ) => void;
  replaceBundle: (bundle: ToolBundle) => void;

  /* ---------------- AI ---------------- */
  chat: ChatMessage[];
  appendChat: (m: Omit<ChatMessage, "id">) => string;
  updateChat: (id: string, patch: Partial<ChatMessage>) => void;
  claudeConfigured: boolean | null;
  setClaudeConfigured: (v: boolean | null) => void;

  /* ---------------- navigation ---------------- */
  activeTab: WorkspaceTab;
  setActiveTab: (t: WorkspaceTab) => void;
  /** Set by the Validator when a finding is clicked; consumed by Editor/Config. */
  focusRequest: { tab: WorkspaceTab; line?: number; field?: string; token: number } | null;
  requestFocus: (tab: WorkspaceTab, opts?: { line?: number; field?: string }) => void;
};

export type FileKind = "ts" | "json" | "env" | "tests";

const ToolContext = createContext<Store | null>(null);

export function ToolProvider({ children }: { children: ReactNode }) {
  const [bundle, setBundle] = useState<ToolBundle>(() => createDefaultBundle());
  const [configDraft, setConfigDraftState] = useState<Partial<ToolConfig>>(
    () => createDefaultBundle().config,
  );
  const [configOrigin, setConfigOrigin] = useState<ConfigOrigin>("tool");
  const [dirty, setDirty] = useState(false);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("Raw Data");
  const [focusRequest, setFocusRequest] = useState<Store["focusRequest"]>(null);
  const [mountedDir, setMountedDir] = useState<MountedDirectory | null>(null);
  const [claudeConfigured, setClaudeConfigured] = useState<boolean | null>(null);

  const [pythonRules, setPythonRules] = useState<PythonRule[]>(() =>
    BUILTIN_PYTHON_RULES.map((r) => ({
      id: r.id,
      filename: r.filename,
      source: r.source,
      builtin: true,
    })),
  );
  const [rubricMarkdown, setRubricMarkdownState] = useState(DEFAULT_LLM_RUBRIC);

  const [validation, setValidation] = useState<ValidationState>({
    python: [],
    llm: [],
    health: EMPTY_HEALTH,
    stale: true,
    pythonRunning: false,
    llmRunning: false,
    pythonError: null,
    llmError: null,
    lastRunAt: null,
  });

  const [runnerUrl, setRunnerUrlState] = useState(DEFAULT_RUNNER_URL);
  const [runnerStatus, setRunnerStatus] = useState<RunnerStatus>({ state: "unknown" });
  const [runnerResults, setRunnerResults] = useState<RunnerTestResult[]>([]);
  const [runnerBusy, setRunnerBusy] = useState(false);

  const [chat, setChat] = useState<ChatMessage[]>([
    {
      id: uid(),
      role: "assistant",
      text: "I am ready to help you build this tool. I can read the active tab, rewrite the execution logic, patch the config, add tests, and trigger the validators.",
    },
  ]);

  /* ------------------------------------------------------------------ */
  /* rehydrate                                                          */
  /* ------------------------------------------------------------------ */
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    const saved = loadWorkspace();
    if (!saved) return;
    try {
      const b: ToolBundle = {
        name: saved.bundle.name,
        logic: saved.bundle.logic,
        config: saved.bundle.config as Partial<ToolConfig>,
        configJson: saved.bundle.configJson as Partial<ToolConfig>,
        secrets: saved.bundle.secrets,
        jsonTests: saved.bundle.jsonTests as ToolTest[],
      };
      setBundle(b);
      setConfigDraftState(b.config);
      if (saved.pythonRules.length) {
        setPythonRules(
          saved.pythonRules.map((r) => ({
            id: r.filename,
            filename: r.filename,
            source: r.source,
            builtin: r.builtin,
          })),
        );
      }
      if (saved.rubricMarkdown) setRubricMarkdownState(saved.rubricMarkdown);
      if (WORKSPACE_TABS.includes(saved.activeTab as WorkspaceTab)) {
        setActiveTab(saved.activeTab as WorkspaceTab);
      }
    } catch {
      /* corrupt payload — fall back to the default bundle */
    }
  }, []);

  /* persist (debounced) */
  useEffect(() => {
    const handle = setTimeout(() => {
      const payload: PersistedWorkspace = {
        version: 1,
        bundle: {
          name: bundle.name,
          logic: bundle.logic,
          config: bundle.config,
          configJson: bundle.configJson,
          secrets: bundle.secrets,
          jsonTests: bundle.jsonTests,
        },
        pythonRules: pythonRules.map((r) => ({
          filename: r.filename,
          source: r.source,
          builtin: r.builtin,
        })),
        rubricMarkdown,
        activeTab,
        savedAt: new Date().toISOString(),
      };
      saveWorkspace(payload);
    }, 400);
    return () => clearTimeout(handle);
  }, [bundle, pythonRules, rubricMarkdown, activeTab]);

  /* ------------------------------------------------------------------ */
  /* derived                                                            */
  /* ------------------------------------------------------------------ */
  const rendered = useMemo(() => renderBundle(bundle), [bundle]);
  const names = useMemo(() => fileNames(bundle.name), [bundle.name]);

  const files = useMemo(
    () => [
      { name: names.ts, language: "typescript", content: rendered.ts, kind: "ts" as const },
      { name: names.json, language: "json", content: rendered.json, kind: "json" as const },
      { name: names.env, language: "ini", content: rendered.env, kind: "env" as const },
      { name: names.tests, language: "json", content: rendered.tests, kind: "tests" as const },
    ],
    [names, rendered],
  );

  const configDivergence = useMemo(
    () => configDiff(bundle.config, bundle.configJson),
    [bundle.config, bundle.configJson],
  );

  const declaredSecretKeys = useMemo(
    () => Object.keys(bundle.config.secrets ?? {}),
    [bundle.config.secrets],
  );

  const touch = useCallback(() => {
    setDirty(true);
    setValidation((v) => ({ ...v, stale: true }));
  }, []);

  /* ------------------------------------------------------------------ */
  /* bundle mutations                                                   */
  /* ------------------------------------------------------------------ */
  const setToolName = useCallback(
    (name: string) => {
      const clean = name.replace(/\s+/g, "_").replace(/[^A-Za-z0-9_.-]/g, "");
      setBundle((b) => renameTool(b, clean || b.name));
      setConfigDraftState((d) => {
        const next = clean || d.name;
        return next === undefined ? d : { ...d, name: next };
      });
      touch();
    },
    [touch],
  );

  const setLogic = useCallback(
    (logic: string) => {
      setBundle((b) => ({ ...b, logic }));
      touch();
    },
    [touch],
  );

  const setConfigDraft = useCallback((patch: Partial<ToolConfig>) => {
    setConfigDraftState((d) => ({ ...d, ...patch }));
  }, []);

  const replaceBundle = useCallback((next: ToolBundle) => {
    setBundle(next);
    setConfigDraftState(next.config);
    setConfigOrigin("tool");
    setRunnerResults([]);
    setValidation((v) => ({ ...v, python: [], llm: [], health: EMPTY_HEALTH, stale: true }));
    setDirty(false);
  }, []);

  const loadBundleFromFiles = useCallback(
    (
      incoming: { ts?: string; json?: string; env?: string; tests?: string },
      fallbackName?: string,
    ) => {
      const next = parseBundleFromFiles(incoming, fallbackName);
      replaceBundle(next);
    },
    [replaceBundle],
  );

  /* ------------------- synchronization matrix ------------------- */

  // [ 📥 Load from Tool ] — AST parse of the .ts, overwrite the form.
  const loadFormFromTool = useCallback(() => {
    setConfigDraftState(bundle.config);
    setConfigOrigin("tool");
  }, [bundle.config]);

  // [ 📥 Load from Config ] — read the standalone .json, overwrite the form.
  const loadFormFromConfig = useCallback(() => {
    setConfigDraftState(bundle.configJson);
    setConfigOrigin("config");
  }, [bundle.configJson]);

  // [ 💾 Save to Tool ] — inject the form state into the .ts baseConfig (AST).
  const saveFormToTool = useCallback(() => {
    setBundle((b) => ({ ...b, config: { ...configDraft } }));
    setConfigOrigin("tool");
    touch();
  }, [configDraft, touch]);

  // [ 💾 Save to Config ] — serialize the form state to the standalone .json.
  const saveFormToConfig = useCallback(() => {
    setBundle((b) => ({ ...b, configJson: { ...configDraft } }));
    setConfigOrigin("config");
    touch();
  }, [configDraft, touch]);

  // Tool JSON pane → .ts (AST rewrite of baseConfig).
  const saveToolJsonBuffer = useCallback(
    (json: string) => {
      try {
        const parsed = JSON.parse(json) as Partial<ToolConfig>;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return { ok: false, error: "Tool config must be a JSON object." };
        }
        setBundle((b) => ({ ...b, config: parsed }));
        setConfigDraftState(parsed);
        setConfigOrigin("tool");
        touch();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    [touch],
  );

  // Config JSON pane → .json (no AST).
  const saveConfigJsonBuffer = useCallback(
    (json: string) => {
      try {
        const parsed = JSON.parse(json) as Partial<ToolConfig>;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return { ok: false, error: "Config file must be a JSON object." };
        }
        setBundle((b) => ({ ...b, configJson: parsed }));
        setConfigDraftState(parsed);
        setConfigOrigin("config");
        touch();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    [touch],
  );

  const saveEmbeddedTests = useCallback(
    (tests: ToolTest[]) => {
      setBundle((b) => ({ ...b, config: { ...b.config, tests } }));
      setConfigDraftState((d) => ({ ...d, tests }));
      touch();
    },
    [touch],
  );

  const saveJsonTests = useCallback(
    (json: string) => {
      try {
        const parsed = JSON.parse(json) as unknown;
        if (!Array.isArray(parsed)) {
          return { ok: false, error: "The external test file must contain a JSON array." };
        }
        setBundle((b) => ({ ...b, jsonTests: parsed as ToolTest[] }));
        touch();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    [touch],
  );

  /* ---------------------------- secrets ---------------------------- */
  const setSecretValue = useCallback(
    (key: string, value: string) => {
      setBundle((b) => ({ ...b, secrets: { ...b.secrets, [key]: value } }));
      touch();
    },
    [touch],
  );

  const loadEnvText = useCallback(
    (text: string) => {
      const incoming = parseEnv(text);
      const declared = Object.keys(bundle.config.secrets ?? {});
      const { merged, filled, ignored } = mergeEnvNonDestructive(
        bundle.secrets,
        incoming,
        declared,
      );
      setBundle((b) => ({ ...b, secrets: merged }));
      if (filled.length) touch();
      return { filled, ignored };
    },
    [bundle.config.secrets, bundle.secrets, touch],
  );

  /* --------------------------- validator --------------------------- */
  const setRubricMarkdown = useCallback((md: string) => {
    setRubricMarkdownState(md);
    setValidation((v) => ({ ...v, stale: true }));
  }, []);

  const addPythonRule = useCallback((filename: string) => {
    const clean = filename.endsWith(".py") ? filename : `${filename}.py`;
    const id = uid();
    setPythonRules((rs) => [
      ...rs,
      {
        id,
        filename: clean,
        builtin: false,
        source: [
          "def validate(ts_code: str, config_json: dict):",
          '    """Return (True, message) to pass, (False, message) to fail."""',
          '    return True, "not implemented yet"',
          "",
        ].join("\n"),
      },
    ]);
    return id;
  }, []);

  const updatePythonRule = useCallback((id: string, source: string) => {
    setPythonRules((rs) => rs.map((r) => (r.id === id ? { ...r, source } : r)));
    setValidation((v) => ({ ...v, stale: true }));
  }, []);

  const removePythonRule = useCallback((id: string) => {
    setPythonRules((rs) => rs.filter((r) => r.id !== id));
    setValidation((v) => ({ ...v, stale: true }));
  }, []);

  const runPythonValidations = useCallback(async () => {
    setValidation((v) => ({ ...v, pythonRunning: true, pythonError: null }));
    try {
      const { createPythonEngine } = await import("@/lib/tgs/pythonEngine");
      const engine = createPythonEngine();
      const results = await engine.run(
        rendered.ts,
        bundle.config,
        pythonRules.map((r) => ({ filename: r.filename, source: r.source })),
      );
      setValidation((v) => {
        const health = computeHealth(results, v.llm);
        return {
          ...v,
          python: results,
          health,
          pythonRunning: false,
          stale: false,
          lastRunAt: new Date().toISOString(),
        };
      });
    } catch (e) {
      setValidation((v) => ({
        ...v,
        pythonRunning: false,
        pythonError: (e as Error).message,
      }));
    }
  }, [rendered.ts, bundle.config, pythonRules]);

  const runLlmValidation = useCallback(async () => {
    setValidation((v) => ({ ...v, llmRunning: true, llmError: null }));
    try {
      const { postLlmValidation } = await import("@/rpc/tgsServerFns");
      const res = await postLlmValidation({
        data: {
          rubricMarkdown,
          tsCode: rendered.ts,
          configJson: bundle.configJson,
        },
      });
      if (!res.ok) {
        setValidation((v) => ({ ...v, llmRunning: false, llmError: res.error }));
        return;
      }
      setValidation((v) => {
        const health = computeHealth(v.python, res.results);
        return {
          ...v,
          llm: res.results,
          health,
          llmRunning: false,
          lastRunAt: new Date().toISOString(),
        };
      });
    } catch (e) {
      setValidation((v) => ({ ...v, llmRunning: false, llmError: (e as Error).message }));
    }
  }, [rubricMarkdown, rendered.ts, bundle.configJson]);

  const runAllValidations = useCallback(async () => {
    await Promise.all([runPythonValidations(), runLlmValidation()]);
  }, [runPythonValidations, runLlmValidation]);

  /* ----------------------------- runner ----------------------------- */
  const setRunnerUrl = useCallback((url: string) => {
    setRunnerUrlState(url.replace(/\/+$/, ""));
    setRunnerStatus({ state: "unknown" });
  }, []);

  const checkRunner = useCallback(async () => {
    const { probeRunner } = await import("@/lib/tgs/runnerClient");
    setRunnerStatus(await probeRunner(runnerUrl));
  }, [runnerUrl]);

  const runAllTests = useCallback(async () => {
    setRunnerBusy(true);
    try {
      const { runBundleTests } = await import("@/lib/tgs/runnerClient");
      const out = await runBundleTests({
        baseUrl: runnerUrl,
        toolName: bundle.name,
        code: rendered.ts,
        env: bundle.secrets,
        tests: allTests(bundle),
      });
      setRunnerStatus(out.status);
      setRunnerResults(out.results);
    } finally {
      setRunnerBusy(false);
    }
  }, [runnerUrl, bundle, rendered.ts]);

  const runSingleTest = useCallback(
    async (source: "ts" | "json", index: number) => {
      const list = allTests(bundle);
      const target = list.filter((t) => t.source === source)[index];
      if (!target) return;
      setRunnerBusy(true);
      try {
        const { runBundleTests } = await import("@/lib/tgs/runnerClient");
        const out = await runBundleTests({
          baseUrl: runnerUrl,
          toolName: bundle.name,
          code: rendered.ts,
          env: bundle.secrets,
          tests: [target],
        });
        setRunnerStatus(out.status);
        setRunnerResults((prev) => {
          const next = [...prev];
          const first = out.results[0];
          if (!first) return prev;
          const at = next.findIndex((r) => r.source === source && r.name === first.name);
          if (at >= 0) next[at] = first;
          else next.push(first);
          return next;
        });
      } finally {
        setRunnerBusy(false);
      }
    },
    [bundle, runnerUrl, rendered.ts],
  );

  /* ------------------------------- AI ------------------------------- */
  const appendChat = useCallback((m: Omit<ChatMessage, "id">) => {
    const id = uid();
    setChat((c) => [...c, { ...m, id }]);
    return id;
  }, []);

  const updateChat = useCallback((id: string, patch: Partial<ChatMessage>) => {
    setChat((c) => c.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }, []);

  /* --------------------------- navigation --------------------------- */
  const requestFocus = useCallback(
    (tab: WorkspaceTab, opts?: { line?: number; field?: string }) => {
      setActiveTab(tab);
      setFocusRequest({
        tab,
        ...(opts?.line === undefined ? {} : { line: opts.line }),
        ...(opts?.field === undefined ? {} : { field: opts.field }),
        token: Date.now(),
      });
    },
    [],
  );

  const value: Store = {
    bundle,
    files,
    dirty,
    markSaved: () => setDirty(false),
    setToolName,
    setLogic,
    setConfigDraft,
    configDraft,
    configOrigin,
    configDivergence,
    loadFormFromTool,
    loadFormFromConfig,
    saveFormToTool,
    saveFormToConfig,
    saveToolJsonBuffer,
    saveConfigJsonBuffer,
    saveEmbeddedTests,
    saveJsonTests,
    setSecretValue,
    loadEnvText,
    declaredSecretKeys,
    pythonRules,
    addPythonRule,
    updatePythonRule,
    removePythonRule,
    rubricMarkdown,
    setRubricMarkdown,
    validation,
    runPythonValidations,
    runLlmValidation,
    runAllValidations,
    runnerUrl,
    setRunnerUrl,
    runnerStatus,
    runnerResults,
    runnerBusy,
    checkRunner,
    runAllTests,
    runSingleTest,
    mountedDir,
    setMountedDir,
    loadBundleFromFiles,
    replaceBundle,
    chat,
    appendChat,
    updateChat,
    claudeConfigured,
    setClaudeConfigured,
    activeTab,
    setActiveTab,
    focusRequest,
    requestFocus,
  };

  return <ToolContext.Provider value={value}>{children}</ToolContext.Provider>;
}

export function useTool(): Store {
  const ctx = useContext(ToolContext);
  if (!ctx) throw new Error("useTool must be used inside ToolProvider");
  return ctx;
}

/** Re-exported so screens do not need to reach into the lib layer for these. */
export { extractTool, recombineTool, allTests };
