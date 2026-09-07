// @vitest-environment jsdom
/**
 * [ Runner ] — docs/llm_generated/15-screen-runner.md.
 *
 * Monaco cannot mount under jsdom (it needs real layout, ResizeObserver and web
 * workers) and is covered by its own test, so it is stubbed with a plain
 * textarea here; everything else runs against the real store.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { ToolProvider } from "@/state/toolStore";
import { createDefaultBundle } from "@/lib/tgs/defaultTool";
import type { RunnerTestResult } from "@/lib/tgs/runnerClient";
import { RunnerScreen } from "@/screens/RunnerScreen";
import {
  buildMatrixRows,
  describeExpect,
  isVacuousTest,
  sourceLabel,
  statusCell,
  summarize,
  type MatrixRow,
} from "@/screens/runner/RunnerDashboard";
import { draftsToTests, draftIsVacuous, emptyDraft, toDraft } from "@/screens/runner/TsTestsPane";

vi.mock("@/components/tgs/MonacoEditor", () => ({
  MonacoEditor: (props: { value: string; onChange?: (v: string) => void; ariaLabel?: string }) => (
    <textarea
      aria-label={props.ariaLabel ?? "editor"}
      value={props.value}
      onChange={(e) => props.onChange?.(e.target.value)}
    />
  ),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  }),
}));

function renderRunner() {
  return render(
    <ToolProvider>
      <RunnerScreen />
    </ToolProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  // The dashboard probes on mount; keep it offline and deterministic.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))),
  );
});

/* ------------------------------------------------------------------ */
/* §1 sub-navigation                                                    */
/* ------------------------------------------------------------------ */

