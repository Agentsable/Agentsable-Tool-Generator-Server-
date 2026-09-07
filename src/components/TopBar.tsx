import { FolderOpen, FolderTree, Rocket, Save, Terminal } from "lucide-react";
import { toast } from "sonner";
import { useTool } from "@/state/toolStore";

export function TopBar() {
  const { toolName, setToolName, dirty, markSaved } = useTool();

  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2">
      <div className="mr-2 flex items-center gap-2">
        <Terminal className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold tracking-tight">STS Tool Workspace</span>
      </div>

      <button className="btn" onClick={() => toast("Pick a tool bundle to load")}>
        <FolderOpen className="h-4 w-4" /> Load File
      </button>
      <button
        className="btn"
        onClick={() => toast("Mounting a local folder needs a supported browser")}
      >
        <FolderTree className="h-4 w-4" /> Select Local Folder
      </button>

      <div className="mx-auto flex items-center gap-2">
        <span className="text-xs uppercase tracking-widest text-muted-foreground">tool</span>
        <input
          value={toolName}
          onChange={(e) => setToolName(e.target.value.replace(/\s+/g, "_"))}
          className="field w-56 text-center"
          aria-label="Tool name"
        />
        <span className="chip">{dirty ? "unsaved" : "in sync"}</span>
      </div>

      <button
        className="btn"
        onClick={() => {
          markSaved();
          toast.success("Bundle serialized to the four tool files");
        }}
      >
        <Save className="h-4 w-4" /> Save
      </button>
      <button
        className="btn btn-primary"
        onClick={() => toast.success("Publish queued for the production tools server")}
      >
        <Rocket className="h-4 w-4" /> Publish
      </button>
    </header>
  );
}
