import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { AiSidebar } from "@/components/AiSidebar";
import { TopBar } from "@/components/TopBar";
import { ToolProvider } from "@/state/toolStore";
import { RawDataScreen } from "@/screens/RawDataScreen";
import { EditorScreen } from "@/screens/EditorScreen";
import { ConfigScreen } from "@/screens/ConfigScreen";
import { SecretsScreen } from "@/screens/SecretsScreen";
import { ValidatorScreen } from "@/screens/ValidatorScreen";
import { RunnerScreen } from "@/screens/RunnerScreen";

const TABS = ["Raw Data", "Editor", "Config", "Secrets", "Validator", "Runner"] as const;
type Tab = (typeof TABS)[number];

const title = "STS Tool Workspace — author, validate and test tools";
const description =
  "A local workspace for authoring Simple Tools Server tools: raw bundle view, focused code editor, config and secrets builders, validator dashboard and an HTTP test runner.";

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
  }),
  component: Workspace,
});

function Workspace() {
  const [tab, setTab] = useState<Tab>("Raw Data");

  return (
    <ToolProvider>
      <div className="flex h-screen flex-col bg-background">
        <h1 className="sr-only">STS Tool Workspace</h1>
        <TopBar />

        <nav className="flex flex-wrap gap-1 border-b border-border bg-surface px-3 py-2">
          {TABS.map((t) => (
            <button key={t} className="tab" data-active={t === tab} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </nav>

        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <AiSidebar activeTab={tab} />
          <main className="min-h-0 flex-1 overflow-y-auto p-4">
            {tab === "Raw Data" ? <RawDataScreen /> : null}
            {tab === "Editor" ? <EditorScreen /> : null}
            {tab === "Config" ? <ConfigScreen /> : null}
            {tab === "Secrets" ? <SecretsScreen /> : null}
            {tab === "Validator" ? <ValidatorScreen /> : null}
            {tab === "Runner" ? <RunnerScreen /> : null}
          </main>
        </div>
      </div>
    </ToolProvider>
  );
}
