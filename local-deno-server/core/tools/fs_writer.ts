// /core/tools/fs_writer.ts
//
// The `fs_writer` core tool, reached with
//   await context.useCoreTool("fs_writer", { op: "write", key, content })
//
// It is a thin, auditable wrapper over `context.storage`, which on the local
// runner is the sandbox File_space at `.tgs-filespace/<userId>/`. A tool must
// declare "fs_writer" in config.tool_dependencies to reach it.

import type { ToolExecutionContext } from "../contracts/ToolContract.ts";

export interface FsWriterParams {
  /** Defaults to "write". */
  op?: "write" | "read" | "list" | "remove";
  key?: string;
  /** Alias for `key`, accepted because agents habitually say "path". */
  path?: string;
  content?: string;
  prefix?: string;
}

export class CoreToolError extends Error {
  readonly code: string;
  readonly actionable_advice: string;
  constructor(code: string, message: string, actionable_advice: string) {
    super(message);
    this.name = "CoreToolError";
    this.code = code;
    this.actionable_advice = actionable_advice;
  }
  toJSON() {
    return { error: this.code, message: this.message, actionable_advice: this.actionable_advice };
  }
}

export async function fsWriter(
  params: FsWriterParams,
  context: ToolExecutionContext,
): Promise<unknown> {
  const storage = context.storage;
  if (!storage) {
    throw new CoreToolError(
      "STORAGE_UNAVAILABLE",
      "No storage backend is attached to this execution context.",
      "Run the local Deno server with --allow-read --allow-write so the File_space can be created.",
    );
  }

  const op = params?.op ?? "write";
  const key = params?.key ?? params?.path;

  switch (op) {
    case "write": {
      if (!key) throw missingKey("write");
      if (typeof params.content !== "string") {
        throw new CoreToolError(
          "INVALID_INPUT",
          "fs_writer 'write' requires a string `content`.",
          "Serialize objects with JSON.stringify before writing.",
        );
      }
      await storage.write(key, params.content);
      const size = new TextEncoder().encode(params.content).byteLength;
      return { success: true, op, key, size, kind: storage.kind };
    }
    case "read": {
      if (!key) throw missingKey("read");
      const found = await storage.read(key);
      if (!found) return { success: false, op, key, found: false, content: null };
      return { success: true, op, key, found: true, ...found };
    }
    case "list": {
      const keys = await storage.list(params?.prefix ?? "");
      return { success: true, op, prefix: params?.prefix ?? "", keys, count: keys.length };
    }
    case "remove": {
      if (!key) throw missingKey("remove");
      await storage.remove(key);
      return { success: true, op, key };
    }
    default:
      throw new CoreToolError(
        "INVALID_OPERATION",
        `fs_writer does not support op "${String(op)}".`,
        'Use one of: "write", "read", "list", "remove".',
      );
  }
}

function missingKey(op: string): CoreToolError {
  return new CoreToolError(
    "INVALID_INPUT",
    `fs_writer '${op}' requires a \`key\`.`,
    "Pass a flat key such as { key: \"notes.txt\" }.",
  );
}

export default fsWriter;
