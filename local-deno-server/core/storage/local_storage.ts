// /core/storage/local_storage.ts
//
// The local-disk backend for `context.storage` (ToolStorage). On the production
// Simple Tools Server the router swaps in an R2-backed implementation with the
// same surface, so a tool never branches on runtime.
//
// Keys are FLAT. A key that looks nested ("reports/2026/q1.json") is still one
// object: the key is percent-encoded into a single filename inside the user's
// File_space root, which also makes path traversal ("../../etc/passwd")
// structurally impossible.

import type { ToolStorage } from "../contracts/ToolContract.ts";

function encodeKey(key: string): string {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("STORAGE_INVALID_KEY: key must be a non-empty string");
  }
  if (key.length > 512) {
    throw new Error("STORAGE_INVALID_KEY: key exceeds 512 characters");
  }
  // encodeURIComponent leaves ! ' ( ) * - . _ ~ alone; "." alone is still safe
  // because the whole key is one segment and "." / ".." are rejected below.
  if (key === "." || key === "..") {
    throw new Error("STORAGE_INVALID_KEY: reserved key");
  }
  return encodeURIComponent(key);
}

function decodeKey(fileName: string): string {
  try {
    return decodeURIComponent(fileName);
  } catch {
    return fileName;
  }
}

export class LocalFileSpaceStorage implements ToolStorage {
  readonly kind = "local-fs";
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private async ensureRoot(): Promise<void> {
    await Deno.mkdir(this.root, { recursive: true });
  }

  private pathFor(key: string): string {
    return `${this.root}/${encodeKey(key)}`;
  }

  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    const wanted = typeof prefix === "string" ? prefix : "";
    const out: { key: string; size: number }[] = [];
    try {
      for await (const entry of Deno.readDir(this.root)) {
        if (!entry.isFile) continue;
        const key = decodeKey(entry.name);
        if (wanted && !key.startsWith(wanted)) continue;
        const stat = await Deno.stat(`${this.root}/${entry.name}`);
        out.push({ key, size: stat.size });
      }
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return [];
      throw err;
    }
    out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return out;
  }

  async read(key: string): Promise<{ content: string; size: number } | null> {
    try {
      const content = await Deno.readTextFile(this.pathFor(key));
      return { content, size: new TextEncoder().encode(content).byteLength };
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return null;
      throw err;
    }
  }

  async write(key: string, content: string): Promise<void> {
    await this.ensureRoot();
    await Deno.writeTextFile(this.pathFor(key), String(content ?? ""));
  }

  async remove(key: string): Promise<void> {
    try {
      await Deno.remove(this.pathFor(key));
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return;
      throw err;
    }
  }
}

/** `.tgs-filespace/<userId>/` under the given base directory. */
export function createFileSpaceStorage(baseDir: string, userId: string): LocalFileSpaceStorage {
  const safeUser = encodeURIComponent(userId || "anonymous");
  return new LocalFileSpaceStorage(`${baseDir}/${safeUser}`);
}

export default LocalFileSpaceStorage;
