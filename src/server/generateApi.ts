/**
 * Agent-facing HTTP API for tool generation.
 *
 * The browser reaches Claude through CSRF-protected server functions
 * (src/rpc/tgsServerFns.ts). An external AI agent cannot: it has no session, no
 * CSRF token, and it wants finished files back rather than a queue of edits for
 * a React store to apply. This module is that second door — one stateless POST
 * that runs the same assistant turn, applies the returned edits to a bundle
 * server-side, and renders the four tool files.
 *
 * Mounted at /api/* from src/server.ts, ahead of TanStack routing.
 *
 *   POST /api/tools/generate
 *   Authorization: Bearer $TGS_API_KEY
 *   { "prompt": "...", "name"?: "weather", "tool"?: { ts?, json?, env?, tests? } }
 *
 * Statelessness is the whole contract: to iterate, post the `.ts` you got back
 * together with the next instruction.
 */

import { z } from "zod";

import type { ToolConfig, ToolTest } from "@/lib/tgs/contract";
import type { AssistantEdit, ClaudeFailure } from "@/server/claude";
import { createDefaultBundle } from "@/lib/tgs/defaultTool";
import {
  deepMerge,
  fileNames,
  parseBundleFromFilesDetailed,
  renameTool,
  renderBundle,
  validateToolTest,
  type ToolBundle,
  type ToolFileContents,
} from "@/lib/tgs/toolFiles";

export const GENERATE_PATH = "/api/tools/generate";

/** Same ceiling per field as the browser path (tgsServerFns.MAX_FIELD_BYTES). */
const MAX_FILE_CHARS = 400 * 1024;

const bodySchema = z.object({
  prompt: z.string().min(1).max(20_000),
  name: z.string().max(64).optional(),
  tool: z
    .object({
      ts: z.string().max(MAX_FILE_CHARS).optional(),
      json: z.string().max(MAX_FILE_CHARS).optional(),
      env: z.string().max(40_000).optional(),
      tests: z.string().max(MAX_FILE_CHARS).optional(),
    })
    .optional(),
  model: z.string().max(120).optional(),
});

/* ------------------------------------------------------------------ */
/* edit application                                                    */
/* ------------------------------------------------------------------ */

function mergeConfigs(bundle: ToolBundle, patch: Record<string, unknown>): ToolBundle {
  return {
    ...bundle,
    config: deepMerge(bundle.config, patch) as Partial<ToolConfig>,
    // The UI lets the embedded and standalone configs diverge on purpose
    // (12-screen-config.md §4). Over HTTP there is no one to reconcile them, so
    // both move together.
    configJson: deepMerge(bundle.configJson, patch) as Partial<ToolConfig>,
  };
}

/**
 * The server-side twin of AiSidebar's `applyEdit`: same AssistantEdit kinds,
 * applied to a plain bundle instead of the React store. `request_run` is dropped
 * — there is no browser here to run the Deno harness or Pyodide.
 */
