# TGS Screen Specification: [ Raw Data ]

**Source:** `docs/human_only/app_ui.md` §1, reconciled per `00-INDEX.md`.

The **Raw Data** screen is a read-only, developer-centric diagnostic view. It provides complete transparency into the exact files that constitute the tool bundle before it is deployed to production.

It operates within the standard TGS base44 shell (see `01-system-overview.md`): top action bar, persistent left AI assistant pane, and the tabbed main workspace.

## ASCII Layout

```text
+=============================================================================================+
| [📂 Load File] [📁 Select Local Folder ▼] | [ ✏️ weather_fetcher ] | [ 💾 Save ] [ 🚀 Publish ]|
+---------------------------------------------------------------------------------------------+
| [ Raw Data ] [ Editor ] [ Config ] [ Secrets ] [ Validator ] [ Runner ]                     |
+---------------------------------------------------------------------------------------------+
|                              |  📄 RAW DATA: [ .ts ] [ .json ] [ .env ] [ _tests.json ]     |
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

The sub-navigation labels render with the active tool's name substituted — for `weather_fetcher` the tabs read `[ weather_fetcher.ts ] [ weather_fetcher.json ] [ weather_fetcher.env ] [ weather_fetcher_tests.json ]`. Renaming the tool in the top action bar renames all four.

## UI Elements & Underlying Logic

* **Sub-Navigation Tabs** — a secondary navigation bar toggles between the four files that make up the tool's local ecosystem:

  1. **`[tool_name].ts`** — the primary executable TypeScript file. Displays the fully combined code: the `/core/` imports, the `baseConfig` object with embedded tests, and the `execute(request, context)` function.
  2. **`[tool_name].json`** — the standalone JSON representation of the `ToolConfig` schema. This reflects the exact JSON payload external SDKs or MCP clients might read to understand the tool's inputs and outputs.
  3. **`[tool_name].env`** — a plain-text mapping of the local testing secrets (e.g. `WEATHER_API_KEY=sk-...`). Used exclusively for local HTTP testing and explicitly excluded when clicking `[ 🚀 Publish ]`.
  4. **`[tool_name]_tests.json`** — an external JSON array containing extended HTTP-driven test definitions. Keeps the main `.ts` file clean while allowing large edge-case test suites.

* **Syntax Highlighting** — each pane is a Monaco instance configured for its file type: TypeScript, JSON, and env/properties respectively.

* **State Synchronization** — the Raw Data screen is the visual output of the global application state. Any modification made via the visual builders in **[ Config ]**, **[ Editor ]**, **[ Secrets ]**, or **[ Runner ]** is instantly serialized and reflected in these raw text files.

* **Read-Only Safety** — to prevent state desynchronization, this view is strictly read-only. Developers must use the dedicated Editor, Config, Secrets, or Runner tabs to make changes.

* **Save semantics** — `[ 💾 Save ]` in the top action bar writes all four files to disk (or to the mounted File System Access API directory). This requires a full AST compile pass to recombine the Editor buffer with the stored config; see the synchronization matrix in `12-screen-config.md`.
