// Main-thread client for the Pyodide validator worker.
// Spec: docs/llm_generated/14-screen-validator.md §3.4.
//
// The worker is spawned lazily and kept warm across runs (loading Pyodide
// costs several seconds). Runs are serialized, and a run that exceeds
// RUN_TIMEOUT_MS rejects with a clear error rather than hanging the UI.
//
// There is deliberately no "pure JS fallback": if no Worker implementation
// exists, `isPyodideAvailable()` resolves false so the UI can render
// "Python engine unavailable in this environment". Fabricating passing results
// would silently defeat the publish gate.

export type PythonRuleResult = {
  filename: string;
  passed: boolean;
  message: string;
  error?: string;
  durationMs: number;
};

export type PythonRuleDef = { filename: string; source: string };

export type PythonEngineStatus = "idle" | "loading" | "ready" | "running" | "error" | "disposed";

export type PythonEngineProgress = {
  status: PythonEngineStatus;
  message: string;
};

export type PythonEngineOptions = {
  /** Called on runtime load and per-rule progress messages from the worker. */
  onProgress?: (progress: PythonEngineProgress) => void;
  /** Overrides the default 120s per-run timeout (used by tests). */
  timeoutMs?: number;
};

export type PythonEngine = {
  run(
    tsCode: string,
    configJson: unknown,
    rules: readonly PythonRuleDef[],
  ): Promise<PythonRuleResult[]>;
  dispose(): void;
  readonly status: PythonEngineStatus;
};

export const RUN_TIMEOUT_MS = 120_000;

type WorkerResponse =
  | { type: "READY" }
  | { type: "PONG"; requestId?: string }
  | { type: "PROGRESS"; message: string }
  | { type: "RESULT"; results: PythonRuleResult[]; requestId?: string }
  | { type: "ERROR"; message: string; requestId?: string };

export const PYTHON_ENGINE_UNAVAILABLE =
  "Python engine unavailable in this environment: Web Workers are not supported here, so the deterministic rules cannot run.";

/**
 * Whether the deterministic engine can run at all. Resolves false in
 * environments without Web Workers (SSR, some test runners) so callers can
 * show a clear state instead of faking results.
 */
export function isPyodideAvailable(): Promise<boolean> {
  return Promise.resolve(typeof Worker !== "undefined");
}

export function createPythonEngine(options: PythonEngineOptions = {}): PythonEngine {
  const timeoutMs = options.timeoutMs ?? RUN_TIMEOUT_MS;
  const onProgress = options.onProgress;

  let worker: Worker | null = null;
  let status: PythonEngineStatus = "idle";
  let queue: Promise<unknown> = Promise.resolve();
  let requestCounter = 0;

  function setStatus(next: PythonEngineStatus, message: string): void {
    status = next;
    onProgress?.({ status: next, message });
  }

  function ensureWorker(): Worker {
    if (worker !== null) return worker;
    if (typeof Worker === "undefined") {
      throw new Error(PYTHON_ENGINE_UNAVAILABLE);
    }
    setStatus("loading", "Starting the Python worker…");
    worker = new Worker(new URL("./pyodideWorker.ts", import.meta.url), {
      type: "module",
    });
    worker.onerror = (event: ErrorEvent) => {
      setStatus("error", event.message || "The Python worker crashed.");
    };
    return worker;
  }

  function runOnce(
    tsCode: string,
    configJson: unknown,
    rules: readonly PythonRuleDef[],
  ): Promise<PythonRuleResult[]> {
    if (status === "disposed") {
      return Promise.reject(new Error("Python engine has been disposed."));
    }
    if (rules.length === 0) return Promise.resolve([]);

    let active: Worker;
    try {
      active = ensureWorker();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }

    requestCounter += 1;
    const requestId = `run-${requestCounter}`;

    return new Promise<PythonRuleResult[]>((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        clearTimeout(timer);
        active.removeEventListener("message", handleMessage);
      };

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const timer = setTimeout(() => {
        finish(() => {
          // A wedged Pyodide run cannot be interrupted from outside; drop the
          // worker so the next run starts from a clean runtime.
          terminate();
          setStatus("error", `Python validation timed out after ${timeoutMs} ms.`);
          reject(
            new Error(
              `Python validation timed out after ${timeoutMs} ms. The Pyodide runtime was restarted; try running fewer or simpler rules.`,
            ),
          );
        });
      }, timeoutMs);

      function handleMessage(event: MessageEvent): void {
        const data = event.data as WorkerResponse | null;
        if (data === null || typeof data !== "object") return;

        switch (data.type) {
          case "READY":
            setStatus("running", "Python runtime ready.");
            return;
          case "PROGRESS":
            onProgress?.({ status: status === "idle" ? "loading" : status, message: data.message });
            return;
          case "RESULT":
            if (data.requestId !== undefined && data.requestId !== requestId) return;
            finish(() => {
              setStatus("ready", "Validation complete.");
              resolve(data.results);
            });
            return;
          case "ERROR":
            if (data.requestId !== undefined && data.requestId !== requestId) return;
            finish(() => {
              setStatus("error", data.message);
              reject(new Error(data.message));
            });
            return;
          case "PONG":
            return;
          default:
            return;
        }
      }

      active.addEventListener("message", handleMessage);
      setStatus(
        status === "idle" || status === "loading" ? "loading" : "running",
        "Running deterministic rules…",
      );
      active.postMessage({
        action: "RUN_RULES",
        tsCode,
        configJson,
        rules: rules.map((rule) => ({ filename: rule.filename, source: rule.source })),
        requestId,
      });
    });
  }

  function terminate(): void {
    if (worker !== null) {
      worker.onerror = null;
      worker.terminate();
      worker = null;
    }
  }

  return {
    run(tsCode, configJson, rules) {
      // Serialize runs: one Pyodide interpreter, one batch at a time.
      const next = queue.then(
        () => runOnce(tsCode, configJson, rules),
        () => runOnce(tsCode, configJson, rules),
      );
      queue = next.catch(() => undefined);
      return next;
    },
    dispose() {
      terminate();
      setStatus("disposed", "Python engine disposed.");
    },
    get status() {
      return status;
    },
  };
}
