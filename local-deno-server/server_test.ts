// local-deno-server/server_test.ts
//
//   deno test --allow-all local-deno-server/
//
// Every test starts a real server on an ephemeral port and talks to it over
// HTTP, exactly the way the TGS browser app does — no in-process shortcuts.

import { assert, assertEquals, assertExists, assertStringIncludes } from "jsr:@std/assert@1";
import { startServer, type RunnerServer } from "./server.ts";
import { LocalFileSpaceStorage } from "./core/storage/local_storage.ts";
import type { ToolConfig, ToolTest } from "./core/contracts/ToolContract.ts";

// Keep every test's File_space inside a throwaway directory.
const TEST_FILESPACE = await Deno.makeTempDir({ prefix: "tgs-test-filespace-" });
Deno.env.set("TGS_FILESPACE_DIR", TEST_FILESPACE);

const CALC_SOURCE = await Deno.readTextFile(new URL("./tools/calc.ts", import.meta.url));

async function withServer<T>(fn: (srv: RunnerServer) => Promise<T>): Promise<T> {
  const srv = startServer({ port: 0, quiet: true });
  try {
    return await fn(srv);
  } finally {
    await srv.shutdown();
  }
}

async function mount(
  srv: RunnerServer,
  name: string,
  code: string,
  env: Record<string, string> = {},
  tests: ToolTest[] = [],
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${srv.url}/tools/${name}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, env, tests }),
  });
  return { status: res.status, body: await res.json() };
}

