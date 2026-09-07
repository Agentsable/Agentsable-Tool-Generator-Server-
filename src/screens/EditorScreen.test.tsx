// @vitest-environment jsdom
/**
 * [ Editor ] behaviour — docs/llm_generated/11-screen-editor.md.
 *
 * Monaco cannot mount under jsdom, so the component falls back to its plain
 * pane; every assertion below is about the surrounding chrome (the config
 * abstraction banner and the CONFIG_STUB guard rail), which is ours either way.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { EditorScreen } from "@/screens/EditorScreen";
import { CONFIG_STUB } from "@/lib/tgs/ast";
import { ToolProvider, useTool } from "@/state/toolStore";

/** Edits the logic buffer through the real store action, as Monaco would. */
function LogicHarness() {
  const { bundle, setLogic } = useTool();
  return (
    <div>
      <button type="button" onClick={() => setLogic(bundle.logic.replace(CONFIG_STUB, ""))}>
        delete-stub
      </button>
      <button
        type="button"
        onClick={() => setLogic(`${bundle.logic}\nawait fetch("https://example.com");\n`)}
      >
        add-fetch
      </button>
    </div>
  );
}

function renderScreen() {
  return render(
    <ToolProvider>
      <LogicHarness />
      <EditorScreen />
    </ToolProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("EditorScreen", () => {
  it("announces that the config block is hidden", () => {
    renderScreen();
    expect(screen.getByText("[ TypeScript Logic View — Config Block Hidden ]")).toBeTruthy();
    expect(screen.getByTestId("editor-config-banner").textContent).toMatch(/Config tab/);
  });

  it("shows the real config summary for the default calc bundle", () => {
    renderScreen();

    const summary = within(screen.getByTestId("editor-config-summary"));
    expect(summary.getByText("name").nextElementSibling?.textContent).toBe("calc");
    expect(summary.getByText("version").nextElementSibling?.textContent).toBe("1.1.0");
    expect(summary.getByText("secrets").nextElementSibling?.textContent).toBe("0");
    expect(summary.getByText("tool dependencies").nextElementSibling?.textContent).toBe("0");
    expect(summary.getByText("rate limit").nextElementSibling?.textContent).toBe("300/min");
  });

  it("does not warn while the CONFIG_STUB is present, and warns once it is deleted", async () => {
    const user = userEvent.setup();
    renderScreen();

    expect(screen.queryByTestId("editor-stub-warning")).toBeNull();

    await user.click(screen.getByRole("button", { name: "delete-stub" }));

    await waitFor(() => {
      expect(screen.getByTestId("editor-stub-warning")).toBeTruthy();
    });
    const warning = screen.getByTestId("editor-stub-warning");
    expect(warning.textContent).toMatch(/CONFIG_STUB comment is missing/);
    expect(warning.textContent).toMatch(/append the config block after the last import/);
    // The stub itself is offered so the developer can paste it back.
    expect(warning.textContent).toContain("[CONFIG_STUB]");
  });

  it("lists the zero-trust warning for a direct fetch() call", async () => {
    const user = userEvent.setup();
    renderScreen();

    expect(screen.queryByTestId("editor-lint-warnings")).toBeNull();

    await user.click(screen.getByRole("button", { name: "add-fetch" }));

    await waitFor(() => {
      expect(screen.getByTestId("editor-lint-warnings").textContent).toMatch(
        /Zero-Trust Violation/,
      );
    });
  });

  it("reveals the recombined file on demand", async () => {
    const user = userEvent.setup();
    renderScreen();

    expect(screen.queryByTestId("editor-recombination-preview")).toBeNull();

    await user.click(screen.getByRole("button", { name: /Recombination preview/ }));

    const preview = await screen.findByTestId("editor-recombination-preview");
    await waitFor(() => {
      // The config the Editor hides is present again in the recombined output.
      expect(preview.textContent).toMatch(/initToolConfig/);
    });
  });
});
