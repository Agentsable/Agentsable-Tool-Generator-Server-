/* eslint-disable @typescript-eslint/no-explicit-any --
 * This file is a verbatim mirror of docs/llm_generated/ToolContract.ts, which is
 * itself derived from the authoritative docs/human_only/ToolsContract.ts. The `any`s
 * are part of the published Tool Contract V2 surface (JSON Schema fragments and the
 * `useCoreTool` return), so narrowing them here would silently fork the contract.
 */
// Tool Contract V2 — mirrored verbatim from docs/llm_generated/ToolContract.ts.
// The authoring rules live in docs/llm_generated/02-tool-authoring-guide.md.
// Do not edit without updating that spec.

export interface ToolSignature {
  inputs: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
  outputs: {
    type: "object";
    properties: Record<string, any>;
  };
  /** Surfaced to the Python agent so a failure carries a next step, not just a code. */
  errors?: Record<
    string,
    {
      description: string;
      actionable_advice?: string;
    }
  >;
}

/** Defines an HTTP-driven test case for the tool. */
export interface ToolTest {
  name: string;
  payload: any;
  expect: {
    status?: number;
    hasKey?: string;
  };
}

/** What `OPTIONS /<tool>` returns: the subset an SDK needs to build a callable. */
export interface SDKToolManifest {
  name: string;
  description: string;
  version: string;
  cost?: number;
  isIdempotent?: boolean;
  signature: ToolSignature;
}

export interface ToolConfig {
  name: string;
  version: string;
  icon?: string;
  tags?: string[];
  description: string;
  mcpDescription?: string;

  /** V2 replaces the flat `requiredEnv` array: a secret says what it is and whether it is optional. */
  secrets?: Record<
    string,
    {
      description: string;
      isOptional?: boolean;
    }
  >;

  /** Sibling tools this tool may reach via internalFetch/useCoreTool. */
  tool_dependencies?: string[];

  /**
   * Egress allowlist as absolute URL prefixes, e.g. "https://api.anthropic.com/v1/messages".
   * network_gateway.ts matches a target against these and refuses anything else.
   */
  network_requests?: string[];

  permissions?: {
    read?: string[];
    write?: string[];
  };

  timeoutMs?: number;
  isIdempotent?: boolean;
  cost?: number;

  rateLimit?: {
    requestsPerMinute: number;
  };

  outputModality?: ("text" | "image" | "application/pdf" | "binary")[];

  mcpResources?: Array<{ uri: string; name: string; description?: string }>;
  mcpPrompts?: Array<{ name: string; description?: string; arguments?: any[] }>;

  /** Embedded test suite for local HTTP validation. */
  tests?: ToolTest[];

  signature: ToolSignature;
}

/**
 * File_space access, addressed as flat keys relative to the File_space root.
 * The router picks the backend — the local file system on Deno, the R2 bucket
 * on Workers — so a storage tool never branches on runtime. `env` cannot carry
 * this: it is Record<string, string>, and an R2 binding is an object.
 */
export interface ToolStorage {
  kind: string;
  list(prefix: string): Promise<{ key: string; size: number }[]>;
  read(key: string): Promise<{ content: string; size: number } | null>;
  write(key: string, content: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface ToolExecutionContext {
  /** The 6 characters after `sk-`. The router validates the key and derives this once. */
  userId: string;
  /** Who is calling. Tools format for the audience: markdown for "agent", strict JSON otherwise. */
  origin: "agent" | "sdk_rest" | "mcp_client";
  env: Record<string, string>;
  internalFetch: (toolName: string, init?: RequestInit) => Promise<Response>;
  useCoreTool: (toolName: string, params: any) => Promise<any>;
  /** Absent only if no backend is available at all (no disk and no binding). */
  storage?: ToolStorage;
  /**
   * The calling tool's own config, attached by asCaller(). network_gateway.ts
   * reads network_requests from it to enforce the egress allowlist — without it
   * the gateway has no rules and refuses everything.
   */
  callerConfig?: ToolConfig;
}
