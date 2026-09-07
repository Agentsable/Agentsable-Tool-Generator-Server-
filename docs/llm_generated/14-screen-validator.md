# TGS Screen Specification: [ Validator ]

**Source:** `docs/human_only/validator_page.md`, reconciled per `00-INDEX.md`.

The Validator is the quality assurance gate for tools before deployment to the production **Simple Tools Server (STS)** at `sts.agentsable.com`. It enforces both deterministic Cloudflare Workers (WinterCG) runtime boundaries and qualitative AI-agent authoring guidelines using a hybrid dual-engine architecture:

1. **Deterministic Static Analysis** — Python scripts executing entirely in the browser via WebAssembly (**Pyodide**).
2. **Qualitative Heuristic Review** — a system prompt rubric written in Markdown and evaluated by Claude via `@anthropic-ai/claude-agent-sdk`.

---

## 1. Sub-Navigation & Screen Architecture

The Validator tab is divided into three sub-views accessible via a secondary navigation bar:

* **`[ Dashboard ]`** — aggregated reporting centre: overall tool health, pass/fail summaries, and detailed findings.
* **`[ Python Rules ]`** — script management console with an interactive list of deterministic checks and an accordion Monaco editor (restricted to **one active rule at a time**).
* **`[ LLM Rules ]`** — a full Markdown editor defining the qualitative rubric and prompt instructions sent to the Claude Agent SDK, enforcing strict JSON output.

---

## 2. Sub-Screen 1: [ Dashboard ]

### 2.1 Purpose

Aggregates the execution results of both the Pyodide static analysis and the Claude heuristic review. Provides a health score and maps errors and warnings directly to line numbers and configuration fields.

### 2.2 ASCII Layout

```text
+=============================================================================================+
| [📂 Load File] [📁 Select Local Folder ▼] | [ ✏️ weather_fetcher ] | [ 💾 Save ] [ 🚀 Publish ]|
+---------------------------------------------------------------------------------------------+
| [ Raw Data ] [ Editor ] [ Config ] [ Secrets ] [ Validator ] [ Runner ]                     |
+---------------------------------------------------------------------------------------------+
|                              |  🛡️ VALIDATOR: [ Dashboard ] [ Python Rules ] [ LLM Rules ]  |
|  🤖 AI Assistant             | -----------------------------------------------------------  |
|  --------------------------  |  [ ▶ Run All Validations ]    Health Score: [ 70 / 100 ]     |
|                              |  Status: ⚠️ 1 Failure, 1 Warning                             |
|  The static analysis         | -----------------------------------------------------------  |
|  passed, but the LLM         |  ▼ DETERMINISTIC CHECKS (Python Wasm)                        |
|  heuristic flagged your      |    [✅ PASS] rule_no_global_fetch.py                         |
|  actionable advice.          |    [✅ PASS] rule_has_required_exports.py                    |
|                              |    [❌ FAIL] rule_cf_worker_compat.py                        |
|  "CITY_NOT_FOUND" does       |       Line 14: Found prohibited module 'node:path'. CF       |
|  not tell the agent what     |       Workers isolates do not support Node.js built-ins.     |
|  payload changes to make.    |    [✅ PASS] rule_dependencies_declared.py                   |
|                              |    [✅ PASS] rule_network_allowlist.py                       |
|  Want me to fix this         |                                                              |
|  in the Config tab?          |  ▼ HEURISTIC CHECKS (Claude Agent SDK)                       |
|                              |    [✅ PASS] Clear & Concise Description                     |
|  [ Auto-Fix Advice ]         |    [⚠️ WARN] Actionable Error Advice                         |
|                              |       Error 'CITY_NOT_FOUND' lacks dynamic guidance.         |
|                              |       Advise agent to inspect input and retry.               |
|  [ Type a command...    ] [^]|    [✅ PASS] Sensible Rate Limits                            |
+=============================================================================================+
```

### 2.3 UI Elements & Underlying Logic

* **`[ ▶ Run All Validations ]`** — dispatches the tool bundle concurrently to both engines:
  1. Compiles and executes all Python rules sequentially in the Pyodide WebAssembly worker.
  2. Sends the tool's code, configuration schema, and the Markdown rubric to Claude via `@anthropic-ai/claude-agent-sdk`.

* **Health Score Widget** — a weighted calculation from 0 to 100:
  * Deterministic failures (Python Wasm): **−25 points each** (blocker for publishing).
  * Qualitative failures (Claude Agent SDK): **−15 points each**.
  * Warnings (either engine): **−5 points each**.
  * A tool cannot be published via `[ 🚀 Publish ]` unless the score is **≥ 90** *and* zero deterministic failures exist.

  The dashboard above shows the arithmetic: 1 deterministic failure (−25) + 1 warning (−5) = **70 / 100**.

* **Findings Tree** — categorized by engine type. Clicking any failing finding highlights the exact line in the **[ Editor ]** or the specific field in the **[ Config ]** tab.

---

## 3. Sub-Screen 2: [ Python Rules ] (Wasm Engine)