describe("Runner sub-navigation", () => {
  it("renders the three spec'd sub-tabs and switches between them", async () => {
    renderRunner();

    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["Dashboard", "Tool TS Tests", "JSON Tests"]);

    // Dashboard is the default view.
    expect(screen.getByRole("button", { name: /Run All Tests/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Tool TS Tests" }));
    expect(screen.getAllByRole("button", { name: /Save to Tool/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Run All Tests/ })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "JSON Tests" }));
    expect(screen.getByRole("button", { name: /Save to Tests JSON/ })).toBeTruthy();
    expect(screen.getByLabelText("calc_tests.json editor")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Dashboard" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Run All Tests/ })).toBeTruthy());
  });
});

/* ------------------------------------------------------------------ */
/* §2 execution matrix                                                  */
/* ------------------------------------------------------------------ */

describe("Runner dashboard matrix", () => {
  it("lists the default calc bundle's 3 tests with the spec's source attribution", async () => {
    renderRunner();

    // 2 embedded tests from calc.ts, 1 from the external calc_tests.json.
    expect(screen.getAllByText("📄 calc.ts")).toHaveLength(2);
    expect(screen.getAllByText("📦 calc_tests.json")).toHaveLength(1);

    expect(screen.getByText("Valid Addition")).toBeTruthy();
    expect(screen.getByText("Divide by Zero Error Handling")).toBeTruthy();
    expect(screen.getByText("Missing Payload")).toBeTruthy();

    // Spec columns.
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers.slice(0, 4)).toEqual(["Source", "Test Name", "Status", "Details"]);

    // A per-row re-run control.
    expect(screen.getByRole("button", { name: "Re-run Valid Addition" })).toBeTruthy();

    // Nothing has run yet.
    expect(screen.getByText("3 tests · not run")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("runner-status")).toBeTruthy());
  });

  it("shows the exact command to start the sandbox when the server is down", async () => {
    renderRunner();

    await waitFor(() => expect(screen.getByTestId("runner-status").textContent).toContain("down"));
    expect(screen.getByText(/Cannot reach http:\/\/localhost:8080/)).toBeTruthy();

    // TGS did not spawn the process, so the button is honest about re-probing.
    expect(
      screen.getByRole("button", { name: /Reconnect \/ Restart Local Deno Server/ }),
    ).toBeTruthy();
    expect(screen.getByText(/cannot restart a process it does not own/)).toBeTruthy();

    // ...and it hands over a runnable command with a copy action.
    expect(screen.getByText("bun run deno:server")).toBeTruthy();
    expect(
      screen.getByText(
        "deno run --allow-net --allow-read --allow-env --allow-write local-deno-server/server.ts",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy command: bun run deno:server" })).toBeTruthy();
  });

  it("states the Zero-Trust Parity and Context Injection guarantees", () => {
    renderRunner();
    expect(screen.getByText(/never executes this tool's TypeScript/)).toBeTruthy();
    expect(screen.getByText(/fresh/)).toBeTruthy();
    expect(screen.getByText(/injects/)).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
/* vacuous tests (§3)                                                   */
/* ------------------------------------------------------------------ */

describe("vacuous tests", () => {
  it("flags a test that asserts nothing, end to end through the TS pane", async () => {
    renderRunner();

    fireEvent.click(screen.getByRole("tab", { name: "Tool TS Tests" }));
    // A fresh card asserts neither status nor hasKey.
    fireEvent.click(screen.getByRole("button", { name: /Add test/ }));
    expect(screen.getAllByText("asserts nothing — authoring mistake").length).toBeGreaterThan(0);
    expect(screen.getByText(/always passes and is treated as an authoring mistake/)).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: /Save to Tool/ })[0]!);

    fireEvent.click(screen.getByRole("tab", { name: "Dashboard" }));
    await waitFor(() => expect(screen.getByText("New test")).toBeTruthy());
    const row = screen.getByText("New test").closest("tr");
    expect(row).not.toBeNull();
    expect(
      within(row as HTMLElement).getByText("asserts nothing — authoring mistake"),
    ).toBeTruthy();
    // 3 embedded + 1 external now.
    expect(screen.getAllByText("📄 calc.ts")).toHaveLength(3);
  });

  it("detects vacuity in the pure helpers", () => {
    expect(isVacuousTest({ name: "x", payload: {}, expect: {} })).toBe(true);
    expect(isVacuousTest({ name: "x", payload: {}, expect: { status: 200 } })).toBe(false);
    expect(isVacuousTest({ name: "x", payload: {}, expect: { hasKey: "error" } })).toBe(false);
    expect(draftIsVacuous(emptyDraft())).toBe(true);
    expect(draftIsVacuous(toDraft({ name: "x", payload: {}, expect: { status: 200 } }))).toBe(
      false,
    );
  });
});

/* ------------------------------------------------------------------ */
/* pure formatting helpers                                              */
/* ------------------------------------------------------------------ */

describe("dashboard formatting helpers", () => {
  const bundle = createDefaultBundle();

  const result = (patch: Partial<RunnerTestResult>): RunnerTestResult => ({
    name: "Valid Addition",
    source: "ts",
    ok: true,
    expected: "status 200",
    actualStatus: 200,
    actualBody: '{"result":8}',
    detail: "Matched every assertion.",
    durationMs: 4,
    vacuous: false,
    ...patch,
  });

  it("attributes each source to the file that must change", () => {
    expect(sourceLabel("ts", "calc")).toBe("📄 calc.ts");
    expect(sourceLabel("json", "calc")).toBe("📦 calc_tests.json");
  });

  it("describes expectations the way the runner client does", () => {
    expect(describeExpect({ status: 400, hasKey: "error" })).toBe('status 400, hasKey "error"');
    expect(describeExpect({})).toBe("nothing asserted");
  });

  it("joins declared tests with their results, indexed per source", () => {
    const rows = buildMatrixRows(bundle, [result({})]);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.source)).toEqual(["ts", "ts", "json"]);
    expect(rows.map((r) => r.indexWithinSource)).toEqual([0, 1, 0]);
    expect(rows[0]?.result?.actualStatus).toBe(200);
    expect(rows[1]?.result).toBeNull();
    expect(rows[2]?.sourceLabel).toBe("📦 calc_tests.json");
  });

  it("renders [✅ 200] and [❌ 500] Exp 400 cells", () => {
    const rows = buildMatrixRows(bundle, [
      result({}),
      result({ name: "Divide by Zero Error Handling", ok: false, actualStatus: 500 }),
    ]);
    expect(statusCell(rows[0] as MatrixRow)).toEqual({
      badge: "✅ 200",
      expectedNote: null,
      tone: "success",
    });
    expect(statusCell(rows[1] as MatrixRow)).toEqual({
      badge: "❌ 500",
      expectedNote: "Exp 400",
      tone: "destructive",
    });
    expect(statusCell(rows[2] as MatrixRow)).toEqual({
      badge: "· not run",
      expectedNote: null,
      tone: "muted",
    });
  });

  it("summarizes X/Y passing plus per-source counts", () => {
    const rows = buildMatrixRows(bundle, [
      result({}),
      result({ name: "Divide by Zero Error Handling", ok: false, actualStatus: 500 }),
      result({ name: "Missing Payload", source: "json", ok: true, actualStatus: 400 }),
    ]);
    expect(summarize(rows)).toEqual({
      total: 3,
      ran: 3,
      passing: 2,
      ts: { total: 2, passing: 1 },
      json: { total: 1, passing: 1 },
      vacuous: 0,
    });
  });
});

/* ------------------------------------------------------------------ */
/* §4.1 embedded suite conversion                                       */
/* ------------------------------------------------------------------ */

describe("TS test drafts", () => {
  it("converts drafts to ToolTest objects, omitting unset expectations", () => {
    const converted = draftsToTests([
      {
        id: "a",
        name: " Valid Addition ",
        payloadText: '{"a":1}',
        status: "200",
        hasKey: "result",
      },
      { id: "b", name: "No status", payloadText: "", status: "", hasKey: "error" },
    ]);
    expect(converted).toEqual({
      ok: true,
      tests: [
        { name: "Valid Addition", payload: { a: 1 }, expect: { status: 200, hasKey: "result" } },
        { name: "No status", payload: {}, expect: { hasKey: "error" } },
      ],
    });
  });

  it("refuses to commit a broken payload or a bogus status", () => {
    const bad = draftsToTests([
      { id: "a", name: "Broken", payloadText: "{oops", status: "", hasKey: "" },
    ]);
    expect(bad.ok).toBe(false);

    const bogus = draftsToTests([
      { id: "a", name: "Bogus", payloadText: "{}", status: "9000", hasKey: "" },
    ]);
    expect(bogus.ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* §4.2 external suite editor                                           */
/* ------------------------------------------------------------------ */

describe("JSON tests pane", () => {
  it("keeps a modified buffer and never commits an invalid one", () => {
    renderRunner();
    fireEvent.click(screen.getByRole("tab", { name: "JSON Tests" }));

    const editor = screen.getByLabelText("calc_tests.json editor");
    expect(screen.getByText("in sync")).toBeTruthy();

    fireEvent.change(editor, { target: { value: "[oops" } });
    expect(screen.getByText("modified — not saved")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Save to Tests JSON/ }));
    expect(screen.getByText(/Invalid JSON — not saved/)).toBeTruthy();
    expect(screen.getByText("modified — not saved")).toBeTruthy();

    fireEvent.change(editor, {
      target: {
        value: JSON.stringify(
          [{ name: "Extra case", payload: {}, expect: { status: 400 } }],
          null,
          2,
        ),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save to Tests JSON/ }));
    expect(screen.getByText("in sync")).toBeTruthy();

    // ...and the Dashboard picks it up from global state.
    fireEvent.click(screen.getByRole("tab", { name: "Dashboard" }));
    expect(screen.getByText("Extra case")).toBeTruthy();
    expect(screen.queryByText("Missing Payload")).toBeNull();
  });
});
