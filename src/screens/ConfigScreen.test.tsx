// @vitest-environment jsdom
/**
 * [ Config ] screen behaviour (docs/llm_generated/12-screen-config.md).
 *
 * Everything is driven through the real `ToolProvider`, so these assertions
 * exercise the synchronization matrix in §5 rather than a mocked store.
 * Monaco is stubbed with a plain textarea: the editor itself has its own suite,
 * and a headless jsdom cannot run its worker.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ConfigScreen } from "@/screens/ConfigScreen";
import { ToolProvider } from "@/state/toolStore";

vi.mock("@/components/tgs/MonacoEditor", () => ({
  MonacoEditor: ({
    value,
    onChange,
    ariaLabel,
  }: {
    value: string;
    onChange?: (v: string) => void;
    ariaLabel?: string;
  }) => (
    <textarea
      aria-label={ariaLabel ?? "Code editor"}
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}));

function setup() {
  return render(
    <ToolProvider>
      <ConfigScreen />
    </ToolProvider>,
  );
}

const tab = (name: string) => screen.getByRole("tab", { name });
const button = (name: RegExp | string) => screen.getByRole("button", { name });

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("ConfigScreen — sub-navigation (§1)", () => {
  it("renders the three sub-views and switches between them", () => {
    setup();

    expect(tab("Form Editor").getAttribute("aria-selected")).toBe("true");
    expect(tab("Tool JSON")).toBeTruthy();
    expect(tab("Config JSON")).toBeTruthy();

    // Form Editor is the landing sub-view.
    expect(screen.getByLabelText("Description")).toBeTruthy();
    expect(screen.queryByLabelText("Tool JSON")).toBeNull();

    fireEvent.click(tab("Tool JSON"));
    expect(tab("Tool JSON").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByLabelText("Tool JSON")).toBeTruthy();
    expect(screen.queryByLabelText("Description")).toBeNull();

    fireEvent.click(tab("Config JSON"));
    expect(screen.getByLabelText("Config JSON")).toBeTruthy();
    expect(button(/Save to Config \(\.json\)/)).toBeTruthy();

    fireEvent.click(tab("Form Editor"));
    expect(screen.getByLabelText("Description")).toBeTruthy();
  });
});

describe("ConfigScreen — the 4 action buttons (§2)", () => {
  it("renders all four with their specified labels", () => {
    setup();

    expect(button(/📥 Load from Tool$/)).toBeTruthy();
    expect(button(/📥 Load from Config$/)).toBeTruthy();
    expect(button(/💾 Save to Tool$/)).toBeTruthy();
    expect(button(/💾 Save to Config$/)).toBeTruthy();
  });

  it("shows which source the form is currently reflecting", () => {
    const { container } = setup();

    expect(container.textContent).toContain("Reflecting:");
    expect(container.textContent).toContain("calc.ts");

    fireEvent.click(button(/📥 Load from Config$/));
    expect(container.textContent).toContain("calc.json");
  });
});

describe("ConfigScreen — inline validation (§2)", () => {
  it("warns when the rate limit falls outside the 60–600 RPM rubric range", () => {
    const { container } = setup();

    const rpm = screen.getByLabelText("Rate limit (requests per minute)");
    expect((rpm as HTMLInputElement).value).toBe("300");
    expect(container.textContent).not.toContain("outside the recommended");

    fireEvent.change(rpm, { target: { value: "5000" } });

    expect((rpm as HTMLInputElement).value).toBe("5000");
    expect(container.textContent).toContain("outside the recommended");
    expect(container.textContent).toContain("60–600");
  });

  it("flags a network request that is not an absolute URL prefix", () => {
    const { container } = setup();

    const input = screen.getByLabelText("Add Network requests");
    fireEvent.change(input, { target: { value: "api.openweathermap.org" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(container.textContent).toContain(
      "must be an absolute URL prefix starting with http:// or https://",
    );

    // A well-formed prefix clears the warning.
    fireEvent.click(screen.getByLabelText("Remove api.openweathermap.org from Network requests"));
    fireEvent.change(input, { target: { value: "https://api.openweathermap.org" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(container.textContent).not.toContain("must be an absolute URL prefix");
    expect(
      screen.getByLabelText("Remove https://api.openweathermap.org from Network requests"),
    ).toBeTruthy();
  });

  it("flags an actionable error declared without actionable_advice", () => {
    const { container } = setup();

    expect(container.textContent).not.toContain("Missing actionable_advice");

    fireEvent.click(button(/Add Error/));

    expect(container.textContent).toContain("Missing actionable_advice");
    expect(container.textContent).toContain("the LLM rubric fails tools without it");

    const advice = screen.getByLabelText("Actionable advice 2");
    fireEvent.change(advice, { target: { value: "Retry with a valid city name." } });

    expect(container.textContent).not.toContain("Missing actionable_advice");
  });
});

describe("ConfigScreen — synchronization matrix (§5)", () => {
  it("Save to Tool pushes the form into the .ts config the Tool JSON pane projects", () => {
    setup();

    const version = screen.getByLabelText("Version");
    fireEvent.change(version, { target: { value: "9.9.9" } });

    // Not committed yet: the Tool JSON pane still shows the stored config.
    fireEvent.click(tab("Tool JSON"));
    expect((screen.getByLabelText("Tool JSON") as HTMLTextAreaElement).value).toContain(
      '"version": "1.1.0"',
    );

    fireEvent.click(tab("Form Editor"));
    fireEvent.click(button(/💾 Save to Tool$/));
    fireEvent.click(tab("Tool JSON"));

    expect((screen.getByLabelText("Tool JSON") as HTMLTextAreaElement).value).toContain(
      '"version": "9.9.9"',
    );
  });

  it("Save to Config writes only the standalone .json and reports the divergence", () => {
    const { container } = setup();

    fireEvent.change(screen.getByLabelText("Version"), { target: { value: "2.0.0" } });
    fireEvent.click(button(/💾 Save to Config$/));

    // The .ts side is untouched, so the two files now disagree on `version`.
    expect(container.textContent).toContain("1 value differs");
    expect(container.textContent).toContain("version");

    fireEvent.click(tab("Config JSON"));
    expect((screen.getByLabelText("Config JSON") as HTMLTextAreaElement).value).toContain(
      '"version": "2.0.0"',
    );

    fireEvent.click(tab("Tool JSON"));
    expect((screen.getByLabelText("Tool JSON") as HTMLTextAreaElement).value).toContain(
      '"version": "1.1.0"',
    );
  });

  it("rejects invalid JSON in the Tool JSON pane and leaves the store alone", async () => {
    const { toast } = await import("sonner");
    setup();

    fireEvent.click(tab("Tool JSON"));
    const editor = screen.getByLabelText("Tool JSON") as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '{ "version": ' } });

    expect(screen.getByText(/modified — not saved/)).toBeTruthy();

    fireEvent.click(button(/Save to Tool \(\.ts file\)/));

    expect(screen.getByRole("alert").textContent).toBeTruthy();
    expect(toast.error).toHaveBeenCalled();

    // The store never saw the broken buffer.
    fireEvent.click(tab("Form Editor"));
    fireEvent.click(button(/📥 Load from Tool$/));
    expect((screen.getByLabelText("Version") as HTMLInputElement).value).toBe("1.1.0");
  });

  it("Config JSON: Load from Tool replaces the buffer with the .ts config", () => {
    setup();

    fireEvent.change(screen.getByLabelText("Version"), { target: { value: "3.1.4" } });
    fireEvent.click(button(/💾 Save to Tool$/));

    fireEvent.click(tab("Config JSON"));
    const editor = screen.getByLabelText("Config JSON") as HTMLTextAreaElement;
    expect(editor.value).toContain('"version": "1.1.0"');

    fireEvent.click(button(/📥 Load from Tool \(\.ts\)/));
    expect((screen.getByLabelText("Config JSON") as HTMLTextAreaElement).value).toContain(
      '"version": "3.1.4"',
    );

    fireEvent.click(button(/💾 Save to Config \(\.json\)/));
    expect(screen.getByText(/in sync with calc\.json/)).toBeTruthy();
  });
});

describe("ConfigScreen — signature and secrets editors (§2)", () => {
  it("adds an input field, keeps the object shape, and round-trips through the .ts", () => {
    setup();

    const addField = screen.getAllByRole("button", { name: /Add Field/ })[0];
    expect(addField).toBeTruthy();
    fireEvent.click(addField!);

    const nameInput = screen.getByLabelText("input name 4");
    fireEvent.change(nameInput, { target: { value: "units" } });
    fireEvent.change(screen.getByLabelText("input enum 4"), {
      target: { value: "metric, imperial" },
    });
    fireEvent.click(screen.getByLabelText("input 4 required"));

    fireEvent.click(button(/💾 Save to Tool$/));
    fireEvent.click(tab("Tool JSON"));

    const json = (screen.getByLabelText("Tool JSON") as HTMLTextAreaElement).value;
    const parsed = JSON.parse(json) as {
      signature: {
        inputs: { type: string; properties: Record<string, unknown>; required: string[] };
      };
    };
    expect(parsed.signature.inputs.type).toBe("object");
    expect(parsed.signature.inputs.properties["units"]).toEqual({
      type: "string",
      enum: ["metric", "imperial"],
    });
    expect(parsed.signature.inputs.required).toContain("units");
    // The pre-existing fields survived.
    expect(Object.keys(parsed.signature.inputs.properties)).toEqual([
      "a",
      "b",
      "operation",
      "units",
    ]);
  });

  it("declares a secret with a description and an optional flag", () => {
    setup();

    fireEvent.click(button(/Add Secret/));
    fireEvent.change(screen.getByLabelText("Secret name 1"), {
      target: { value: "OPENWEATHER_API_KEY" },
    });
    fireEvent.change(screen.getByLabelText("Secret description 1"), {
      target: { value: "Key for api.openweathermap.org" },
    });
    fireEvent.click(screen.getByLabelText("Secret 1 optional"));

    fireEvent.click(button(/💾 Save to Tool$/));
    fireEvent.click(tab("Tool JSON"));

    const parsed = JSON.parse(
      (screen.getByLabelText("Tool JSON") as HTMLTextAreaElement).value,
    ) as { secrets: Record<string, { description: string; isOptional: boolean }> };
    expect(parsed.secrets["OPENWEATHER_API_KEY"]).toEqual({
      description: "Key for api.openweathermap.org",
      isOptional: true,
    });
  });

  it("removes a signature row without corrupting the remaining ones", () => {
    setup();

    fireEvent.click(screen.getByLabelText("Remove input operation"));
    fireEvent.click(button(/💾 Save to Tool$/));
    fireEvent.click(tab("Tool JSON"));

    const parsed = JSON.parse(
      (screen.getByLabelText("Tool JSON") as HTMLTextAreaElement).value,
    ) as { signature: { inputs: { properties: Record<string, unknown>; required: string[] } } };
    expect(Object.keys(parsed.signature.inputs.properties)).toEqual(["a", "b"]);
    expect(parsed.signature.inputs.required).toEqual(["a", "b"]);
  });
});