function run(srv: RunnerServer, name: string, payload: unknown): Promise<Response> {
  return fetch(`${srv.url}/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// ---------------------------------------------------------------------------

Deno.test("GET /health reports kind, version and the mounted tools", async () => {
  await withServer(async (srv) => {
    const before = await (await fetch(`${srv.url}/health`)).json();
    assertEquals(before.ok, true);
    assertEquals(before.kind, "tgs-local-deno-server");
    assertExists(before.version);
    assertEquals(before.mounted, []);

    await mount(srv, "calc", CALC_SOURCE);

    const after = await (await fetch(`${srv.url}/health`)).json();
    assertEquals(after.mounted, ["calc"]);
  });
});

Deno.test("CORS preflight is answered and is NOT confused with a manifest OPTIONS", async () => {
  await withServer(async (srv) => {
    await mount(srv, "calc", CALC_SOURCE);

    const preflight = await fetch(`${srv.url}/calc`, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, x-sts-origin",
      },
    });
    await preflight.body?.cancel();
    assertEquals(preflight.status, 204);
    assertEquals(preflight.headers.get("access-control-allow-origin"), "http://localhost:5173");
    assertStringIncludes(preflight.headers.get("access-control-allow-methods") ?? "", "PUT");
    assertStringIncludes(preflight.headers.get("access-control-allow-headers") ?? "", "x-sts-origin");

    // A real manifest OPTIONS carries no Access-Control-Request-Method.
    const manifestRes = await fetch(`${srv.url}/calc`, { method: "OPTIONS" });
    assertEquals(manifestRes.status, 200);
    const manifest = await manifestRes.json();
    assertEquals(manifest.name, "calc");
    assertEquals(manifest.version, "1.1.0");
    assertExists(manifest.signature.inputs);
    assertExists(manifest.signature.errors.DIV_BY_ZERO);
    // The manifest is the SDK subset only — no secrets, no network_requests.
    assertEquals(Object.keys(manifest).sort(), [
      "cost",
      "description",
      "isIdempotent",
      "name",
      "signature",
      "version",
    ]);
  });
});

Deno.test("calc.ts mounts and both embedded tests pass end-to-end over HTTP", async () => {
  await withServer(async (srv) => {
    const mounted = await mount(srv, "calc", CALC_SOURCE);
    assertEquals(mounted.status, 200);
    assertEquals(mounted.body.ok, true);

    const config = mounted.body.config as ToolConfig;
    assertEquals(config.name, "calc");
    assertEquals(config.rateLimit?.requestsPerMinute, 300);
    assertEquals(config.timeoutMs, 15000); // filled in by initToolConfig
    assertEquals(config.tests?.length, 2);

    // Drive the tool's own embedded ToolTest suite, the way the Runner does.
    for (const t of config.tests ?? []) {
      const res = await run(srv, "calc", t.payload);
      const body = await res.json();
      assertEquals(res.status, t.expect.status, `${t.name}: status`);
      if (t.expect.hasKey) {
        assert(t.expect.hasKey in body, `${t.name}: expected key "${t.expect.hasKey}" in ${JSON.stringify(body)}`);
      }
      assertExists(res.headers.get("x-tgs-duration-ms"), `${t.name}: duration header`);
    }

    // Spot-check the actual values behind those two tests.
    const add = await (await run(srv, "calc", { a: 5, b: 3, operation: "add" })).json();
    assertEquals(add, { success: true, result: 8 });

    const div0res = await run(srv, "calc", { a: 10, b: 0, operation: "divide" });
    assertEquals(div0res.status, 400);
    assertEquals(await div0res.json(), { error: "DIV_BY_ZERO" });
  });
});

Deno.test("re-mounting the same name replaces the module (no stale cache)", async () => {
  await withServer(async (srv) => {
    const v1 = CALC_SOURCE;
    const v2 = CALC_SOURCE.replace('version: "1.1.0"', 'version: "9.9.9"')
      .replace("result = a + b; break;", "result = a + b + 1000; break;");

    await mount(srv, "calc", v1);
    const first = await (await run(srv, "calc", { a: 1, b: 1, operation: "add" })).json();
    assertEquals(first.result, 2);

    const remounted = await mount(srv, "calc", v2);
    assertEquals(remounted.body.config.version, "9.9.9");
    const second = await (await run(srv, "calc", { a: 1, b: 1, operation: "add" })).json();
    assertEquals(second.result, 1002);
  });
});

Deno.test("a compile error returns 400 JSON and leaves the server alive", async () => {
  await withServer(async (srv) => {
    const broken = await mount(srv, "broken", "export const config = {{{ this is not typescript");
    assertEquals(broken.status, 400);
    assertEquals(broken.body.error, "COMPILE_ERROR");
    assertExists(broken.body.message);

    const noExports = await mount(srv, "no_exports", "export const nothing = 1;\n");
    assertEquals(noExports.status, 400);
    assertEquals(noExports.body.error, "MISSING_CONFIG_EXPORT");

    const noExecute = await mount(
      srv,
      "no_execute",
      `import { initToolConfig } from "/core/utils/initToolConfig.ts";
       export const config = await initToolConfig(import.meta.url, { name: "no_execute", signature: { inputs: { type: "object", properties: {} }, outputs: { type: "object", properties: {} } } });`,
    );
    assertEquals(noExecute.status, 400);
    assertEquals(noExecute.body.error, "MISSING_EXECUTE_EXPORT");

    // Still serving.
    assertEquals((await (await fetch(`${srv.url}/health`)).json()).ok, true);
  });
});

Deno.test("DELETE /tools/:name unmounts", async () => {
  await withServer(async (srv) => {
    await mount(srv, "calc", CALC_SOURCE);
    const del = await fetch(`${srv.url}/tools/calc`, { method: "DELETE" });
    assertEquals(del.status, 200);
    assertEquals((await del.json()).unmounted, true);

    const gone = await run(srv, "calc", { a: 1, b: 1, operation: "add" });
    assertEquals(gone.status, 404);
    assertEquals((await gone.json()).error, "TOOL_NOT_MOUNTED");
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — explicit tool dependencies
// ---------------------------------------------------------------------------

const CALLER_TEMPLATE = (deps: string) =>
  `import { initToolConfig } from "/core/utils/initToolConfig.ts";
import type { ToolConfig, ToolExecutionContext } from "/core/contracts/ToolContract.ts";

const baseConfig: Partial<ToolConfig> = {
  name: "caller",
  version: "1.0.0",
  description: "Calls a sibling tool through internalFetch.",
  tool_dependencies: ${deps},
  rateLimit: { requestsPerMinute: 300 },
  signature: {
    inputs: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    outputs: { type: "object", properties: { relayed: { type: "object" } } }
  }
};

export const config = await initToolConfig(import.meta.url, baseConfig) as ToolConfig;

export default async function execute(request: Request, context: ToolExecutionContext): Promise<Response> {
  try {
    const { target, payload } = await request.json();
    const res = await context.internalFetch(target, {
      method: "POST",
      body: JSON.stringify(payload ?? {})
    });
    const body = await res.json();
    return Response.json({ relayedStatus: res.status, relayed: body }, { status: res.status === 200 ? 200 : res.status });
  } catch (error) {
    return Response.json({ error: "INTERNAL_ERROR", message: String(error) }, { status: 500 });
  }
}
`;

Deno.test("internalFetch to an UNDECLARED sibling is refused", async () => {
  await withServer(async (srv) => {
    await mount(srv, "calc", CALC_SOURCE);
    await mount(srv, "caller", CALLER_TEMPLATE("[]")); // declares nothing

    const res = await run(srv, "caller", {
      target: "calc",
      payload: { a: 2, b: 2, operation: "add" },
    });
    assertEquals(res.status, 403);
    const body = await res.json();
    assertEquals(body.relayedStatus, 403);
    assertEquals(body.relayed.error, "DEPENDENCY_NOT_DECLARED");
    assertStringIncludes(body.relayed.actionable_advice, "tool_dependencies");
  });
});

Deno.test("internalFetch to a DECLARED sibling is dispatched in-process", async () => {
  await withServer(async (srv) => {
    await mount(srv, "calc", CALC_SOURCE);
    await mount(srv, "caller", CALLER_TEMPLATE('["calc"]'));

    const res = await run(srv, "caller", {
      target: "calc",
      payload: { a: 2, b: 2, operation: "add" },
    });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { relayedStatus: 200, relayed: { success: true, result: 4 } });
  });
});

Deno.test("useCoreTool for an undeclared core tool throws inside the tool", async () => {
  await withServer(async (srv) => {
    const code = `import { initToolConfig } from "/core/utils/initToolConfig.ts";
import type { ToolConfig, ToolExecutionContext } from "/core/contracts/ToolContract.ts";
export const config = await initToolConfig(import.meta.url, {
  name: "sneaky", version: "1.0.0", description: "Calls a core tool it never declared.",
  tool_dependencies: [],
  signature: { inputs: { type: "object", properties: {} }, outputs: { type: "object", properties: {} } }
}) as ToolConfig;
export default async function execute(_r: Request, context: ToolExecutionContext): Promise<Response> {
  try {
    await context.useCoreTool("fs_writer", { op: "write", key: "x", content: "y" });
    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ error: (err as { code?: string }).code, message: String(err) }, { status: 403 });
  }
}
`;
    await mount(srv, "sneaky", code);
    const res = await run(srv, "sneaky", {});
    assertEquals(res.status, 403);
    assertEquals((await res.json()).error, "DEPENDENCY_NOT_DECLARED");
  });
});

// ---------------------------------------------------------------------------
// Rule 7 — zero-trust network
// ---------------------------------------------------------------------------

const GATEWAY_TOOL = (allowPrefix: string) =>
  `import { initToolConfig } from "/core/utils/initToolConfig.ts";
