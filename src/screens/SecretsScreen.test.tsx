// @vitest-environment jsdom
/**
 * [ Secrets ] — docs/llm_generated/13-screen-secrets.md.
 *
 * The default `calc` bundle declares no secrets, so the render tests either
 * exercise the empty state or first drive the store to declare some through the
 * same action the Config tab uses (`saveToolJsonBuffer`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { toast } from "sonner";

import type { ToolConfig } from "@/lib/tgs/contract";
import { ToolProvider, useTool } from "@/state/toolStore";
import { SecretsScreen, secretRows } from "@/screens/SecretsScreen";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  }),
}));

const WEATHER_CONFIG: Partial<ToolConfig> = {
  name: "weather_fetcher",
  secrets: {
    WEATHER_API_KEY: { description: "Key for the upstream forecast API." },
    SLACK_WEBHOOK_URL: { description: "Where to post alerts.", isOptional: true },
    LEGACY_TOKEN: { description: "Kept for the old endpoint.", isOptional: false },
  },
};

/** Drives the store the way the Config tab does, and exposes the active tab. */
function Harness({ config }: { config?: Partial<ToolConfig> }) {
  const { saveToolJsonBuffer, activeTab } = useTool();
  return (
    <div>
      <button type="button" onClick={() => saveToolJsonBuffer(JSON.stringify(config ?? {}))}>
        declare secrets
      </button>
      <span data-testid="active-tab">{activeTab}</span>
    </div>
  );
}

function renderSecrets(config?: Partial<ToolConfig>) {
  const view = render(
    <ToolProvider>
      <Harness {...(config === undefined ? {} : { config })} />
      <SecretsScreen />
    </ToolProvider>,
  );
  if (config) fireEvent.click(screen.getByRole("button", { name: "declare secrets" }));
  return view;
}

const valueInput = (key: string) => screen.getByLabelText(`Value for ${key}`) as HTMLInputElement;

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

/* ------------------------------------------------------------------ */
/* §3 strict schema mapping                                             */
/* ------------------------------------------------------------------ */

describe("secretRows (strict schema mapping)", () => {
  it("renders one row per declared key, in declaration order", () => {
    expect(secretRows(WEATHER_CONFIG).map((r) => r.key)).toEqual([
      "WEATHER_API_KEY",
      "SLACK_WEBHOOK_URL",
      "LEGACY_TOKEN",
    ]);
  });

  it("derives Required vs Optional from isOptional", () => {
    const rows = secretRows(WEATHER_CONFIG);
    // unset ⇒ Required
    expect(rows[0]).toEqual({
      key: "WEATHER_API_KEY",
      description: "Key for the upstream forecast API.",
      required: true,
    });
    // true ⇒ Optional
    expect(rows[1]?.required).toBe(false);
    // false ⇒ Required
    expect(rows[2]?.required).toBe(true);
  });

  it("shows nothing for a tool that declares no secrets", () => {
    expect(secretRows({})).toEqual([]);
    expect(secretRows({ secrets: {} })).toEqual([]);
  });
});

