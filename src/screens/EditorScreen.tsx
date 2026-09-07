import { useState } from "react";
import { Code2, Eye, EyeOff } from "lucide-react";
import { CodePane } from "@/components/CodePane";
import { useTool } from "@/state/toolStore";

export function EditorScreen() {
  const { logic, setLogic, files } = useTool();
  const [showConfig, setShowConfig] = useState(false);
  const combined = files[0]!.content;

  return (
    <section className="panel">
      <div className="panel-head">
        <Code2 className="h-4 w-4 text-primary" />
        <span>TypeScript Logic{showConfig ? "" : " — config block hidden"}</span>
        <button className="btn ml-auto" onClick={() => setShowConfig((v) => !v)}>
          {showConfig ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          {showConfig ? "Hide config block" : "Show config block"}
        </button>
      </div>
      <div className="p-3">
        {showConfig ? (
          <CodePane value={combined} readOnly />
        ) : (
          <CodePane value={logic} onChange={setLogic} />
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Edit only the <span className="font-mono text-primary">execute</span> function. The config
          object is stitched back on save.
        </p>
      </div>
    </section>
  );
}
