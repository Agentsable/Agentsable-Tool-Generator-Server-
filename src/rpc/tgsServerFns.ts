// TanStack Start server functions for the TGS Claude subsystem.
//
// These are the ONLY entry points the browser uses to reach Claude. The
// Anthropic SDK and ANTHROPIC_API_KEY live behind `await import("@/server/claude")`
// inside each handler, so neither the client bundle nor any client-imported
// module graph can ever pull them in — importing this file from a component
// only pulls in zod and the generated RPC stubs.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type {
  AssistantEdit,
  AssistantTurnSuccess,
  ClaudeAvailability,
  ClaudeFailure,
  LLMValidationResult,
  LlmValidationSuccess,
  ToolContextPayload,
} from "@/server/claude";

export type {
  AssistantEdit,
  AssistantTurnSuccess,
  ClaudeAvailability,
  ClaudeFailure,
  LLMValidationResult,
  LlmValidationSuccess,
  ToolContextPayload,
};

/** Hard payload ceiling per field. Keeps a runaway buffer from becoming a bill. */
export const MAX_FIELD_BYTES = 400 * 1024; // 400 KB
/** Ceiling on the whole chat transcript sent up for one assistant turn. */
export const MAX_TRANSCRIPT_BYTES = 1024 * 1024; // 1 MB

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function tooLarge(field: string, bytes: number, limit: number): ClaudeFailure {
  return {
    ok: false,
    code: "TOO_LARGE",
    error: `${field} is ${Math.round(bytes / 1024)} KB, over the ${Math.round(limit / 1024)} KB limit for a single Claude request.`,
  };
}

function serialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------------- */
/* Input schemas                                                              */
/* ------------------------------------------------------------------------- */

const toolContextSchema = z.object({
  toolName: z.string().max(200),
  tsCode: z.string(),
  configJson: z.unknown(),
  rubricMarkdown: z.string().optional(),
  pythonFindings: z
    .array(
      z.object({
        filename: z.string().max(300),
        passed: z.boolean(),
        message: z.string().max(8000),
      }),
    )
    .max(200)
    .optional(),
  testResults: z
    .array(
      z.object({
        name: z.string().max(300),
        source: z.string().max(300),
        ok: z.boolean(),
        detail: z.string().max(8000),
      }),
    )
    .max(200)
    .optional(),
});

const assistantTurnSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    )
    .min(1)
    .max(200),
  context: toolContextSchema,
  activeTab: z.string().max(64),
  model: z.string().max(120).optional(),
});

const llmValidationSchema = z.object({
  rubricMarkdown: z.string().min(1),
  tsCode: z.string(),
  configJson: z.unknown(),
  model: z.string().max(120).optional(),
});

export type AssistantTurnInput = z.infer<typeof assistantTurnSchema>;
export type LlmValidationInput = z.infer<typeof llmValidationSchema>;

/* ------------------------------------------------------------------------- */
/* Server functions                                                           */
/* ------------------------------------------------------------------------- */

/**
 * Is Claude usable on this server, and under which model?
 * The API key itself is never returned — only whether one is present.
 */
export const getClaudeStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<ClaudeAvailability> => {
    const { claudeAvailability } = await import("@/server/claude");
    return claudeAvailability();
  },
);

/** One turn of the persistent left-pane AI assistant. */
export const postAssistantTurn = createServerFn({ method: "POST", strict: false })
  .validator(assistantTurnSchema)
  .handler(async ({ data }): Promise<AssistantTurnSuccess | ClaudeFailure> => {
    const codeBytes = byteLength(data.context.tsCode);
    if (codeBytes > MAX_FIELD_BYTES)
      return tooLarge("The tool's TypeScript source", codeBytes, MAX_FIELD_BYTES);

    const configBytes = byteLength(serialize(data.context.configJson));
    if (configBytes > MAX_FIELD_BYTES)
      return tooLarge("The tool config", configBytes, MAX_FIELD_BYTES);

    const rubric = data.context.rubricMarkdown;
    if (rubric !== undefined) {
      const rubricBytes = byteLength(rubric);
      if (rubricBytes > MAX_FIELD_BYTES)
        return tooLarge("The LLM rubric", rubricBytes, MAX_FIELD_BYTES);
    }

    const transcriptBytes = data.messages.reduce((sum, m) => sum + byteLength(m.content), 0);
    if (transcriptBytes > MAX_TRANSCRIPT_BYTES) {
      return tooLarge("The chat transcript", transcriptBytes, MAX_TRANSCRIPT_BYTES);
    }

    // Rebuilt field by field: zod infers `configJson` as optional (z.unknown()),
    // which `exactOptionalPropertyTypes` will not widen into the required slot.
    const context: ToolContextPayload = {
      toolName: data.context.toolName,
      tsCode: data.context.tsCode,
      configJson: data.context.configJson ?? null,
      ...(rubric === undefined ? {} : { rubricMarkdown: rubric }),
      ...(data.context.pythonFindings === undefined
        ? {}
        : { pythonFindings: data.context.pythonFindings }),
      ...(data.context.testResults === undefined ? {} : { testResults: data.context.testResults }),
    };

    const { runAssistantTurn } = await import("@/server/claude");
    return runAssistantTurn({
      messages: data.messages,
      context,
      activeTab: data.activeTab,
      ...(data.model === undefined ? {} : { model: data.model }),
    });
  });

/** The Validator's [ ▶ Run LLM Validator ] action. */
export const postLlmValidation = createServerFn({ method: "POST", strict: false })
  .validator(llmValidationSchema)
  .handler(async ({ data }): Promise<LlmValidationSuccess | ClaudeFailure> => {
    const codeBytes = byteLength(data.tsCode);
    if (codeBytes > MAX_FIELD_BYTES)
      return tooLarge("The tool's TypeScript source", codeBytes, MAX_FIELD_BYTES);

    const rubricBytes = byteLength(data.rubricMarkdown);
    if (rubricBytes > MAX_FIELD_BYTES)
      return tooLarge("The LLM rubric", rubricBytes, MAX_FIELD_BYTES);

    const configBytes = byteLength(serialize(data.configJson));
    if (configBytes > MAX_FIELD_BYTES)
      return tooLarge("The tool config", configBytes, MAX_FIELD_BYTES);

    const { runLlmValidation } = await import("@/server/claude");
    return runLlmValidation({
      rubricMarkdown: data.rubricMarkdown,
      tsCode: data.tsCode,
      configJson: data.configJson,
      ...(data.model === undefined ? {} : { model: data.model }),
    });
  });
