# TGS Module Specification: Runner Screen

This document provides the complete functional, architectural, and visual specifications for the **[ Runner ]** screen within the **Tool Generator Server (TGS)** workspace.

The Runner operates as an HTTP-driven execution sandbox. It ensures that all tests run in an environment that perfectly mirrors the production Simple Tools Server (STS), enforcing the core principle that tools act strictly as data APIs serving predictable JSON data over HTTP.

---

## 1. Sub-Navigation & Screen Architecture

To efficiently manage both embedded configurations and extensive external test suites, the Runner tab is divided into three distinct sub-views accessed via a secondary navigation bar:

* **`[ Dashboard ]`**: A unified execution matrix combining tests from all sources, displaying real-time success or failure metrics.
* **`[ Tool TS Tests ]`**: A read/write view displaying the embedded test suite defined directly within the tool's `config.tests` array.


* **`[ JSON Tests ]`**: A dedicated Monaco editor for managing extended test suites stored in the external `[tool_name]_tests.json` file.



---

## 2. Sub-Screen 1: [ Dashboard ]

The Dashboard provides a consolidated view of all test executions. When triggered, the TGS frontend maps over all test definitions, translates them into raw HTTP `fetch()` calls, and fires them sequentially at the local Deno child process.

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
|  `.json` file.               |  Source      | Test Name                | Status | Details   |
|                              |  ----------------------------------------------------------- |
|  Test "Divide by Zero"       |  📄 calc.ts  | Valid Addition           | [✅ 200] {"res...  |
|  failed. It expected a       |  📄 calc.ts  | Divide by Zero Error     | [❌ 500] Exp 400   |
|  400 status but got 500.     |  📦 ext.json | Missing Payload          | [✅ 400] {"err...  |
|                              |                                                              |
|  Want me to fix the          |                                                              |
|  error handler?              |                                                              |
|  [ Type a command...    ] [^]|                                                              |
+=============================================================================================+

```

### Execution Engine Logic

* **Zero-Trust Parity:** The frontend never executes the TypeScript code directly. It strictly sends HTTP POST requests to the local Deno proxy server.
* **Context Injection:** The local server dynamically builds the `ToolExecutionContext` per request, injecting testing values mapped from the **[ Secrets ]** tab into `context.env`.


* **Result Comparison:** The engine compares the actual HTTP responses against the expectations defined in the test, verifying if the tool correctly returns standard HTTP 4xx/5xx responses for errors.



---

## 3. Test Definitions & Tool Contract

Tests in the STS ecosystem follow a strict interface defined in the `ToolContract.ts` file.

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

* **`name`**: A human-readable identifier for the test case.


* **`payload`**: The raw JSON object that will be sent as the HTTP request body.


* **`expect`**: The assertion object used to validate the tool's output. It can check the HTTP `status` code and verify if the response JSON body `hasKey`.



---

## 4. Sub-Screens 2 & 3: File-Based Test Editors

TGS splits tests into two storage locations to prevent source code bloat while allowing for exhaustive edge-case testing.

### 4.1 [ Tool TS Tests ] (Embedded Suite)

This view allows developers to manage the primary set of tests directly embedded within the `tests` array of the `ToolConfig`. These tests are extracted from `[tool_name].ts` via AST parsing.

**Example Extracted Data (from `calc.ts`):**

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
> 
> 

### 4.2 [ JSON Tests ] (Extended Suite)

This view provides a direct Monaco JSON editor for the `[tool_name]_tests.json` file. It enables developers to build massive test banks decoupled from the main execution logic.

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
