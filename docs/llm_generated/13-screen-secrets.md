# TGS Screen Specification: [ Secrets ]

**Source:** `docs/human_only/tool_Generator_Server.md` §4.D. The ASCII layout and mechanics below are reconstructed from the design conversation that produced that section — see the provenance note in `00-INDEX.md`.

## 1. Purpose & Architectural Role

The **Secrets** screen is a strictly mapped environment variable manager for local testing. It renders inputs **only** from the tool's `config.secrets` dictionary, so the local execution environment matches the strict secrets schema demanded by the STS architecture with no visual clutter.

Values entered here are serialized to `[tool_name].env` and injected into `context.env` by the local Deno server during Runner executions. They are **never** published with the tool code.

## 2. ASCII Layout

```text
+=============================================================================================+
| [📂 Load File] [📁 Select Local Folder ▼] | [ ✏️ weather_fetcher ] | [ 💾 Save ] [ 🚀 Publish ]|
+---------------------------------------------------------------------------------------------+
| [ Raw Data ] [ Editor ] [ Config ] [ Secrets ] [ Validator ] [ Runner ]                     |
+---------------------------------------------------------------------------------------------+
|                              |  🔐 SECRETS CONFIGURATION                                    |
|  🤖 AI Assistant             | -----------------------------------------------------------  |
|  --------------------------  |  [ 📥 Load .env File ]  *(Fills only missing values)*        |
|                              | -----------------------------------------------------------  |
|  I see you need a            |                                                              |
|  `WEATHER_API_KEY` to        |  🔑 WEATHER_API_KEY                                          |
|  run this tool locally.      |  Status: [ Required ]                                        |
|                              |  Value:  [ **************************** ] [👁️]              |
|  If you load a `.env`        |                                                              |
|  file, I will only           |  🔑 SLACK_WEBHOOK_URL                                        |
|  populate the empty          |  Status: [ Optional ]                                        |
|  fields so your existing     |  Value:  [                              ] [👁️]              |
|  inputs are safe.            |                                                              |
|                              |                                                              |
|  [ Type a command...    ] [^]|                                                              |
+=============================================================================================+
```

## 3. Screen Mechanics

* **Strict Mapping / Schema Enforcement** — the form renders inputs strictly from the keys defined in `config.secrets`. Custom or undocumented variables are not displayed here. When the Config tab adds or removes a secret, this screen re-renders to match.

* **Required vs. Optional** — each field explicitly states its requirement status (`[ Required ]` or `[ Optional ]`), derived from the `isOptional` boolean on the secret's `ToolConfig` entry. A secret with `isOptional` unset or `false` renders as Required.

* **Secure Masking** — inputs behave like password fields by default, with a `[👁️]` toggle to reveal the text.

* **Smart `.env` Loader** — `[ 📥 Load .env File ]` opens a file picker, parses the selected `.env`, and applies a **non-destructive merge**: it checks parsed keys against the current form and *only* fills fields that are currently empty. Values already typed manually are never overwritten. Keys in the `.env` that are not declared in `config.secrets` are ignored.

* **Data Flow** — changes are serialized to the `[tool_name].env` file in the global state and appear immediately in the **[ Raw Data ]** tab's `.env` pane.

* **Publish Exclusion** — `[ 🚀 Publish ]` bundles the `.ts`, `.json`, and `_tests.json` files. The `.env` file is explicitly excluded.

## 4. Interaction with the Runner

The **[ Runner ]** screen depends on this tab: the local Deno server builds a fresh `ToolExecutionContext` per request and injects these values into `context.env`. A required secret left empty will surface as whatever error the tool itself returns for a missing key (commonly HTTP 401) — TGS does not block execution on an empty required field, so the tool's own validation is exercised as it would be in production.
