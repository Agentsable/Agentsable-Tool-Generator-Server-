// local-deno-server/server.ts
//
// The TGS local execution sandbox: a small Deno HTTP server the browser app
// fires real HTTP requests at, so the Runner never executes tool TypeScript in
// the page. It mirrors the production Simple Tools Server (STS) contract:
// a tool is a single .ts file exporting `config` + a default `execute`, and the
// router builds a FRESH ToolExecutionContext for every request.
//
//   deno run --allow-all server.ts            # port 8080
//   TGS_RUNNER_PORT=9099 deno run --allow-all server.ts
//
// See README.md for the full HTTP contract.

import type {
  SDKToolManifest,
  ToolConfig,
  ToolExecutionContext,
  ToolStorage,
  ToolTest,
} from "./core/contracts/ToolContract.ts";
import { networkGateway } from "./core/network/network_gateway.ts";
import { CoreToolError, fsWriter } from "./core/tools/fs_writer.ts";
import { createFileSpaceStorage } from "./core/storage/local_storage.ts";

export const SERVER_KIND = "tgs-local-deno-server";
export const SERVER_VERSION = "1.0.0";
export const DEFAULT_PORT = 8080;

/** Hard ceiling on internalFetch nesting, so a tool cycle cannot spin forever. */
const MAX_INTERNAL_DEPTH = 8;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RPM = 60;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

type ExecuteFn = (request: Request, context: ToolExecutionContext) => Promise<Response> | Response;

interface MountedTool {
  name: string;
  config: ToolConfig;
  execute: ExecuteFn;
  /** Secret values from the Secrets screen; merged over Deno.env at call time. */
  env: Record<string, string>;
  tests: ToolTest[];
  modulePath: string;
  mountedAt: string;
  /** Sliding-window rate limiter: epoch-ms of accepted executions. */
  hits: number[];
}

export interface RunnerServer {
  port: number;
  hostname: string;
  url: string;
  registry: Map<string, MountedTool>;
  shutdown: () => Promise<void>;
  finished: Promise<void>;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SERVER_DIR = new URL("./", import.meta.url);
const CORE_DIR_HREF = new URL("./core/", SERVER_DIR).href; // ends with "/"

function fileSpaceRoot(): string {
  const override = safeEnvGet("TGS_FILESPACE_DIR");
  if (override) return override;
  return new URL("./.tgs-filespace", SERVER_DIR).pathname;
}

function safeEnvGet(key: string): string | undefined {
  try {
    return Deno.env.get(key);
  } catch {
    return undefined;
  }
}

function safeEnvObject(): Record<string, string> {
  try {
    return Deno.env.toObject();
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

const ALLOWED_METHODS = "GET, POST, PUT, DELETE, OPTIONS";
const FALLBACK_ALLOWED_HEADERS =
  "Content-Type, Authorization, x-sts-origin, x-sts-api-key, x-tgs-tool";

function corsHeaders(req: Request): Record<string, string> {
  const requested = req.headers.get("access-control-request-headers");
  return {
    "access-control-allow-origin": req.headers.get("origin") ?? "*",
    "access-control-allow-methods": ALLOWED_METHODS,
    "access-control-allow-headers": requested && requested.length > 0
      ? requested
      : FALLBACK_ALLOWED_HEADERS,
    "access-control-expose-headers": "x-tgs-duration-ms, x-tgs-tool, x-tgs-user",
    "access-control-max-age": "86400",
    vary: "Origin, Access-Control-Request-Headers",
  };
}

/** A CORS preflight is an OPTIONS carrying Access-Control-Request-Method. */
function isCorsPreflight(req: Request): boolean {
  return req.method === "OPTIONS" && req.headers.has("access-control-request-method");
}

function withCors(res: Response, req: Request): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(req))) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}

// ---------------------------------------------------------------------------
// Context construction
// ---------------------------------------------------------------------------

/** The 6 characters after `sk-`; a stable dev id when no key is configured. */
export function deriveUserId(env: Record<string, string>): string {
  const key = env.STS_API_KEY ?? env.STS_APIKEY ?? "";
  const match = /^sk-(.{6})/.exec(key);
  if (match) return match[1];
  return "local1";
}

function deriveOrigin(req: Request): ToolExecutionContext["origin"] {
  const raw = (req.headers.get("x-sts-origin") ?? "").trim().toLowerCase();
  if (raw === "agent" || raw === "sdk_rest" || raw === "mcp_client") return raw;
  return "sdk_rest";
}

