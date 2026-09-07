/**
 * TGS File System Access layer.
 *
 * Backs the Top Action Bar (see docs/llm_generated/01-system-overview.md §2):
 *   [📂 Load File]  [📁 Select Local Folder ▼]  [ 💾 Save ]  [ 🚀 Publish ]
 *
 * A TGS tool is always four sibling files (10-screen-raw-data.md):
 *   <base>.ts   <base>.json   <base>.env   <base>_tests.json
 *
 * Design notes
 * - This module is deliberately *pure plumbing*: it never renders or parses tool
 *   content. Callers hand it already-rendered strings (from `toolFiles.ts`) and the
 *   filenames to use. That keeps it decoupled and unit-testable in a node test env.
 * - SSR-safe: no module-scope access to `window`, `document` or any browser global.
 *   Every entry point checks availability first and fails with a typed, readable
 *   `TgsFsError` instead of an opaque DOMException.
 * - A user cancelling a picker (DOMException "AbortError") resolves to `null`, never throws.
 */

/** The four file bodies that make up one tool. */
export type TgsFileSet = { ts: string; json: string; env: string; tests: string };

/** The four filenames on disk for one tool. */
export type TgsFileNames = { ts: string; json: string; env: string; tests: string };

/** Key of one of the four files. */
export type TgsFileKind = keyof TgsFileSet;

export const TGS_FILE_KINDS: readonly TgsFileKind[] = ["ts", "json", "env", "tests"] as const;

export type TgsFsErrorCode = "UNSUPPORTED" | "ABORTED" | "PERMISSION" | "IO";

/** Typed, human-readable failure. Shape is `{ code, message }` (it is also an Error). */
export class TgsFsError extends Error {
  readonly code: TgsFsErrorCode;
  override readonly cause?: unknown;

  constructor(code: TgsFsErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "TgsFsError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

export function isTgsFsError(e: unknown): e is TgsFsError {
  return e instanceof TgsFsError;
}

function fsError(code: TgsFsErrorCode, message: string, cause?: unknown): TgsFsError {
  return new TgsFsError(code, message, cause);
}

function errName(e: unknown): string {
  return typeof e === "object" && e !== null && "name" in e
    ? String((e as { name?: unknown }).name)
    : "";
}

function isAbort(e: unknown): boolean {
  return errName(e) === "AbortError";
}

/** Map a DOMException-ish failure onto a TgsFsError with a sentence a user can act on. */
function mapError(e: unknown, what: string): TgsFsError {
  if (isTgsFsError(e)) return e;
  const name = errName(e);
  const detail = e instanceof Error && e.message ? ` (${e.message})` : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return fsError(
      "PERMISSION",
      `Permission denied while ${what}. Grant this page access to the folder and try again.${detail}`,
      e,
    );
  }
  if (name === "AbortError") return fsError("ABORTED", `Cancelled while ${what}.`, e);
  return fsError("IO", `Failed while ${what}.${detail}`, e);
}

/* ------------------------------------------------------------------ *
 * Browser API typings the DOM lib does not ship
 * ------------------------------------------------------------------ */

interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}
interface OpenFilePickerOptions {
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
  types?: FilePickerAcceptType[];
  id?: string;
}
interface DirectoryPickerOptions {
  id?: string;
  mode?: "read" | "readwrite";
}
type FsPermissionDescriptor = { mode?: "read" | "readwrite" };

/** `FileSystemDirectoryHandle` plus the async-iteration and permission members lib.dom omits. */
export interface TgsDirectoryHandle extends FileSystemDirectoryHandle {
  values?(): AsyncIterableIterator<FileSystemHandle>;
  entries?(): AsyncIterableIterator<[string, FileSystemHandle]>;
  keys?(): AsyncIterableIterator<string>;
  queryPermission?(descriptor?: FsPermissionDescriptor): Promise<PermissionState>;
  requestPermission?(descriptor?: FsPermissionDescriptor): Promise<PermissionState>;
}

type PickerGlobals = {
  showOpenFilePicker?: (options?: OpenFilePickerOptions) => Promise<FileSystemFileHandle[]>;
  showDirectoryPicker?: (options?: DirectoryPickerOptions) => Promise<TgsDirectoryHandle>;
  document?: Document;
  URL?: typeof URL;
  Blob?: typeof Blob;
};

function g(): PickerGlobals {
  return globalThis as unknown as PickerGlobals;
}

/** True only in a browser that implements the File System Access API. False on the server, in Firefox and in Safari. */
export function isFileSystemAccessSupported(): boolean {
  return typeof globalThis !== "undefined" && "showOpenFilePicker" in globalThis;
}

/** True when this environment can trigger an anchor download (the universal fallback). */
export function isDownloadSupported(): boolean {
  const doc = g().document;
  return !!doc && typeof doc.createElement === "function";
}

