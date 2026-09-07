# TGS Module Specification: Editor & Config Screens

This document defines the complete functional, visual, and architectural specifications for the **[ Editor ]** and **[ Config ]** screens within the **Tool Generator Server (TGS)** at `tgs.agentsable.com`.

Both screens operate within the standard TGS base44 shell:

* **Top Action Bar:** File management, folder mounting via the File System Access API, active tool renaming, and global Save/Publish controls.
* **Left AI Assistant Pane:** Persistent assistant powered by the `claude-agent-sdk-typescript` having bidirectional access to global state.
* **Main Center/Right Workspace:** Active tab view.

---

## 1. The [ Editor ] Screen Specification

### 1.1 Purpose & Architectural Role

The **Editor** screen is a Monaco-based TypeScript environment dedicated exclusively to authoring runtime execution logic. To prevent developers from corrupting the declarative JSON schema while writing code, the declarative `config` definition is parsed via an Abstract Syntax Tree (AST) and abstracted out of view.

### 1.2 ASCII Layout

```text
+=============================================================================================+
| [📂 Load File] [📁 Select Local Folder ▼] | [ ✏️ weather_fetcher ] | [ 💾 Save ] [ 🚀 Publish ]|
+---------------------------------------------------------------------------------------------+
| [ Raw Data ] [ Editor ] [ Config ] [ Secrets ] [ Validator ] [ Runner ]                     |
+---------------------------------------------------------------------------------------------+
|                              |  [ TypeScript Logic View - Config Block Hidden ]             |
|  🤖 AI Assistant             | -----------------------------------------------------------  |
|  --------------------------  |  1 import type { ToolExecutionContext } from "/core/contrac  |
|                              |  2 import { dispatchToGateway } from "/core/network/network  |
|  I see you are editing       |  3                                                           |
|  the execution logic.        |  4 /* [CONFIG_STUB]: Configuration managed in Config Tab */  |
|                              |  5                                                           |
|  The `config` object is      |  6 export default async function execute(                    |
|  hidden and safely synced    |  7   request: Request,                                       |
|  in the Config tab.          |  8   context: ToolExecutionContext                           |
|                              |  9 ): Promise<Response> {                                    |
|  Remember: No global         | 10   try {                                                   |
|  fetch() allowed!            | 11     const payload = await request.json();                 |
|                              | 12     const apiKey = context.env["WEATHER_API_KEY"];        |
|                              | 13     // Execution logic continues...                       |
|                              | 14     return new Response(JSON.stringify({ result }));      |
|                              | 15   } catch (error) {                                       |
|                              | 16     return new Response(                                  |
|                              | 17       JSON.stringify({ error: (error as Error).message }),|
|                              | 18       { status: 500 }                                     |
|                              | 19     );                                                    |
|                              | 20   }                                                       |
|                              | 21 }                                                         |
|  [ Type a command...    ] [^]|                                                              |
+=============================================================================================+

```

### 1.3 AST Parsing & Recombination Engine

The Editor uses a TypeScript/JavaScript parser (such as `@babel/parser`, `swc`, or `ts-morph` running in-browser) to isolate imperative code from declarative configuration:

1. **Extraction (File Load):**
* The AST identifies the `VariableDeclaration` matching `baseConfig` or `export const config`.


* The configuration node is extracted, converted to an internal JavaScript object, and saved to the global config store.
* The code rendered in Monaco replaces the config declaration with a read-only or comment stub:
```typescript
/* [CONFIG_STUB]: Configuration managed in Config Tab */

```




2. **Recombination (File Save / Tab Switch / Publish):**
* The editor retrieves the raw user-modified code from the Monaco instance.
* The stub comment is located.
* The serialized `baseConfig` object (and its wrapped `export const config = await initToolConfig(...)` line) is injected back into the exact position.


* The combined string is saved into the global tool store and reflected in the `[tool_name].ts` pane of the **[ Raw Data ]** tab.



### 1.4 Monaco Workspace Configuration & Validation

