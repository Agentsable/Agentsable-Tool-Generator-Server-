import { describe, expect, it } from "vitest";

import { evaluateExpectation } from "@/lib/tgs/runnerClient";

describe("evaluateExpectation", () => {
  it("passes when the status and key both match", () => {
    const v = evaluateExpectation({ status: 200, hasKey: "result" }, 200, '{"result":8}');
    expect(v.ok).toBe(true);
    expect(v.vacuous).toBe(false);
  });

  it("fails with the actual status when the status differs", () => {
    const v = evaluateExpectation({ status: 400 }, 500, '{"error":"boom"}');
    expect(v.ok).toBe(false);
    expect(v.detail).toContain("expected status 400, got 500");
  });

  it("fails when the expected key is absent", () => {
    const v = evaluateExpectation({ hasKey: "error" }, 400, '{"message":"nope"}');
    expect(v.ok).toBe(false);
    expect(v.detail).toContain('no key "error"');
  });

  it("fails clearly when hasKey is asserted but the body is not JSON", () => {
    const v = evaluateExpectation({ hasKey: "error" }, 500, "Internal Server Error");
    expect(v.ok).toBe(false);
    expect(v.detail).toContain("not JSON");
  });

  it("checks only the status when hasKey is absent", () => {
    const v = evaluateExpectation({ status: 204 }, 204, "");
    expect(v.ok).toBe(true);
  });

  it("passes but flags a test that asserts nothing", () => {
    // 15-screen-runner.md §3: both fields are optional; a test with neither
    // always passes and should be treated as an authoring mistake.
    const v = evaluateExpectation({}, 500, "anything");
    expect(v.ok).toBe(true);
    expect(v.vacuous).toBe(true);
    expect(v.detail).toContain("asserts neither");
  });

  it("treats a null-prototype-safe key check correctly for nested keys", () => {
    const v = evaluateExpectation({ hasKey: "success" }, 200, '{"success":true,"result":1}');
    expect(v.ok).toBe(true);
  });
});
