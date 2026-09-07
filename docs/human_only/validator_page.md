# TGS Module Specification: Validator Screen

This document defines the functional, architectural, and visual specifications for the **[ Validator ]** screen within the **Tool Generator Server (TGS)** at `tgs.agentsable.com`.

The Validator acts as the quality assurance gate for tools before they are deployed to the production **Simple Tools Server (STS)** at `sts.agentsable.com`. It enforces both deterministic Cloudflare Workers (WinterCG) runtime boundaries and qualitative AI-agent authoring guidelines using a hybrid dual-engine architecture:

1. **Deterministic Static Analysis:** Python AST scripts executing entirely in the browser via WebAssembly (**Pyodide**).
2. **Qualitative Heuristic Review:** A system prompt rubric written in Markdown and evaluated by Claude via the **`claude-agent-sdk-typescript`**.

---

## 1. Sub-Navigation & Screen Architecture

The Validator tab is divided into three dedicated sub-views accessible via a secondary navigation bar:

* **`[ Dashboard ]`**: An aggregated reporting center displaying overall tool health, pass/fail summaries, and detailed findings.
* **`[ Python Rules ]`**: A script management console with an interactive list of deterministic checks and an accordion Monaco editor (restricted to **one active rule at a time**).
* **`[ LLM Rules ]`**: A full Markdown editor defining the qualitative rubric and prompt instructions sent to the Claude Agent SDK, enforcing strict JSON output.

---

## 2. Sub-Screen 1: [ Dashboard ]

### 2.1 Purpose

The **Dashboard** aggregates the execution results of both the Python Wasm static analysis and the Claude SDK heuristic review. It provides a visual health score and maps errors and warnings directly to line numbers and configuration fields.

### 2.2 ASCII Layout

```text
+=============================================================================================+
| [📂 Load File] [📁 Select Local Folder ▼] | [ ✏️ weather_fetcher ] | [ 💾 Save ] [ 🚀 Publish ]|
+---------------------------------------------------------------------------------------------+
| [ Raw Data ] [ Editor ] [ Config ] [ Secrets ] [ Validator ] [ Runner ]                     |
+---------------------------------------------------------------------------------------------+
|                              |  🛡️ VALIDATOR: [ Dashboard ] [ Python Rules ] [ LLM Rules ]  |
|  🤖 AI Assistant             | -----------------------------------------------------------  |
|  --------------------------  |  [ ▶ Run All Validations ]    Health Score: [ 82 / 100 ]     |
|                              |  Status: ⚠️ 1 Failure, 1 Warning                             |
|  The static analysis         | -----------------------------------------------------------  |
|  passed, but the LLM         |  ▼ DETERMINISTIC CHECKS (Python Wasm)                        |
|  heuristic flagged your      |    [✅ PASS] rule_no_global_fetch.py                         |
|  actionable advice.          |    [✅ PASS] rule_has_required_exports.py                     |
|                              |    [❌ FAIL] rule_cf_worker_compat.py                        |
|  "CITY_NOT_FOUND" does       |       Line 14: Found prohibited module 'node:path'. CF       |
|  not tell the agent what     |       Workers isolates do not support Node.js built-ins.     |
|  payload changes to make.    |                                                              |
|                              |  ▼ HEURISTIC CHECKS (Claude Agent SDK)                      |
|  Want me to fix this         |    [✅ PASS] Clear & Concise Description                     |
|  in the Config tab?          |    [⚠️ WARN] Actionable Error Advice                         |
|                              |       Error 'CITY_NOT_FOUND' lacks dynamic guidance.         |
|  [ Auto-Fix Advice ]         |       Advise agent to inspect input and retry.               |
|                              |    [✅ PASS] Sensible Rate Limits                            |
|  [ Type a command...    ] [^]|                                                              |
+=============================================================================================+

```

### 2.3 UI Elements & Underlying Logic

* **`[ ▶ Run All Validations ]` Button:** Dispatches the tool bundle concurrently to both engines:
1. Compiles and executes all Python rules sequentially in the Pyodide WebAssembly worker.
2. Sends the tool's code, configuration schema, and the Markdown rubric to Claude via `claude-agent-sdk-typescript`.


* **Health Score Widget:** A weighted calculation from 0 to 100:
* Deterministic Failures (Python Wasm): **-25 points each** (Blocker for publishing).
* Qualitative Failures (Claude SDK): **-15 points each**.
* Warnings: **-5 points each**.
* A tool cannot be published via `[ 🚀 Publish ]` unless the score is $\ge 90$ and zero deterministic failures exist.