### 3.1 Purpose

Manages the deterministic rule set that runs in the client's browser using **Pyodide**. These rules analyze the tool's TypeScript source and inspect its JSON configuration to enforce Cloudflare Workers and STS runtime constraints.

### 3.2 ASCII Layout

```text
+=============================================================================================+
| [📂 Load File] [📁 Select Local Folder ▼] | [ ✏️ weather_fetcher ] | [ 💾 Save ] [ 🚀 Publish ]|
+---------------------------------------------------------------------------------------------+
| [ Raw Data ] [ Editor ] [ Config ] [ Secrets ] [ Validator ] [ Runner ]                     |
+---------------------------------------------------------------------------------------------+
|                              |  🛡️ VALIDATOR: [ Dashboard ] [ Python Rules ] [ LLM Rules ]  |
|  🤖 AI Assistant             | -----------------------------------------------------------  |
|  --------------------------  | [ + New Rule ] [ 💾 Save Rule ] [ ▶ Run Python Checks ]      |
|                              | -----------------------------------------------------------  |
|  You are editing the         |  [✅ Pass] rule_no_global_fetch.py                           |
|  CF Worker compatibility     | -----------------------------------------------------------  |
|  rule.                       |  [❌ Fail] rule_cf_worker_compat.py                          |
|                              |    1 import re                                               |
|  Only one rule can be open   |    2                                                         |
|  for editing at a time.      |    3 def validate(ts_code: str, config_json: dict):          |
|                              |    4     # Prohibit Node.js built-ins for CF Worker isolates |
|  This rule checks for        |    5     illegal = ["node:fs", "node:path", "fs",            |
|  prohibited Node imports.    |    6                "path", "crypto"]                        |
|                              |    7     for imp in illegal:                                 |
|                              |    8         if f'from "{imp}"' in ts_code:                   |
|                              |    9             return False, f"Illegal import: {imp}"       |
|                              |   10     return True, "Valid CF Worker syntax"               |
|                              | -----------------------------------------------------------  |
|                              |  [✅ Pass] rule_has_required_exports.py                      |
|                              | -----------------------------------------------------------  |
|                              |  [✅ Pass] rule_dependencies_declared.py                     |
|                              | -----------------------------------------------------------  |
|  [ Type a command...    ] [^]|  [✅ Pass] rule_network_allowlist.py                         |
+=============================================================================================+
```

### 3.3 Rule List & Single-Active Accordion Logic

* **Single-Active Editor Constraint** — the UI renders an accordion list of Python files. Clicking a rule expands an embedded Monaco editor with Python syntax highlighting. Opening another rule automatically collapses and saves the previously active rule, ensuring only **one editor instance** is open at any time.

* **Execution Contract** — every Python rule must implement a standard entry point:

  ```python
  def validate(ts_code: str, config_json: dict) -> tuple[bool, str]:
      """
      Returns:
          bool: True for Pass, False for Fail.
          str: Explanatory message or failure context.
      """
  ```

* **Core Built-in Rules:**
  1. `rule_no_global_fetch.py` — verifies global `fetch()` is never called directly; external requests must use `dispatchToGateway` or `context.useCoreTool('network_gateway')`.
  2. `rule_cf_worker_compat.py` — scans imports for CommonJS (`require`) or Node.js built-in modules (`fs`, `path`, `child_process`).
  3. `rule_has_required_exports.py` — confirms both `export const config` and `export default async function execute` are defined.
  4. `rule_dependencies_declared.py` — verifies that any sibling tool called via `context.internalFetch()` is explicitly listed in `config.tool_dependencies`.
  5. `rule_network_allowlist.py` — ensures any external domain contacted via the gateway is explicitly allowlisted in `config.network_requests`.

### 3.4 WebAssembly (Pyodide) Runtime Architecture

* **Isolation** — Pyodide runs inside a dedicated Web Worker so heavy AST/regex operations never freeze the main UI thread.
* **Payload Injection** — on execution the host transfers the current `rawCode` string (from the Editor) and the serialized `config` JSON object across the worker boundary:

  ```typescript
  pyodideWorker.postMessage({
    action: "RUN_RULES",
    tsCode: globalState.rawCode,
    configJson: globalState.config,
    rules: ruleDefinitions
  });
  ```

---

## 4. Sub-Screen 3: [ LLM Rules ] (Claude Agent SDK)

### 4.1 Purpose

Authoring surface for qualitative heuristic standards in Markdown. These guidelines are compiled and executed via `@anthropic-ai/claude-agent-sdk` to evaluate semantic nuances that static regex/AST parsers cannot catch — such as whether an error message contains sufficient instructions for an agent to self-correct.

### 4.2 ASCII Layout