import { dispatchToGateway } from "/core/network/network_gateway.ts";
import type { ToolConfig, ToolExecutionContext } from "/core/contracts/ToolContract.ts";

export const config = await initToolConfig(import.meta.url, {
  name: "fetcher",
  version: "1.0.0",
  description: "Fetches an allowlisted URL through the gateway.",
  tool_dependencies: ["network_gateway"],
  network_requests: ["${allowPrefix}"],
  rateLimit: { requestsPerMinute: 300 },
  signature: {
    inputs: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    outputs: { type: "object", properties: { status: { type: "number" } } },
    errors: { NETWORK_NOT_ALLOWLISTED: { description: "Egress refused.", actionable_advice: "Add the prefix to network_requests." } }
  }
}) as ToolConfig;

export default async function execute(request: Request, context: ToolExecutionContext): Promise<Response> {
  const { url, viaCoreTool } = await request.json();
  try {
    const result = viaCoreTool
      ? await context.useCoreTool("network_gateway", { url, method: "GET" })
      : await dispatchToGateway({ url, method: "GET" }, { ...context, callerConfig: config });
    return Response.json({ success: true, upstreamStatus: result.status, upstreamBody: result.body });
  } catch (err) {
    const e = err as { code?: string; actionable_advice?: string; message?: string };
    return Response.json(
      { error: e.code ?? "INTERNAL_ERROR", message: e.message, actionable_advice: e.actionable_advice },
      { status: e.code === "NETWORK_NOT_ALLOWLISTED" ? 403 : 500 }
    );
  }
}
`;

Deno.test("network gateway allows an allowlisted URL and refuses everything else", async () => {
  // The "external" endpoint: a local HTTP server, so no internet is required.
  let upstreamPort = 0;
  const upstream = Deno.serve({
    port: 0,
    hostname: "127.0.0.1",
    onListen: ({ port }) => {
      upstreamPort = port;
    },
  }, (req) => {
    const path = new URL(req.url).pathname;
    return new Response(JSON.stringify({ pong: true, path }), {
      headers: { "content-type": "application/json" },
    });
  });

  try {
    await withServer(async (srv) => {
      const allowPrefix = `http://127.0.0.1:${upstreamPort}/allowed`;
      await mount(srv, "fetcher", GATEWAY_TOOL(allowPrefix));

      // INSIDE the allowlist -> real fetch, JSON body parsed.
      const okRes = await run(srv, "fetcher", { url: `${allowPrefix}/ping` });
      assertEquals(okRes.status, 200);
      const ok = await okRes.json();
      assertEquals(ok.success, true);
      assertEquals(ok.upstreamStatus, 200);
      assertEquals(ok.upstreamBody, { pong: true, path: "/allowed/ping" });

      // Same host, different path -> outside the prefix -> refused.
      const deniedPathRes = await run(srv, "fetcher", {
        url: `http://127.0.0.1:${upstreamPort}/forbidden`,
      });
      assertEquals(deniedPathRes.status, 403);
      const deniedPath = await deniedPathRes.json();
      assertEquals(deniedPath.error, "NETWORK_NOT_ALLOWLISTED");
      assertStringIncludes(deniedPath.actionable_advice, "network_requests");

      // A completely different host -> refused (and never dialled).
      const deniedHostRes = await run(srv, "fetcher", { url: "https://evil.example.com/steal" });
      assertEquals(deniedHostRes.status, 403);
      assertEquals((await deniedHostRes.json()).error, "NETWORK_NOT_ALLOWLISTED");

      // Same enforcement through useCoreTool('network_gateway', ...).
      const viaCore = await run(srv, "fetcher", {
        url: `${allowPrefix}/via-core`,
        viaCoreTool: true,
      });
      assertEquals(viaCore.status, 200);
      assertEquals((await viaCore.json()).upstreamStatus, 200);
    });
  } finally {
    await upstream.shutdown();
  }
});

