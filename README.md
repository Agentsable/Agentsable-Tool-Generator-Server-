# Tool Weaver

Here is the comprehensive UI overview of the Tool Generator Server (TGS) application. This breakdown details the visual ASCII layout and the underlying logic for each of the core screens in the workspace.

## 1. Global Application Shell (Base44 Layout)

The global shell provides a persistent workspace context. It ensures the developer and the AI assistant always operate on the same single source of truth.

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

**Underlying Logic:**

* **State Management:** The frontend maintains a global state (e.g., via Zustand) representing the current tool's code, configuration, secrets, and tests.

* **AI Integration:** The left pane runs the `claude-agent-sdk-typescript` framework. It is hooked into the global state, allowing the AI to read the active tab, propose code edits, and trigger test executions directly.

* **Top Bar Operations:** The folder dropdown utilizes the browser's File System Access API to mount a local directory, while the `[ 🚀 Publish ]` button bundles the code for deployment to the production Simple Tools Server (STS).

---

## 2. [ Raw Data ] Screen

A read-only, developer-centric view displaying the exact files that constitute the tool bundle.

```text

+=============================================================================================+

|                              |  📄 RAW DATA: [ tool.ts ] [ tool.json ] [ tool.env ] [ tests.json ]

|  🤖 AI Assistant             | -----------------------------------------------------------  |

|  --------------------------  |   1 // Combined execution logic and config                   |

|  You are viewing the         |   2 import { initToolConfig } from "/core/utils...";         |

|  generated TypeScript        |   3                                                          |

|  file.                       |   4 export const config = { ... };                           |

|                              |   5                                                          |

|  [ Type a command...    ] [^]|   6 export default async function execute(...) { ... }       |

+=============================================================================================+

```

**Underlying Logic:**

* **Four-File Ecosystem:** Organizes the tool into its `.ts` source, external `.json` schema, local `.env` secrets, and external `_tests.json` suite.

* **Serialization Sync:** Any modification made in the visual builders (like Config or Editor) is instantly serialized and reflected in these raw text files.

---

## 3. [ Editor ] Screen

A strictly focused Monaco workspace for writing execution logic.

```text

+=============================================================================================+

|                              |  [ TypeScript Logic View - Config Block Hidden ]             |

|  🤖 AI Assistant             | -----------------------------------------------------------  |

|  --------------------------  |  1 import type { ToolExecutionContext } from "/core/contrac  |

|  I hid the config block      |  2                                                           |

|  so you can focus on         |  3 export default async function execute(request, context) { |

|  the execution flow.         |  4    const payload = await request.json();                  |

|                              |  5                                                           |

|  [ Type a command...    ] [^]|  6    return Response.json({ success: true });               |

+=============================================================================================+

```

**Underlying Logic:**

* **AST Abstraction:** Uses an Abstract Syntax Tree (AST) parser to read the raw `.ts` file, locate the `export const config` block, and hide it from the editor view.

* **Execution Focus:** Developers only see and edit the main `execute` function, returning strict, predictable JSON data wrapped in standard Web `Response` objects.

* **Recombination:** When the user hits save or switches tabs, the app stitches the visual code and the hidden config object back together seamlessly.

---

## 4. [ Config ] Screen

A nested three-view configuration builder.

```text

+=============================================================================================+

|                              |  ⚙️ CONFIGURATION: [ Form Editor ] [ Tool JSON ] [ Config JSON ] |

|  🤖 AI Assistant             | -----------------------------------------------------------  |

|  --------------------------  |  Tool Dependencies: [ "network_gateway" (x) ] [+ Add]        |

|  Want me to populate         |  Network Requests:  [ "https://api.external.com" (x) ]       |

|  the error definitions?      |  Rate Limit (RPM):  [ 300 ]                                  |

|                              |                                                              |

|  [ Type a command...    ] [^]|  > Actionable Errors [ + Add Error ]                         |

+=============================================================================================+

```

**Underlying Logic:**

* **Schema Enforcement:** The form strictly maps to the `ToolConfig` TypeScript interface.

* **Security & Gateway:** Provides fields to declare `tool_dependencies` and whitelist external URL prefixes in the `network_requests` array.

* **Self-Correction:** Provides a builder for error schemas so developers can map error codes to `actionable_advice`, enabling AI agents to self-correct upon failure.

---

## 5. [ Secrets ] Screen

A local environment variable manager that replaces flat `.env` files.

```text

+=============================================================================================+

|                              |  🔐 SECRETS CONFIGURATION                                    |

|  🤖 AI Assistant             | -----------------------------------------------------------  |

|  --------------------------  |  [ 📥 Load .env File ]  *(Fills only missing values)*        |

|  You need an API key to      | -----------------------------------------------------------  |

|  run this locally.           |  🔑 EXTERNAL_API_KEY                                       |

|                              |  Status: [ Required ]                                        |

|  [ Type a command...    ] [^]|  Value:  [ **************************** ] [👁️]               |

+=============================================================================================+

```

**Underlying Logic:**

* **Config-Driven Rendering:** The screen parses the `secrets` dictionary from the tool's configuration and generates inputs dynamically, labeling them as mandatory or optional.

