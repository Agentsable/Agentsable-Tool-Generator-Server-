/**
 * [ Raw Data ] — docs/llm_generated/10-screen-raw-data.md
 *
 * A read-only, developer-centric diagnostic view of the four files that make up
 * the tool bundle. The sub-navigation renders the ACTIVE TOOL's filenames, so
 * renaming the tool in the top action bar renames all four tabs at once (the
 * store derives `files` from `fileNames(bundle.name)`).
 *
 * Everything here is the serialized output of the global state: the panes are
 * strictly read-only so the raw text can never desynchronize from the store
 * (spec: "Read-Only Safety"). Edits happen in Editor / Config / Secrets / Runner.
 */
import { useMemo, useState } from "react";
import {
  FileCode2,
  Lock,
  ShieldAlert,
  KeyRound,
  Braces,
  FlaskConical,
  ArrowRight,
} from "lucide-react";

import { MonacoEditor, type MonacoLanguage } from "@/components/tgs/MonacoEditor";
import { useTool, type FileKind, type WorkspaceTab } from "@/state/toolStore";

type FileMeta = {
  language: MonacoLanguage;
  icon: typeof FileCode2;
  /** What this file is, per 10-screen-raw-data.md "Sub-Navigation Tabs". */
  blurb: string;
  /** Where a developer goes to change it. */
  editIn: WorkspaceTab;
};

const FILE_META: Record<FileKind, FileMeta> = {
  ts: {
    language: "typescript",
    icon: FileCode2,
    blurb:
      "The primary executable file: the /core/ imports, the baseConfig object with its embedded tests, and the execute(request, context) function — recombined by the AST engine.",
    editIn: "Editor",
  },
  json: {
    language: "json",
    icon: Braces,
    blurb:
      "The standalone ToolConfig JSON — the exact payload an external SDK or MCP client reads to understand the tool's inputs and outputs.",
    editIn: "Config",
  },
  env: {
    language: "ini",
    icon: KeyRound,
    blurb:
      "Local testing secrets, keyed by config.secrets. Injected into context.env by the local Deno runner and used only for local HTTP testing.",
    editIn: "Secrets",
  },
  tests: {
    language: "json",
    icon: FlaskConical,
    blurb:
      "The external HTTP-driven test suite. Keeps the main .ts clean while allowing large edge-case suites.",
    editIn: "Runner",
  },
};

const EDIT_TABS: WorkspaceTab[] = ["Editor", "Config", "Secrets", "Runner"];

function byteLength(text: string): number {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
}

export function RawDataScreen() {
  const { files, dirty, bundle, requestFocus } = useTool();
  const [activeKind, setActiveKind] = useState<FileKind>("ts");

  const totalBytes = useMemo(
    () => files.reduce((sum, f) => sum + byteLength(f.content), 0),
    [files],
  );

  const file = files.find((f) => f.kind === activeKind) ?? files[0];
  if (!file) return null;

  const meta = FILE_META[file.kind];
  const Icon = meta.icon;
  const lineCount = file.content === "" ? 0 : file.content.split("\n").length;

  return (
    <section className="panel">
      <div className="panel-head">
        <FileCode2 className="h-4 w-4 text-primary" />
        <span className="font-semibold">📄 RAW DATA:</span>

        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Tool bundle files">
          {files.map((f) => (
            <button
              key={f.kind}
              type="button"
              role="tab"
              className="subtab"
              data-active={f.kind === activeKind}
              aria-selected={f.kind === activeKind}
              onClick={() => setActiveKind(f.kind)}
            >
              {f.name}
            </button>
          ))}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-1">
          <span className="chip" title="These files are serialized from the global tool state.">
            serialized from global state · {totalBytes.toLocaleString()} B
          </span>
          <span
            className="chip"
            data-dirty={dirty}
            title={
              dirty
                ? "Unsaved changes are already reflected here, but are not yet written to disk."
                : "Everything shown here matches the last save."
            }
          >
            <span className={dirty ? "text-warning" : "text-success"}>
              {dirty ? "● unsaved changes" : "● in sync with disk"}
            </span>
          </span>
        </div>
      </div>

      <div className="space-y-3 p-3">
        {/* ------------------------------------------------------------------
            Read-Only Safety (10-screen-raw-data.md)
        ------------------------------------------------------------------ */}
        <div
          className="finding"
          data-state="warn"
          role="note"
          aria-label="Read-only view"
          data-testid="raw-readonly-notice"
        >
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div className="space-y-2 text-xs">
            <p className="font-semibold text-foreground">
              Read-only view — this is the serialized output of the global tool state.
            </p>
            <p className="text-muted-foreground">
              Typing here is disabled on purpose: editing the raw text directly would desynchronize
              it from the store that produced it. Make changes in the dedicated tabs and they are
              serialized back into these four files instantly.
            </p>
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-muted-foreground">Edit in:</span>
              {EDIT_TABS.map((tab) => (
                <button key={tab} type="button" className="btn" onClick={() => requestFocus(tab)}>
                  {tab}
                  <ArrowRight className="h-3 w-3" />
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ------------------------------- pane ------------------------------- */}
        <div className="flex flex-wrap items-center gap-2">
          <Icon className="h-4 w-4 text-primary" />
          <span className="font-mono text-sm text-foreground" data-testid="raw-active-file">
            {file.name}
          </span>
          <span className="chip">{meta.language}</span>
          <span className="chip">
            {lineCount} lines · {byteLength(file.content).toLocaleString()} B
          </span>
          <span className="chip">read-only</span>
          {file.kind === "env" ? (
            <span className="chip" data-testid="raw-env-publish-warning">
              <ShieldAlert className="h-3 w-3 text-warning" />
              <span className="text-warning">real local values — excluded from [ 🚀 Publish ]</span>
            </span>
          ) : null}
        </div>

        <p className="text-xs text-muted-foreground">{meta.blurb}</p>

        {file.kind === "env" && file.content.trim() === "" ? (
          <p className="text-xs text-muted-foreground" data-testid="raw-env-empty">
            <code className="font-mono text-foreground">{bundle.name}</code> declares no secrets in{" "}
            <code className="font-mono text-foreground">config.secrets</code>, so this file is
            empty. Declare one in the Config tab, then fill its value in the Secrets tab.
          </p>
        ) : null}

        <div data-testid="raw-pane">
          <MonacoEditor
            value={file.content}
            language={meta.language}
            readOnly
            // Namespaced: Monaco models are global and keyed by path, and the
            // [ Editor ] tab already owns `<tool>.ts` for its logic-only buffer
            // while the Runner owns `<tool>_tests.json`. Sharing a path would
            // make two panes show each other's content.
            path={`raw/${file.name}`}
            height="60vh"
            ariaLabel={`${file.name} (read-only)`}
          />
        </div>

        <p className="text-xs text-muted-foreground">
          <span className="text-foreground">💾 Save</span> in the top action bar writes all four
          files to disk (or to the mounted local folder), running a full AST compile pass to
          recombine the Editor buffer with the stored config.
        </p>
      </div>
    </section>
  );
}