* **Findings Tree:** Categorized by engine type. Clicking any failing finding highlights the exact line in the **[ Editor ]** or the specific field in the **[ Config ]** tab.

---

## 3. Sub-Screen 2: [ Python Rules ] (Wasm Engine)

### 3.1 Purpose

Manages the deterministic rule set that runs in the client's browser using **Pyodide** (Python compiled to WebAssembly). These rules analyze the Abstract Syntax Tree (AST) of the tool's TypeScript code and inspect its JSON configuration to enforce strict Cloudflare Workers and STS runtime constraints.

### 3.2 ASCII Layout

```text
+=============================================================================================+
| [📂 Load File] [📁 Select Local Folder ▼] | [ ✏️ weather_fetcher ] | [ 💾 Save ] [ 🚀 Publish ]|
+---------------------------------------------------------------------------------------------+
| [ Raw Data ] [ Editor ] [ Config ] [ Secrets ] [ Validator ] [ Runner ]                     |
+---------------------------------------------------------------------------------------------+
|                              |  🛡️ VALIDATOR: [ Dashboard ] [ Python Rules ] [ LLM Rules ]  |
|  🤖 AI Assistant             | -----------------------------------------------------------  |
|  --------------------------  |  [ + New Python Rule ]  [ 💾 Save Rule ]  [ ▶ Run Python Checks ]
|                              | -----------------------------------------------------------  |
|  You are editing the         |  [✅ Pass] rule_no_global_fetch.py                           |
|  CF Worker compatibility     | -----------------------------------------------------------  |
|  rule.                       |  [❌ Fail] rule_cf_worker_compat.py                          |
|                              |    1 import re                                               |
|  Only one rule can be open   |    2                                                         |
|  for editing at a time.      |    3 def validate(ts_code: str, config_json: dict):          |
|                              |    4     # Prohibit Node.js built-ins for CF Worker isolates|
|  This rule checks for        |    5     illegal_imports = ["node:fs", "node:path", "fs",    |
|  prohibited Node imports.    |    6                        "path", "crypto"]                |
|                              |    7     for imp in illegal_imports:                         |
|                              |    8         if f"from '{imp}'" in ts_code or f'from "{imp}"'|
|                              |    9             return False, f"Illegal import found: {imp}"|
|                              |   10     return True, "Valid CF Worker syntax"               |
|                              | -----------------------------------------------------------  |
|                              |  [✅ Pass] rule_has_required_exports.py                      |
|                              | -----------------------------------------------------------  |
|                              |  [✅ Pass] rule_dependencies_declared.py                     |
|  [ Type a command...    ] [^]|                                                              |
+=============================================================================================+

```

### 3.3 Rule List & Single-Active Accordion Logic

* **Single-Active Editor Constraint:** The UI renders an accordion list of Python files. Clicking a rule expands an embedded Monaco editor with Python syntax highlighting. Opening another rule automatically collapses and saves the previously active rule, ensuring only **one editor instance** is open at any time.
* **Execution Contract:** Every Python rule must implement a standard entry point:
```python
def validate(ts_code: str, config_json: dict) -> tuple[bool, str]:
    """
    Returns:
        bool: True for Pass, False for Fail.
        str: Explanatory message or failure context.
    """

```


* **Core Built-in Rules:**
1. `rule_no_global_fetch.py`: Verifies that global `fetch()` is never called directly; external requests must use `dispatchToGateway` or `context.useCoreTool('network_gateway')`.


2. `rule_cf_worker_compat.py`: Scans imports for CommonJS (`require`) or Node.js built-in modules (`fs`, `path`, `child_process`).
3. `rule_has_required_exports.py`: Confirms both `export const config` and `export default async function execute` are defined.


4. `rule_dependencies_declared.py`: Verifies that any sibling tool called via `context.internalFetch()` is explicitly listed in `config.tool_dependencies`.


5. `rule_network_allowlist.py`: Ensures any external domain contacted via the gateway is explicitly whitelisted in `config.network_requests`.





### 3.4 WebAssembly (Pyodide) Runtime Architecture

* **Isolation:** Pyodide runs inside a dedicated Web Worker to prevent heavy AST regex operations from freezing the main UI thread.
* **Payload Injection:** When executed, the host transfers the current `rawCode` string (from the Editor) and the serialized `config` JSON object across the worker boundary into the Pyodide runtime context:
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