function dependencyRefusal(caller: MountedTool, toolName: string) {
  return {
    error: "DEPENDENCY_NOT_DECLARED",
    message:
      `Tool "${caller.name}" tried to call "${toolName}", which is not in its tool_dependencies.`,
    actionable_advice:
      `Add "${toolName}" to config.tool_dependencies in ${caller.name}.ts, then re-mount the tool.`,
    declared: caller.config.tool_dependencies ?? [],
  };
}

interface BuildContextOptions {
  tool: MountedTool;
  req: Request;
  registry: Map<string, MountedTool>;
  depth: number;
}

function buildContext(opts: BuildContextOptions): ToolExecutionContext {
  const { tool, req, registry, depth } = opts;

  // Mount env wins over the process env.
  const env: Record<string, string> = { ...safeEnvObject(), ...tool.env };
  const userId = deriveUserId(env);

  let storage: ToolStorage | undefined;
  try {
    storage = createFileSpaceStorage(fileSpaceRoot(), userId);
  } catch {
    storage = undefined; // no disk backend available at all
  }

  const context: ToolExecutionContext = {
    userId,
    origin: deriveOrigin(req),
    env,
    storage,
    callerConfig: tool.config,

    internalFetch: async (toolName: string, init?: RequestInit): Promise<Response> => {
      const declared = tool.config.tool_dependencies ?? [];
      if (!declared.includes(toolName)) {
        // Rule 3 — refused, and refused as data the tool can read and report.
        return json(dependencyRefusal(tool, toolName), 403);
      }
      if (depth >= MAX_INTERNAL_DEPTH) {
        return json({
          error: "INTERNAL_DEPTH_EXCEEDED",
          message: `internalFetch nesting exceeded ${MAX_INTERNAL_DEPTH}.`,
          actionable_advice: "Break the tool-to-tool call cycle.",
        }, 508);
      }
      const sibling = registry.get(toolName);
      if (!sibling) {
        return json({
          error: "TOOL_NOT_MOUNTED",
          message: `"${toolName}" is declared as a dependency but is not mounted on this runner.`,
          actionable_advice: `PUT /tools/${toolName} with its source before running ${tool.name}.`,
        }, 404);
      }
      const innerReq = new Request(`http://internal.tgs/${toolName}`, {
        method: init?.method ?? "POST",
        headers: mergeInternalHeaders(req, init),
        body: init?.body ?? "{}",
      });
      const { response } = await runTool(sibling, innerReq, registry, depth + 1);
      return response;
    },

    useCoreTool: async (toolName: string, params: any): Promise<any> => {
      const declared = tool.config.tool_dependencies ?? [];
      if (!declared.includes(toolName)) {
        const refusal = dependencyRefusal(tool, toolName);
        throw Object.assign(new Error(refusal.message), {
          code: refusal.error,
          actionable_advice: refusal.actionable_advice,
          toJSON: () => refusal,
        });
      }
      switch (toolName) {
        case "network_gateway":
          return await networkGateway(params ?? {}, context);
        case "fs_writer":
          return await fsWriter(params ?? {}, context);
        default:
          throw new CoreToolError(
            "UNKNOWN_CORE_TOOL",
            `"${toolName}" is not a core tool on this runner.`,
            'Available core tools: "network_gateway", "fs_writer".',
          );
      }
    },
  };

  return context;
}