* **Language & Target:** TypeScript targeting ES2022 / Cloudflare Workers environment (WinterCG compliance).
* **Strict Autocomplete Context:** Standard Web API types (`Request`, `Response`, `URL`, `Headers`) and injected types for `/core/contracts/ToolContract.ts` (`ToolExecutionContext`, `ToolStorage`).


* **Linter Warnings:**
* Flags any direct `fetch()` call with: *"Zero-Trust Violation: Use dispatchToGateway() or context.useCoreTool('network_gateway') instead"*.


* Flags Node.js core modules (`node:fs`, `node:path`) as Cloudflare Worker isolate violations.



---

## 2. The [ Config ] Screen Specification

### 2.1 Purpose & Architectural Role

The **Config** screen provides a schema builder and dual-file JSON synchronizer. It allows developers to define inputs, outputs, error handling, rate limits, and network permissions according to the `ToolConfig` interface.

The workspace contains three sub-views accessible via a sub-navigation bar:

1. **Form Editor:** Interactive form builder with 4 bidirectional loading and saving buttons.
2. **Tool JSON:** Direct editor of the configuration extracted from the `.ts` file.
3. **Config JSON:** Direct editor of the standalone `.json` config file.

---

### 2.2 Sub-View 1: The Form Editor

#### ASCII Representation

```text
+=============================================================================================+
| [📂 Load File] [📁 Select Local Folder ▼] | [ ✏️ weather_fetcher ] | [ 💾 Save ] [ 🚀 Publish ]|
+---------------------------------------------------------------------------------------------+
| [ Raw Data ] [ Editor ] [ Config ] [ Secrets ] [ Validator ] [ Runner ]                     |
+---------------------------------------------------------------------------------------------+
|                              |  ⚙️ CONFIGURATION: [ Form Editor ] [ Tool JSON ] [ Config JSON ] |
|  🤖 AI Assistant             | -----------------------------------------------------------  |
|  --------------------------  |  [ 📥 Load from Tool ] [ 📥 Load from Config ]               |
|                              |  [ 💾 Save to Tool ]   [ 💾 Save to Config ]                 |
|  I noticed you updated       | -----------------------------------------------------------  |
|  the rate limit to 300.      |  Name:              [ weather_fetcher                      ] |
|                              |  Description:       [ Fetches current weather data...      ] |
|  Where would you like        |  Version:           [ 1.1.0        ]  Icon: [ 🌤️ ]  Cost: [ 5 ]|
|  to save this change?        |  Timeout (ms):      [ 15000        ]  [x] Is Idempotent      |
|                              |                                                              |
|  [ Save to Tool.ts ]         |  Tool Dependencies: [ "network_gateway" (x) ] [ + Add ]     |
|  [ Save to Config.json ]     |  Network Requests:  [ "https://api.openweathermap.org" (x) ]  |
|                              |  Rate Limit (RPM):  [ 300                                  ] |
|                              |                                                              |
|                              |  [ Signature Builder ]                                       |
|                              |  > Inputs [ + Add Field ]                                    |
|                              |    - city: string (required) [🗑️]                             |
|                              |  > Outputs [ + Add Field ]                                   |
|                              |    - temperature: number [🗑️]                                 |
|                              |    - description: string [🗑️]                                 |
|                              |  > Actionable Errors [ + Add Error ]                         |
|                              |    - "CITY_NOT_FOUND"                                        |
|                              |      Advice: "Verify city name spelling and try again."      |
|  [ Type a command...    ] [^]|                                                              |
+=============================================================================================+

```

#### Fields & Form Controls

1. **General Metadata:**
* `Name`: Text input (synchronized with project tool name).


* `Description`: Multiline text area. Must clearly describe the tool capability.


* `Version`: Semantic version string (e.g., `1.1.0`).


* `Icon`: Single character or emoji selector.


* `Cost`: Numeric operational cost units (default: `0`).


* `TimeoutMs`: Maximum execution time in milliseconds (e.g., `15000`).


* `IsIdempotent`: Boolean checkbox indicating safe retry status.




