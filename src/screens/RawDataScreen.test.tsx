// @vitest-environment jsdom
/**
 * [ Raw Data ] behaviour — docs/llm_generated/10-screen-raw-data.md.
 *
 * The panes are Monaco instances; under jsdom Monaco cannot mount, so the
 * component falls back to its plain read-only pane. These assertions read the
 * rendered text of the pane container, which holds either way.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { RawDataScreen } from "@/screens/RawDataScreen";
import { ToolProvider, useTool } from "@/state/toolStore";

/** Drives the store the way the top action bar's tool-name field does. */
function RenameButton({ to }: { to: string }) {
  const { setToolName } = useTool();
  return (
    <button type="button" onClick={() => setToolName(to)}>
      rename-tool
    </button>
  );
}

function renderScreen() {
  return render(
    <ToolProvider>
      <RenameButton to="weather_fetcher" />
      <RawDataScreen />
    </ToolProvider>,
  );
}

const paneText = () => screen.getByTestId("raw-pane").textContent ?? "";

beforeEach(() => {
  window.localStorage.clear();
});

describe("RawDataScreen", () => {
  it("renders all four filenames with the active tool's name substituted", () => {
    renderScreen();

    expect(screen.getByRole("tab", { name: "calc.ts" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "calc.json" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "calc.env" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "calc_tests.json" })).toBeTruthy();
    expect(screen.getAllByRole("tab")).toHaveLength(4);
  });

  it("renames all four sub-tabs when the tool is renamed", async () => {
    const user = userEvent.setup();
    renderScreen();

    await user.click(screen.getByRole("button", { name: "rename-tool" }));

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "weather_fetcher.ts" })).toBeTruthy();
    });
    expect(screen.getByRole("tab", { name: "weather_fetcher.json" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "weather_fetcher.env" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "weather_fetcher_tests.json" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "calc.ts" })).toBeNull();
  });

  it("switches the displayed content when a sub-tab is clicked", async () => {
    const user = userEvent.setup();
    renderScreen();

    // .ts is the default pane: the recombined executable file.
    await waitFor(() => {
      expect(paneText()).toContain("export default async function execute");
    });
    expect(screen.getByTestId("raw-active-file").textContent).toBe("calc.ts");

    await user.click(screen.getByRole("tab", { name: "calc.json" }));

    await waitFor(() => {
      expect(screen.getByTestId("raw-active-file").textContent).toBe("calc.json");
    });
    expect(paneText()).not.toContain("export default async function execute");
    expect(paneText()).toContain("signature");
  });

  it("distinguishes the standalone .json from the external _tests.json", async () => {
    const user = userEvent.setup();
    renderScreen();

    await user.click(screen.getByRole("tab", { name: "calc.json" }));
    await waitFor(() => {
      expect(screen.getByTestId("raw-active-file").textContent).toBe("calc.json");
    });
    // The embedded suite lives in the config; the external suite does not.
    expect(paneText()).toContain("Valid Addition");
    expect(paneText()).not.toContain("Missing Payload");

    await user.click(screen.getByRole("tab", { name: "calc_tests.json" }));
    await waitFor(() => {
      expect(screen.getByTestId("raw-active-file").textContent).toBe("calc_tests.json");
    });
    expect(paneText()).toContain("Missing Payload");
  });

  it("shows the read-only safety notice and the tabs that can make changes", () => {
    renderScreen();

    const notice = screen.getByTestId("raw-readonly-notice");
    expect(notice.textContent).toMatch(/Read-only view/i);
    expect(notice.textContent).toMatch(/desynchronize/i);
    for (const tab of ["Editor", "Config", "Secrets", "Runner"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${tab}$`) })).toBeTruthy();
    }
  });

  it("warns that the .env file is excluded from publish", async () => {
    const user = userEvent.setup();
    renderScreen();

    expect(screen.queryByTestId("raw-env-publish-warning")).toBeNull();

    await user.click(screen.getByRole("tab", { name: "calc.env" }));

    await waitFor(() => {
      expect(screen.getByTestId("raw-env-publish-warning").textContent).toMatch(/Publish/);
    });
  });

  it("reports that the raw files are serialized from the global state", () => {
    renderScreen();
    expect(screen.getByText(/serialized from global state/i)).toBeTruthy();
  });
});
