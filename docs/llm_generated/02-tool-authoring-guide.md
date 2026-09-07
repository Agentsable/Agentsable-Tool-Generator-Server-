# STS Tool Format & Guidelines

**Source:** `docs/human_only/tools_definitions.md`, reconciled per `00-INDEX.md`.

This document defines the exact structural and operational requirements for authoring Tools within the Simple Tools Server (STS) ecosystem. The types that enforce these rules are in `ToolContract.ts` (Tool Contract V2), alongside this file.

## 1. Architectural Context: The Split Stack

The STS ecosystem is built on a **"Two First-Class Citizens"** architecture:

1. **Agents (Stateful — Python/FastAPI):** Markdown-based personas orchestrated by the Claude Agent SDK. **Agents never run tool code directly.**
2. **Tools (Stateless — Deno):** TypeScript (`.ts`) files that serve as zero-trust execution boundaries.

Because tools are hosted on the Deno server, they serve three distinct masters simultaneously via HTTP:

* **Internal AI Agents** (ReAct loops fetching context)
* **External SDKs** (standard REST clients needing raw JSON)
* **MCP Clients** (external tools like Cursor or Claude Desktop)

**Core Principle:** Regardless of who is calling, tools are pure data APIs. They must **always** return strict, predictable JSON data.

---

## 2. Tool File Structure (Block Diagram)

Every tool is a strictly contained, single `.ts` file. It must not rely on external file imports outside of the `/core/` foundational utilities.

```text
+======================================================================+
|                   STS Tool File (e.g., calc.ts)                      |
+======================================================================+
                                  |
+---------------------------------+------------------------------------+
| [1] IMPORTS                                                          |
|  ├─ initToolConfig                                                   |
|  └─ ToolContract types                                               |
+---------------------------------+------------------------------------+
                                  |
                                  v
+---------------------------------+------------------------------------+
| [2] baseConfig                                                       |
|  └─ Defines Schema, Secrets, Limits, Dependencies, Errors, Tests     |
+---------------------------------+------------------------------------+
                                  |
                                  v
+---------------------------------+------------------------------------+
| [3] export const config                                              |
|  └─ Finalized via initToolConfig(baseConfig)                         |
+---------------------------------+------------------------------------+
                                  |
                                  v
+---------------------------------+------------------------------------+
| [4] export default async function execute(request, context)          |
+---------------------------------+------------------------------------+
                                  |
                                  v
                       [ Validate Request Input ]
                              /          \
                     (Invalid)            (Valid)
                        /                    \
                       v                      v
        +-------------------------+     +-------------------------+
        | Return HTTP 400/500 JSON|     |   Perform Operation     |
        | (Error matching schema) |     |                         |
        +-------------------------+     +-------------------------+
                                                      |
                                                      v
                                        +-------------------------+
                                        | Shape Output:           |
                                        | Strict JSON Data Only   |
                                        +-------------------------+
                                                      |
                                                      v
                              +------------------------------------------+
                              |       Return standard Web Response       |
                              +------------------------------------------+
```

---

## 3. Key Components of a Tool

A valid STS Tool requires exactly two exports: `config` and `execute`.

### A. The Configuration (`export const config`)

Defined by the `ToolConfig` interface, this acts as the declarative schema for the tool.

* **`signature`** — JSON Schema defining `inputs`, `outputs`, and critically, **`errors`**. Explicit error schemas let AI agents read `actionable_advice` and self-correct when they make a mistake.
* **`secrets`** — replaces standard `.env` arrays. Declares exact requirements (e.g. `{ "SLACK_API_KEY": { description: "...", isOptional: false } }`). The server validates this before execution.
* **`tool_dependencies`** — a strict array of sibling tool names this tool is allowed to call.
* **`network_requests`** — the egress allowlist: absolute URL prefixes the tool may contact through the gateway.
* **`rateLimit`** — protects the Deno server from AI hallucination loops (e.g. `requestsPerMinute: 300`).
* **`outputModality`** — tells the caller whether to expect `text`, `image`, or `binary`.
* **`tests`** — an embedded array of HTTP-driven test definitions (`name`, `payload`, `expect`) to validate the tool's logic and error handling locally. Additional external tests can live in a sibling `[tool_name]_tests.json` file.
* **`mcpResources` / `mcpPrompts`** — native hooks for Model Context Protocol integrations.

### B. The Execution Context (`ToolExecutionContext`)

Injected into the `execute` function by the Deno router.