* **Safe Merging:** Loading an external `.env` file triggers a non-destructive merge that only populates empty fields, preventing the accidental overwriting of manually typed keys.

---

## 6. [ Validator ] Screen

A dual-engine diagnostic dashboard enforcing STS rules.

```text

+=============================================================================================+

|                              |  🛡️ VALIDATOR: [ Dashboard ] [ Python Rules ] [ LLM Rules ]  |

|  🤖 AI Assistant             | -----------------------------------------------------------  |

|  --------------------------  |  Health Score: [ 85 / 100 ]                                  |

|  The structural Wasm         |  Status: [ ⚠️ 1 Warning ]                                    |

|  checks passed!              |                                                              |

|                              |  [✅ Pass] rule_no_global_fetch.py (Wasm)                    |

|  [ Type a command...    ] [^]|  [⚠️ Warn] LLM Heuristic: Error description lacks advice.    |

+=============================================================================================+

```

**Underlying Logic:**

* **WebAssembly Engine:** The **Python Rules** tab uses an in-browser Pyodide runtime to execute AST-based structural checks. It verifies Cloudflare Worker compatibility, such as ensuring developers never call the global `fetch()` directly inside a tool.

* **Heuristic Engine:** The **LLM Rules** tab leverages the `claude-agent-sdk-typescript` to run qualitative tests. It feeds a markdown rubric and the tool's source code to the model, enforcing a strict JSON array output to update the dashboard's visual badges.

---

## 7. [ Runner ] Screen

An HTTP-driven execution sandbox mirroring the stateless production environment.

```text

+=============================================================================================+

|                              |  🚀 RUNNER: [ Dashboard ] [ Tool TS Tests ] [ JSON Tests ]   |

|  🤖 AI Assistant             | -----------------------------------------------------------  |

|  --------------------------  |  [ ▶ Run All Tests ]  [ ↻ Restart Local Deno Server ]        |

|  Test 1 failed. Expected     | -----------------------------------------------------------  |

|  400, got 500.               |  Source      | Test Name                | Status             |

|                              |  ----------------------------------------------------------- |

|  [ Type a command...    ] [^]|  📄 calc.ts  | Divide by Zero Error     | [❌ 500] Exp 400   |

+=============================================================================================+

```

**Underlying Logic:**

* **Zero-Trust Parity:** The web app never executes the tool's TypeScript functions directly in the browser. Instead, it spins up a local Deno wrapper process (e.g., `http://localhost:8080`) that mounts the code.

* **Payload Translation:** It extracts the HTTP-driven test definitions (containing `name`, `payload`, and `expect`) embedded in the `tests` array inside the `.ts` config block.

* **Execution:** These definitions are translated into raw HTTP `fetch()` requests and fired at the local Deno proxy, perfectly simulating how external SDKs and internal AI Agents will interact with the tool in production.

---
the app will be used to create 
Here is the main markdown document defining the STS Tool Workspace Application, consolidating the architecture, layout, and operational guidelines into a single reference.




App Overview & Architecture

The STS Tool Workspace is a local development GUI for authoring, validating, and testing Simple Tools Server (STS) tools. Built on a base44-inspired layout, it enforces Cloudflare (CF) Workers code standards (V8 isolates, no Node.js built-ins) while adhering strictly to the external sts_tool_guidelines.md specification. The application manages a single tool context globally. A persistent left-pane AI assistant, powered by the claude-agent-sdk-typescript, operates alongside the main workspace to read state, write code, and execute evaluations.




Basic File Tree Structure

Plaintext

/sts-workspace-app
├── /src
│   ├── /components       # Global UI (Left Sidebar AI, TopBar)
│   ├── /screens          # The 6 core workspace tabs
│   ├── /state            # Single source of truth (Code, Config, Secrets)
│   ├── /lib              # AST parsers, Claude SDK wrappers, Pyodide setup
│   └── App.tsx           # Main application routing
├── /local-deno-server    # HTTP wrapper for zero-trust execution
└── sts_rules.md          # LLM heuristic validation definitions


Core Workspace Screens

Raw Data: A four-pane view displaying the generated [tool].ts, [tool].json, [tool].env, and [tool]_tests.json files for developer transparency.

Editor: A Monaco TypeScript environment utilizing AST parsing to temporarily hide the config block, allowing developers to focus safely on execution logic.

Config & Secrets: Visual form builders that bidirectionally sync with the underlying JSON and code, ensuring schema compliance and securely mapping local .env variables to tool requirements.

Validator: A diagnostic dashboard evaluating structural rules via browser-based Python WebAssembly (Pyodide) and heuristic rules via the Claude SDK.

Runner: A dual-purpose sandbox that parses embedded test arrays and external JSON test suites into raw HTTP fetch() calls against the local Deno server.

Execution & Validation Engine

Zero-Trust Parity: Tests never execute TypeScript functions directly; they fire HTTP requests at a lightweight Deno proxy (e.g., http://localhost:8080) that mounts the tool, perfectly mirroring the strict, pure data API execution environment of production.

Hybrid Validation: The Claude SDK orchestrates qualitative checks (e.g., ensuring actionable errors) by passing the markdown rules and tool code to the LLM, enforcing a strict JSON output schema.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/0827a5dd-a667-4cef-8421-01a02f71bf78).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
