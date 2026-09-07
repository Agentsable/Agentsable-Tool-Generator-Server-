import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildPublishBundle,
  classifyFileName,
  downloadPublishBundle,
  downloadTextFile,
  isFileSystemAccessSupported,
  mountDirectory,
  pickToolFile,
  pickWorkspaceDirectory,
  readFilesFromInput,
  saveAllFiles,
  siblingFileNames,
  TgsFsError,
  type TgsDirectoryHandle,
  type TgsFileNames,
  type TgsFileSet,
} from "./fsAccess";

/* ------------------------------------------------------------------ *
 * Fixtures + in-memory File System Access API fakes
 * ------------------------------------------------------------------ */

const NAMES: TgsFileNames = siblingFileNames("weather_fetcher");

const FILES: TgsFileSet = {
  ts: "export default async function execute() {}",
  json: '{ "name": "weather_fetcher" }',
  env: "WEATHER_API_KEY=sk-secret",
  tests: '[{ "name": "happy path" }]',
};

function domError(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

function fakeFile(name: string, content: string): File {
  return { name, text: async () => content } as unknown as File;
}

type FakeDir = {
  handle: TgsDirectoryHandle;
  store: Map<string, string>;
  permission: { state: PermissionState; requested: number };
};

function makeFakeDirectory(name: string, initial: Record<string, string> = {}): FakeDir {
  const store = new Map<string, string>(Object.entries(initial));
  const permission: FakeDir["permission"] = { state: "granted", requested: 0 };

  const fileHandle = (fileName: string) => ({
    kind: "file" as const,
    name: fileName,
    async getFile() {
      return fakeFile(fileName, store.get(fileName) ?? "");
    },
    async createWritable() {
      let buffer = "";
      return {
        async write(chunk: string) {
          buffer += chunk;
        },
        async close() {
          store.set(fileName, buffer);
        },
      };
    },
  });

  const handle = {
    kind: "directory" as const,
    name,
    async getFileHandle(fileName: string, options?: { create?: boolean }) {
      if (!store.has(fileName)) {
        if (!options?.create) throw domError("NotFoundError");
        store.set(fileName, "");
      }
      return fileHandle(fileName);
    },
    async *values() {
      for (const key of [...store.keys()]) yield { kind: "file" as const, name: key };
    },
    async queryPermission() {
      return permission.state;
    },
    async requestPermission() {
      permission.requested += 1;
      return permission.state;
    },
  };

  return { handle: handle as unknown as TgsDirectoryHandle, store, permission };
}

/** Stub just enough DOM for the anchor-download fallback; returns the captured downloads. */
function stubDownloadDom(): { name: string; href: string }[] {
  const captured: { name: string; href: string }[] = [];
  vi.stubGlobal("document", {
    createElement: () => {
      const anchor = {
        href: "",
        download: "",
        rel: "",
        parentNode: null,
        click() {
          captured.push({ name: anchor.download, href: anchor.href });
        },
      };
      return anchor;
    },
    body: { appendChild: () => undefined },
  });
  return captured;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ *
 * Publish bundle: the .env exclusion is a hard spec requirement
 * ------------------------------------------------------------------ */

describe("buildPublishBundle", () => {
  it("bundles .ts, .json and _tests.json and NEVER the .env", () => {
    const bundle = buildPublishBundle(NAMES, FILES);

    expect(bundle.files.map((f) => f.name)).toEqual([
      "weather_fetcher.ts",
      "weather_fetcher.json",
      "weather_fetcher_tests.json",
    ]);
    expect(bundle.files).toHaveLength(3);
    for (const file of bundle.files) {
      expect(file.name.endsWith(".env")).toBe(false);
    }
    // No secret value can leak through the bundle contents either.
    expect(bundle.files.some((f) => f.content.includes("sk-secret"))).toBe(false);
    expect(bundle.excluded).toEqual(["weather_fetcher.env"]);
  });

  it("carries the exact file contents through", () => {
    const bundle = buildPublishBundle(NAMES, FILES);
    expect(bundle.files[0]?.content).toBe(FILES.ts);
    expect(bundle.files[1]?.content).toBe(FILES.json);
    expect(bundle.files[2]?.content).toBe(FILES.tests);
  });

  it("downloadPublishBundle downloads exactly the three published files", async () => {
    const captured = stubDownloadDom();
    await downloadPublishBundle(NAMES, FILES);
    expect(captured.map((c) => c.name)).toEqual([
      "weather_fetcher.ts",
      "weather_fetcher.json",
      "weather_fetcher_tests.json",
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * Filename classification
 * ------------------------------------------------------------------ */

describe("classifyFileName", () => {
  it("matches _tests.json BEFORE .json", () => {
    expect(classifyFileName("weather_fetcher_tests.json")).toEqual({
      kind: "tests",
      baseName: "weather_fetcher",
    });
  });

  it("still classifies a plain .json as the config file", () => {
    expect(classifyFileName("weather_fetcher.json")).toEqual({
      kind: "json",
      baseName: "weather_fetcher",
    });
  });

  it("classifies .ts and .env", () => {
    expect(classifyFileName("weather_fetcher.ts")).toEqual({
      kind: "ts",
      baseName: "weather_fetcher",
    });
    expect(classifyFileName("weather_fetcher.env")).toEqual({
      kind: "env",
      baseName: "weather_fetcher",
    });
  });

  it("strips directory prefixes and rejects unrelated files", () => {
    expect(classifyFileName("/tools/weather_fetcher.ts")?.baseName).toBe("weather_fetcher");
    expect(classifyFileName("README.md")).toBeNull();
    expect(classifyFileName("notes.txt")).toBeNull();
  });

  it("round-trips with siblingFileNames", () => {
    const names = siblingFileNames("tool_x");
    expect(classifyFileName(names.tests)).toEqual({ kind: "tests", baseName: "tool_x" });
    expect(classifyFileName(names.json)).toEqual({ kind: "json", baseName: "tool_x" });
    expect(classifyFileName(names.ts)).toEqual({ kind: "ts", baseName: "tool_x" });
    expect(classifyFileName(names.env)).toEqual({ kind: "env", baseName: "tool_x" });
  });
});

/* ------------------------------------------------------------------ *
 * <input type=file> fallback
 * ------------------------------------------------------------------ */

describe("readFilesFromInput", () => {
  it("groups four selected files into one bundle and derives the base name", async () => {
    const result = await readFilesFromInput([
      fakeFile("weather_fetcher_tests.json", FILES.tests),
      fakeFile("weather_fetcher.json", FILES.json),
      fakeFile("weather_fetcher.env", FILES.env),
      fakeFile("weather_fetcher.ts", FILES.ts),
    ]);

    expect(result.baseName).toBe("weather_fetcher");
    expect(result.files).toEqual(FILES);
  });

  it("prefers the .ts base name and ignores files from another tool", async () => {
    const result = await readFilesFromInput([
      fakeFile("other_tool.json", "{}"),
      fakeFile("weather_fetcher.ts", FILES.ts),
      fakeFile("weather_fetcher.env", FILES.env),
      fakeFile("README.md", "ignored"),
    ]);

    expect(result.baseName).toBe("weather_fetcher");
    expect(result.files).toEqual({ ts: FILES.ts, env: FILES.env });
  });

  it("fails with a readable IO error when nothing is a tool file", async () => {
    await expect(readFilesFromInput([fakeFile("README.md", "x")])).rejects.toMatchObject({
      code: "IO",
    });
  });
});

/* ------------------------------------------------------------------ *
 * Directory mount round-trip
 * ------------------------------------------------------------------ */

describe("pickWorkspaceDirectory -> listTools -> readTool -> writeTool", () => {
  it("round-trips through an in-memory directory handle", async () => {
    const fake = makeFakeDirectory("tools", {
      "weather_fetcher.ts": FILES.ts,
      "weather_fetcher.json": FILES.json,
      "weather_fetcher_tests.json": FILES.tests,
      "slack_poster.ts": "// slack",
      "README.md": "ignored",
    });
    vi.stubGlobal("showOpenFilePicker", () => Promise.reject(domError("AbortError")));
    vi.stubGlobal("showDirectoryPicker", async () => fake.handle);

    const dir = await pickWorkspaceDirectory();
    expect(dir).not.toBeNull();
    expect(dir?.name).toBe("tools");

    // listTools: base names of every *.ts, sorted, non-tool files skipped.
    expect(await dir!.listTools()).toEqual(["slack_poster", "weather_fetcher"]);

    // readTool: only the siblings that exist (no .env on disk here).
    const read = await dir!.readTool("weather_fetcher");
    expect(read).toEqual({ ts: FILES.ts, json: FILES.json, tests: FILES.tests });
    expect(read.env).toBeUndefined();

    // writeTool: all four files land on disk, including the .env.
    const written = await dir!.writeTool(NAMES, { ...FILES, ts: "// updated" });
    expect(written.written).toEqual([
      "weather_fetcher.ts",
      "weather_fetcher.json",
      "weather_fetcher.env",
      "weather_fetcher_tests.json",
    ]);
    expect(fake.store.get("weather_fetcher.ts")).toBe("// updated");
    expect(fake.store.get("weather_fetcher.env")).toBe(FILES.env);

    // ...and reading back sees the update plus the new .env sibling.
    expect(await dir!.readTool("weather_fetcher")).toEqual({ ...FILES, ts: "// updated" });
  });

  it("writeSome writes only the requested files", async () => {
    const fake = makeFakeDirectory("tools");
    const dir = mountDirectory(fake.handle);

    const result = await dir.writeSome({ json: FILES.json }, NAMES);
    expect(result.written).toEqual(["weather_fetcher.json"]);
    expect([...fake.store.keys()]).toEqual(["weather_fetcher.json"]);
  });

  it("surfaces a PERMISSION failure when readwrite access is denied", async () => {
    const fake = makeFakeDirectory("tools");
    fake.permission.state = "denied";
    const dir = mountDirectory(fake.handle);

    await expect(dir.writeTool(NAMES, FILES)).rejects.toMatchObject({ code: "PERMISSION" });
    expect(fake.permission.requested).toBe(1);
    expect(fake.store.size).toBe(0);
  });

  it("pickToolFile pulls in the three siblings when a directory is mounted", async () => {
    const fake = makeFakeDirectory("tools", {
      "weather_fetcher.ts": "// stale on disk",
      "weather_fetcher.json": FILES.json,
      "weather_fetcher.env": FILES.env,
      "weather_fetcher_tests.json": FILES.tests,
    });
    const dir = mountDirectory(fake.handle);
    vi.stubGlobal("showOpenFilePicker", async () => [
      {
        kind: "file",
        name: "weather_fetcher.ts",
        getFile: async () => fakeFile("weather_fetcher.ts", FILES.ts),
      },
    ]);

    const picked = await pickToolFile(dir);
    expect(picked?.baseName).toBe("weather_fetcher");
    // The picked file wins over the copy already in the directory.
    expect(picked?.files).toEqual(FILES);
    expect(picked?.handles?.ts).toBeDefined();
  });
});

/* ------------------------------------------------------------------ *
 * Save
 * ------------------------------------------------------------------ */

describe("saveAllFiles", () => {
  it("writes all four files to the mounted directory", async () => {
    const fake = makeFakeDirectory("tools");
    const result = await saveAllFiles(NAMES, FILES, mountDirectory(fake.handle));

    expect(result.mode).toBe("directory");
    expect(result.written).toHaveLength(4);
    expect(fake.store.get("weather_fetcher_tests.json")).toBe(FILES.tests);
  });

  it("falls back to downloads when no directory is mounted", async () => {
    const captured = stubDownloadDom();
    const result = await saveAllFiles(NAMES, FILES, null);

    expect(result.mode).toBe("download");
    expect(result.written).toEqual([
      "weather_fetcher.ts",
      "weather_fetcher.json",
      "weather_fetcher.env",
      "weather_fetcher_tests.json",
    ]);
    // Save (unlike Publish) does include the .env.
    expect(captured.map((c) => c.name)).toEqual(result.written);
  });
});

/* ------------------------------------------------------------------ *
 * Cancellation + unsupported environments
 * ------------------------------------------------------------------ */

describe("failure modes", () => {
  it("resolves to null when the user cancels a picker (AbortError)", async () => {
    vi.stubGlobal("showOpenFilePicker", () => Promise.reject(domError("AbortError")));
    vi.stubGlobal("showDirectoryPicker", () => Promise.reject(domError("AbortError")));

    await expect(pickToolFile()).resolves.toBeNull();
    await expect(pickWorkspaceDirectory()).resolves.toBeNull();
  });

  it("reports UNSUPPORTED instead of a bare TypeError when the API is missing", async () => {
    expect(isFileSystemAccessSupported()).toBe(false);

    await expect(pickToolFile()).rejects.toBeInstanceOf(TgsFsError);
    await expect(pickToolFile()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(pickWorkspaceDirectory()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(String(await pickWorkspaceDirectory().catch((e: Error) => e.message))).toContain(
      "browser",
    );
  });

  it("reports UNSUPPORTED when a download is attempted without a DOM", () => {
    expect(() => downloadTextFile("weather_fetcher.ts", FILES.ts)).toThrowError(TgsFsError);
    try {
      downloadTextFile("weather_fetcher.ts", FILES.ts);
    } catch (e) {
      expect((e as TgsFsError).code).toBe("UNSUPPORTED");
    }
  });

  it("maps a picker NotAllowedError onto PERMISSION", async () => {
    vi.stubGlobal("showDirectoryPicker", () => Promise.reject(domError("NotAllowedError")));
    await expect(pickWorkspaceDirectory()).rejects.toMatchObject({ code: "PERMISSION" });
  });

  it("rejects a picked file that is not one of the four tool files", async () => {
    vi.stubGlobal("showOpenFilePicker", async () => [
      { kind: "file", name: "README.md", getFile: async () => fakeFile("README.md", "x") },
    ]);
    await expect(pickToolFile()).rejects.toMatchObject({ code: "IO" });
  });

  it("is importable with no browser globals present (SSR safety)", () => {
    expect(typeof globalThis.window).toBe("undefined");
    expect(isFileSystemAccessSupported()).toBe(false);
    expect(buildPublishBundle(NAMES, FILES).excluded).toEqual(["weather_fetcher.env"]);
  });
});