function mergeInternalHeaders(outer: Request, init?: RequestInit): Headers {
  const headers = new Headers(init?.headers ?? {});
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  const origin = outer.headers.get("x-sts-origin");
  if (origin && !headers.has("x-sts-origin")) headers.set("x-sts-origin", origin);
  return headers;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function runTool(
  tool: MountedTool,
  request: Request,
  registry: Map<string, MountedTool>,
  depth: number,
): Promise<{ response: Response; durationMs: number }> {
  const context = buildContext({ tool, req: request, registry, depth });
  const timeoutMs = tool.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = performance.now();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Response>((resolve) => {
    timer = setTimeout(() => {
      resolve(json({
        error: "TOOL_TIMEOUT",
        message: `Tool "${tool.name}" exceeded its timeoutMs of ${timeoutMs}ms.`,
        actionable_advice:
          "Reduce the work done per call, or raise config.timeoutMs in the tool file.",
        tool: tool.name,
        timeoutMs,
      }, 500));
    }, timeoutMs);
  });

  let response: Response;
  try {
    const executed = Promise.resolve()
      .then(() => tool.execute(request, context))
      .then((res) => {
        if (!(res instanceof Response)) {
          return json({
            error: "TOOL_CONTRACT_VIOLATION",
            message: `Tool "${tool.name}" did not return a Web Response.`,
            actionable_advice: "Return Response.json({...}, { status }) from execute().",
          }, 500);
        }
        return res;
      });
    response = await Promise.race([executed, timeout]);
  } catch (err) {
    // Rule 5 said the tool must not throw. It threw anyway — contain it here so
    // the runner process survives.
    response = json({
      error: "TOOL_THREW",
      message: err instanceof Error ? err.message : String(err),
      actionable_advice:
        "Wrap execute() in try/catch and return an HTTP 4xx/5xx JSON body matching config.signature.errors.",
      tool: tool.name,
      stack: err instanceof Error ? err.stack : undefined,
    }, 500);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  const durationMs = Math.round(performance.now() - startedAt);

  // Copy through verbatim (status, headers, body) plus the duration header.
  const headers = new Headers(response.headers);
  headers.set("x-tgs-duration-ms", String(durationMs));
  headers.set("x-tgs-tool", tool.name);
  headers.set("x-tgs-user", context.userId);
  const body = response.body === null ? null : await response.arrayBuffer();

  return {
    response: new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
    durationMs,
  };
}

/** Sliding one-minute window, per mounted tool. */
function checkRateLimit(tool: MountedTool): { ok: true } | { ok: false; retryAfterMs: number } {
  const rpm = tool.config.rateLimit?.requestsPerMinute ?? DEFAULT_RPM;
  const now = Date.now();
  const windowStart = now - 60_000;
  tool.hits = tool.hits.filter((t) => t > windowStart);
  if (tool.hits.length >= rpm) {
    const oldest = tool.hits[0];
    return { ok: false, retryAfterMs: Math.max(1, oldest + 60_000 - now) };
  }
  tool.hits.push(now);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

let mountCounter = 0;
let tempDirPromise: Promise<string> | null = null;

function tempDir(): Promise<string> {
  if (!tempDirPromise) tempDirPromise = Deno.makeTempDir({ prefix: "tgs-runner-" });
  return tempDirPromise;
}

/**
 * Rewrite the STS-absolute `/core/...` specifiers a tool file uses into local
 * file: URLs, so the temp copy resolves against this server's core modules.
 */
export function rewriteCoreImports(code: string, coreHref: string = CORE_DIR_HREF): string {
  return code.replace(
    /(["'])\/core\/([^"'\n]*)\1/g,
    (_m, quote: string, rest: string) => `${quote}${coreHref}${rest}${quote}`,
  );
}

export interface MountRequestBody {
  code: string;
  env?: Record<string, string>;
  tests?: ToolTest[];
}

export class MountError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "MountError";
    this.code = code;
    this.status = status;
  }
}

export async function mountTool(
  registry: Map<string, MountedTool>,
  name: string,
  body: MountRequestBody,
): Promise<MountedTool> {
  if (!name || !/^[A-Za-z0-9_.-]{1,80}$/.test(name)) {
    throw new MountError(
      "INVALID_TOOL_NAME",
      `"${name}" is not a valid tool name (letters, digits, _ . - only).`,
    );
  }
  if (typeof body?.code !== "string" || body.code.trim() === "") {
    throw new MountError("INVALID_BODY", "Request body must include a non-empty `code` string.");
  }

  const dir = await tempDir();
  // Unique filename per mount: Deno's module cache is keyed by URL, so a stale
  // version can never be served after a re-mount.
  const stamp = `${++mountCounter}-${crypto.randomUUID()}`;
  const modulePath = `${dir}/${name}.${stamp}.ts`;
  await Deno.writeTextFile(modulePath, rewriteCoreImports(body.code));

  let mod: Record<string, unknown>;
  try {
    mod = await import(`${new URL(`file://${modulePath}`).href}?v=${stamp}`);
  } catch (err) {
    await Deno.remove(modulePath).catch(() => {});
    throw new MountError(
      "COMPILE_ERROR",
      err instanceof Error ? err.message : String(err),
    );
  }

  const config = mod.config as ToolConfig | undefined;
  const execute = mod.default as ExecuteFn | undefined;

  if (!config || typeof config !== "object") {
    await Deno.remove(modulePath).catch(() => {});
    throw new MountError(
      "MISSING_CONFIG_EXPORT",
      `Tool "${name}" must "export const config = await initToolConfig(import.meta.url, baseConfig)".`,
    );
  }
  if (typeof execute !== "function") {
    await Deno.remove(modulePath).catch(() => {});
    throw new MountError(
      "MISSING_EXECUTE_EXPORT",
      `Tool "${name}" must "export default async function execute(request, context)".`,
    );
  }
  if (!config.signature || typeof config.signature !== "object") {
    await Deno.remove(modulePath).catch(() => {});
    throw new MountError(
      "INVALID_CONFIG",
      `Tool "${name}" config is missing a \`signature\` block.`,
    );
  }

  const previous = registry.get(name);
  if (previous) await Deno.remove(previous.modulePath).catch(() => {});

  const mounted: MountedTool = {
    name,
    config,
    execute,
    env: body.env ?? {},
    tests: body.tests ?? config.tests ?? [],
    modulePath,
    mountedAt: new Date().toISOString(),
    hits: [],
  };
  registry.set(name, mounted);
  return mounted;
}

function toManifest(config: ToolConfig): SDKToolManifest {
  return {
    name: config.name,
    description: config.description,
    version: config.version,
    cost: config.cost,
    isIdempotent: config.isIdempotent,
    signature: config.signature,
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function handleRequest(
  req: Request,
  registry: Map<string, MountedTool>,
): Promise<Response> {
  // 1. CORS preflight — answered before anything else, and kept strictly apart
  //    from a real manifest OPTIONS (which carries no Access-Control-Request-Method).
  if (isCorsPreflight(req)) {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter((s) => s.length > 0);

  try {
    // 2. GET /health
    if (req.method === "GET" && segments.length === 1 && segments[0] === "health") {
      return withCors(
        json({
          ok: true,
          kind: SERVER_KIND,
          version: SERVER_VERSION,
          mounted: [...registry.keys()].sort(),
        }),
        req,
      );
    }

    // 3. GET /tools — convenience listing for the app's Runner dashboard.
    if (req.method === "GET" && segments.length === 1 && segments[0] === "tools") {
      return withCors(
        json({
          ok: true,
          tools: [...registry.values()].map((t) => ({
            name: t.name,
            mountedAt: t.mountedAt,
            version: t.config.version,
            tests: t.tests.length,
          })),
        }),
        req,
      );
    }

    // 4. PUT/DELETE/GET /tools/:name
    if (segments.length === 2 && segments[0] === "tools") {
      const name = decodeURIComponent(segments[1]);

      if (req.method === "PUT") {
        let body: MountRequestBody;
        try {
          body = await req.json();
        } catch (err) {
          return withCors(
            json({
              error: "INVALID_JSON",
              message: err instanceof Error ? err.message : String(err),
            }, 400),
            req,
          );
        }
        try {
          const mounted = await mountTool(registry, name, body);
          return withCors(
            json({
              ok: true,
              name: mounted.name,
              config: mounted.config,
              tests: mounted.tests,
              mountedAt: mounted.mountedAt,
            }),
            req,
          );
        } catch (err) {
          if (err instanceof MountError) {
            return withCors(json({ error: err.code, message: err.message }, err.status), req);
          }
          return withCors(
            json({
              error: "MOUNT_FAILED",
              message: err instanceof Error ? err.message : String(err),
            }, 400),
            req,
          );
        }
      }

      if (req.method === "DELETE") {
        const existing = registry.get(name);
        if (!existing) {
          return withCors(
            json({ error: "TOOL_NOT_MOUNTED", message: `"${name}" is not mounted.` }, 404),
            req,
          );
        }
        registry.delete(name);
        await Deno.remove(existing.modulePath).catch(() => {});
        return withCors(json({ ok: true, name, unmounted: true }), req);
      }

      if (req.method === "GET") {
        const existing = registry.get(name);
        if (!existing) {
          return withCors(
            json({ error: "TOOL_NOT_MOUNTED", message: `"${name}" is not mounted.` }, 404),
            req,
          );
        }
        return withCors(
          json({ ok: true, name, config: existing.config, tests: existing.tests }),
          req,
        );
      }

      return withCors(
        json({ error: "METHOD_NOT_ALLOWED", message: `${req.method} /tools/${name}` }, 405),
        req,
      );
    }

    // 5. /:name — the tool endpoints.
    if (segments.length === 1) {
      const name = decodeURIComponent(segments[0]);
      const tool = registry.get(name);

      if (req.method === "OPTIONS") {
        // A real SDK manifest request (not a CORS preflight — that returned above).
        if (!tool) {
          return withCors(
            json({
              error: "TOOL_NOT_MOUNTED",
              message: `"${name}" is not mounted.`,
              actionable_advice: `PUT /tools/${name} with the tool source first.`,
            }, 404),
            req,
          );
        }
        return withCors(json(toManifest(tool.config)), req);
      }

      if (req.method === "POST") {
        if (!tool) {
          return withCors(
            json({
              error: "TOOL_NOT_MOUNTED",
              message: `"${name}" is not mounted.`,
              actionable_advice: `PUT /tools/${name} with the tool source first.`,
            }, 404),
            req,
          );
        }

        const limit = checkRateLimit(tool);
        if (!limit.ok) {
          return withCors(
            json({
              error: "RATE_LIMITED",
              message:
                `"${name}" exceeded its rateLimit of ${tool.config.rateLimit?.requestsPerMinute} requests per minute.`,
              actionable_advice:
                "Back off and retry after the window, or raise config.rateLimit.requestsPerMinute.",
              tool: name,
              requestsPerMinute: tool.config.rateLimit?.requestsPerMinute ?? DEFAULT_RPM,
              retryAfterMs: limit.retryAfterMs,
            }, 429, { "retry-after": String(Math.ceil(limit.retryAfterMs / 1000)) }),
            req,
          );
        }

        const { response } = await runTool(tool, req, registry, 0);
        return withCors(response, req);
      }

      return withCors(
        json({
          error: "METHOD_NOT_ALLOWED",
          message: `${req.method} /${name}. Use POST to execute, OPTIONS for the manifest.`,
        }, 405),
        req,
      );
    }

    return withCors(
      json({
        error: "NOT_FOUND",
        message: `No route for ${req.method} ${url.pathname}.`,
        routes: ["GET /health", "GET /tools", "PUT /tools/:name", "DELETE /tools/:name", "GET /tools/:name", "POST /:name", "OPTIONS /:name"],
      }, 404),
      req,
    );
  } catch (err) {
    // The router itself must never take the process down.
    return withCors(
      json({
        error: "ROUTER_ERROR",
        message: err instanceof Error ? err.message : String(err),
      }, 500),
      req,
    );
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export function startServer(options: { port?: number; hostname?: string; quiet?: boolean } = {}): RunnerServer {
  const registry = new Map<string, MountedTool>();
  // `Number("nope")` is NaN, not null, so a `??` chain would hand NaN to Deno.serve.
  const envPort = Number(safeEnvGet("TGS_RUNNER_PORT"));
  const requestedPort =
    options.port ?? (Number.isInteger(envPort) && envPort > 0 ? envPort : DEFAULT_PORT);
  const hostname = options.hostname ?? "127.0.0.1";

  let resolvedPort = requestedPort;
  const server = Deno.serve({
    port: requestedPort,
    hostname,
    onListen: ({ port }) => {
      resolvedPort = port;
      if (!options.quiet) {
        console.log(`[${SERVER_KIND} v${SERVER_VERSION}] listening on http://${hostname}:${port}`);
        console.log(`  GET    /health`);
        console.log(`  PUT    /tools/:name   { code, env?, tests? }`);
        console.log(`  DELETE /tools/:name`);
        console.log(`  POST   /:name         <raw test payload JSON>`);
        console.log(`  OPTIONS /:name        SDK manifest`);
      }
    },
    onError: (err) => {
      return json({
        error: "ROUTER_ERROR",
        message: err instanceof Error ? err.message : String(err),
      }, 500);
    },
  }, (req) => handleRequest(req, registry));

  return {
    get port() {
      return resolvedPort;
    },
    hostname,
    get url() {
      return `http://${hostname}:${resolvedPort}`;
    },
    registry,
    shutdown: () => server.shutdown(),
    finished: server.finished,
  };
}

if (import.meta.main) {
  startServer();
}
