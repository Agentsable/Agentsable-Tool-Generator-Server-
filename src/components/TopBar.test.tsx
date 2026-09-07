// @vitest-environment jsdom
/**
 * Top Action Bar contract (01-system-overview.md §2):
 *  - the tool name is global and renames all four files (10-screen-raw-data.md)
 *  - [ 💾 Save ] writes all four files and clears the dirty flag
 *  - [ 🚀 Publish ] is gated by the Validator (14-screen-validator.md §2.3)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { TopBar } from "@/components/TopBar";
import { ToolProvider, useTool } from "@/state/toolStore";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}));

vi.mock("@/lib/tgs/fsAccess", () => ({
  isFileSystemAccessSupported: vi.fn(() => false),
  pickToolFile: vi.fn(async () => null),
  pickWorkspaceDirectory: vi.fn(async () => null),
  readFilesFromInput: vi.fn(async () => ({ files: {}, baseName: "untitled_tool" })),
  saveAllFiles: vi.fn(async () => ({ mode: "download" as const, written: [] as string[] })),
  buildPublishBundle: vi.fn(() => ({ files: [], excluded: [] })),
  downloadPublishBundle: vi.fn(async () => undefined),
  downloadTextFile: vi.fn(),
}));

// The store reaches for these lazily; keep both engines off the network.
vi.mock("@/lib/tgs/pythonEngine", () => ({
  createPythonEngine: vi.fn(() => ({
    run: async () => [
      {
        filename: "rule_cf_worker_compat.py",
        passed: false,
        message: "Line 14: Found prohibited module 'node:path'.",
        durationMs: 4,
      },
    ],
  })),
}));

vi.mock("@/rpc/tgsServerFns", () => ({
  getClaudeStatus: vi.fn(async () => ({ configured: false, model: "claude-opus-5" })),
  postAssistantTurn: vi.fn(async () => ({ ok: false, error: "no key", code: "NO_API_KEY" })),
  postLlmValidation: vi.fn(async () => ({ ok: true, results: [], attempts: 1 })),
}));

import { saveAllFiles } from "@/lib/tgs/fsAccess";

/** Drives the store from inside the provider so the Validator gate can be exercised. */
function ValidationHarness() {
  const { runAllValidations } = useTool();
  return <button onClick={() => void runAllValidations()}>run-validations</button>;
}

function renderTopBar() {
  return render(
    <ToolProvider>
      <TopBar />
      <ValidationHarness />
    </ToolProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(saveAllFiles).mockResolvedValue({ mode: "download", written: [] });
});

afterEach(() => {
  cleanup();
});

describe("TopBar", () => {
  it("renames all four files when the global tool name changes", () => {
    renderTopBar();

    // The default bundle is `calc`.
    expect(screen.getByText("calc.ts")).toBeTruthy();
    expect(screen.getByText("calc_tests.json")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Tool name"), {
      target: { value: "weather_fetcher" },
    });

    expect(screen.getByText("weather_fetcher.ts")).toBeTruthy();
    expect(screen.getByText("weather_fetcher.json")).toBeTruthy();
    expect(screen.getByText("weather_fetcher.env")).toBeTruthy();
    expect(screen.getByText("weather_fetcher_tests.json")).toBeTruthy();
    expect(screen.queryByText("calc.ts")).toBeNull();
  });

  it("blocks Publish and lists the Validator's blockers", async () => {
    renderTopBar();

    const publish = screen.getByRole("button", { name: /Publish/ });

    // Nothing has been validated yet: the gate is closed for that reason alone.
    fireEvent.click(publish);
    expect(screen.getByRole("dialog", { name: "Publishing is blocked" }).textContent).toContain(
      "have not been run yet",
    );
    fireEvent.click(publish); // close again

    // One deterministic failure -> score 75, canPublish === false.
    fireEvent.click(screen.getByText("run-validations"));
    await waitFor(() => expect(screen.getByText(/75\/100/)).toBeTruthy());

    fireEvent.click(publish);
    const dialog = screen.getByRole("dialog", { name: "Publishing is blocked" });
    expect(dialog.textContent).toContain(
      "1 deterministic failure must be fixed before publishing.",
    );
    expect(dialog.textContent).toContain("Health score 75/100 is below the required 90/100.");
    expect(publish.getAttribute("aria-disabled")).toBe("true");
  });

  it("Save writes all four files and clears the dirty flag", async () => {
    renderTopBar();

    fireEvent.change(screen.getByLabelText("Tool name"), { target: { value: "weather_fetcher" } });
    expect(screen.getByText("unsaved")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Save/ }));

    await waitFor(() => expect(saveAllFiles).toHaveBeenCalledTimes(1));

    const call = vi.mocked(saveAllFiles).mock.calls[0];
    expect(call).toBeDefined();
    const [names, contents, dir] = call as unknown as [
      Record<string, string>,
      Record<string, string>,
      unknown,
    ];
    expect(names).toEqual({
      ts: "weather_fetcher.ts",
      json: "weather_fetcher.json",
      env: "weather_fetcher.env",
      tests: "weather_fetcher_tests.json",
    });
    expect(Object.keys(contents).sort()).toEqual(["env", "json", "tests", "ts"]);
    expect(contents["ts"]).toContain("export default async function execute");
    expect(dir).toBeNull();

    await waitFor(() => expect(screen.getByText("in sync")).toBeTruthy());
  });
});
