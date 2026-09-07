import { useState } from "react";
import { FileCode2 } from "lucide-react";
import { CodePane } from "@/components/CodePane";
import { useTool } from "@/state/toolStore";

export function RawDataScreen() {
  const { files } = useTool();
  const [active, setActive] = useState(0);
  const file = files[Math.min(active, files.length - 1)]!;

  return (
    <section className="panel">
      <div className="panel-head">
        <FileCode2 className="h-4 w-4 text-primary" />
        <span>Raw Data</span>
        <div className="ml-2 flex flex-wrap gap-1">
          {files.map((f, i) => (
            <button
              key={f.name}
              className="tab"
              data-active={i === active}
              onClick={() => setActive(i)}
            >
              {f.name}
            </button>
          ))}
        </div>
      </div>
      <div className="p-3">
        <p className="mb-3 text-xs text-muted-foreground">
          Read-only. Everything you change in the visual builders is serialized here instantly.
        </p>
        <CodePane value={file.content} readOnly />
      </div>
    </section>
  );
}