```text
+=============================================================================================+
| [📂 Load File] [📁 Select Local Folder ▼] | [ ✏️ weather_fetcher ] | [ 💾 Save ] [ 🚀 Publish ]|
+---------------------------------------------------------------------------------------------+
| [ Raw Data ] [ Editor ] [ Config ] [ Secrets ] [ Validator ] [ Runner ]                     |
+---------------------------------------------------------------------------------------------+
|                              |  🛡️ VALIDATOR: [ Dashboard ] [ Python Rules ] [ LLM Rules ]  |
|  🤖 AI Assistant             | -----------------------------------------------------------  |
|  --------------------------  |  [ ▶ Run LLM Validator ]        [ 💾 Save Markdown ]         |
|                              | -----------------------------------------------------------  |
|  You are editing the         |   1 # STS Tool Heuristic Validation Guidelines               |
|  qualitative markdown        |   2                                                          |
|  rubric.                     |   3 You are an automated auditor verifying compliance with   |
|                              |   4 the Simple Tools Server (STS) Tool Guidelines.           |
|  The output must match       |   5                                                          |
|  the embedded JSON schema    |   6 ## Guidelines to Evaluate                                |
|  so the SDK can parse        |   7 1. **Actionable Advice**: Every defined error must give  |
|  the findings.               |   8    specific instructions enabling the AI agent to        |
|                              |   9    modify its payload and self-correct on failure.       |
|                              |  10 2. **Description Clarity**: The description must explain |
|                              |  11    *what* data the tool outputs and its external utility.|
|                              |  12 3. **Rate Limits**: Rate limits must not be unlimited.   |
|                              |  13    Reasonable ranges are between 60 and 600 RPM.         |
|                              |  14                                                          |
|                              |  15 ## Mandatory Output Format                               |
|                              |  16 Return ONLY a valid JSON array of objects matching:      |
|                              |  17 [                                                        |
|                              |  18   {                                                      |
|                              |  19     "rule": "Actionable Advice",                         |
|  [ Type a command...    ] [^]|  20     "status": "pass" | "fail" | "warn",                  |
|                              |  21     "reasoning": "Explanation of the evaluation..."      |
|                              |  22   }                                                      |
|                              |  23 ]                                                        |
+=============================================================================================+
```

This markdown is persisted as `sts_rules.md` (see the file tree in `01-system-overview.md`).

### 4.3 Claude Agent SDK Integration Pipeline

1. **Payload Assembly** — when `[ ▶ Run LLM Validator ]` is triggered, the app compiles the full tool context:
   * **System prompt** — the edited Markdown text (`sts_rules.md`).
   * **User prompt** — the complete `[tool_name].ts` code and `[tool_name].json` schema.

2. **SDK Invocation** — TGS runs an agent query using `@anthropic-ai/claude-agent-sdk`:

   ```typescript
   import { query } from "@anthropic-ai/claude-agent-sdk";

   const result = query({
     prompt: `Evaluate this STS Tool:\n\n### TS Code\n${tsCode}\n\n### Config\n${JSON.stringify(configJson, null, 2)}`,
     options: {
       model: "claude-opus-5",          // configurable in app settings
       systemPrompt: markdownContent,   // the sts_rules.md rubric
     },
   });
   ```

   The model is a configurable app setting; `claude-opus-5` is the default.

3. **Structured JSON Parsing** — the app captures the model's response, extracts the JSON array block, and validates it against:

   ```typescript
   interface LLMValidationResult {
     rule: string;
     status: "pass" | "fail" | "warn";
     reasoning: string;
   }
   ```

   On successful parse the results update the global validation store and render immediately in the **[ Dashboard ]** sub-screen. If the model returns conversational text instead of raw JSON, the run is retried under the same rubric.

---

## 5. Data Flow & Cross-Tab Interactivity

```text
               +-------------------------------------------+
               |  Global Tool State (Code, Config, Tests)   |
               +-------------------------------------------+
                                     |
               +---------------------+---------------------+
               |                                           |
               v                                           v
+-------------------------------+         +-------------------------------+
|    Python Wasm Engine         |         |      Claude Agent SDK         |
|    (Pyodide Web Worker)       |         |   (LLM Heuristic Pipeline)    |
+-------------------------------+         +-------------------------------+
               |                                           |
    [Deterministic Results]                     [Qualitative Results]
               |                                           |
               +---------------------+---------------------+
                                     |
                                     v
                 +---------------------------------------+
                 |       Validation Dashboard            |
                 |  - Health Score Calculation           |
                 |  - Failure Diagnostics & File Links   |
                 +---------------------------------------+
                                     |
                                     v
                 +---------------------------------------+
                 | Left AI Assistant: Auto-Fix Proposals |
                 +---------------------------------------+
```

* **Live Re-Validation** — editing code in **[ Editor ]** or modifying parameters in **[ Config ]** marks the current Validation Dashboard state as "Stale" until `[ ▶ Run All Validations ]` is re-triggered.
* **AI Assistant Auto-Remediation** — when a rule fails on the Dashboard (e.g. an unhandled division by zero, or non-actionable error advice), the persistent left AI Assistant reads the finding directly from state and renders a one-click prompt (e.g. `[ Auto-Fix Advice ]`) to update the tool's code or configuration.
