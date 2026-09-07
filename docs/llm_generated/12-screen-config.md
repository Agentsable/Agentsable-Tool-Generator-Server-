# TGS Screen Specification: [ Config ]

**Source:** `docs/human_only/editor_config_page.md` §2–4, reconciled per `00-INDEX.md`.

## 1. Purpose & Architectural Role

The **Config** screen provides a schema builder and dual-file JSON synchronizer. It allows developers to define inputs, outputs, error handling, rate limits, and network permissions according to the `ToolConfig` interface in `ToolContract.ts`.

The workspace contains three sub-views accessible via a sub-navigation bar:

1. **Form Editor** — interactive form builder with 4 bidirectional load/save buttons.
2. **Tool JSON** — direct editor of the configuration extracted from the `.ts` file.
3. **Config JSON** — direct editor of the standalone `.json` config file.

---

## 2. Sub-View 1: The Form Editor

### ASCII Layout

```text
+=============================================================================================+
| [📂 Load File] [📁 Select Local Folder ▼] | [ ✏️ weather_fetcher ] | [ 💾 Save ] [ 🚀 Publish ]|
+---------------------------------------------------------------------------------------------+
| [ Raw Data ] [ Editor ] [ Config ] [ Secrets ] [ Validator ] [ Runner ]                     |
+---------------------------------------------------------------------------------------------+
|                              | ⚙️ CONFIGURATION: [ Form Editor ] [ Tool JSON ] [ Config JSON ]|
|  🤖 AI Assistant             | -----------------------------------------------------------  |
|  --------------------------  |  [ 📥 Load from Tool ] [ 📥 Load from Config ]               |
|                              |  [ 💾 Save to Tool ]   [ 💾 Save to Config ]                 |
|  I noticed you updated       | -----------------------------------------------------------  |
|  the rate limit to 300.      |  Name:              [ weather_fetcher                      ] |
|                              |  Description:       [ Fetches current weather data...      ] |
|  Where would you like        |  Version:           [ 1.1.0        ]  Icon: [ 🌤️ ]  Cost: [ 5 ]|
|  to save this change?        |  Timeout (ms):      [ 15000        ]  [x] Is Idempotent      |
|                              |                                                              |
|  [ Save to Tool.ts ]         |  Tool Dependencies: [ "network_gateway" (x) ] [ + Add ]      |
|  [ Save to Config.json ]     |  Network Requests:  [ "https://api.openweathermap.org" (x) ] |
|                              |  Rate Limit (RPM):  [ 300                                  ] |
|                              |                                                              |
|                              |  [ Signature Builder ]                                       |
|                              |  > Inputs [ + Add Field ]                                    |
|                              |    - city: string (required) [🗑️]                            |
|                              |  > Outputs [ + Add Field ]                                   |
|                              |    - temperature: number [🗑️]                                |
|                              |    - description: string [🗑️]                                |
|                              |  > Actionable Errors [ + Add Error ]                         |
|                              |    - "CITY_NOT_FOUND"                                        |
|                              |      Advice: "Verify city name spelling and try again."      |
|  [ Type a command...    ] [^]|                                                              |
+=============================================================================================+
```

### Fields & Form Controls

1. **General Metadata**
   * `Name` — text input, synchronized with the project tool name in the top action bar.
   * `Description` — multiline text area. Must clearly describe the tool capability.
   * `Version` — semantic version string (e.g. `1.1.0`).
   * `Icon` — single character or emoji selector.
   * `Cost` — numeric operational cost units (default `0`).
   * `TimeoutMs` — maximum execution time in milliseconds (e.g. `15000`).
   * `IsIdempotent` — boolean checkbox indicating safe retry status.

2. **Security & Zero-Trust Allowlisting**
   * `Tool Dependencies` — tag list of sibling tool names. Required when using `internalFetch` or `useCoreTool`.
   * `Network Requests` — tag list of allowed outbound absolute URL prefixes, e.g. `https://api.openai.com/v1/chat/completions`.
   * `Rate Limit (RPM)` — max allowed invocations per minute.

3. **Signature Builder (JSON Schema)**
   * `Inputs` — parameter names, datatypes (`string`, `number`, `boolean`, `object`, `array`), and required status.
   * `Outputs` — return properties and their datatypes.
   * `Actionable Errors` — key/value mapper defining the error code (e.g. `DIV_BY_ZERO`, `CITY_NOT_FOUND`) and the mandatory `actionable_advice` string for AI self-correction.

### The 4 Action Buttons

