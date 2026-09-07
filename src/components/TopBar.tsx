import { FolderOpen, FolderTree, Rocket, Save, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useTool } from "@/state/toolStore";

export function TopBar() {
  const { toolName, setToolName, dirty, markSaved } = useTool();

  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-4 py-3 shadow-sm">
      <div className="mr-3 flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Sparkles className="h-4 w-4" />
        </span>
        <div className="leading-none">
          <span className="block font-display text-base font-extrabold text-primary">agentsable</span>
          <span className="mt-1 block text-[0.65rem] font-semibold uppercase text-secondary">Tool Workspace</span>
        </div>
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