// ---------------------------------------------------------------------------
// Rule 5 — a tool must never take the process down
// ---------------------------------------------------------------------------

Deno.test("a tool that throws returns 500 TOOL_THREW and the server survives", async () => {
  await withServer(async (srv) => {
    const code = `import { initToolConfig } from "/core/utils/initToolConfig.ts";
import type { ToolConfig, ToolExecutionContext } from "/core/contracts/ToolContract.ts";
export const config = await initToolConfig(import.meta.url, {
  name: "exploder", version: "1.0.0", description: "Throws on purpose.",
  rateLimit: { requestsPerMinute: 300 },
  signature: { inputs: { type: "object", properties: {} }, outputs: { type: "object", properties: {} } }
}) as ToolConfig;
export default async function execute(_r: Request, _c: ToolExecutionContext): Promise<Response> {
  throw new Error("boom from inside the tool");
}
`;
    await mount(srv, "exploder", code);

    const res = await run(srv, "exploder", {});
    assertEquals(res.status, 500);
    const body = await res.json();
    assertEquals(body.error, "TOOL_THREW");
    assertStringIncludes(body.message, "boom from inside the tool");
    assertExists(res.headers.get("x-tgs-duration-ms"));

    // Process is alive and still serving other tools.
    await mount(srv, "calc", CALC_SOURCE);
    const still = await (await run(srv, "calc", { a: 40, b: 2, operation: "add" })).json();
    assertEquals(still.result, 42);
  });
});

Deno.test({
  name: "a tool that hangs past config.timeoutMs returns 500 TOOL_TIMEOUT",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(async (srv) => {
      const code = `import { initToolConfig } from "/core/utils/initToolConfig.ts";
import type { ToolConfig, ToolExecutionContext } from "/core/contracts/ToolContract.ts";
export const config = await initToolConfig(import.meta.url, {
  name: "sleeper", version: "1.0.0", description: "Sleeps longer than its timeout.",
  timeoutMs: 100,
  rateLimit: { requestsPerMinute: 300 },
  signature: { inputs: { type: "object", properties: {} }, outputs: { type: "object", properties: {} } }
}) as ToolConfig;
export default async function execute(_r: Request, _c: ToolExecutionContext): Promise<Response> {
  await new Promise((r) => setTimeout(r, 5000));
  return Response.json({ success: true });
}
`;
      await mount(srv, "sleeper", code);
      const res = await run(srv, "sleeper", {});
      assertEquals(res.status, 500);
      const body = await res.json();
      assertEquals(body.error, "TOOL_TIMEOUT");
      assertEquals(body.timeoutMs, 100);
    });
  },
});