describe("SecretsScreen empty state", () => {
  it("points the default calc bundle at the Config tab's secrets editor", () => {
    renderSecrets();
    expect(screen.getByText(/declares no secrets/)).toBeTruthy();
    expect(screen.queryByLabelText(/^Value for /)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Open the Config tab's secrets editor/ }));
    expect(screen.getByTestId("active-tab").textContent).toBe("Config");
  });
});

describe("SecretsScreen fields", () => {
  it("renders only declared secrets, with their status and description", () => {
    renderSecrets(WEATHER_CONFIG);

    expect(screen.getByText("🔑 WEATHER_API_KEY")).toBeTruthy();
    expect(screen.getByText("🔑 SLACK_WEBHOOK_URL")).toBeTruthy();
    expect(screen.queryByText("🔑 UNDECLARED_KEY")).toBeNull();
    expect(screen.getAllByLabelText(/^Value for /)).toHaveLength(3);

    const required = screen.getByTestId("secret-WEATHER_API_KEY");
    expect(within(required).getByText("Status: Required")).toBeTruthy();
    expect(within(required).getByText("Key for the upstream forecast API.")).toBeTruthy();
    expect(within(required).getByText("empty")).toBeTruthy();

    const optional = screen.getByTestId("secret-SLACK_WEBHOOK_URL");
    expect(within(optional).getByText("Status: Optional")).toBeTruthy();

    // isOptional: false is still Required.
    expect(
      within(screen.getByTestId("secret-LEGACY_TOKEN")).getByText("Status: Required"),
    ).toBeTruthy();
  });

  it("masks values and reveals them with the 👁️ toggle", () => {
    renderSecrets(WEATHER_CONFIG);

    const input = valueInput("WEATHER_API_KEY");
    expect(input.type).toBe("password");

    fireEvent.change(input, { target: { value: "sk-typed-by-hand" } });
    expect(valueInput("WEATHER_API_KEY").value).toBe("sk-typed-by-hand");
    expect(within(screen.getByTestId("secret-WEATHER_API_KEY")).getByText("set")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reveal WEATHER_API_KEY" }));
    expect(valueInput("WEATHER_API_KEY").type).toBe("text");

    fireEvent.click(screen.getByRole("button", { name: "Hide WEATHER_API_KEY" }));
    expect(valueInput("WEATHER_API_KEY").type).toBe("password");
  });
});

/* ------------------------------------------------------------------ */
/* §3 smart .env loader                                                 */
/* ------------------------------------------------------------------ */

describe("smart .env loader", () => {
  it("fills empty fields, never overwrites, and reports ignored keys", () => {
    renderSecrets(WEATHER_CONFIG);

    // A value typed by hand must survive the merge.
    fireEvent.change(valueInput("SLACK_WEBHOOK_URL"), {
      target: { value: "https://hooks.slack.test/typed" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Paste \.env/ }));
    fireEvent.change(screen.getByLabelText(/Paste the contents of a \.env file/), {
      target: {
        value: [
          "# a comment",
          "WEATHER_API_KEY=sk-from-env",
          "SLACK_WEBHOOK_URL=https://hooks.slack.test/from-env",
          "UNDECLARED_KEY=should-be-ignored",
        ].join("\n"),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Merge into empty fields" }));

    // Empty field filled...
    expect(valueInput("WEATHER_API_KEY").value).toBe("sk-from-env");
    // ...typed field untouched...
    expect(valueInput("SLACK_WEBHOOK_URL").value).toBe("https://hooks.slack.test/typed");
    // ...and the still-empty optional-free key stays empty.
    expect(valueInput("LEGACY_TOKEN").value).toBe("");

    const [, options] = vi.mocked(toast.success).mock.calls[0] ?? [];
    const description = (options as { description?: string } | undefined)?.description ?? "";
    expect(description).toContain("Filled 1 empty field: WEATHER_API_KEY.");
    expect(description).toContain("UNDECLARED_KEY");
    expect(description).toContain("not declared in config.secrets");
    // The undeclared key never becomes a field.
    expect(screen.queryByLabelText("Value for UNDECLARED_KEY")).toBeNull();
  });

  it("offers a file picker restricted to .env files, with the spec's caption", () => {
    renderSecrets(WEATHER_CONFIG);
    const input = screen.getByTestId("env-file-input") as HTMLInputElement;
    expect(input.type).toBe("file");
    expect(input.accept).toBe(".env,text/plain");
    expect(screen.getByText("(Fills only missing values)")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Load \.env File/ })).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
/* §3 publish exclusion / §4 runner interaction                         */
/* ------------------------------------------------------------------ */

describe("SecretsScreen notices", () => {
  it("states the publish exclusion and the Runner's context injection", () => {
    renderSecrets(WEATHER_CONFIG);
    expect(screen.getByText(/Publish exclusion\./)).toBeTruthy();
    expect(screen.getByText(/file is explicitly excluded/)).toBeTruthy();
    expect(screen.getByText(/does not\s+block execution on an empty required secret/)).toBeTruthy();
  });
});
