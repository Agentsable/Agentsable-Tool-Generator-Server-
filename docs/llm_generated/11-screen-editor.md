# TGS Screen Specification: [ Editor ]

**Source:** `docs/human_only/editor_config_page.md` §1, reconciled per `00-INDEX.md`.

## 1. Purpose & Architectural Role

The **Editor** screen is a Monaco-based TypeScript environment dedicated exclusively to authoring runtime execution logic. To prevent developers from corrupting the declarative JSON schema while writing code, the `config` definition is parsed via an Abstract Syntax Tree (AST) and abstracted out of view.

## 2. ASCII Layout

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

> The `initToolConfig` import does **not** appear in this view. It is only referenced by the `export const config = await initToolConfig(...)` line, which the AST engine strips along with the config block — it is re-injected on recombination.

## 3. AST Parsing & Recombination Engine

The Editor uses a TypeScript/JavaScript parser (`@babel/parser`, `swc`, or `ts-morph` running in-browser) to isolate imperative code from declarative configuration:

1. **Extraction (File Load):**
   * The AST identifies the `VariableDeclaration` matching `baseConfig` or `export const config`.
   * The configuration node is extracted, converted to an internal JavaScript object, and saved to the global config store.
   * The `initToolConfig` import specifier and the `export const config = await initToolConfig(...)` statement are extracted alongside it.
   * The code rendered in Monaco replaces the config declaration with a read-only comment stub:

     ```typescript
     /* [CONFIG_STUB]: Configuration managed in Config Tab */
     ```

2. **Recombination (File Save / Tab Switch / Publish):**
   * The editor retrieves the raw user-modified code from the Monaco instance.
   * The stub comment is located.
   * The serialized `baseConfig` object — and its wrapped `export const config = await initToolConfig(...)` line, plus the `initToolConfig` import — is injected back into the exact position.
   * The combined string is saved into the global tool store and reflected in the `[tool_name].ts` pane of the **[ Raw Data ]** tab.

## 4. Monaco Workspace Configuration & Validation

* **Language & Target** — TypeScript targeting ES2022 / Cloudflare Workers environment (WinterCG compliance).
* **Strict Autocomplete Context** — standard Web API types (`Request`, `Response`, `URL`, `Headers`) plus injected types for `ToolContract.ts` (`ToolExecutionContext`, `ToolStorage`, `ToolConfig`).
* **Linter Warnings:**
  * Flags any direct `fetch()` call with: *"Zero-Trust Violation: Use dispatchToGateway() or context.useCoreTool('network_gateway') instead"*.
  * Flags Node.js core modules (`node:fs`, `node:path`) as Cloudflare Worker isolate violations.
* **Execution Focus** — by hiding the schema, the editor keeps the developer on the `execute(request, context)` function and protects the JSON schema from accidental syntax breakage. The editor expects `execute` to return standard Web `Response` objects containing strict JSON.

## 5. Claude Agent SDK Integration

The left AI pane connects to the Editor via `@anthropic-ai/claude-agent-sdk`. When prompted (e.g. *"Wrap the API call in an error check for status 404"*), the assistant accesses the un-abstracted execution block, applies changes, and refreshes the Monaco editor buffer.
