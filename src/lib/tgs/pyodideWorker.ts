// Pyodide Web Worker: runs the deterministic validator rules off the main
// thread. Spec: docs/llm_generated/14-screen-validator.md §3.4.
//
// Message protocol (host -> worker):
//   { action: "RUN_RULES", tsCode, configJson, rules: [{ filename, source }] }
//   { action: "PING" }
// Worker -> host:
//   { type: "READY" } | { type: "PROGRESS", message }
//   { type: "RESULT", results } | { type: "ERROR", message } | { type: "PONG" }
//
// Rules run sequentially, each in a fresh Python namespace. A rule that fails
// to compile or raises is reported as a failure with `error` set; it never
// aborts the batch.

import { loadPyodide, type PyodideInterface } from "pyodide";

/**
 * Must match the installed `pyodide` package version (node_modules/pyodide/
 * package.json) — the runtime refuses a mismatched wasm/stdlib bundle.
 */
export const PYODIDE_VERSION = "314.0.6";
export const PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

export type PythonRuleDefinition = { filename: string; source: string };

export type PythonRuleResultMessage = {
  filename: string;
  passed: boolean;
  message: string;
  error?: string;
  durationMs: number;
};

export type WorkerRequest =
  | {
      action: "RUN_RULES";
      tsCode: string;
      configJson: unknown;
      rules: PythonRuleDefinition[];
      requestId?: string;
    }
  | { action: "PING"; requestId?: string };

export type WorkerResponse =
  | { type: "READY" }
  | { type: "PONG"; requestId?: string }
  | { type: "PROGRESS"; message: string }
  | { type: "RESULT"; results: PythonRuleResultMessage[]; requestId?: string }
  | { type: "ERROR"; message: string; requestId?: string };

/** Worker global, typed narrowly so this file still compiles under `lib: DOM`. */
const ctx = self as unknown as {
  postMessage(message: WorkerResponse): void;
  onmessage: ((event: { data: unknown }) => void) | null;
};

/**
 * Python side of the bridge: compiles one rule in a private namespace, calls
 * `validate(ts_code, config_json)` and hands back a JSON string so no PyProxy
 * has to cross the boundary.
 */
const PYTHON_DRIVER = `
import json
import traceback


def _tgs_run_rule(filename, source, ts_code, config_json_text):
    try:
        config_json = json.loads(config_json_text)
    except Exception:
        config_json = {}
    namespace = {"__name__": "__tgs_rule__", "__file__": filename, "__builtins__": __builtins__}
    try:
        compiled = compile(source, filename, "exec")
        exec(compiled, namespace)
    except BaseException:
        return json.dumps({
            "passed": False,
            "message": "Rule failed to compile.",
            "error": traceback.format_exc(),
        })

    validate = namespace.get("validate")
    if not callable(validate):
        return json.dumps({
            "passed": False,
            "message": "Rule does not define validate(ts_code, config_json).",
            "error": "MissingEntryPoint: expected a top-level 'validate' function.",
        })

    try:
        outcome = validate(ts_code, config_json)
    except BaseException:
        return json.dumps({
            "passed": False,
            "message": "Rule raised while validating.",
            "error": traceback.format_exc(),
        })

    if isinstance(outcome, bool):
        return json.dumps({"passed": outcome, "message": ""})

    if isinstance(outcome, (tuple, list)) and len(outcome) >= 1:
        passed = bool(outcome[0])
        message = "" if len(outcome) < 2 or outcome[1] is None else str(outcome[1])
        return json.dumps({"passed": passed, "message": message})

    return json.dumps({
        "passed": False,
        "message": "Rule returned an unexpected value.",
        "error": "ContractError: validate() must return (bool, str), got %r" % (outcome,),
    })
`;

let pyodidePromise: Promise<PyodideInterface> | null = null;

async function getPyodide(): Promise<PyodideInterface> {
  if (pyodidePromise === null) {
    pyodidePromise = (async () => {
      ctx.postMessage({ type: "PROGRESS", message: "Loading Python runtime (Pyodide)…" });
      const pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
      pyodide.runPython(PYTHON_DRIVER);
      ctx.postMessage({ type: "READY" });
      return pyodide;
    })().catch((error: unknown) => {
      pyodidePromise = null;
      throw error;
    });
  }
  return pyodidePromise;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

function safeStringifyConfig(configJson: unknown): string {
  try {
    const text = JSON.stringify(configJson ?? {});
    return text === undefined ? "{}" : text;
  } catch {
    return "{}";
  }
}

async function runRules(
  tsCode: string,
  configJson: unknown,
  rules: PythonRuleDefinition[],
): Promise<PythonRuleResultMessage[]> {
  const pyodide = await getPyodide();
  // Bracket access: `globals` is typed with an index signature and the repo
  // enables noPropertyAccessFromIndexSignature.
  const runner = pyodide.globals["get"]("_tgs_run_rule") as
    ((filename: string, source: string, tsCode: string, configText: string) => string) | undefined;

  if (typeof runner !== "function") {
    throw new Error("Pyodide driver is missing; _tgs_run_rule was not defined.");
  }

  const configText = safeStringifyConfig(configJson);
  const results: PythonRuleResultMessage[] = [];

  for (const rule of rules) {
    const started = Date.now();
    ctx.postMessage({ type: "PROGRESS", message: `Running ${rule.filename}…` });
    try {
      const raw = runner(rule.filename, rule.source, tsCode, configText);
      const parsed = JSON.parse(raw) as {
        passed?: unknown;
        message?: unknown;
        error?: unknown;
      };
      const result: PythonRuleResultMessage = {
        filename: rule.filename,
        passed: parsed.passed === true,
        message: typeof parsed.message === "string" ? parsed.message : "",
        durationMs: Date.now() - started,
      };
      if (typeof parsed.error === "string" && parsed.error !== "") {
        result.error = parsed.error;
      }
      results.push(result);
    } catch (error) {
      // A host-side failure (JSON, PyProxy, out of memory) must not abort the
      // remaining rules either.
      results.push({
        filename: rule.filename,
        passed: false,
        message: "Rule execution failed inside the Python worker.",
        error: errorMessage(error),
        durationMs: Date.now() - started,
      });
    }
  }

  return results;
}

ctx.onmessage = (event: { data: unknown }) => {
  const request = event.data as WorkerRequest | null;
  if (request === null || typeof request !== "object") return;

  if (request.action === "PING") {
    const pong: WorkerResponse =
      request.requestId === undefined
        ? { type: "PONG" }
        : { type: "PONG", requestId: request.requestId };
    ctx.postMessage(pong);
    return;
  }

  if (request.action !== "RUN_RULES") return;

  const { tsCode, configJson, rules, requestId } = request;
  void runRules(tsCode ?? "", configJson, Array.isArray(rules) ? rules : [])
    .then((results) => {
      ctx.postMessage(
        requestId === undefined
          ? { type: "RESULT", results }
          : { type: "RESULT", results, requestId },
      );
    })
    .catch((error: unknown) => {
      ctx.postMessage(
        requestId === undefined
          ? { type: "ERROR", message: errorMessage(error) }
          : { type: "ERROR", message: errorMessage(error), requestId },
      );
    });
};
