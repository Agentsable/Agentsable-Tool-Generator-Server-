# Tool Generator Server (TGS) — System Specification

**Source:** `docs/human_only/tool_Generator_Server.md`, reconciled per `00-INDEX.md`.

## 1. App Overview & Ecosystem Context

The **Tool Generator Server (TGS)** is a self-hosted web application deployed at `tgs.agentsable.com`. It is a local-first development environment for authoring, configuring, validating, and testing individual tools. Once a tool passes all heuristic and structural checks in TGS, it is ready to be published and executed on the production **Simple Tools Server (STS)** at `sts.agentsable.com`.

TGS enforces Cloudflare (CF) Workers code standards (V8 isolates, no Node.js built-ins) and operates on a **Single Source of Truth** model, managing exactly one tool context at a time across all views.

## 2. The base44 Layout & AI Integration

A fixed three-zone layout maximizes horizontal workspace while keeping AI assistance always available:

* **Top Action Bar** — `[📂 Load File]`, `[📁 Select Local Folder ▼]` (File System Access API), the globally editable tool name, and `[ 💾 Save ]` / `[ 🚀 Publish ]`.
* **Left Pane (AI Assistant)** — a persistent chat interface powered by `@anthropic-ai/claude-agent-sdk`. The assistant has global context access: it reads the current code, writes updates, and triggers test executions.
* **Main Workspace (Center/Right)** — a tabbed routing interface switching between the six core screens.

```text
+=============================================================================================+
| [📂 Load File] [📁 Select Local Folder ▼] | [ ✏️ weather_fetcher ] | [ 💾 Save ] [ 🚀 Publish ]|
+---------------------------------------------------------------------------------------------+
| [ Raw Data ] [ Editor ] [ Config ] [ Secrets ] [ Validator ] [ Runner ]                     |
+---------------------------------------------------------------------------------------------+
|                              |                                                              |
|  🤖 AI Assistant             |                                                              |
|  --------------------------  |                                                              |
|                              |                 ( ACTIVE TAB WORKSPACE )                     |
|  I am ready to help you      |                                                              |
|  build this tool!            |                                                              |
|                              |                                                              |
|  [ Type a command...    ] [^]|                                                              |
+=============================================================================================+
```

**Underlying logic:**

* **State Management** — a global store (e.g. Zustand) holds the active tool's code, configuration, secrets, and tests.
* **AI Integration** — the left pane runs `@anthropic-ai/claude-agent-sdk`, hooked into the global state so the assistant can read the active tab, propose edits, and trigger test executions.
* **Top Bar Operations** — the folder dropdown uses the browser's File System Access API to mount a local directory; `[ 🚀 Publish ]` bundles the tool for deployment to STS.

## 3. Basic File Tree Structure

```text
/tgs-workspace-app
├── /src
│   ├── /components       # Global UI (TopBar, Left Sidebar AI, Tab Navigation)
│   ├── /screens          # The 6 core workspace tabs (Editor, Config, Runner, etc.)
│   ├── /state            # Global state manager (Code, Config, Secrets, Tests)
│   ├── /lib              # AST parsers, Pyodide (Wasm) setup, Claude Agent SDK wrappers
│   └── App.tsx           # Main application router
├── /local-deno-server    # HTTP wrapper for zero-trust local execution
└── sts_rules.md          # LLM heuristic validation rubric for the Claude Agent SDK
```

> `sts_rules.md` is the **LLM heuristic rubric** edited on the Validator's `[ LLM Rules ]` sub-screen. It is a different file from the tool-authoring guidelines, which live in `02-tool-authoring-guide.md`.

## 4. Core Workspace Screens (The Tabs)

Each screen has a dedicated specification in this directory.

| Tab | Purpose | Spec |
| --- | --- | --- |
| **[ Raw Data ]** | Read-only four-file developer view of the active tool | `10-screen-raw-data.md` |
| **[ Editor ]** | Monaco TypeScript editor for execution logic (config block hidden via AST) | `11-screen-editor.md` |
| **[ Config ]** | Schema builder + dual-file JSON synchronizer | `12-screen-config.md` |
| **[ Secrets ]** | Schema-driven environment variable manager for local testing | `13-screen-secrets.md` |
| **[ Validator ]** | Dual-engine diagnostics (Pyodide static analysis + Claude heuristic review) | `14-screen-validator.md` |
| **[ Runner ]** | HTTP-driven execution sandbox against the local Deno server | `15-screen-runner.md` |

## 5. Execution & Validation Engine

* **Zero-Trust Parity** — tests never execute TypeScript functions directly in the browser. They fire HTTP requests at a lightweight local Deno proxy (e.g. `http://localhost:8080`) that mounts the tool, mirroring the pure-data-API execution environment of production.
* **Hybrid Validation** — Pyodide (Python compiled to WebAssembly) runs deterministic structural checks in a Web Worker, while `@anthropic-ai/claude-agent-sdk` runs qualitative checks by passing the markdown rubric and the tool's source to the model under a strict JSON output schema.

## 6. Tool Authoring Reference

Tools developed in TGS must adhere to `02-tool-authoring-guide.md`, which maps to the V2 `ToolContract.ts` in this directory.

Key requirements enforced by TGS:

1. **Strict Output** — tools always return strict JSON data via standard Web `Response` objects.
2. **No Global Fetch** — outbound requests go through `context.useCoreTool('network_gateway', {...})` (or `dispatchToGateway`), validated against the `network_requests` array.
3. **Actionable Errors** — the schema defines errors with `actionable_advice` so AI agents can self-correct during ReAct loops.
