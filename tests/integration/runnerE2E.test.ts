/**
 * End-to-end: the browser-side runner client against the real local Deno server.
 *
 * Proves the Zero-Trust Parity path in docs/llm_generated/15-screen-runner.md §2:
 * render the four-file bundle -> mount over HTTP -> fire one HTTP request per
 * ToolTest -> compare against the `expect` block.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDefaultBundle } from "@/lib/tgs/defaultTool";
import { renderBundle, allTests } from "@/lib/tgs/toolFiles";
import { probeRunner, runBundleTests } from "@/lib/tgs/runnerClient";

const PORT = 8099;
const BASE = `http://127.0.0.1:${PORT}`;
const DENO = `${process.env["HOME"]}/.deno/bin/deno`;

let proc: ChildProcessWithoutNullStreams | null = null;

async function waitForHealth(timeoutMs = 40_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await probeRunner(BASE);
    if (status.state === "up") return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

beforeAll(async () => {
  proc = spawn(
    DENO,
    ["run", "--allow-net", "--allow-read", "--allow-env", "--allow-write", "server.ts"],
    {
      cwd: new URL("../../local-deno-server/", import.meta.url).pathname,
      env: { ...process.env, TGS_RUNNER_PORT: String(PORT) },
    },
  ) as ChildProcessWithoutNullStreams;
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", () => {});
  const up = await waitForHealth();
  if (!up) throw new Error("local Deno server did not become healthy");
}, 60_000);

afterAll(() => {
  proc?.kill("SIGTERM");
});

describe("runner end-to-end against the local Deno server", () => {
  it("reports healthy", async () => {
    const status = await probeRunner(BASE);
    expect(status.state).toBe("up");
  });

  it("mounts the default calc bundle and passes every test from both sources", async () => {
    const bundle = createDefaultBundle();
    const rendered = renderBundle(bundle);
    const tests = allTests(bundle);

    expect(tests.length).toBeGreaterThanOrEqual(3);
    expect(tests.filter((t) => t.source === "ts").length).toBe(2);
    expect(tests.filter((t) => t.source === "json").length).toBeGreaterThanOrEqual(1);

    const out = await runBundleTests({
      baseUrl: BASE,
      toolName: bundle.name,
      code: rendered.ts,
      env: bundle.secrets,
      tests,
    });

    const failures = out.results.filter((r) => !r.ok);
    expect(
      failures.map((f) => `${f.name}: ${f.detail} (got ${f.actualStatus} ${f.actualBody})`),
    ).toEqual([]);
    expect(out.results.every((r) => r.ok)).toBe(true);
  }, 60_000);

  it("reports a failing expectation rather than throwing", async () => {
    const bundle = createDefaultBundle();
    const rendered = renderBundle(bundle);

    const out = await runBundleTests({
      baseUrl: BASE,
      toolName: bundle.name,
      code: rendered.ts,
      env: bundle.secrets,
      tests: [
        {
          source: "ts",
          test: {
            name: "deliberately wrong expectation",
            payload: { a: 1, b: 2, operation: "add" },
            expect: { status: 418 },
          },
        },
      ],
    });

    expect(out.results[0]?.ok).toBe(false);
    expect(out.results[0]?.detail).toContain("expected status 418, got 200");
  }, 30_000);

  it("surfaces a clear message when the server is unreachable", async () => {
    const out = await runBundleTests({
      baseUrl: "http://127.0.0.1:8098",
      toolName: "calc",
      code: "export const config = {}; export default async function execute() { return new Response('{}'); }",
      env: {},
      tests: [{ source: "ts", test: { name: "x", payload: {}, expect: { status: 200 } } }],
    });
    expect(out.status.state).toBe("down");
    expect(out.results[0]?.ok).toBe(false);
    expect(out.results[0]?.detail).toMatch(/Cannot reach|No response/);
  }, 20_000);
});
