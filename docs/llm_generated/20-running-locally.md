# Running TGS locally

**Not derived from `docs/human_only/`** — this file documents the implementation in this
repository. The specs describe *what* TGS does; this describes how to start it and what
each moving part needs. Divergences from the specs are logged in `00-INDEX.md` §5.

## 1. The three processes

| Process | Command | Port | Needed for |
| --- | --- | --- | --- |
| TGS web app | `bun run dev` | 3000 (Vite picks a free port) | Everything |
| Local Deno sandbox | `bun run deno:server` | 8080 (`TGS_RUNNER_PORT`) | The **[ Runner ]** tab only |
| — | — | — | Pyodide is in-browser; Claude is in the app server |

The app runs without the Deno sandbox — the Runner tab then shows a "down" status with
the exact command to start it, and every other tab works normally.

## 2. Environment

Copy `env.example` to `.env` (gitignored) and fill in what you need:

```
ANTHROPIC_API_KEY=sk-ant-...      # enables the AI Assistant and the [ LLM Rules ] validator
TGS_CLAUDE_MODEL=claude-opus-5    # optional; the spec's configurable model setting
VITE_TGS_RUNNER_URL=http://localhost:8080
```

Without `ANTHROPIC_API_KEY` the app still runs: the AI sidebar and the LLM half of the
Validator report that Claude is not configured rather than fabricating results. The key is
read only inside TanStack Start server-function handlers, so it never reaches the browser.

## 3. What runs where

* **AST extraction / recombination** — `src/lib/tgs/ast.ts`, in the browser, using the
  TypeScript compiler API. Drives the Editor's `[CONFIG_STUB]` abstraction and every
  "Save to Tool" path in the sync matrix.
* **Deterministic validation** — `src/lib/tgs/pyodideWorker.ts`, a module Web Worker that
  loads Pyodide from the jsDelivr CDN and executes the Python rules. The **first** run
  downloads the Pyodide runtime (~10 MB) and takes a few seconds; later runs are warm.
  Offline, the Python engine reports itself unavailable instead of faking a pass.
* **Heuristic validation and the AI assistant** — `src/server/claude.ts`, on the app server.
* **Tool execution** — `local-deno-server/`, a separate Deno process. The browser mounts the
  rendered `.ts` over HTTP (`PUT /tools/:name`) and then fires one `POST /:name` per
  `ToolTest`. See `local-deno-server/README.md` for the full contract.

## 4. Tests

```bash
bun run test            # vitest: unit tests + the runner end-to-end test
bun run test:e2e        # playwright: the real app in a real browser
bun run typecheck       # tsc --noEmit
bun run lint            # eslint + prettier
cd local-deno-server && deno test --allow-all .
```

`tests/integration/runnerE2E.test.ts` spawns the real Deno sandbox on port 8099, mounts the
default `calc` bundle and asserts every embedded and external test passes over HTTP. It needs
`deno` on `PATH` (`~/.deno/bin`).

`src/lib/tgs/pythonRules.test.ts` executes the five built-in rules through a real Pyodide
runtime in Node, so the first run downloads the Pyodide wheel.

`tests/e2e/workspace.spec.ts` drives the real app in Chromium: it starts the dev server and
the Deno sandbox itself (`playwright.config.ts`), runs the Python rules through the real
Pyodide worker, and executes the bundled tests against the real sandbox. Install the browser
once with `bunx playwright install --with-deps chromium`. Note that the shell is
server-rendered, so a test must wait for hydration before interacting — the spec gates on a
mounted Monaco instance, which is client-only.

## 5. Browser requirements

`[📂 Load File]` and `[📁 Select Local Folder ▼]` use the File System Access API, which
today means a Chromium-based browser over `https` or `localhost`. Elsewhere the app falls
back to `<input type="file">` for loading and anchor downloads for `[ 💾 Save ]` and
`[ 🚀 Publish ]`; the controls say so rather than failing silently.
