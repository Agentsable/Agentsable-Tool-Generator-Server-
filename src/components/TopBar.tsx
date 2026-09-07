/**
 * Top Action Bar — docs/llm_generated/01-system-overview.md §2.
 *
 *   [📂 Load File] [📁 Select Local Folder ▼] | [ ✏️ weather_fetcher ] | [ 💾 Save ] [ 🚀 Publish ]
 *
 * Behaviour contracts:
 * - Renaming the tool renames all four files (10-screen-raw-data.md).
 * - [ 💾 Save ] writes all four files to the mounted directory, or downloads them.
 * - [ 🚀 Publish ] is gated by the Validator: score >= 90 AND zero deterministic
 *   failures (14-screen-validator.md §2.3), and never emits the `.env`
 *   (13-screen-secrets.md §3).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  FolderOpen,
  FolderTree,
  Rocket,
  Save,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";

import {
  downloadPublishBundle,
  isFileSystemAccessSupported,
  pickToolFile,
  pickWorkspaceDirectory,
  readFilesFromInput,
  saveAllFiles,
} from "@/lib/tgs/fsAccess";
import { fileNames } from "@/lib/tgs/toolFiles";
import { useTool, type FileKind } from "@/state/toolStore";

/** The four file bodies, in the shape `fsAccess` wants them. */
type FileSet = { ts: string; json: string; env: string; tests: string };

const KINDS: readonly FileKind[] = ["ts", "json", "env", "tests"] as const;

const UNSUPPORTED_HINT =
  "Mounting a local folder needs the File System Access API — a Chromium-based browser (Chrome, Edge, Arc) served over https or localhost. Use [Load File] and download the saved files instead.";

function errorMessage(e: unknown): string {
  return e instanceof Error && e.message ? e.message : String(e);
}

function fileSetFrom(files: { content: string; kind: FileKind }[]): FileSet {
  const pick = (kind: FileKind) => files.find((f) => f.kind === kind)?.content ?? "";
  return { ts: pick("ts"), json: pick("json"), env: pick("env"), tests: pick("tests") };
}

/** "Found weather.ts, weather.json — missing weather.env, weather_tests.json". */
function describeLoad(baseName: string, found: Partial<Record<FileKind, string>>): string {
  const names = fileNames(baseName);
  const present: string[] = [];
  const missing: string[] = [];
  for (const kind of KINDS) {
    (found[kind] === undefined ? missing : present).push(names[kind]);
  }
  const head = present.length ? `Found ${present.join(", ")}` : "Found none of the four files";
  return missing.length ? `${head} — missing ${missing.join(", ")}` : head;
}

