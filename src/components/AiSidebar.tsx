import { useState } from "react";
import { Bot, CornerDownLeft, Sparkles } from "lucide-react";
import { useTool } from "@/state/toolStore";

export function AiSidebar({ activeTab }: { activeTab: string }) {
  const { chat, sendChat } = useTool();
  const [draft, setDraft] = useState("");

  return (
    <aside className="flex w-full flex-col border-b border-border bg-surface lg:h-full lg:w-[320px] lg:shrink-0 lg:border-b-0 lg:border-r">
      <div className="panel-head border-b">
        <Bot className="h-4 w-4 text-primary" />
        <span>AI Assistant</span>
        <span className="chip ml-auto">{activeTab}</span>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {chat.map((m) => (
          <div
            key={m.id}
            className={
              m.role === "assistant"
                ? "rounded-md border border-border bg-code p-3 text-sm leading-relaxed"
                : "rounded-md border border-border-strong bg-surface-raised p-3 text-sm leading-relaxed"
            }
          >
            <div className="mb-1 flex items-center gap-1.5 text-[0.68rem] uppercase tracking-widest text-muted-foreground">
              {m.role === "assistant" ? <Sparkles className="h-3 w-3 text-primary" /> : null}
              {m.role === "assistant" ? "agentsable agent" : "you"}
            </div>
            {m.text}
          </div>
        ))}
      </div>

      <form
        className="flex items-center gap-2 border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          sendChat(draft.trim());
          setDraft("");
        }}
      >
        <input
          className="field"
          placeholder="Type a command..."
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" aria-label="Send command">
          <CornerDownLeft className="h-4 w-4" />
        </button>
      </form>
    </aside>
  );
}