/* ------------------------------------------------------------------ *
 * Filename handling
 * ------------------------------------------------------------------ */

/**
 * The four sibling names for a base name.
 * `toolFiles.fileNames()` is the canonical renderer-side version; this mirrors it so the
 * FS layer can find siblings without importing it.
 */
export function siblingFileNames(baseName: string): TgsFileNames {
  return {
    ts: `${baseName}.ts`,
    json: `${baseName}.json`,
    env: `${baseName}.env`,
    tests: `${baseName}_tests.json`,
  };
}

/**
 * Classify a filename into one of the four kinds and recover its base name.
 * ORDER MATTERS: `_tests.json` must be tested before `.json`, otherwise
 * `weather_fetcher_tests.json` is misfiled as the config JSON.
 */
export function classifyFileName(fileName: string): { kind: TgsFileKind; baseName: string } | null {
  const name = fileName.replace(/^.*[\\/]/, "");
  if (name.endsWith("_tests.json"))
    return { kind: "tests", baseName: name.slice(0, -"_tests.json".length) };
  if (name.endsWith(".json")) return { kind: "json", baseName: name.slice(0, -".json".length) };
  if (name.endsWith(".ts")) return { kind: "ts", baseName: name.slice(0, -".ts".length) };
  if (name.endsWith(".env")) return { kind: "env", baseName: name.slice(0, -".env".length) };
  return null;
}

function assignFile(target: Partial<TgsFileSet>, kind: TgsFileKind, content: string): void {
  target[kind] = content;
}

/* ------------------------------------------------------------------ *
 * [📁 Select Local Folder ▼] — a mounted directory
 * ------------------------------------------------------------------ */

export type MountedDirectory = {
  /** Directory name as reported by the picker. */
  name: string;
  handle: TgsDirectoryHandle;
  /** Base names of every `*.ts` in the directory (sorted, `_tests.json` siblings ignored). */
  listTools(): Promise<string[]>;
  /** Read whichever of the four sibling files exist for `baseName`. */
  readTool(baseName: string): Promise<Partial<TgsFileSet>>;
  /** Write all four files. Used by [ 💾 Save ]. */
  writeTool(names: TgsFileNames, files: TgsFileSet): Promise<{ written: string[] }>;
  /** Write only the given subset. */
  writeSome(
    files: Partial<Record<TgsFileKind, string>>,
    names: TgsFileNames,
  ): Promise<{ written: string[] }>;
  /** Ask for (or confirm) readwrite permission. Throws `PERMISSION` when denied. */
  ensureWritePermission(): Promise<void>;
};

async function ensureWritePermissionOn(handle: TgsDirectoryHandle): Promise<void> {
  try {
    if (typeof handle.queryPermission === "function") {
      const current = await handle.queryPermission({ mode: "readwrite" });
      if (current === "granted") return;
    }
    if (typeof handle.requestPermission === "function") {
      const granted = await handle.requestPermission({ mode: "readwrite" });
      if (granted === "granted") return;
      throw fsError(
        "PERMISSION",
        `Write access to the folder "${handle.name}" was denied. Re-select the folder and choose "Edit files" to save.`,
      );
    }
    // Browser without the permission API surface: assume the picker already granted it.
    return;
  } catch (e) {
    throw mapError(e, `requesting write access to "${handle.name}"`);
  }
}

async function readTextFile(handle: TgsDirectoryHandle, name: string): Promise<string | null> {
  try {
    const fileHandle = await handle.getFileHandle(name);
    const file = await fileHandle.getFile();
    return await file.text();
  } catch (e) {
    if (errName(e) === "NotFoundError" || errName(e) === "TypeMismatchError") return null;
    throw mapError(e, `reading "${name}"`);
  }
}

async function writeTextFile(
  handle: TgsDirectoryHandle,
  name: string,
  content: string,
): Promise<void> {
  try {
    const fileHandle = await handle.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
  } catch (e) {
    throw mapError(e, `writing "${name}"`);
  }
}

async function* iterateEntries(handle: TgsDirectoryHandle): AsyncGenerator<FileSystemHandle> {
  if (typeof handle.values === "function") {
    for await (const entry of handle.values()) yield entry;
    return;
  }
  if (typeof handle.entries === "function") {
    for await (const pair of handle.entries()) {
      const entry = pair[1];
      if (entry) yield entry;
    }
    return;
  }
  throw fsError("UNSUPPORTED", "This browser cannot list the contents of a directory handle.");
}

