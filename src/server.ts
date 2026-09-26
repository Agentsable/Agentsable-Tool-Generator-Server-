import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

// The API renders tool files through src/lib/tgs/ast.ts, which parses with the
// TypeScript compiler. unenv gives the Worker a `process.versions.node`, so `ts`
// takes its Node path at module-eval and reads `__filename`, which workerd has
// no concept of — the module throws before a single request is served. Two
// globals are enough to get it past that probe.
function shimNodeFileGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  g["__filename"] ??= "/worker.js";
  g["__dirname"] ??= "/";
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      // The agent-facing JSON API is handled before TanStack routing: server
      // functions are CSRF-protected for the browser, and an external agent has
      // no token to send. Imported lazily so zod and the Anthropic SDK stay out
      // of the SSR path.
      if (new URL(request.url).pathname.startsWith("/api/")) {
        shimNodeFileGlobals();
        const { handleApiRequest } = await import("./server/generateApi");
        return await handleApiRequest(request);
      }

      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