export function TopBar() {
  const {
    bundle,
    files,
    dirty,
    markSaved,
    setToolName,
    loadBundleFromFiles,
    mountedDir,
    setMountedDir,
    validation,
  } = useTool();

  const [fsSupported, setFsSupported] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderTools, setFolderTools] = useState<string[] | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderRef = useRef<HTMLDivElement | null>(null);
  const publishRef = useRef<HTMLDivElement | null>(null);

  const names = fileNames(bundle.name);

  // The API check touches `globalThis`; run it after mount so SSR and the first
  // client render agree.
  useEffect(() => {
    setFsSupported(isFileSystemAccessSupported());
  }, []);

  /* ------------------------------------------------------------------ */
  /* [📂 Load File]                                                      */
  /* ------------------------------------------------------------------ */

  const applyLoaded = useCallback(
    (loaded: { ts?: string; json?: string; env?: string; tests?: string }, baseName: string) => {
      loadBundleFromFiles(loaded, baseName);
      toast.success(`Loaded ${baseName}`, { description: describeLoad(baseName, loaded) });
    },
    [loadBundleFromFiles],
  );

  const handleLoadFile = useCallback(async () => {
    if (!isFileSystemAccessSupported()) {
      fileInputRef.current?.click();
      return;
    }
    try {
      const picked = await pickToolFile(mountedDir);
      if (!picked) return; // user cancelled
      applyLoaded(picked.files, picked.baseName);
    } catch (e) {
      toast.error(`Could not open that file: ${errorMessage(e)}`);
    }
  }, [applyLoaded, mountedDir]);

  const handleInputFiles = useCallback(
    async (list: FileList | null) => {
      if (!list || list.length === 0) return;
      try {
        const { files: loaded, baseName } = await readFilesFromInput(list);
        applyLoaded(loaded, baseName);
      } catch (e) {
        toast.error(`Could not read those files: ${errorMessage(e)}`);
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [applyLoaded],
  );

  /* ------------------------------------------------------------------ */
  /* [📁 Select Local Folder ▼]                                          */
  /* ------------------------------------------------------------------ */

  const refreshFolder = useCallback(async (dir: NonNullable<typeof mountedDir>) => {
    setFolderBusy(true);
    try {
      setFolderTools(await dir.listTools());
    } catch (e) {
      setFolderTools([]);
      toast.error(`Could not list that folder: ${errorMessage(e)}`);
    } finally {
      setFolderBusy(false);
    }
  }, []);

  const handleSelectFolder = useCallback(async () => {
    try {
      const dir = await pickWorkspaceDirectory();
      if (!dir) return; // cancelled
      setMountedDir(dir);
      setFolderOpen(true);
      await refreshFolder(dir);
      toast.success(`Mounted ${dir.name}`, {
        description: "Saving now writes the four files straight into this folder.",
      });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, [refreshFolder, setMountedDir]);

  const handleFolderButton = useCallback(() => {
    if (!mountedDir) {
      void handleSelectFolder();
      return;
    }
    const next = !folderOpen;
    setFolderOpen(next);
    if (next) void refreshFolder(mountedDir);
  }, [folderOpen, handleSelectFolder, mountedDir, refreshFolder]);

  const handleOpenTool = useCallback(
    async (baseName: string) => {
      if (!mountedDir) return;
      try {
        const loaded = await mountedDir.readTool(baseName);
        applyLoaded(loaded, baseName);
        setFolderOpen(false);
      } catch (e) {
        toast.error(`Could not read ${baseName}: ${errorMessage(e)}`);
      }
    },
    [applyLoaded, mountedDir],
  );

  /* ------------------------------------------------------------------ */
  /* [ 💾 Save ] — all four files                                         */
  /* ------------------------------------------------------------------ */

  const savingRef = useRef(false);
  const handleSave = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const result = await saveAllFiles(fileNames(bundle.name), fileSetFrom(files), mountedDir);
      markSaved();
      toast.success(
        result.mode === "directory"
          ? `Wrote 4 files to ${mountedDir?.name ?? "the mounted folder"}`
          : "Downloaded 4 files",
        { description: result.written.join(", ") },
      );
    } catch (e) {
      toast.error(`Save failed: ${errorMessage(e)}`);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [bundle.name, files, markSaved, mountedDir]);

  // Ctrl/Cmd+S saves, exactly like the button.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      void handleSave();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSave]);

  /* ------------------------------------------------------------------ */
  /* [ 🚀 Publish ] — the Validator gate (§2.3)                          */
  /* ------------------------------------------------------------------ */

  const neverRun = validation.lastRunAt === null;
  const gateBlockers: string[] = [];
  if (neverRun) {
    gateBlockers.push("The validations have not been run yet — open [ Validator ] and run them.");
  } else if (validation.stale) {
    gateBlockers.push(
      "The tool changed since the last validation run — re-run [ ▶ Run All Validations ].",
    );
  }
  gateBlockers.push(...validation.health.blockers);
  const canPublish = validation.health.canPublish && !neverRun && !validation.stale;

  const handlePublish = useCallback(async () => {
    if (!canPublish) {
      setPublishOpen((open) => !open);
      return;
    }
    setPublishOpen(false);
    try {
      const publishNames = fileNames(bundle.name);
      await downloadPublishBundle(publishNames, fileSetFrom(files));
      toast.success(`Published bundle for ${bundle.name}`, {
        description: `${publishNames.ts}, ${publishNames.json}, ${publishNames.tests} — ${publishNames.env} was excluded, secrets are never published.`,
      });
    } catch (e) {
      toast.error(`Publish failed: ${errorMessage(e)}`);
    }
  }, [bundle.name, canPublish, files]);

  /* Close the two popovers on an outside click. */
  useEffect(() => {
    if (!folderOpen && !publishOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && folderRef.current?.contains(target)) return;
      if (target && publishRef.current?.contains(target)) return;
      setFolderOpen(false);
      setPublishOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [folderOpen, publishOpen]);

  /* ------------------------------------------------------------------ */

  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-4 py-3 shadow-sm">
      <div className="mr-3 flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Sparkles className="h-4 w-4" />
        </span>
        <div className="leading-none">
          <span className="block font-display text-base font-extrabold text-primary">
            agentsable
          </span>
          <span className="mt-1 block text-[0.65rem] font-semibold uppercase text-secondary">
            Tool Workspace
          </span>
        </div>
      </div>

      <button className="btn" onClick={() => void handleLoadFile()}>
        <FolderOpen className="h-4 w-4" /> Load File
      </button>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        data-testid="tgs-file-input"
        onChange={(e) => void handleInputFiles(e.target.files)}
      />

      <div className="relative" ref={folderRef}>
        <button
          className="btn"
          onClick={handleFolderButton}
          disabled={!fsSupported}
          title={fsSupported ? "Mount a local folder of tools" : UNSUPPORTED_HINT}
          aria-expanded={folderOpen}
          aria-haspopup="menu"
        >
          <FolderTree className="h-4 w-4" /> Select Local Folder
          <ChevronDown className="h-3.5 w-3.5" />
        </button>

        {folderOpen && mountedDir ? (
          <div
            role="menu"
            aria-label="Tools in the mounted folder"
            className="panel absolute left-0 top-full z-30 mt-1 max-h-72 w-72 overflow-y-auto p-1"
          >
            <div className="panel-head border-b-0 py-1.5">{mountedDir.name}</div>
            {folderBusy ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">Reading the folder…</p>
            ) : folderTools && folderTools.length > 0 ? (
              folderTools.map((name) => (
                <button
                  key={name}
                  role="menuitem"
                  className="subtab block w-full text-left"
                  onClick={() => void handleOpenTool(name)}
                >
                  {name}.ts
                </button>
              ))
            ) : (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                No <code>.ts</code> tools in this folder yet. Saving will create them.
              </p>
            )}
          </div>
        ) : null}
      </div>

      {mountedDir ? (
        <span className="chip" title={`Mounted directory: ${mountedDir.name}`}>
          📁 {mountedDir.name}
        </span>
      ) : null}

      <div className="mx-auto flex flex-col items-center gap-1">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-widest text-muted-foreground">tool</span>
          <input
            value={bundle.name}
            onChange={(e) => setToolName(e.target.value)}
            className="field w-56 text-center"
            aria-label="Tool name"
            aria-describedby="tgs-rename-note"
            title="Renaming the tool renames all four files and updates config.name."
          />
          <span className="chip">{dirty ? "unsaved" : "in sync"}</span>
        </div>
        <p
          id="tgs-rename-note"
          className="flex flex-wrap items-center justify-center gap-x-2 text-[0.65rem] text-muted-foreground"
        >
          <span>renaming renames all four files:</span>
          {KINDS.map((kind) => (
            <code key={kind} className="font-mono">
              {names[kind]}
            </code>
          ))}
        </p>
      </div>

      <span
        className="chip"
        title={
          neverRun
            ? "The validators have not been run for this tool yet."
            : `Health score from the last run${validation.stale ? " (stale)" : ""}.`
        }
      >
        🛡️ {validation.health.score}/100
      </span>
      {validation.stale || neverRun ? (
        <span className="chip" title="Re-run the validations before publishing.">
          stale
        </span>
      ) : null}

      <button className="btn" onClick={() => void handleSave()} disabled={saving}>
        <Save className="h-4 w-4" /> {saving ? "Saving…" : "Save"}
      </button>

      <div className="relative" ref={publishRef}>
        <button
          className={canPublish ? "btn btn-primary" : "btn"}
          onClick={() => void handlePublish()}
          aria-disabled={!canPublish}
          aria-expanded={publishOpen}
          title={
            canPublish
              ? "Bundle the .ts, .json and _tests.json for the Simple Tools Server"
              : "Publishing is blocked by the Validator — click for details"
          }
        >
          {canPublish ? (
            <Rocket className="h-4 w-4" />
          ) : (
            <TriangleAlert className="h-4 w-4 text-destructive" />
          )}{" "}
          Publish
        </button>

        {publishOpen && !canPublish ? (
          <div
            role="dialog"
            aria-label="Publishing is blocked"
            className="panel absolute right-0 top-full z-30 mt-1 w-80 p-3 text-sm"
          >
            <p className="mb-2 font-semibold">Publishing is blocked by the Validator.</p>
            <p className="mb-2 text-xs text-muted-foreground">
              A tool can only be published with a health score of at least 90/100 and zero
              deterministic (Python) failures.
            </p>
            <ul className="space-y-1.5">
              {gateBlockers.map((blocker) => (
                <li key={blocker} className="finding" data-state="fail">
                  {blocker}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </header>
  );
}
