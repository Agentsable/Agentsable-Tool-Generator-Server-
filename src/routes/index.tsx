/**
 * The TGS application shell — docs/llm_generated/01-system-overview.md §2.
 *
 *   +------------------------------------------------------------------+
 *   | [📂 Load File] [📁 Folder ▼] | [ ✏️ name ] | [ 💾 Save ] [ 🚀 Publish ] |
 *   +------------------------------------------------------------------+
 *   | [ Raw Data ] [ Editor ] [ Config ] [ Secrets ] [ Validator ] [ Runner ] |
 *   +---------------------------+--------------------------------------+
 *   |  🤖 AI Assistant          |        ( ACTIVE TAB WORKSPACE )      |
 *   +---------------------------+--------------------------------------+
 *
 * The tab state lives in the store, not here, so the Validator's finding links
 * (`requestFocus`) can switch tabs from anywhere (14-screen-validator.md §5).
 */
import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";

import { AiSidebar } from "@/components/AiSidebar";
import { TopBar } from "@/components/TopBar";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ToolProvider, WORKSPACE_TABS, useTool } from "@/state/toolStore";
import { RawDataScreen } from "@/screens/RawDataScreen";
import { EditorScreen } from "@/screens/EditorScreen";
import { ConfigScreen } from "@/screens/ConfigScreen";
import { SecretsScreen } from "@/screens/SecretsScreen";
import { ValidatorScreen } from "@/screens/ValidatorScreen";
import { RunnerScreen } from "@/screens/RunnerScreen";

const title = "Agentsable Tool Workspace — Build and Test Tools";
const description =
  "The Agentsable workspace for authoring, configuring, validating, and testing production-ready agent tools.";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "/" }],
  }),
  component: WorkspaceRoute,
});

function WorkspaceRoute() {
  return (
    <ToolProvider>
      <Workspace />
    </ToolProvider>
  );
}

/** True once the viewport is at least Tailwind's `lg` breakpoint. */
function useIsWide(): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(min-width: 1024px)");
    const sync = () => setWide(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return wide;
}

function ActiveScreen() {
  const { activeTab } = useTool();
  switch (activeTab) {
    case "Raw Data":
      return <RawDataScreen />;
    case "Editor":
      return <EditorScreen />;
    case "Config":
      return <ConfigScreen />;
    case "Secrets":
      return <SecretsScreen />;
    case "Validator":
      return <ValidatorScreen />;
    case "Runner":
      return <RunnerScreen />;
    default:
      return null;
  }
}

function Workspace() {
  const { activeTab, setActiveTab } = useTool();
  const wide = useIsWide();

  return (
    <div className="flex h-screen flex-col bg-background">
      <h1 className="sr-only">Agentsable Tool Workspace</h1>
      <TopBar />

      <nav
        aria-label="Workspace sections"
        className="flex flex-wrap items-center gap-0 border-b border-border bg-surface px-4"
      >
        {WORKSPACE_TABS.map((tab) => (
          <button
            key={tab}
            className="tab"
            data-active={tab === activeTab}
            aria-current={tab === activeTab ? "page" : undefined}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </nav>

      {wide ? (
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          <ResizablePanel
            id="tgs-ai-pane"
            defaultSize={320}
            minSize={240}
            maxSize={560}
            className="min-h-0"
          >
            <AiSidebar />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="tgs-workspace-pane" minSize={400} className="min-h-0">
            <main className="h-full min-h-0 overflow-y-auto p-4">
              <ActiveScreen />
            </main>
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="max-h-[45vh] min-h-0 shrink-0">
            <AiSidebar />
          </div>
          <main className="min-h-0 flex-1 overflow-y-auto p-4">
            <ActiveScreen />
          </main>
        </div>
      )}
    </div>
  );
}