2. **Security & Zero-Trust Allowlisting:**
* `Tool Dependencies`: Tag list of sibling tool names. Required when using `internalFetch`.


* `Network Requests`: Tag list of allowed outbound absolute URL prefixes (e.g., `[https://api.openai.com/v1/chat/completions](https://api.openai.com/v1/chat/completions)`).


* `Rate Limit (RPM)`: Max allowed invocations per minute.




3. **Signature Builder (JSON Schema):**
* `Inputs`: List of parameter names, datatypes (`string`, `number`, `boolean`, `object`, `array`), and required status.


* `Outputs`: List of return properties and their datatypes.


* `Actionable Errors`: Key-value pair mapper defining the Error Code (e.g., `DIV_BY_ZERO`, `CITY_NOT_FOUND`) and the mandatory `actionable_advice` string for AI self-correction.





#### The 4 Action Buttons

* **`[ 📥 Load from Tool ]`:** Parses the AST of the active `.ts` file, extracts `baseConfig`, and overwrites the active Form fields.
* **`[ 📥 Load from Config ]`:** Reads the active `[tool_name].json` file and overwrites the active Form fields.
* **`[ 💾 Save to Tool ]`:** Serializes the current Form state into a JavaScript AST object and injects it into the `baseConfig` of the `.ts` file.
* **`[ 💾 Save to Config ]`:** Formats the current Form state into standard JSON and overwrites `[tool_name].json`.

---

### 2.3 Sub-View 2: Raw Tool JSON

#### ASCII Representation

```text
+=============================================================================================+
| [📂 Load File] [📁 Select Local Folder ▼] | [ ✏️ weather_fetcher ] | [ 💾 Save ] [ 🚀 Publish ]|
+---------------------------------------------------------------------------------------------+
| [ Raw Data ] [ Editor ] [ Config ] [ Secrets ] [ Validator ] [ Runner ]                     |
+---------------------------------------------------------------------------------------------+
|                              |  ⚙️ CONFIGURATION: [ Form Editor ] [ Tool JSON ] [ Config JSON ] |
|  🤖 AI Assistant             | -----------------------------------------------------------  |
|  --------------------------  |  [ 💾 Save to Tool (.ts file) ]                              |
|                              | -----------------------------------------------------------  |
|  I have extracted the        |   1 {                                                        |
|  configuration object        |   2   "name": "weather_fetcher",                             |
|  from your tool's `.ts`      |   3   "version": "1.1.0",                                    |
|  file.                       |   4   "description": "Fetches current weather data.",        |
|                              |   5   "cost": 5,                                             |
|  Edits saved here write      |   6   "timeoutMs": 15000,                                    |
|  directly to the `.ts`       |   7   "tool_dependencies": ["network_gateway"],              |
|  code.                       |   8   "network_requests": [                                  |
|                              |   9     "https://api.openweathermap.org/data/2.5/weather"    |
|                              |  10   ],                                                     |
|                              |  11   "signature": {                                         |
|                              |  12     "inputs": {                                          |
|                              |  13       "type": "object",                                  |
|                              |  14       "properties": { "city": { "type": "string" } },    |
|                              |  15       "required": ["city"]                               |
|                              |  16     },                                                   |
|                              |  17     "outputs": {                                         |
|                              |  18       "type": "object",                                  |
|                              |  19       "properties": { "temperature": { "type": "number"} }|
|                              |  20     }                                                    |
|                              |  21   }                                                      |
|                              |  22 }                                                        |
|  [ Type a command...    ] [^]|                                                              |
+=============================================================================================+

```

#### Underlying Logic

* **Data Source:** A live projection of the `baseConfig` object extracted from `[tool_name].ts`.


* **Editor Instance:** Read/Write Monaco editor with JSON schema validation.
* **`[ 💾 Save to Tool (.ts file) ]` Action:** Parses the edited JSON text, runs syntax validation, and uses the AST engine to rewrite the `baseConfig` declaration inside the `.ts` file without altering any custom functions or the `execute` block.



