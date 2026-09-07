# Tool Generator Server (TGS): Raw Data & Editor Screen Specifications

This document provides a deep dive into two critical screens of the **Tool Generator Server (TGS)** workspace: the **Raw Data** screen and the **Editor** screen. Deployed at `tgs.agentsable.com`, TGS acts as the local-first authoring and validation environment for stateless Deno tools destined for the production Simple Tools Server (STS) ecosystem.

Both screens operate within the global base44 layout, featuring a persistent left-pane AI assistant (powered by the `claude-agent-sdk-typescript`) and a top action bar for file loading, saving, and publishing.

---

## 1. The [ Raw Data ] Screen

The **Raw Data** screen is a read-only, developer-centric diagnostic view. It provides complete transparency into the exact files that constitute the tool bundle before it is deployed to production.

### ASCII Representation

```text
+=============================================================================================+
| [📂 Load File] [📁 Select Local Folder ▼] | [ ✏️ weather_fetcher ] | [ 💾 Save ] [ 🚀 Publish ]|
+---------------------------------------------------------------------------------------------+
| [ Raw Data ] [ Editor ] [ Config ] [ Secrets ] [ Validator ] [ Runner ]                     |
+---------------------------------------------------------------------------------------------+
|                              |  📄 RAW DATA: [ tool.ts ] [ tool.json ] [ tool.env ] [ tests.json ]
|  🤖 AI Assistant             | -----------------------------------------------------------  |
|  --------------------------  |   1 // Combined execution logic and config                   |
|                              |   2 import { initToolConfig } from "/core/utils...";         |
|  You are viewing the         |   3 import type { ToolConfig } from "/core/contracts...";    |
|  generated TypeScript        |   4                                                          |
|  file.                       |   5 export const config: Partial<ToolConfig> = {             |
|                              |   6   name: "weather_fetcher",                               |
|  Changes made in the         |   7   version: "1.1.0",                                      |
|  other tabs are              |   8   // ...                                                 |
|  instantly serialized        |   9 };                                                       |
|  here.                       |  10                                                          |
|                              |  11 export default async function execute(req, ctx) {        |
|                              |  12   // ...                                                 |
|  [ Type a command...    ] [^]|  13 }                                                        |
+=============================================================================================+

```

### UI Elements & Underlying Logic

* **Sub-Navigation Tabs:** The main workspace header contains a secondary navigation bar allowing the developer to toggle between the four files that make up the tool's local ecosystem:
1. **`[tool_name].ts`:** The primary executable TypeScript file. It displays the fully combined code, including the foundational `/core/` imports, the `baseConfig` object with embedded tests, and the `execute(request, context)` function.


2. **`[tool_name].json`:** The standalone JSON representation of the `ToolConfig` schema. This reflects the exact JSON payload external SDKs or MCP clients might read to understand the tool's inputs and outputs.


3. **`[tool_name].env`:** A plain-text mapping of the local testing secrets (e.g., `WEATHER_API_KEY=sk-...`). This file is utilized exclusively for local HTTP testing and is explicitly excluded when clicking `[ 🚀 Publish ]`.
4. **`[tool_name]_tests.json`:** An external JSON array containing extended HTTP-driven test definitions. This keeps the main `.ts` file clean while allowing for massive edge-case test suites.


* **State Synchronization:** The Raw Data screen serves as the visual output of the global application state. Any modification made via the visual builders in the **[ Config ]** or **[ Editor ]** tabs is instantly serialized and reflected in these raw text files.
* **Read-Only Safety:** To prevent state desynchronization, this view is strictly read-only. Developers must use the dedicated Editor or Config tabs to make changes.

---

## 2. The [ Editor ] Screen

The **Editor** screen is a Monaco-powered workspace focused exclusively on writing the tool's core execution logic. It enforces the architectural rule that tools act strictly as data APIs, returning predictable JSON data.

### ASCII Representation

```text
+=============================================================================================+
| [📂 Load File] [📁 Select Local Folder ▼] | [ ✏️ weather_fetcher ] | [ 💾 Save ] [ 🚀 Publish ]|
+---------------------------------------------------------------------------------------------+
| [ Raw Data ] [ Editor ] [ Config ] [ Secrets ] [ Validator ] [ Runner ]                     |
+---------------------------------------------------------------------------------------------+
|                              |  [ TypeScript Logic View - Config Block Hidden ]             |
|  🤖 AI Assistant             | -----------------------------------------------------------  |
|  --------------------------  |  1 import { initToolConfig } from "/core/utils...";          |
|                              |  2 import type { ToolExecutionContext } from "/core/contrac  |
|  I hid the config block      |  3                                                           |
|  so you can focus on         |  4 // Configuration is managed via the Config tab.           |
|  the execution flow.         |  5                                                           |
|                              |  6 export default async function execute(request, context) { |
|  Remember to return          |  7    const payload = await request.json();                  |
|  strict JSON!                |  8                                                           |
|                              |  9    // Zero-trust execution                                |
|                              | 10    const apiKey = context.env["WEATHER_API_KEY"];         |
|                              | 11                                                           |
|                              | 12    return Response.json({ success: true, payload });      |
|                              | 13 }                                                         |
|  [ Type a command...    ] [^]|                                                              |
+=============================================================================================+

```

### UI Elements & Underlying Logic

* **AST Abstraction Engine:** When the `.ts` file is loaded into memory, the TGS frontend parses the code using an Abstract Syntax Tree (AST). It identifies the declarative `export const config` block and hides it from the Monaco editor. A non-editable stub (e.g., `// Configuration is managed via the Config tab.`) replaces it visually.


* **Execution Focus:** By hiding the schema, the editor forces the developer to focus purely on the `execute(request, context)` function. This protects the JSON schema from accidental syntax breakage while writing complex logic.


* **STS Compliance Enforcement:** The editor environment highlights STS-specific constraints:
* It expects the `execute` function to return standard Web `Response` objects containing strict JSON.


* It provides autocomplete for the `ToolExecutionContext`, including access to `context.env` and the `context.useCoreTool()` wrapper required for zero-trust network calls.




* **Seamless Recombination:** When the user hits `[ 💾 Save ]` or navigates back to the **[ Raw Data ]** tab, the application's AST engine stitches the visual execution code and the hidden configuration object back together into a single, valid Cloudflare Worker-compliant TypeScript file.