The **LLM Rules** screen enables authoring qualitative heuristic standards in Markdown. These guidelines are compiled and executed using the **`claude-agent-sdk-typescript`** to evaluate semantic nuances that static regex/AST parsers cannot catch, such as whether an error message contains sufficient instructions for an agent to self-correct.

### 4.2 ASCII Layout

```text
+=============================================================================================+
| [📂 Load File] [📁 Select Local Folder ▼] | [ ✏️ weather_fetcher ] | [ 💾 Save ] [ 🚀 Publish ]|
+---------------------------------------------------------------------------------------------+
| [ Raw Data ] [ Editor ] [ Config ] [ Secrets ] [ Validator ] [ Runner ]                     |
+---------------------------------------------------------------------------------------------+
|                              |  🛡️ VALIDATOR: [ Dashboard ] [ Python Rules ] [ LLM Rules ]  |
|  🤖 AI Assistant             | -----------------------------------------------------------  |
|  --------------------------  |  [ ▶ Run LLM Validator (Claude SDK) ]   [ 💾 Save Markdown ] |
|                              | -----------------------------------------------------------  |
|  You are editing the         |   1 # STS Tool Heuristic Validation Guidelines               |
|  qualitative markdown        |   2                                                          |
|  rubric.                     |   3 You are an automated auditor verifying compliance with  |
|                              |   4 the Simple Tools Server (STS) Tool Guidelines.           |
|  The output must match       |   5                                                          |
|  the embedded JSON schema    |   6 ## Guidelines to Evaluate                                |
|  so the SDK can parse        |   7 1. **Actionable Advice**: Every defined error must give  |
|  the findings.               |   8    specific instructions enabling the AI agent to        |
|                              |   9    modify its payload and self-correct on failure.       |
|                              |  10 2. **Description Clarity**: The description must explain  |
|                              |  11    *what* data the tool outputs and its external utility.|
|                              |  12 3. **Rate Limits**: Rate limits must not be unlimited.   |
|                              |  13    Reasonable ranges are between 60 and 600 RPM.         |
|                              |  14                                                          |
|                              |  15 ## Mandatory Output Format                               |
|                              |  16 Return ONLY a valid JSON array of objects matching:      |
|                              |  17 ```json                                                  |
|                              |  18 [                                                        |
|                              |  19   {                                                      |
|                              |  20     "rule": "Actionable Advice",                         |
|  [ Type a command...    ] [^]|  21     "status": "pass" | "fail" | "warn",                  |
|                              |  22     "reasoning": "Explanation of heuristic evaluation..."|
|                              |  23   }                                                      |
|                              |  24 ]                                                        |
|                              |  25 ```                                                      |
+=============================================================================================+

```

### 4.3 Claude Agent SDK Integration Pipeline

1. **Payload Assembly:**
* When `[ ▶ Run LLM Validator ]` is triggered, the app compiles the full tool context:
* System Prompt: The edited Markdown text (`sts_rules.md`).
* User Prompt: Contains the complete `[tool_name].ts` code and `[tool_name].json` schema.




2. **SDK Agent Invocation:**
* TGS instantiates an agent loop using the TypeScript SDK:
```typescript
import { Agent } from "claude-agent-sdk";

const validatorAgent = new Agent({
  apiKey: context.env.ANTHROPIC_API_KEY,
  model: "claude-3-5-sonnet-latest"
});

const response = await validatorAgent.run({
  system: markdownContent,
  prompt: `Evaluate this STS Tool:\n\n### TS Code\n${tsCode}\n\n### Config\n${JSON.stringify(configJson, null, 2)}`
});

```




3. **Structured JSON Parsing:**
* The SDK captures the model's response, extracts the JSON array block, and validates it against the expected interface:
```typescript
interface LLMValidationResult {
  rule: string;
  status: "pass" | "fail" | "warn";
  reasoning: string;
}

```


* If parsing succeeds, the results update the global validation store and render immediately in the **[ Dashboard ]** sub-screen.



---

## 5. Data Flow & Cross-Tab Interactivity

```text
               +-------------------------------------------+
               |  Global Tool State (Code, Config, Tests)  |
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

* **Live Re-Validation:** Editing code in the **[ Editor ]** or modifying parameters in the **[ Config ]** marks the current Validation Dashboard state as "Stale" until `[ ▶ Run All Validations ]` is re-triggered.
* **AI Assistant Auto-Remediation:** When a rule fails on the Dashboard (e.g., an unhandled division by zero or non-actionable error advice), the persistent Left AI Assistant reads the finding directly from state and renders a one-click prompt (e.g., `[ Auto-Fix Advice ]`) to automatically update the tool's code or configuration.