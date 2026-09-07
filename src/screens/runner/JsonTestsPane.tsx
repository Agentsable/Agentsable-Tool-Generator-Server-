/**
 * [ Runner ] › [ JSON Tests ] — docs/llm_generated/15-screen-runner.md §4.2.
 *
 * A direct Monaco editor over the external `[tool_name]_tests.json` file, for
 * building large test banks decoupled from the execution logic. Saving updates
 * the file in global state and syncs immediately with [ Raw Data ].
 */
import { useCallback, useMemo, useState } from "react";
import { Save } from "lucide-react";
import { toast } from "sonner";

import { MonacoEditor } from "@/components/tgs/MonacoEditor";
import { useTool } from "@/state/toolStore";

export function JsonTestsPane() {
  const { bundle, files, saveJsonTests } = useTool();

  const fileName = `${bundle.name}_tests.json`;
  const stored = useMemo(() => files.find((f) => f.kind === "tests")?.content ?? "[]", [files]);

  const [buffer, setBuffer] = useState(stored);
  const [syncedFrom, setSyncedFrom] = useState(stored);
  const [error, setError] = useState<string | null>(null);

  const modified = buffer !== syncedFrom;

  // Resync when the file changes outside this pane (AI edit, file load, rename).
  // An unsaved local edit wins: it is never silently discarded.
  if (stored !== syncedFrom && !modified) {
    setSyncedFrom(stored);
    setBuffer(stored);
  }
  const divergedExternally = stored !== syncedFrom && modified;

  const save = useCallback(() => {
    const result = saveJsonTests(buffer);
    if (!result.ok) {
      setError(result.error ?? "The external test file must contain a JSON array.");
      toast.error("Nothing was written — the buffer is not a valid ToolTest array.");
      return;
    }
    setError(null);
    setSyncedFrom(buffer);
    toast.success(`Saved ${fileName}`, {
      description: "The [ Raw Data ] tab now shows the same content.",
    });
  }, [buffer, fileName, saveJsonTests]);

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary" onClick={save}>
          <Save className="h-4 w-4" aria-hidden /> 💾 Save to Tests JSON
        </button>
        <span className="chip">📦 {fileName}</span>
        {modified ? (
          <span className="chip text-warning">modified — not saved</span>
        ) : (
          <span className="chip text-muted-foreground">in sync</span>
        )}
        {divergedExternally ? (
          <span className="chip text-warning">
            the stored file changed elsewhere — saving overwrites it
          </span>
        ) : null}
      </div>

      {error ? (
        <div className="finding" data-state="fail">
          <span className="text-destructive">Invalid JSON — not saved: {error}</span>
        </div>
      ) : null}

      <MonacoEditor
        value={buffer}
        onChange={(next) => {
          setBuffer(next);
          setError(null);
        }}
        language="json"
        path={fileName}
        height="55vh"
        ariaLabel={`${fileName} editor`}
      />

      <p className="text-xs text-muted-foreground">
        These tests run alongside the embedded <code className="font-mono">{bundle.name}.ts</code>{" "}
        suite on the Dashboard. The file must contain a JSON array of{" "}
        <code className="font-mono">ToolTest</code> objects (<code className="font-mono">name</code>
        , <code className="font-mono">payload</code>, <code className="font-mono">expect</code>); an
        invalid buffer is never committed to global state.
      </p>
    </div>
  );
}
