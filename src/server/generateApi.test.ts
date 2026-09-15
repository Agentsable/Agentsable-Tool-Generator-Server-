import { afterEach, describe, expect, it, vi } from "vitest";

import { createDefaultBundle } from "@/lib/tgs/defaultTool";
import { applyEdits, GENERATE_PATH, handleApiRequest } from "@/server/generateApi";

const turn = vi.hoisted(() => ({ runAssistantTurn: vi.fn() }));
vi.mock("@/server/claude", () => turn);

function setKey(value: string | undefined): void {
  if (value === undefined) delete process.env["TGS_API_KEY"];
  else process.env["TGS_API_KEY"] = value;
}

function post(body: unknown, key = "secret"): Request {
  return new Request(`https://tgs.test${GENERATE_PATH}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  setKey(undefined);
  turn.runAssistantTurn.mockReset();
});

describe("applyEdits", () => {
  it("applies logic, config, advice and tests to the bundle", () => {
    const next = applyEdits(createDefaultBundle(), [
      { kind: "logic", logic: "export default async function execute() {}", rationale: "r" },
      { kind: "config", patch: { rateLimit: { requestsPerMinute: 10 } }, rationale: "r" },
      {
        kind: "error_advice",
        code: "BAD_INPUT",
        description: "d",
        actionable_advice: "a",
      },
      {
        kind: "test",
        target: "json",
        test: { name: "t", payload: {}, expect: { status: 200 } },
      },
      { kind: "request_run", what: "tests" },
    ]);

    expect(next.logic).toContain("export default async function execute");
    expect(next.config.rateLimit).toEqual({ requestsPerMinute: 10 });
    expect(next.config.signature?.errors?.["BAD_INPUT"]?.actionable_advice).toBe("a");
    // The merge must not drop what the seed config already declared.
    expect(next.config.signature?.errors?.["DIV_BY_ZERO"]).toBeDefined();
    expect(next.config.signature?.inputs?.properties?.["operation"]).toBeDefined();
    expect(next.jsonTests.at(-1)?.name).toBe("t");
  });

  it("renames every file when the model renames the tool", () => {
    const next = applyEdits(createDefaultBundle(), [
      { kind: "config", patch: { name: "weather" }, rationale: "r" },
    ]);
    expect(next.name).toBe("weather");
  });
});

describe("handleApiRequest", () => {
  it("is closed until TGS_API_KEY is set", async () => {
    const res = await handleApiRequest(post({ prompt: "hi" }));
    expect(res.status).toBe(503);
    expect(turn.runAssistantTurn).not.toHaveBeenCalled();
  });

  it("rejects a wrong or missing key", async () => {
    setKey("secret");
    expect((await handleApiRequest(post({ prompt: "hi" }, "nope"))).status).toBe(401);
    expect(turn.runAssistantTurn).not.toHaveBeenCalled();
  });

  it("rejects a body without a prompt", async () => {
    setKey("secret");
    const res = await handleApiRequest(post({ name: "x" }));
    expect(res.status).toBe(400);
  });

  it("404s an unknown path and 405s a GET", async () => {
    setKey("secret");
    const unknown = new Request("https://tgs.test/api/nope", { method: "POST" });
    expect((await handleApiRequest(unknown)).status).toBe(404);
    const get = new Request(`https://tgs.test${GENERATE_PATH}`, { method: "GET" });
    expect((await handleApiRequest(get)).status).toBe(405);
  });

  it("returns the four rendered files under their real filenames", async () => {
    setKey("secret");
    turn.runAssistantTurn.mockResolvedValue({
      ok: true,
      reply: "done",
      edits: [{ kind: "config", patch: { name: "weather" }, rationale: "r" }],
    });

    const res = await handleApiRequest(post({ prompt: "build a weather tool" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; files: Record<string, string> };
    expect(body.name).toBe("weather");
    expect(Object.keys(body.files)).toEqual([
      "weather.ts",
      "weather.json",
      "weather.env",
      "weather_tests.json",
    ]);
    expect(body.files["weather.ts"]).toContain("export default async function execute");
  });

  it("maps a Claude rate limit onto 429", async () => {
    setKey("secret");
    turn.runAssistantTurn.mockResolvedValue({ ok: false, code: "RATE_LIMIT", error: "slow down" });
    const res = await handleApiRequest(post({ prompt: "hi" }));
    expect(res.status).toBe(429);
  });
});

describe("config patch semantics", () => {
  it("treats a null in a patch as a key removal, not a null value", () => {
    const next = applyEdits(createDefaultBundle(), [
      {
        kind: "config",
        // What the model actually sends when repurposing the seed tool.
        patch: {
          signature: {
            inputs: { properties: { a: null, b: null, text: { type: "string" } } },
          },
        },
        rationale: "r",
      },
    ]);
    const props = next.config.signature?.inputs?.properties ?? {};
    expect(props).not.toHaveProperty("a");
    expect(props).not.toHaveProperty("b");
    expect(props["text"]).toEqual({ type: "string" });
  });
});