* **`[ 📥 Load from Tool ]`** — parses the AST of the active `.ts` file, extracts `baseConfig`, and overwrites the active Form fields.
* **`[ 📥 Load from Config ]`** — reads the active `[tool_name].json` file and overwrites the active Form fields.
* **`[ 💾 Save to Tool ]`** — serializes the current Form state into a JavaScript AST object and injects it into the `baseConfig` of the `.ts` file.
* **`[ 💾 Save to Config ]`** — formats the current Form state into standard JSON and overwrites `[tool_name].json`.

**Conflict resolution:** when the `.ts` and `.json` values diverge, the Form Editor displays a visual indicator of which source it is currently reflecting.

---

## 3. Sub-View 2: Raw Tool JSON

### ASCII Layout

```text
+=============================================================================================+
| [📂 Load File] [📁 Select Local Folder ▼] | [ ✏️ weather_fetcher ] | [ 💾 Save ] [ 🚀 Publish ]|
+---------------------------------------------------------------------------------------------+
| [ Raw Data ] [ Editor ] [ Config ] [ Secrets ] [ Validator ] [ Runner ]                     |
+---------------------------------------------------------------------------------------------+
|                              | ⚙️ CONFIGURATION: [ Form Editor ] [ Tool JSON ] [ Config JSON ]|
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

### Underlying Logic

* **Data Source** — a live projection of the `baseConfig` object extracted from `[tool_name].ts`.
* **Editor Instance** — read/write Monaco editor with JSON schema validation against `ToolConfig`.
* **`[ 💾 Save to Tool (.ts file) ]`** — parses the edited JSON text, runs syntax validation, and uses the AST engine to rewrite the `baseConfig` declaration inside the `.ts` file without altering any custom functions or the `execute` block.

---

## 4. Sub-View 3: Raw Config JSON

### ASCII Layout

```text
+=============================================================================================+
| [📂 Load File] [📁 Select Local Folder ▼] | [ ✏️ weather_fetcher ] | [ 💾 Save ] [ 🚀 Publish ]|
+---------------------------------------------------------------------------------------------+
| [ Raw Data ] [ Editor ] [ Config ] [ Secrets ] [ Validator ] [ Runner ]                     |
+---------------------------------------------------------------------------------------------+
|                              | ⚙️ CONFIGURATION: [ Form Editor ] [ Tool JSON ] [ Config JSON ]|
|  🤖 AI Assistant             | -----------------------------------------------------------  |
|  --------------------------  | [ 📥 Load from Tool (.ts) ] [ 💾 Save to Config (.json) ]    |
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

### Underlying Logic

* **Data Source** — directly bound to the `[tool_name].json` file content.
* **`[ 📥 Load from Tool (.ts file) ]`** — reads the AST `baseConfig` from the TypeScript file and replaces the editor buffer content with its formatted JSON string.
* **`[ 💾 Save to Config (.json) ]`** — validates JSON syntax and commits the buffer directly to `[tool_name].json` in the global state, updating the **[ Raw Data ]** tab without affecting the `.ts` file.

---

## 5. Data Synchronization Matrix

| Trigger Action | Source | Target(s) Updated | AST Parsing Needed? |
| --- | --- | --- | --- |
| **Save in Editor Tab** | Editor Monaco Buffer | `tool.ts` (Global State), `Raw Data (tool.ts)` | Yes — recombines code + stored config |
| **Form Editor: Save to Tool** | Form UI State | `tool.ts` (Global State), `Raw Tool JSON`, `Raw Data (tool.ts)` | Yes — injects config into AST |
| **Form Editor: Save to Config** | Form UI State | `tool.json` (Global State), `Raw Config JSON`, `Raw Data (tool.json)` | No — direct JSON serialization |
| **Tool JSON: Save to Tool** | Tool JSON Buffer | `tool.ts` (Global State), Form UI State, `Raw Data (tool.ts)` | Yes — validates JSON and writes to AST |
| **Config JSON: Save to Config** | Config JSON Buffer | `tool.json` (Global State), Form UI State, `Raw Data (tool.json)` | No — direct JSON commit |
| **Top Action Bar: `[ 💾 Save ]`** | All Active Buffers | Writes all 4 files (`.ts`, `.json`, `.env`, `_tests.json`) to Disk/FS | Yes — full AST compile pass |

## 6. Claude Agent SDK Integration

The left AI pane connects to the Config screen via `@anthropic-ai/claude-agent-sdk`. When prompted (e.g. *"Add a required string parameter 'units' with enum 'metric' or 'imperial'"*), the assistant updates the structured schema in the global config store, automatically refreshing both the visual Form fields and the Raw JSON sub-views.
