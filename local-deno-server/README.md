# `local-deno-server/` — the TGS zero-trust execution sandbox

This is the local Deno process the TGS browser app fires **real HTTP requests** at.
Per `docs/llm_generated/15-screen-runner.md`, the Runner screen never executes tool
TypeScript in the page: it mounts the tool here and drives it over HTTP, so local
testing mirrors the production Simple Tools Server (STS) exactly.

```
browser app  ──PUT /tools/calc {code,env,tests}──▶  runner  ──dynamic import──▶  calc.ts
             ──POST /calc      {a:5,b:3,...}────▶  runner  ──execute(req,ctx)─▶  Response
```

---

## Running it

```bash
export PATH="$HOME/.deno/bin:$PATH"

cd local-deno-server
deno task start                       # http://127.0.0.1:8080
# or
deno run --allow-all server.ts
TGS_RUNNER_PORT=9099 deno run --allow-all server.ts
```

**Default port: `8080`.** Override with the `TGS_RUNNER_PORT` env var.
The server binds `127.0.0.1` only.

Permissions: `--allow-all` is the practical setting. Individually the server needs
`--allow-net` (serve + the network gateway's egress), `--allow-read` / `--allow-write`
(temp module dir + the File_space), and `--allow-env` (merged `context.env`).

### Tests and type-checking

```bash
deno test  --allow-all local-deno-server/           # from the repo root — 18 tests
cd local-deno-server && deno task test              # same thing

cd local-deno-server && deno task check             # type-check everything
# From the repo root, pass the config explicitly so the "/core/" import map is found:
deno check --config local-deno-server/deno.json \
  local-deno-server/*.ts local-deno-server/core/**/*.ts local-deno-server/tools/*.ts
```

`deno.json` maps the STS-absolute specifier prefix `"/core/"` to `./core/`, which is
what lets `tools/*.ts` type-check in place with the exact import lines they ship with.

---

## HTTP contract

Every response is `application/json` unless the mounted tool itself says otherwise,
and every response carries permissive CORS headers (`access-control-allow-origin`
echoes the request `Origin`, falling back to `*`).

### `GET /health`

```jsonc
// 200
{ "ok": true, "kind": "tgs-local-deno-server", "version": "1.0.0", "mounted": ["calc"] }
```

### `PUT /tools/:name` — mount (or replace) a tool

Request body:

```jsonc
{
  "code": "import { initToolConfig } from \"/core/utils/initToolConfig.ts\"; ...",  // required
  "env":  { "WEATHER_API_KEY": "..." },   // optional — values from the [ Secrets ] tab
  "tests": [ { "name": "...", "payload": {}, "expect": { "status": 200 } } ]  // optional
}
```

The server writes `code` to a unique file in a temp dir, rewrites every `"/core/..."`
import specifier to this server's core module `file:` URLs, dynamically imports it,
and verifies the two required exports (`config`, and a default `execute` function).

```jsonc
// 200
{ "ok": true, "name": "calc", "config": { /* the full ToolConfig after initToolConfig */ },
  "tests": [ /* body.tests, else config.tests */ ], "mountedAt": "2026-09-07T17:07:24.000Z" }
```

```jsonc
// 400 — never crashes the server
{ "error": "COMPILE_ERROR", "message": "..." }
```

`error` is one of `INVALID_TOOL_NAME`, `INVALID_BODY`, `INVALID_JSON`, `COMPILE_ERROR`,
`MISSING_CONFIG_EXPORT`, `MISSING_EXECUTE_EXPORT`, `INVALID_CONFIG`, `MOUNT_FAILED`.

Re-mounting the same name **replaces** it: each mount gets a unique temp filename plus
a cache-busting `?v=` query, so Deno's module cache can never serve a stale version.

### `POST /:name` — execute a mounted tool

The request body is the **raw test `payload` JSON** — it is handed to the tool
untouched as the `Request` that `execute(request, context)` receives.

Optional request header `x-sts-origin: agent | sdk_rest | mcp_client`
(default `sdk_rest`) becomes `context.origin`.

The tool's `Response` is returned **verbatim** — same status, same headers, same body —
plus:

| Response header | Meaning |
| --- | --- |
| `x-tgs-duration-ms` | wall-clock ms spent inside `execute` |
| `x-tgs-tool` | the mounted tool name |
| `x-tgs-user` | the derived `context.userId` |

All three are listed in `access-control-expose-headers`, so the browser app can read them.

Runner-generated failures (the tool's own errors pass through untouched):

```jsonc
// 404 — not mounted
{ "error": "TOOL_NOT_MOUNTED", "message": "...", "actionable_advice": "PUT /tools/calc ..." }

// 429 — over config.rateLimit.requestsPerMinute (sliding 60s window, per tool)
{ "error": "RATE_LIMITED", "message": "...", "actionable_advice": "...",
  "tool": "calc", "requestsPerMinute": 300, "retryAfterMs": 41230 }   // + Retry-After header

// 500 — the tool threw instead of returning a Response
{ "error": "TOOL_THREW", "message": "...", "actionable_advice": "...", "tool": "calc", "stack": "..." }

// 500 — the tool exceeded config.timeoutMs (default 15000)
{ "error": "TOOL_TIMEOUT", "message": "...", "actionable_advice": "...", "tool": "calc", "timeoutMs": 15000 }

// 500 — execute() returned something that is not a Web Response
{ "error": "TOOL_CONTRACT_VIOLATION", "message": "...", "actionable_advice": "..." }
```

### `OPTIONS /:name` — the SDK manifest

`OPTIONS` is overloaded, and the two cases are kept strictly apart:

* **CORS preflight** — the request carries `Access-Control-Request-Method`.
  Answered `204` with the CORS headers, and never reaches the registry.
* **Manifest request** — no `Access-Control-Request-Method`. Returns the
  `SDKToolManifest` subset of the mounted config:

```jsonc
// 200
{ "name": "calc", "description": "...", "version": "1.1.0",
  "cost": 0, "isIdempotent": false, "signature": { "inputs": {}, "outputs": {}, "errors": {} } }
```

Note what is *not* there: `secrets`, `network_requests`, `tool_dependencies`, `tests`.
`404 { "error": "TOOL_NOT_MOUNTED" }` when the name is not mounted.

### `DELETE /tools/:name` — unmount

```jsonc
// 200
{ "ok": true, "name": "calc", "unmounted": true }
// 404
{ "error": "TOOL_NOT_MOUNTED", "message": "\"calc\" is not mounted." }
```

### Convenience reads

* `GET /tools` → `{ ok, tools: [{ name, mountedAt, version, tests }] }`
* `GET /tools/:name` → `{ ok, name, config, tests }`

Anything else → `404 { "error": "NOT_FOUND", "routes": [...] }`;
a wrong verb on a known route → `405 { "error": "METHOD_NOT_ALLOWED" }`.

### CORS summary

| Header | Value |
| --- | --- |
| `access-control-allow-origin` | the request `Origin`, else `*` |
| `access-control-allow-methods` | `GET, POST, PUT, DELETE, OPTIONS` |
| `access-control-allow-headers` | echoes `Access-Control-Request-Headers`, else `Content-Type, Authorization, x-sts-origin, x-sts-api-key, x-tgs-tool` |
| `access-control-expose-headers` | `x-tgs-duration-ms, x-tgs-tool, x-tgs-user` |
| `access-control-max-age` | `86400` |

---

## Context guarantees

A **fresh** `ToolExecutionContext` is built for every single request — nothing is
shared between calls except the on-disk File_space. Every field of
`docs/llm_generated/ToolContract.ts` is populated:

| Field | Guarantee |
| --- | --- |
| `userId` | the 6 characters after `sk-` in `STS_API_KEY` (mount env, else process env). No key → the stable dev id `"local1"`. |
| `origin` | `x-sts-origin` request header, validated against `agent \| sdk_rest \| mcp_client`; anything else → `"sdk_rest"`. |
| `env` | `Deno.env.toObject()` merged with the mount's `env`. **Mount env wins** — that is how the Secrets tab overrides the shell. |
| `internalFetch(name, init)` | Dispatches to a sibling **mounted** tool in-process (no socket). Refuses with a `403 { error: "DEPENDENCY_NOT_DECLARED", actionable_advice, declared }` Response when `name` is not in the *calling* tool's `config.tool_dependencies`. Also `404 TOOL_NOT_MOUNTED` and `508 INTERNAL_DEPTH_EXCEEDED` (nesting cap 8). |
| `useCoreTool(name, params)` | Same dependency check, but **throws** (the return type is `any`, not `Response`) an error carrying `code: "DEPENDENCY_NOT_DECLARED"` + `actionable_advice`. Implemented core tools: `network_gateway`, `fs_writer`. Anything else throws `UNKNOWN_CORE_TOOL`. |
| `storage` | `ToolStorage` of `kind: "local-fs"`, rooted at `.tgs-filespace/<userId>/` (override the base with `TGS_FILESPACE_DIR`). `list/read/write/remove`, flat keys. |
| `callerConfig` | The mounted tool's own `ToolConfig` — already attached, so `dispatchToGateway(req, context)` works even without the `{ ...context, callerConfig: config }` spread. |

### Storage keys are flat

Keys are one flat namespace. A nested-looking key is percent-encoded into a single
filename, so `reports/2026/q1.json` is stored as `reports%2F2026%2Fq1.json` and
`../escape.txt` cannot leave the user's root. `read` on a missing key returns `null`;
`remove` on a missing key is a no-op.

### Egress is closed by default

`core/network/network_gateway.ts` matches the target URL against
`callerConfig.network_requests` (absolute prefixes, literal `startsWith`) and throws a
`GatewayError` with `code: "NETWORK_NOT_ALLOWLISTED"` for anything else — including
**every** request when `callerConfig` is missing, or when the URL is not absolute
`http(s)`. Reachable but failing hosts throw `NETWORK_UNREACHABLE`. On allow it performs
the real `fetch` and returns `{ status, headers, body }`, with `body` parsed as JSON when
the response content type says JSON.

Two equivalent entry points, same enforcement:

```ts
import { dispatchToGateway } from "/core/network/network_gateway.ts";
await dispatchToGateway({ url, method: "GET" }, { ...context, callerConfig: config });

await context.useCoreTool("network_gateway", { url, method: "GET" });  // needs the dependency declared
```

### Rate limiting

A sliding 60-second window per mounted tool, sized by `config.rateLimit.requestsPerMinute`
(default 60 when the tool declares none). It applies to the `POST /:name` entry point.

---

## Layout

```
local-deno-server/
├── server.ts                      # HTTP router, registry, context builder, rate limiter
├── server_test.ts                 # 18 end-to-end tests over real HTTP
├── deno.json                      # "/core/" import map + tasks
├── core/
│   ├── contracts/ToolContract.ts  # verbatim mirror of docs/llm_generated/ToolContract.ts
│   ├── utils/initToolConfig.ts    # fills the STS defaults; derives name from the module URL
│   ├── network/network_gateway.ts # dispatchToGateway / networkGateway + the egress allowlist
│   ├── storage/local_storage.ts   # ToolStorage over .tgs-filespace/<userId>/
│   └── tools/fs_writer.ts         # the fs_writer core tool
└── tools/
    ├── calc.ts                    # reference tool, verbatim from 02-tool-authoring-guide.md §4
    └── weather_fetcher.ts         # reference tool for the gateway pattern
```

### `initToolConfig` defaults

`version "0.0.0"`, `description ""`, `cost 0`, `timeoutMs 15000`, `isIdempotent false`,
`rateLimit.requestsPerMinute 60`, `outputModality ["text"]`, and empty `secrets`,
`tool_dependencies`, `network_requests`, `tests`. `name` falls back to the module URL
basename (`.../weather_fetcher.ts` → `"weather_fetcher"`).

### The bundled tools

* **`tools/calc.ts`** — copied **verbatim** from `02-tool-authoring-guide.md` §4, including
  its `400 DIV_BY_ZERO` response and both embedded tests. This is the fixture the app ships
  as its default tool.
* **`tools/weather_fetcher.ts`** — the gateway pattern: `tool_dependencies: ["network_gateway"]`,
  `network_requests: ["https://api.open-meteo.com/"]`, an optional `WEATHER_API_KEY` secret
  that is only forwarded when present, an actionable `CITY_NOT_FOUND`, and embedded tests.
  Its "known city" test needs network access; the error-path test does not.