/** Wrap a raw directory handle in the MountedDirectory facade. Exported for tests and for re-mounting a persisted handle. */
export function mountDirectory(handle: TgsDirectoryHandle): MountedDirectory {
  const dir: MountedDirectory = {
    name: handle.name,
    handle,

    async listTools(): Promise<string[]> {
      const found: string[] = [];
      try {
        for await (const entry of iterateEntries(handle)) {
          if (entry.kind !== "file") continue;
          const classified = classifyFileName(entry.name);
          if (classified && classified.kind === "ts") found.push(classified.baseName);
        }
      } catch (e) {
        throw mapError(e, `listing the folder "${handle.name}"`);
      }
      return found.sort((a, b) => a.localeCompare(b));
    },

    async readTool(baseName: string): Promise<Partial<TgsFileSet>> {
      const names = siblingFileNames(baseName);
      const out: Partial<TgsFileSet> = {};
      for (const kind of TGS_FILE_KINDS) {
        const content = await readTextFile(handle, names[kind]);
        if (content !== null) assignFile(out, kind, content);
      }
      return out;
    },

    async writeTool(names: TgsFileNames, files: TgsFileSet): Promise<{ written: string[] }> {
      return dir.writeSome(files, names);
    },

    async writeSome(
      files: Partial<Record<TgsFileKind, string>>,
      names: TgsFileNames,
    ): Promise<{ written: string[] }> {
      await ensureWritePermissionOn(handle);
      const written: string[] = [];
      for (const kind of TGS_FILE_KINDS) {
        const content = files[kind];
        if (content === undefined) continue;
        await writeTextFile(handle, names[kind], content);
        written.push(names[kind]);
      }
      return { written };
    },

    async ensureWritePermission(): Promise<void> {
      await ensureWritePermissionOn(handle);
    },
  };
  return dir;
}

/** [📁 Select Local Folder ▼] — mount a local directory. Resolves to `null` if the user cancels. */
export async function pickWorkspaceDirectory(): Promise<MountedDirectory | null> {
  const picker = g().showDirectoryPicker;
  if (typeof picker !== "function") {
    throw fsError(
      "UNSUPPORTED",
      "Selecting a local folder needs the File System Access API, which this browser does not support. Use [📂 Load File] and download the saved files instead.",
    );
  }
  let handle: TgsDirectoryHandle;
  try {
    handle = await picker({ mode: "readwrite", id: "tgs-workspace" });
  } catch (e) {
    if (isAbort(e)) return null;
    throw mapError(e, "opening the folder picker");
  }
  return mountDirectory(handle);
}

/* ------------------------------------------------------------------ *
 * [📂 Load File]
 * ------------------------------------------------------------------ */

export type PickedTool = {
  files: Partial<TgsFileSet>;
  baseName: string;
  handles?: Partial<Record<TgsFileKind, FileSystemFileHandle>>;
};

const OPEN_FILE_TYPES: FilePickerAcceptType[] = [
  {
    description: "TGS tool files",
    accept: {
      "text/plain": [".ts", ".json", ".env"],
    },
  },
];

/**
 * [📂 Load File] — pick ONE file. When a directory is mounted, its three siblings are
 * pulled in too, so a single click loads the whole four-file bundle.
 * Resolves to `null` when the user cancels the picker.
 */
export async function pickToolFile(dir?: MountedDirectory | null): Promise<PickedTool | null> {
  const picker = g().showOpenFilePicker;
  if (typeof picker !== "function") {
    throw fsError(
      "UNSUPPORTED",
      "Opening a file needs the File System Access API, which this browser does not support. Use the file input fallback instead.",
    );
  }

  let handles: FileSystemFileHandle[];
  try {
    handles = await picker({ multiple: false, types: OPEN_FILE_TYPES, id: "tgs-tool-file" });
  } catch (e) {
    if (isAbort(e)) return null;
    throw mapError(e, "opening the file picker");
  }

  const picked = handles[0];
  if (!picked) return null;

  const classified = classifyFileName(picked.name);
  if (!classified) {
    throw fsError(
      "IO",
      `"${picked.name}" is not a TGS tool file. Expected one of <name>.ts, <name>.json, <name>.env or <name>_tests.json.`,
    );
  }

  let text: string;
  try {
    const file = await picked.getFile();
    text = await file.text();
  } catch (e) {
    throw mapError(e, `reading "${picked.name}"`);
  }

  const files: Partial<TgsFileSet> = dir ? await dir.readTool(classified.baseName) : {};
  // The explicitly picked file always wins over whatever the directory held.
  assignFile(files, classified.kind, text);

  return {
    files,
    baseName: classified.baseName,
    handles: { [classified.kind]: picked } as Partial<Record<TgsFileKind, FileSystemFileHandle>>,
  };
}

/* ------------------------------------------------------------------ *
 * [ 💾 Save ]
 * ------------------------------------------------------------------ */

/**
 * [ 💾 Save ] — writes all four files (`.ts`, `.json`, `.env`, `_tests.json`) to the mounted
 * directory (12-screen-config.md §5, last row). With no directory mounted it falls back to
 * four browser downloads.
 */
