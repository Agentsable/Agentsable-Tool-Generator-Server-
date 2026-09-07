// /core/network/network_gateway.ts
//
// Rule 7 of the authoring guide ("Zero-Trust Network"): a tool never calls the
// global `fetch()`. Every outbound request goes through this gateway, which
// matches the target URL against the CALLING tool's `config.network_requests`
// allowlist and refuses anything that is not covered by it.
//
// The gateway reads the allowlist from `context.callerConfig`. If that is
// missing, the gateway has no rules — and so it refuses everything.

import type { ToolExecutionContext } from "../contracts/ToolContract.ts";

export interface GatewayRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface GatewayResponse {
  status: number;
  headers: Record<string, string>;
  /** Parsed JSON when the response is JSON, otherwise the raw text. */
  body: unknown;
}

/** A refusal / failure that carries a machine-readable code plus advice. */
export class GatewayError extends Error {
  readonly code: string;
  readonly actionable_advice: string;
  readonly allowlist: string[];
  readonly target?: string;

  constructor(
    code: string,
    message: string,
    actionable_advice: string,
    allowlist: string[] = [],
    target?: string,
  ) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.actionable_advice = actionable_advice;
    this.allowlist = allowlist;
    this.target = target;
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      actionable_advice: this.actionable_advice,
      allowlist: this.allowlist,
      target: this.target,
    };
  }
}

/**
 * True when `target` starts with one of the absolute prefixes in `allowlist`.
 * Prefixes are matched literally, exactly as documented in ToolConfig:
 * "https://api.anthropic.com/v1/messages".
 */
export function isAllowlisted(target: string, allowlist: string[]): boolean {
  if (!Array.isArray(allowlist) || allowlist.length === 0) return false;
  return allowlist.some((prefix) =>
    typeof prefix === "string" && prefix.length > 0 && target.startsWith(prefix)
  );
}

/**
 * The gateway proper. Tools call it as:
 *
 *   await dispatchToGateway({ url, method: "GET" }, { ...context, callerConfig: config });
 */
export async function dispatchToGateway(
  req: GatewayRequest,
  context: ToolExecutionContext,
): Promise<GatewayResponse> {
  const callerConfig = context?.callerConfig;

  if (!callerConfig) {
    throw new GatewayError(
      "NETWORK_NOT_ALLOWLISTED",
      "The network gateway received no callerConfig, so it has no egress rules and refuses every request.",
      "Pass your own config as callerConfig: dispatchToGateway(req, { ...context, callerConfig: config }).",
      [],
      req?.url,
    );
  }

  const target = String(req?.url ?? "");
  if (!/^https?:\/\//i.test(target)) {
    throw new GatewayError(
      "NETWORK_NOT_ALLOWLISTED",
      `The gateway only dispatches absolute http(s) URLs; received "${target}".`,
      "Build an absolute URL (https://host/path) before calling the gateway.",
      callerConfig.network_requests ?? [],
      target,
    );
  }

  const allowlist = callerConfig.network_requests ?? [];
  if (!isAllowlisted(target, allowlist)) {
    throw new GatewayError(
      "NETWORK_NOT_ALLOWLISTED",
      `"${target}" is not covered by the egress allowlist of tool "${callerConfig.name}".`,
      allowlist.length === 0
        ? `Add the absolute URL prefix to config.network_requests in ${callerConfig.name}, e.g. network_requests: ["${safePrefix(target)}"].`
        : `Add a matching absolute URL prefix to config.network_requests in ${callerConfig.name}. Currently allowed: ${allowlist.join(", ")}.`,
      allowlist,
      target,
    );
  }

  const method = (req.method ?? "GET").toUpperCase();
  const headers = new Headers(req.headers ?? {});
  let body: BodyInit | undefined;

  if (req.body !== undefined && req.body !== null && method !== "GET" && method !== "HEAD") {
    if (typeof req.body === "string") {
      body = req.body;
    } else {
      body = JSON.stringify(req.body);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
  }

  let res: Response;
  try {
    res = await fetch(target, { method, headers, body });
  } catch (err) {
    throw new GatewayError(
      "NETWORK_UNREACHABLE",
      `The gateway could not reach "${target}": ${err instanceof Error ? err.message : String(err)}`,
      "Check the host is reachable from the runner and that the URL is correct.",
      allowlist,
      target,
    );
  }

  const outHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    outHeaders[k] = v;
  });

  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  let parsed: unknown = text;
  if (contentType.includes("json")) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  return { status: res.status, headers: outHeaders, body: parsed };
}

/**
 * The `useCoreTool('network_gateway', params)` entry point. Same enforcement,
 * params-shaped instead of request-shaped.
 */
export async function networkGateway(
  params: GatewayRequest,
  context: ToolExecutionContext,
): Promise<GatewayResponse> {
  return await dispatchToGateway(params, context);
}

function safePrefix(target: string): string {
  try {
    const u = new URL(target);
    return `${u.protocol}//${u.host}`;
  } catch {
    return target;
  }
}

export default dispatchToGateway;
