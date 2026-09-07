Here is the comprehensive architectural document for the **Tool Generator Server (TGS)**. This document acts as the master specification for building the self-hosted workspace application on `tgs.agentsable.com`.

# Tool Generator Server (TGS) Specification

## 1. App Overview & Ecosystem Context

The **Tool Generator Server (TGS)** is a self-hosted web application deployed at `tgs.agentsable.com`. It serves as a dedicated, local-first development environment for authoring, configuring, validating, and testing individual tools. Once a tool successfully passes all heuristic and structural checks within TGS, it is ready to be published and executed on the production **Simple Tools Server (STS)** at `sts.agentsable.com`.

The application strictly enforces Cloudflare (CF) Workers code standards (V8 isolates, no Node.js built-ins) and operates on a **Single Source of Truth** model, managing exactly one tool context at a time across all views.

## 2. The base44 Layout & AI Integration

The application uses a fixed, three-zone layout designed to maximize horizontal workspace while maintaining constant access to AI assistance:

* **Top Action Bar:** Contains `[📂 Load File]`, `[📁 Select Local Folder ▼]` (using the File System Access API), the globally editable tool name, and `[ 💾 Save ]` / `[ 🚀 Publish ]` controls.
* **Left Pane (AI Assistant):** A persistent chat interface powered by the `claude-agent-sdk-typescript`. The AI has global context access, allowing it to read the current code, write updates, and trigger test executions.
* **Main Workspace (Center/Right):** A tabbed routing interface switching between the six core screens.

## 3. Basic File Tree Structure

```text
/tgs-workspace-app
├── /src
│   ├── /components       # Global UI (TopBar, Left Sidebar AI, Tab Navigation)
│   ├── /screens          # The 6 core workspace tabs (Editor, Config, Runner, etc.)
│   ├── /state            # Global state manager (Code, Config, Secrets, Tests)
│   ├── /lib              # AST parsers, Pyodide (Wasm) setup, Claude SDK wrappers
│   └── App.tsx           # Main application router
├── /local-deno-server    # HTTP wrapper for zero-trust local execution
└── sts_rules.md          # LLM heuristic validation definitions for the Claude SDK

```

---

## 4. Core Workspace Screens (The Tabs)

### A. [ Raw Data ]

A read-only, four-pane developer view displaying the raw files that constitute the active tool:

* **`[tool_name].ts`:** The TypeScript execution logic and embedded config.
* **`[tool_name].json`:** The externalized JSON configuration schema.
* **`[tool_name].env`:** The plain-text mapping of local testing secrets (never deployed).
* **`[tool_name]_tests.json`:** The external file for extended HTTP test suites.

### B. [ Editor ]

A Monaco-powered TypeScript editor focused entirely on execution logic.

* **AST Abstraction:** The editor automatically parses the `.ts` file's Abstract Syntax Tree to temporarily hide the `export const config` block. This prevents developers from accidentally breaking the JSON schema while writing code.
* **Recombination:** Stitches the config and execution logic back together seamlessly upon saving.

### C. [ Config ]

A robust configuration builder featuring three nested views to manage the `ToolConfig` schema:

* **Form Editor:** A visual UI to manage metadata, network requests, rate limits, and the tool signature (inputs, outputs, and actionable errors).
* **Tool JSON / Config JSON:** Direct JSON editors for the configuration embedded in the `.ts` file and the standalone `.json` file, with bi-directional syncing.

### D. [ Secrets ]

A strictly mapped environment variable manager for local testing.

* **Schema Enforcement:** Renders inputs directly based on the `config.secrets` dictionary, explicitly marking them as "Required" or "Optional".


* **Smart Loading:** Users can click `[ 📥 Load .env File ]`, which safely merges values by only filling in missing fields to prevent overwriting manual entries.

### E. [ Validator ]

A three-pane diagnostic dashboard enforcing STS architectural rules.

* **Dashboard:** Aggregates real-time pass/fail/warning results.
* **Python Rules:** WebAssembly-powered (Pyodide) static analysis scripts running in the browser. Checks for CF Worker compatibility (e.g., no global `fetch()`). Includes a single-active Monaco editor for modifying the Python rules.


* **LLM Rules:** Powered by `claude-agent-sdk-typescript`. A Markdown editor contains qualitative prompts (e.g., ensuring error descriptions give the AI actionable advice) and explicitly defines the required JSON output schema for the SDK to parse.

### F. [ Runner ]

An HTTP-driven execution sandbox ensuring tests mirror the `sts.agentsable.com` production environment.

* **Dashboard:** An execution matrix comparing expected HTTP status codes/keys against actual results.
* **Tool TS Tests:** Displays tests embedded directly within the tool's `.ts` `config` block.


* **JSON Tests:** An editor for the external `[tool_name]_tests.json` file.
* **Execution Engine:** Translates JSON tests into raw `fetch()` calls fired at the local Deno server process, enforcing a strict Zero-Trust HTTP boundary.



---

## 5. Tool Authoring Reference

Tools developed in TGS must adhere to the external `sts_tool_guidelines.md` (which maps to the V2 `ToolContract.ts`).

Key requirements enforced by TGS include:

1. **Strict Output:** Tools must always return strict JSON Data via standard Web `Response` objects.


2. **No Global Fetch:** Tools must use `context.useCoreTool('network_gateway', {...})` for outbound requests, validated against the `network_requests` array.


3. **Actionable Errors:** The schema must define errors with `actionable_advice` so AI agents can self-correct during ReAct loops.


