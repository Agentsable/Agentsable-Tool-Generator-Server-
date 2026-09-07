/**
 * Runner HTTP client — docs/llm_generated/15-screen-runner.md §2.
 *
 * Zero-Trust Parity: the browser NEVER executes tool TypeScript. It mounts the
 * tool on the local Deno server over HTTP and fires one plain HTTP request per
 * test, exactly as a production caller would.
 */
import type { ToolTest } from "@/lib/tgs/contract";

export type RunnerStatus =
  | { state: "unknown" }
  | { state: "up"; version: string; mounted: string[] }
  | { state: "down"; message: string };

export type RunnerTestResult = {
  name: string;
  source: "ts" | "json";
  ok: boolean;
  /** Human-readable expectation, e.g. `status 400, hasKey "error"`. */
  expected: string;
  actualStatus: number | null;
  /** Response body, truncated for display. */
  actualBody: string;
  detail: string;
  durationMs: number;
  /** True when the test asserts nothing — an authoring mistake per the spec. */
  vacuous: boolean;
};

const HEALTH_TIMEOUT_MS = 4000;
const MOUNT_TIMEOUT_MS = 20000;
const RUN_TIMEOUT_MS = 30000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export async function probeRunner(baseUrl: string): Promise<RunnerStatus> {
  const base = normalizeBase(baseUrl);
  try {
    const res = await fetchWithTimeout(`${base}/health`, { method: "GET" }, HEALTH_TIMEOUT_MS);
    if (!res.ok) {
      return { state: "down", message: `Health check returned HTTP ${res.status}.` };
    }
    const body = (await res.json()) as {
      ok?: boolean;
      version?: string;
      mounted?: string[];
    };
    if (!body.ok) return { state: "down", message: "Health check reported not-ok." };
    return {
      state: "up",
      version: body.version ?? "unknown",
      mounted: Array.isArray(body.mounted) ? body.mounted : [],
    };
  } catch (e) {
    const err = e as Error;
    const message =
      err.name === "AbortError"
        ? `No response from ${base} within ${HEALTH_TIMEOUT_MS}ms.`
        : `Cannot reach ${base}: ${err.message}. Start it with \`bun run deno:server\`.`;
    return { state: "down", message };
  }
}

export async function mountTool(input: {
  baseUrl: string;
  toolName: string;
  code: string;
  env: Record<string, string>;
  tests?: ToolTest[];
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const base = normalizeBase(input.baseUrl);
  try {
    const res = await fetchWithTimeout(
      `${base}/tools/${encodeURIComponent(input.toolName)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: input.code,
          env: input.env,
          tests: input.tests ?? [],
        }),
      },
      MOUNT_TIMEOUT_MS,
    );
    if (res.ok) return { ok: true };
    const text = await res.text();
    let message = text;
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string };
      message = parsed.message ?? parsed.error ?? text;
    } catch {
      /* keep the raw text */
    }
    return { ok: false, error: `Mount failed (HTTP ${res.status}): ${message}` };
  } catch (e) {
    return { ok: false, error: `Mount failed: ${(e as Error).message}` };
  }
}

function describeExpectation(expect: ToolTest["expect"]): string {
  const parts: string[] = [];
  if (expect.status !== undefined) parts.push(`status ${expect.status}`);
  if (expect.hasKey !== undefined) parts.push(`hasKey "${expect.hasKey}"`);
  return parts.length ? parts.join(", ") : "nothing asserted";
}

function truncate(text: string, max = 400): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Compares one HTTP response against a ToolTest's `expect` block. */
export function evaluateExpectation(
  expect: ToolTest["expect"],
  status: number,
  bodyText: string,
): { ok: boolean; detail: string; vacuous: boolean } {
  const vacuous = expect.status === undefined && expect.hasKey === undefined;
  const failures: string[] = [];

  if (expect.status !== undefined && status !== expect.status) {
    failures.push(`expected status ${expect.status}, got ${status}`);
  }

  if (expect.hasKey !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      failures.push(`expected JSON body containing "${expect.hasKey}", body was not JSON`);
      return { ok: false, detail: failures.join("; "), vacuous };
    }
    const hasKey =
      typeof parsed === "object" &&
      parsed !== null &&
      Object.prototype.hasOwnProperty.call(parsed, expect.hasKey);
    if (!hasKey) {
      failures.push(`response body has no key "${expect.hasKey}"`);
    }
  }

  if (failures.length) return { ok: false, detail: failures.join("; "), vacuous };
  return {
    ok: true,
    detail: vacuous
      ? "Passed, but this test asserts neither status nor hasKey — add an assertion."
      : "Matched every assertion.",
    vacuous,
  };
}

export async function runBundleTests(input: {
  baseUrl: string;
  toolName: string;
  code: string;
  env: Record<string, string>;
  tests: { source: "ts" | "json"; test: ToolTest }[];
}): Promise<{ status: RunnerStatus; results: RunnerTestResult[] }> {
  const base = normalizeBase(input.baseUrl);
  const status = await probeRunner(base);

  if (status.state !== "up") {
    const message = status.state === "down" ? status.message : "Runner state unknown.";
    return {
      status,
      results: input.tests.map(({ source, test }) => ({
        name: test.name,
        source,
        ok: false,
        expected: describeExpectation(test.expect),
        actualStatus: null,
        actualBody: "",
        detail: message,
        durationMs: 0,
        vacuous: false,
      })),
    };
  }

  const mounted = await mountTool({
    baseUrl: base,
    toolName: input.toolName,
    code: input.code,
    env: input.env,
    tests: input.tests.map((t) => t.test),
  });

  if (!mounted.ok) {
    return {
      status,
      results: input.tests.map(({ source, test }) => ({
        name: test.name,
        source,
        ok: false,
        expected: describeExpectation(test.expect),
        actualStatus: null,
        actualBody: "",
        detail: mounted.error,
        durationMs: 0,
        vacuous: false,
      })),
    };
  }

  const results: RunnerTestResult[] = [];
  for (const { source, test } of input.tests) {
    const started = performance.now();
    try {
      const res = await fetchWithTimeout(
        `${base}/${encodeURIComponent(input.toolName)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-sts-origin": "sdk_rest" },
          body: JSON.stringify(test.payload ?? {}),
        },
        RUN_TIMEOUT_MS,
      );
      const bodyText = await res.text();
      const verdict = evaluateExpectation(test.expect, res.status, bodyText);
      results.push({
        name: test.name,
        source,
        ok: verdict.ok,
        expected: describeExpectation(test.expect),
        actualStatus: res.status,
        actualBody: truncate(bodyText),
        detail: verdict.detail,
        durationMs: Math.round(performance.now() - started),
        vacuous: verdict.vacuous,
      });
    } catch (e) {
      results.push({
        name: test.name,
        source,
        ok: false,
        expected: describeExpectation(test.expect),
        actualStatus: null,
        actualBody: "",
        detail: `Request failed: ${(e as Error).message}`,
        durationMs: Math.round(performance.now() - started),
        vacuous: false,
      });
    }
  }

  return { status, results };
}
