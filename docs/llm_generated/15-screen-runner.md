# TGS Screen Specification: [ Runner ]

**Source:** `docs/human_only/runner_page.md`, reconciled per `00-INDEX.md`.

The Runner is an HTTP-driven execution sandbox. It ensures all tests run in an environment that mirrors the production Simple Tools Server (STS), enforcing the core principle that tools act strictly as data APIs serving predictable JSON over HTTP.

---

## 1. Sub-Navigation & Screen Architecture

To manage both embedded configurations and extensive external test suites, the Runner tab is divided into three sub-views accessed via a secondary navigation bar:

* **`[ Dashboard ]`** — a unified execution matrix combining tests from all sources, displaying real-time success or failure metrics.
* **`[ Tool TS Tests ]`** — a read/write view of the embedded test suite defined in the tool's `config.tests` array.
* **`[ JSON Tests ]`** — a dedicated Monaco editor for the external `[tool_name]_tests.json` file.

---

## 2. Sub-Screen 1: [ Dashboard ]

The Dashboard provides a consolidated view of all test executions. When triggered, the TGS frontend maps over all test definitions, translates them into raw HTTP `fetch()` calls, and fires them sequentially at the local Deno child process (e.g. `http://localhost:8080`).

### ASCII Layout

```text
+=============================================================================================+
| [📂 Load File] [📁 Select Local Folder ▼] | [ ✏️ calc ]            | [ 💾 Save ] [ 🚀 Publish ]|
+---------------------------------------------------------------------------------------------+
| [ Raw Data ] [ Editor ] [ Config ] [ Secrets ] [ Validator ] [ Runner ]                     |
+---------------------------------------------------------------------------------------------+
|                              |  🚀 RUNNER: [ Dashboard ] [ Tool TS Tests ] [ JSON Tests ]   |
|  🤖 AI Assistant             | -----------------------------------------------------------  |
|  --------------------------  |  [ ▶ Run All Tests ]  [ ↻ Restart Local Deno Server ]        |
|                              | -----------------------------------------------------------  |
|  You have 2 tests in your    |  [ Execution Results Dashboard ]                             |
|  `.ts` file and 1 in your    |                                                              |
|  `.json` file.               |  Source        | Test Name             | Status | Details    |
|                              |  ----------------------------------------------------------- |
|  Test "Divide by Zero"       |  📄 calc.ts    | Valid Addition        | [✅ 200] {"res...   |
|  failed. It expected a       |  📄 calc.ts    | Divide by Zero Error  | [❌ 500] Exp 400    |
|  400 status but got 500.     |  📦 _tests.json| Missing Payload       | [✅ 400] {"err...   |
|                              |                                                              |
|  Want me to fix the          |                                                              |
|  error handler?              |                                                              |
|  [ Type a command...    ] [^]|                                                              |
+=============================================================================================+
```

### Execution Engine Logic

* **Zero-Trust Parity** — the frontend never executes the TypeScript code directly. It strictly sends HTTP POST requests to the local Deno proxy server.
* **Context Injection** — the local server dynamically builds the `ToolExecutionContext` per request, injecting testing values mapped from the **[ Secrets ]** tab into `context.env`.
* **Result Comparison** — the engine compares actual HTTP responses against the expectations defined in each test, verifying the tool correctly returns standard HTTP 4xx/5xx responses for errors rather than throwing.
* **Source Attribution** — each row records whether the test came from the `.ts` config block or the external `_tests.json` file, so a failure is traceable to the file that must change.

---

## 3. Test Definitions & Tool Contract

Tests in the STS ecosystem follow a strict interface defined in `ToolContract.ts`.

### The `ToolTest` Interface

Every test, whether embedded in the TypeScript file or stored in the external JSON file, must conform to this schema:

```typescript
/** Defines an HTTP-driven test case for the tool. */
export interface ToolTest {
  name: string;
  payload: any;
  expect: {
    status?: number;
    hasKey?: string;
  };
}
```

* **`name`** — a human-readable identifier for the test case.
* **`payload`** — the raw JSON object sent as the HTTP request body.
* **`expect`** — the assertion object used to validate the tool's output. It can check the HTTP `status` code and verify that the response JSON body `hasKey`. Both fields are optional; a test with neither always passes and should be treated as an authoring mistake.

---

## 4. Sub-Screens 2 & 3: File-Based Test Editors

TGS splits tests into two storage locations to prevent source code bloat while allowing exhaustive edge-case testing.

### 4.1 [ Tool TS Tests ] (Embedded Suite)

Manages the primary set of tests embedded in the `tests` array of the `ToolConfig`. These are extracted from `[tool_name].ts` via AST parsing.

**Example extracted data (from `calc.ts`):**

```json
[
  {
    "name": "Valid Addition",
    "payload": { "a": 5, "b": 3, "operation": "add" },
    "expect": { "status": 200, "hasKey": "result" }
  },
  {
    "name": "Divide by Zero Error Handling",
    "payload": { "a": 10, "b": 0, "operation": "divide" },
    "expect": { "status": 400, "hasKey": "error" }
  }
]
```

> **Note:** Saving changes in this view uses the AST engine to inject the updated JSON array back into the `config` block of the `.ts` file without disturbing the execution logic.

### 4.2 [ JSON Tests ] (Extended Suite)

A direct Monaco JSON editor for the `[tool_name]_tests.json` file, for building large test banks decoupled from the main execution logic.

#### ASCII Layout

```text
+=============================================================================================+
|                              |  🚀 RUNNER: [ Dashboard ] [ Tool TS Tests ] [ JSON Tests ]   |
|  🤖 AI Assistant             | -----------------------------------------------------------  |
|  --------------------------  |  [ 💾 Save to Tests JSON ]                                   |
|                              | -----------------------------------------------------------  |
|  You are editing the         |   1 [                                                        |
|  external JSON test suite.   |   2   {                                                      |
|                              |   3     "name": "Missing Payload",                           |
|  These tests will run        |   4     "payload": {},                                       |
|  alongside the embedded      |   5     "expect": {                                          |
|  TS tests on the Dashboard.  |   6       "status": 400,                                     |
|                              |   7       "hasKey": "error"                                  |
|  [ Type a command...    ] [^]|   8     }                                                    |
|                              |   9   }                                                      |
|                              |  10 ]                                                        |
+=============================================================================================+
```

> **Note:** Saving here directly updates the external `[tool_name]_tests.json` file in the global state, immediately syncing with the **[ Raw Data ]** tab.