export async function saveAllFiles(
  names: TgsFileNames,
  files: TgsFileSet,
  dir: MountedDirectory | null,
): Promise<{ mode: "directory" | "download"; written: string[] }> {
  if (dir) {
    const result = await dir.writeTool(names, files);
    return { mode: "directory", written: result.written };
  }
  const written: string[] = [];
  for (const kind of TGS_FILE_KINDS) {
    downloadTextFile(names[kind], files[kind]);
    written.push(names[kind]);
    // Yield between downloads: browsers drop synchronously-queued multi-file downloads.
    await Promise.resolve();
  }
  return { mode: "download", written };
}

/* ------------------------------------------------------------------ *
 * [ 🚀 Publish ]
 * ------------------------------------------------------------------ */

/**
 * [ 🚀 Publish ] — bundles `.ts`, `.json` and `_tests.json` ONLY.
 * The `.env` is NEVER part of a publish bundle (13-screen-secrets.md §3); its filename is
 * returned in `excluded` so the UI can say so out loud.
 */
export function buildPublishBundle(
  names: TgsFileNames,
  files: TgsFileSet,
): { files: { name: string; content: string }[]; excluded: string[] } {
  const publishKinds: TgsFileKind[] = ["ts", "json", "tests"];
  return {
    files: publishKinds.map((kind) => ({ name: names[kind], content: files[kind] })),
    excluded: [names.env],
  };
}

/** Download the publish bundle as individual files (no archiver dependency). Never emits the `.env`. */
export async function downloadPublishBundle(names: TgsFileNames, files: TgsFileSet): Promise<void> {
  const bundle = buildPublishBundle(names, files);
  for (const file of bundle.files) {
    downloadTextFile(file.name, file.content);
    await Promise.resolve();
  }
}

/* ------------------------------------------------------------------ *
 * Universal fallback: <input type="file"> + anchor downloads
 * ------------------------------------------------------------------ */

/**
 * Fallback for [📂 Load File] in browsers without the FS Access API: group the files chosen
 * through an `<input type="file" multiple>` into one bundle. Files whose base name differs
 * from the chosen tool's are ignored.
 */
export async function readFilesFromInput(
  fileList: ArrayLike<File>,
): Promise<{ files: Partial<TgsFileSet>; baseName: string }> {
  const entries: { kind: TgsFileKind; baseName: string; file: File }[] = [];
  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    if (!file) continue;
    const classified = classifyFileName(file.name);
    if (classified) entries.push({ ...classified, file });
  }
  if (entries.length === 0) {
    throw fsError(
      "IO",
      "None of the selected files look like a TGS tool. Expected <name>.ts, <name>.json, <name>.env or <name>_tests.json.",
    );
  }

  // Prefer the `.ts` file's base name — it is the tool's identity.
  const primary = entries.find((e) => e.kind === "ts") ?? entries[0]!;
  const baseName = primary.baseName;

  const files: Partial<TgsFileSet> = {};
  for (const entry of entries) {
    if (entry.baseName !== baseName) continue;
    try {
      assignFile(files, entry.kind, await entry.file.text());
    } catch (e) {
      throw mapError(e, `reading "${entry.file.name}"`);
    }
  }
  return { files, baseName };
}

function mimeFor(name: string): string {
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".ts")) return "text/typescript";
  return "text/plain";
}

/** Trigger a browser download of a text file. Throws `UNSUPPORTED` outside a DOM. */
export function downloadTextFile(name: string, content: string): void {
  const doc = g().document;
  if (!doc || typeof doc.createElement !== "function") {
    throw fsError("UNSUPPORTED", `Cannot download "${name}": no browser document is available.`);
  }
  const mime = mimeFor(name);
  const BlobCtor = g().Blob;
  const UrlCtor = g().URL;
  let href: string;
  let revoke: (() => void) | null = null;
  if (BlobCtor && UrlCtor && typeof UrlCtor.createObjectURL === "function") {
    const url = UrlCtor.createObjectURL(new BlobCtor([content], { type: mime }));
    href = url;
    revoke = () => {
      try {
        UrlCtor.revokeObjectURL(url);
      } catch {
        /* best effort */
      }
    };
  } else {
    href = `data:${mime};charset=utf-8,${encodeURIComponent(content)}`;
  }

  try {
    const anchor = doc.createElement("a");
    anchor.href = href;
    anchor.download = name;
    anchor.rel = "noopener";
    if (doc.body && typeof doc.body.appendChild === "function") doc.body.appendChild(anchor);
    anchor.click();
    if (anchor.parentNode && typeof anchor.parentNode.removeChild === "function") {
      anchor.parentNode.removeChild(anchor);
    }
  } catch (e) {
    throw mapError(e, `downloading "${name}"`);
  } finally {
    if (revoke) revoke();
  }
}