* **`userId`** — the 6-character jail ID parsed from the `STS_API_KEY`.
* **`origin`** — `"agent"`, `"sdk_rest"`, or `"mcp_client"`. Useful for analytics, logging, or strict feature-flagging, though the output format remains identical.
* **`env`** — the merged environment variables (system + the user's local `.env`).
* **`useCoreTool()`** — safe wrapper to invoke system utilities (like `fs_writer` or `network_gateway`).
* **`internalFetch()`** — invokes authorized sibling tools without leaving the server environment.
* **`storage`** — optional `ToolStorage` handle; absent only if no backend is available at all.
* **`callerConfig`** — the calling tool's own config, attached by `asCaller()`. `network_gateway.ts` reads `network_requests` from it to enforce the egress allowlist.

---

## 4. Example Implementation (`calc.ts`)

```typescript
import { initToolConfig } from "/core/utils/initToolConfig.ts";
import type { ToolExecutionContext, ToolConfig } from "/core/contracts/ToolContract.ts";

// 1. Declarative Configuration
const baseConfig: Partial<ToolConfig> = {
  name: "calc",
  version: "1.1.0",
  description: "Performs basic mathematical operations safely.",

  secrets: {},                           // No external API keys needed
  tool_dependencies: [],                 // Does not call any sibling tools
  rateLimit: { requestsPerMinute: 300 }, // Prevent agent hallucination spam
  outputModality: ["text"],              // Pure JSON output

  signature: {
    inputs: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
        operation: { type: "string", enum: ["add", "subtract", "multiply", "divide"] }
      },
      required: ["a", "b", "operation"]
    },
    outputs: {
      type: "object",
      properties: { result: { type: "number" }, success: { type: "boolean" } }
    },
    errors: {
      "DIV_BY_ZERO": {
        description: "Attempted to divide by zero.",
        actionable_advice: "Check if the denominator 'b' is zero before calling."
      }
    }
  },
  tests: [
    {
      name: "Valid Addition",
      payload: { a: 5, b: 3, operation: "add" },
      expect: { status: 200, hasKey: "result" }
    },
    {
      name: "Divide by Zero Error Handling",
      payload: { a: 10, b: 0, operation: "divide" },
      expect: { status: 400, hasKey: "error" }
    }
  ]
};

export const config = await initToolConfig(import.meta.url, baseConfig) as ToolConfig;

// 2. Execution Logic
export default async function execute(
  request: Request,
  context: ToolExecutionContext
): Promise<Response> {
  try {
    const { a, b, operation } = await request.json();

    if (typeof a !== "number" || typeof b !== "number") {
      return Response.json({ error: "INVALID_INPUT" }, { status: 400 });
    }

    let result = 0;
    switch (operation) {
      case "add": result = a + b; break;
      case "subtract": result = a - b; break;
      case "multiply": result = a * b; break;
      case "divide":
        if (b === 0) return Response.json({ error: "DIV_BY_ZERO" }, { status: 400 });
        result = a / b;
        break;
      default:
        return Response.json({ error: "INVALID_OPERATION" }, { status: 400 });
    }

    // 3. Strict JSON Output
    return Response.json({ success: true, result });

  } catch (error) {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
```

### External API tools: the gateway pattern

Tools that reach an external endpoint import `dispatchToGateway` and pass their own config as `callerConfig`, so the gateway can validate the target against `network_requests`:

```typescript
import { dispatchToGateway } from "/core/network/network_gateway.ts";

const result = await dispatchToGateway({
  url: targetUrl,
  method: "GET",
  headers: { "Content-Type": "application/json" }
}, { ...context, callerConfig: config });
```

Such a tool must declare `"network_gateway"` in `tool_dependencies` **and** list the endpoint prefix in `network_requests`.

---

## 5. Strict Authoring Guidelines (The 7 Rules)

Whenever creating or modifying an STS tool, the following rules are non-negotiable:

1. **Two Required Exports** — every tool must export `config` (wrapped in `initToolConfig`) and `execute(request, context)` returning a standard Web `Response`.
2. **Strict JSON Output** — tools act strictly as APIs. `execute` must **always** return strict, minimal JSON payloads, regardless of whether the caller is an internal Agent, an SDK, or an MCP client. Presentation formatting is the responsibility of the caller, not the tool.
3. **Explicit Tool Dependencies** — never call `internalFetch()` blindly. If a tool invokes a sibling tool, that sibling's name MUST be declared in `tool_dependencies`, otherwise the Deno router blocks it.
4. **Secrets over Env** — never use flat `requiredEnv` arrays. Use the `secrets` dictionary to explicitly define what the secret is and whether it is optional.
5. **Agent Error Handling** — never crash the Deno thread or throw unhandled exceptions. Catch all errors and return standard HTTP 4xx/5xx responses matching the keys defined in `config.signature.errors`. This provides `actionable_advice` to the Python Agent Orchestrator to self-correct.
6. **Rate Limiting** — always assign a sensible `rateLimit.requestsPerMinute` to protect the ecosystem from LLM hallucination loops.
7. **Zero-Trust Network** — **never** call the global `fetch()` directly inside a tool. Declare external domains in `config.network_requests` and proxy all external calls through `context.useCoreTool('network_gateway', {...})`.
