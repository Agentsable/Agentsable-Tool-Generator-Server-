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