// ---------------------------------------------------------------------------
// Rule 6 — rate limiting
// ---------------------------------------------------------------------------

Deno.test("rate limiting returns 429 past config.rateLimit.requestsPerMinute", async () => {
  await withServer(async (srv) => {
    const code = CALC_SOURCE.replace(
      "rateLimit: { requestsPerMinute: 300 }",
      "rateLimit: { requestsPerMinute: 3 }",
    );
    const mounted = await mount(srv, "calc", code);
    assertEquals(mounted.body.config.rateLimit.requestsPerMinute, 3);

    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await run(srv, "calc", { a: 1, b: 1, operation: "add" });
      statuses.push(res.status);
      const body = await res.json();
      if (res.status === 429) {
        assertEquals(body.error, "RATE_LIMITED");
        assertEquals(body.requestsPerMinute, 3);
        assertExists(res.headers.get("retry-after"));
      }
    }
    assertEquals(statuses, [200, 200, 200, 429, 429]);
  });
});

// ---------------------------------------------------------------------------
// Storage / File_space
// ---------------------------------------------------------------------------

Deno.test("ToolStorage round-trips write/read/list/remove through a mounted tool", async () => {
  await withServer(async (srv) => {
    const code = `import { initToolConfig } from "/core/utils/initToolConfig.ts";
import type { ToolConfig, ToolExecutionContext } from "/core/contracts/ToolContract.ts";
export const config = await initToolConfig(import.meta.url, {
  name: "filer", version: "1.0.0", description: "Exercises context.storage and fs_writer.",
  tool_dependencies: ["fs_writer"],
  rateLimit: { requestsPerMinute: 300 },
  signature: { inputs: { type: "object", properties: {} }, outputs: { type: "object", properties: {} } }
}) as ToolConfig;
export default async function execute(_r: Request, context: ToolExecutionContext): Promise<Response> {
  try {
    const s = context.storage!;
    await s.write("alpha.txt", "hello file_space");
    await s.write("beta.json", JSON.stringify({ n: 1 }));

    const read = await s.read("alpha.txt");
    const listed = await s.list("");
    const prefixed = await s.list("beta");

    // ...and the same File_space seen through the fs_writer core tool.
    const viaCore = await context.useCoreTool("fs_writer", { op: "write", key: "gamma.md", content: "# hi" });
    const gamma = await s.read("gamma.md");

    await s.remove("alpha.txt");
    const afterRemove = await s.read("alpha.txt");
    const missing = await s.read("never-written.txt");

    return Response.json({
      success: true,
      kind: s.kind,
      userId: context.userId,
      origin: context.origin,
      read,
      keys: listed.map((k) => k.key),
      prefixed: prefixed.map((k) => k.key),
      viaCore,
      gamma,
      afterRemove,
      missing
    });
  } catch (error) {
    return Response.json({ error: "INTERNAL_ERROR", message: String(error) }, { status: 500 });
  }
}
`;
    await mount(srv, "filer", code);
    const res = await run(srv, "filer", {});
    assertEquals(res.status, 200);
    const body = await res.json();

    assertEquals(body.success, true);
    assertEquals(body.kind, "local-fs");
    assertEquals(body.userId, "local1");
    assertEquals(body.origin, "sdk_rest");
    assertEquals(body.read, { content: "hello file_space", size: 16 });
    assertEquals(body.keys, ["alpha.txt", "beta.json"]); // listed before gamma.md was written
    assertEquals(body.prefixed, ["beta.json"]);
    assertEquals(body.viaCore.success, true);
    assertEquals(body.gamma.content, "# hi");
    assertEquals(body.afterRemove, null);
    assertEquals(body.missing, null);
  });
});