export function applyEdits(bundle: ToolBundle, edits: AssistantEdit[]): ToolBundle {
  let next = bundle;
  for (const edit of edits) {
    switch (edit.kind) {
      case "logic":
        next = { ...next, logic: edit.logic };
        break;
      case "config":
        next = mergeConfigs(next, edit.patch);
        break;
      case "error_advice":
        next = mergeConfigs(next, {
          signature: {
            errors: {
              [edit.code]: {
                description: edit.description,
                actionable_advice: edit.actionable_advice,
              },
            },
          },
        });
        break;
      case "test": {
        if (!validateToolTest(edit.test)) break;
        const test = edit.test as ToolTest;
        if (edit.target === "ts") {
          const tests = [...(next.config.tests ?? []), test];
          next = mergeConfigs(next, { tests });
        } else {
          next = { ...next, jsonTests: [...next.jsonTests, test] };
        }
        break;
      }
      case "request_run":
        break;
    }
  }

  // The model may have renamed the tool through a config patch; filenames follow.
  const named = typeof next.config.name === "string" ? next.config.name.trim() : "";
  return named === "" || named === next.name ? next : renameTool(next, named);
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function readEnv(name: string): string | undefined {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  const value = g.process?.env?.[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function fail(status: number, code: string, error: string): Response {
  return json(status, { ok: false, code, error });
}

/** Null when the caller is authorized, otherwise the response to send back. */
function authorize(request: Request): Response | null {
  const expected = readEnv("TGS_API_KEY");
  if (expected === undefined) {
    return fail(
      503,
      "API_DISABLED",
      "TGS_API_KEY is not set on the server, so the generation API is closed. Set it in the environment and restart.",
    );
  }
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  // ponytail: plain compare. Remote timing attacks through TLS + network jitter
  // are not practical against a high-entropy key; swap in a digest compare if
  // this ever moves somewhere an attacker can measure locally.
  if (presented === "" || presented !== expected) {
    return fail(401, "UNAUTHORIZED", "Send `Authorization: Bearer <TGS_API_KEY>`.");
  }
  return null;
}

/** Maps a typed Claude failure onto the HTTP status an agent should react to. */
function statusForClaudeFailure(code: string): number {
  switch (code) {
    case "NO_API_KEY":
      return 503;
    case "RATE_LIMIT":
      return 429;
    case "TOO_LARGE":
      return 413;
    default:
      return 502;
  }
}

async function handleGenerate(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail(400, "BAD_JSON", "Request body must be JSON.");
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return fail(400, "BAD_REQUEST", detail);
  }
  const { prompt, name, tool, model } = parsed.data;

  // Seed: the caller's files when supplied, otherwise the stock `calc` example
  // so the model always sees a contract-valid tool to work from.
  const fromScratch = tool?.ts === undefined || tool.ts.trim() === "";
  // Rebuilt key by key: `exactOptionalPropertyTypes` will not widen zod's
  // `string | undefined` into ToolFileContents' optional slots.
  const files: ToolFileContents = {
    ...(tool?.ts === undefined ? {} : { ts: tool.ts }),
    ...(tool?.json === undefined ? {} : { json: tool.json }),
    ...(tool?.env === undefined ? {} : { env: tool.env }),
    ...(tool?.tests === undefined ? {} : { tests: tool.tests }),
  };
  const seeded = fromScratch
    ? { bundle: createDefaultBundle(), diagnostics: [] as string[] }
    : parseBundleFromFilesDetailed(files, name);
  let bundle = seeded.bundle;
  if (name !== undefined && name.trim() !== "" && name.trim() !== bundle.name) {
    bundle = renameTool(bundle, name);
  }

  const message = fromScratch
    ? `${prompt}\n\n(The tool currently in context is an unrelated seed example. Replace its name, logic, config, signature and tests entirely with the tool described above.)`
    : prompt;

  const { runAssistantTurn } = await import("@/server/claude");
  const turn = await runAssistantTurn({
    messages: [{ role: "user", content: message }],
    context: {
      toolName: bundle.name,
      tsCode: renderBundle(bundle).ts,
      configJson: bundle.configJson,
    },
    activeTab: "Editor",
    ...(model === undefined ? {} : { model }),
  });

  if (!turn.ok) {
    const failure = turn as ClaudeFailure;
    return fail(statusForClaudeFailure(failure.code), failure.code, failure.error);
  }

  const next = applyEdits(bundle, turn.edits);
  const names = fileNames(next.name);
  const rendered = renderBundle(next);

  return json(200, {
    ok: true,
    name: next.name,
    reply: turn.reply,
    edits: turn.edits,
    config: next.config,
    files: {
      [names.ts]: rendered.ts,
      [names.json]: rendered.json,
      [names.env]: rendered.env,
      [names.tests]: rendered.tests,
    },
    ...(seeded.diagnostics.length === 0 ? {} : { diagnostics: seeded.diagnostics }),
  });
}

/** Entry point for every /api/* request. Never throws. */
export async function handleApiRequest(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname !== GENERATE_PATH) {
    return fail(
      404,
      "NOT_FOUND",
      `No API route at ${pathname}. The only route is POST ${GENERATE_PATH}.`,
    );
  }
  if (request.method !== "POST") {
    return json(
      405,
      { ok: false, code: "METHOD_NOT_ALLOWED", error: `Use POST ${GENERATE_PATH}.` },
      { allow: "POST" },
    );
  }

  const unauthorized = authorize(request);
  if (unauthorized !== null) return unauthorized;

  try {
    return await handleGenerate(request);
  } catch (error) {
    console.error(error);
    return fail(500, "INTERNAL", error instanceof Error ? error.message : String(error));
  }
}
