// @vitest-environment jsdom
/**
 * The persistent left AI pane (01-system-overview.md §2):
 *  - it never fakes a reply when Claude is unconfigured
 *  - it applies the returned edits to the real store
 *  - the Validator's [ Auto-Fix ] buttons drive it via `tgs:ai-submit` (§5)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AI_SUBMIT_EVENT, AiSidebar } from "@/components/AiSidebar";
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

vi.mock("@/rpc/tgsServerFns", () => ({
  getClaudeStatus: vi.fn(async () => ({ configured: true, model: "claude-opus-5" })),
  postAssistantTurn: vi.fn(async () => ({ ok: true, reply: "Done.", edits: [] })),
  postLlmValidation: vi.fn(async () => ({ ok: true, results: [], attempts: 1 })),
}));

import { getClaudeStatus, postAssistantTurn } from "@/rpc/tgsServerFns";

type TurnPayload = {
  data: {
    messages: { role: string; content: string }[];
    activeTab: string;
    context: { toolName: string; tsCode: string };
  };
};

function firstTurnPayload(): TurnPayload {
  const call = vi.mocked(postAssistantTurn).mock.calls[0];
  expect(call).toBeDefined();
  return (call as unknown as [TurnPayload])[0];
}

const AUTO_FIX_PROMPT = "Auto-fix the actionable advice for CITY_NOT_FOUND.";

/** Stands in for the Validator Dashboard's [ Auto-Fix ] button. */
function AutoFixButton({ prompt }: { prompt: string }) {
  const { appendChat } = useTool();
  return (
    <button
      onClick={() => {
        appendChat({ role: "user", text: prompt });
        window.dispatchEvent(new CustomEvent(AI_SUBMIT_EVENT, { detail: { prompt } }));
      }}
    >
      auto-fix
    </button>
  );
}

/** Surfaces the store's Editor buffer so an applied `logic` edit is observable. */
function LogicProbe() {
  const { bundle } = useTool();
  return <pre data-testid="logic">{bundle.logic}</pre>;
}

function renderSidebar() {
  return render(
    <ToolProvider>
      <AiSidebar />
      <LogicProbe />
    </ToolProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(getClaudeStatus).mockResolvedValue({ configured: true, model: "claude-opus-5" });
  vi.mocked(postAssistantTurn).mockResolvedValue({ ok: true, reply: "Done.", edits: [] });
});

afterEach(() => {
  cleanup();
});

describe("AiSidebar", () => {
  it("disables the composer and explains ANTHROPIC_API_KEY when Claude is unconfigured", async () => {
    vi.mocked(getClaudeStatus).mockResolvedValue({
      configured: false,
      model: "claude-opus-5",
      reason: "ANTHROPIC_API_KEY is not set on the TGS server.",
    });

    renderSidebar();

    await waitFor(() =>
      expect(
        screen.getByText(
          "Claude is not configured. Set ANTHROPIC_API_KEY in the server environment and restart.",
        ),
      ).toBeTruthy(),
    );

    const composer = screen.getByLabelText("Type a command") as HTMLInputElement;
    expect(composer.disabled).toBe(true);
    expect((screen.getByLabelText("Send command") as HTMLButtonElement).disabled).toBe(true);
    expect(postAssistantTurn).not.toHaveBeenCalled();
  });

  it("applies a returned `logic` edit to the store", async () => {
    vi.mocked(postAssistantTurn).mockResolvedValue({
      ok: true,
      reply: "I rewrote the execute() body.",
      edits: [
        {
          kind: "logic",
          logic: "// REWRITTEN BY THE ASSISTANT\nexport default async function execute() {}",
          rationale: "handle the 404 case",
        },
      ],
    });

    renderSidebar();
    await waitFor(() =>
      expect((screen.getByLabelText("Type a command") as HTMLInputElement).disabled).toBe(false),
    );

    fireEvent.change(screen.getByLabelText("Type a command"), {
      target: { value: "Handle a 404 from the upstream API." },
    });
    fireEvent.click(screen.getByLabelText("Send command"));

    await waitFor(() =>
      expect(screen.getByTestId("logic").textContent).toContain("// REWRITTEN BY THE ASSISTANT"),
    );

    // The reply and an explicit "here is what I changed" note are both shown.
    await waitFor(() => expect(screen.getByText(/I rewrote the execute\(\) body\./)).toBeTruthy());
    expect(screen.getByText(/Rewrote the execution logic/)).toBeTruthy();

    // The full global context travelled with the turn.
    const payload = firstTurnPayload();
    expect(payload.data.context.toolName).toBe("calc");
    expect(payload.data.context.tsCode).toContain("export default async function execute");
    expect(payload.data.activeTab).toBe("Raw Data");
    expect(payload.data.messages.at(-1)).toEqual({
      role: "user",
      content: "Handle a 404 from the upstream API.",
    });
  });

  it("submits a turn when the `tgs:ai-submit` window event fires", async () => {
    render(
      <ToolProvider>
        <AiSidebar />
        <AutoFixButton prompt={AUTO_FIX_PROMPT} />
      </ToolProvider>,
    );
    await waitFor(() =>
      expect((screen.getByLabelText("Type a command") as HTMLInputElement).disabled).toBe(false),
    );

    // Exactly what ValidatorDashboard's [ Auto-Fix ] does: log the user turn,
    // then hand the transport to this pane.
    await act(async () => {
      fireEvent.click(screen.getByText("auto-fix"));
    });

    await waitFor(() => expect(postAssistantTurn).toHaveBeenCalledTimes(1));
    const messages = firstTurnPayload().data.messages;
    expect(messages.at(-1)).toEqual({ role: "user", content: AUTO_FIX_PROMPT });
    // The dispatcher already logged the turn — it must not be duplicated.
    expect(messages.filter((m) => m.content === AUTO_FIX_PROMPT)).toHaveLength(1);
    expect(screen.getAllByText(AUTO_FIX_PROMPT)).toHaveLength(1);
  });
});