Deno.test("LocalFileSpaceStorage keeps flat keys flat and refuses traversal", async () => {
  const root = await Deno.makeTempDir({ prefix: "tgs-storage-unit-" });
  const storage = new LocalFileSpaceStorage(`${root}/local1`);

  await storage.write("reports/2026/q1.json", '{"revenue":1}');
  assertEquals((await storage.read("reports/2026/q1.json"))?.content, '{"revenue":1}');
  // "Nested-looking" keys are ONE flat object, not a directory tree.
  const onDisk = [...Deno.readDirSync(`${root}/local1`)].map((e) => e.name);
  assertEquals(onDisk, ["reports%2F2026%2Fq1.json"]);

  await storage.write("../escape.txt", "nope");
  const escaped = [...Deno.readDirSync(root)].map((e) => e.name).sort();
  assertEquals(escaped, ["local1"]); // nothing written outside the user's root

  assertEquals((await storage.list("reports")).length, 1);
  await storage.remove("reports/2026/q1.json");
  assertEquals(await storage.read("reports/2026/q1.json"), null);
  await storage.remove("does-not-exist"); // idempotent

  await Deno.remove(root, { recursive: true });
});

// ---------------------------------------------------------------------------
// Context guarantees
// ---------------------------------------------------------------------------

Deno.test("context: userId from STS_API_KEY, origin header, and env merge (mount wins)", async () => {
  await withServer(async (srv) => {
    const code = `import { initToolConfig } from "/core/utils/initToolConfig.ts";
import type { ToolConfig, ToolExecutionContext } from "/core/contracts/ToolContract.ts";
export const config = await initToolConfig(import.meta.url, {
  name: "reflector", version: "1.0.0", description: "Reflects its execution context.",
  secrets: { STS_API_KEY: { description: "key", isOptional: true } },
  rateLimit: { requestsPerMinute: 300 },
  signature: { inputs: { type: "object", properties: {} }, outputs: { type: "object", properties: {} } }
}) as ToolConfig;
export default async function execute(_r: Request, context: ToolExecutionContext): Promise<Response> {
  return Response.json({
    userId: context.userId,
    origin: context.origin,
    injected: context.env.MY_TEST_SECRET ?? null,
    hasPath: typeof context.env.PATH === "string",
    callerConfigName: context.callerConfig?.name ?? null,
    hasStorage: !!context.storage
  });
}
`;
    await mount(srv, "reflector", code, {
      STS_API_KEY: "sk-abc123trailing",
      MY_TEST_SECRET: "from-secrets-tab",
    });

    const res = await fetch(`${srv.url}/reflector`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sts-origin": "agent" },
      body: "{}",
    });
    assertEquals(await res.json(), {
      userId: "abc123",
      origin: "agent",
      injected: "from-secrets-tab",
      hasPath: true,
      callerConfigName: "reflector",
      hasStorage: true,
    });

    // No x-sts-origin header -> default.
    const dflt = await run(srv, "reflector", {});
    assertEquals((await dflt.json()).origin, "sdk_rest");
  });
});

Deno.test("weather_fetcher mounts, declares the gateway, and returns actionable CITY_NOT_FOUND", async () => {
  await withServer(async (srv) => {
    const source = await Deno.readTextFile(new URL("./tools/weather_fetcher.ts", import.meta.url));
    const mounted = await mount(srv, "weather_fetcher", source);
    assertEquals(mounted.status, 200);

    const config = mounted.body.config as ToolConfig;
    assertEquals(config.tool_dependencies, ["network_gateway"]);
    assertEquals(config.network_requests, ["https://api.open-meteo.com/"]);
    assertEquals(config.secrets?.WEATHER_API_KEY?.isOptional, true);
    assertEquals(config.tests?.length, 2);

    // Offline-safe branch: the gazetteer miss never reaches the network.
    const res = await run(srv, "weather_fetcher", { city: "atlantis" });
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error, "CITY_NOT_FOUND");
    assertStringIncludes(body.actionable_advice, "latitude");

    const bad = await run(srv, "weather_fetcher", {});
    assertEquals(bad.status, 400);
    assertEquals((await bad.json()).error, "INVALID_INPUT");
  });
});

Deno.test("unknown routes and wrong methods answer with JSON, not a crash", async () => {
  await withServer(async (srv) => {
    const notFound = await fetch(`${srv.url}/a/b/c`);
    assertEquals(notFound.status, 404);
    assertEquals((await notFound.json()).error, "NOT_FOUND");

    await mount(srv, "calc", CALC_SOURCE);
    const wrongMethod = await fetch(`${srv.url}/calc`, { method: "GET" });
    assertEquals(wrongMethod.status, 405);
    assertEquals((await wrongMethod.json()).error, "METHOD_NOT_ALLOWED");
  });
});

globalThis.addEventListener("unload", () => {
  try {
    Deno.removeSync(TEST_FILESPACE, { recursive: true });
  } catch {
    // best effort
  }
});