---

### 2.4 Sub-View 3: Raw Config JSON

#### ASCII Representation

```text
+=============================================================================================+
| [📂 Load File] [📁 Select Local Folder ▼] | [ ✏️ weather_fetcher ] | [ 💾 Save ] [ 🚀 Publish ]|
+---------------------------------------------------------------------------------------------+
| [ Raw Data ] [ Editor ] [ Config ] [ Secrets ] [ Validator ] [ Runner ]                     |
+---------------------------------------------------------------------------------------------+
|                              |  ⚙️ CONFIGURATION: [ Form Editor ] [ Tool JSON ] [ Config JSON ] |
|  🤖 AI Assistant             | -----------------------------------------------------------  |
|  --------------------------  |  [ 📥 Load from Tool (.ts file) ] [ 💾 Save to Config (.json) ]|
|                              | -----------------------------------------------------------  |
|  You are editing the         |   1 {                                                        |
|  external JSON file.         |   2   "name": "weather_fetcher",                             |
|                              |   3   "version": "1.1.0",                                    |
|  Would you like to sync      |   4   "description": "External override configuration.",     |
|  this with the values        |   5   "cost": 10,                                            |
|  currently in your `.ts`     |   6   "timeoutMs": 20000,                                    |
|  code?                       |   7   "tool_dependencies": ["network_gateway"],              |
|                              |   8   "network_requests": [                                  |
|                              |   9     "https://api.openweathermap.org/data/2.5/weather"    |
|                              |  10   ]                                                      |
|                              |  11 }                                                        |
|  [ Type a command...    ] [^]|                                                              |
+=============================================================================================+

```

#### Underlying Logic

* **Data Source:** Directly bound to the `[tool_name].json` file content.
* **`[ 📥 Load from Tool (.ts file) ]` Action:** Reads the AST `baseConfig` from the TypeScript file and replaces the editor buffer content with its formatted JSON string.


* **`[ 💾 Save to Config (.json) ]` Action:** Validates JSON syntax and commits the buffer directly to `[tool_name].json` in the global state, updating the **[ Raw Data ]** tab without affecting the `.ts` file.

---

## 3. Data Synchronization Matrix

| Trigger Action | Source | Target(s) Updated | AST Parsing Needed? |
| --- | --- | --- | --- |
| **Save in Editor Tab** | Editor Monaco Buffer | `tool.ts` (Global State), `Raw Data (tool.ts)` | Yes (recombines code + stored config) |
| **Form Editor: Save to Tool** | Form UI State | `tool.ts` (Global State), `Raw Tool JSON`, `Raw Data (tool.ts)` | Yes (injects config into AST) |
| **Form Editor: Save to Config** | Form UI State | `tool.json` (Global State), `Raw Config JSON`, `Raw Data (tool.json)` | No (direct JSON serialization) |
| **Tool JSON: Save to Tool** | Tool JSON Buffer | `tool.ts` (Global State), Form UI State, `Raw Data (tool.ts)` | Yes (validates JSON and writes to AST) |
| **Config JSON: Save to Config** | Config JSON Buffer | `tool.json` (Global State), Form UI State, `Raw Data (tool.json)` | No (direct JSON commit) |
| **Top Action Bar: Save All** | All Active Buffers | Writes all 4 files (`.ts`, `.json`, `.env`, `_tests.json`) to Disk/FS | Yes (full AST compile pass) |

---

## 4. Claude Agent SDK Integration Hooks

The left AI pane connects to both the **Editor** and **Config** screens via the `claude-agent-sdk-typescript`:

* **Editor Intent:** When prompted (e.g., *"Wrap the API call in an error check for status 404"*), the assistant accesses the un-abstracted execution block, applies changes, and refreshes the Monaco editor buffer.
* **Config Intent:** When prompted (e.g., *"Add a required string parameter 'units' with enum 'metric' or 'imperial'"*), the assistant updates the structured schema in the global config store, automatically refreshing both the visual Form fields and the Raw JSON screens.