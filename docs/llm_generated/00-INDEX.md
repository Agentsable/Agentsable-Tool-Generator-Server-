# TGS Documentation — LLM-Generated Set

A reconciled, deduplicated rendering of the specifications in `docs/human_only/`. Every fact here traces to a human-only file; where those files disagreed with each other or carried mechanical defects, the conflict is resolved once and recorded in §3 below.

`docs/human_only/` remains the authoritative source and is unmodified.

## 1. Files

| File | Covers | Derived from |
| --- | --- | --- |
| `01-system-overview.md` | Ecosystem context, base44 shell, file tree, execution engine | `tool_Generator_Server.md` |
| `02-tool-authoring-guide.md` | STS tool format, components, `calc.ts` example, the 7 rules | `tools_definitions.md` |
| `ToolContract.ts` | Tool Contract V2 — the types that enforce the guide | `ToolsContract.ts` |
| `10-screen-raw-data.md` | `[ Raw Data ]` — four-file read-only view | `app_ui.md` §1 |
| `11-screen-editor.md` | `[ Editor ]` — AST abstraction, Monaco config | `editor_config_page.md` §1 |
| `12-screen-config.md` | `[ Config ]` — form builder, dual JSON, sync matrix | `editor_config_page.md` §2–4 |
| `13-screen-secrets.md` | `[ Secrets ]` — schema-driven env manager | `tool_Generator_Server.md` §4.D |
| `14-screen-validator.md` | `[ Validator ]` — Pyodide + Claude dual engine | `validator_page.md` |
| `15-screen-runner.md` | `[ Runner ]` — HTTP execution sandbox | `runner_page.md` |
| `20-running-locally.md` | How to start the app, the sandbox and the validators | — (implementation notes) |

## 2. Structural changes

* **Editor and Config split into separate files.** `editor_config_page.md` covered two tabs in one document; every other tab has its own file, so these were separated to match.
* **Secrets given a dedicated file.** No human-only file specified this tab. `13-screen-secrets.md` is built from `tool_Generator_Server.md` §4.D (schema enforcement, smart `.env` loading), with the ASCII layout and merge semantics reconstructed from the design conversation in `llm_ignore/full_conversation.md` (L619–655) that produced that section. This is the only file with content not present verbatim in `docs/human_only/`; it is flagged as reconstructed in its own header.
* **`ToolContract.ts` kept as compilable TypeScript** rather than folded into markdown. Verified against `tsc --noEmit --strict`.

## 3. Reconciliation log

Each entry names the conflict found across the human-only files and the resolution applied here.

### Mechanical defects

| # | Issue | Resolution |
| --- | --- | --- |
| 1 | `ToolsContract.ts` carried 7 `[cite: 7]` citation markers after closing braces, making it invalid TypeScript | Stripped. The file now compiles under `--strict`. |
| 2 | File named `ToolsContract.ts`, but its own header comment and every cross-reference say `ToolContract.ts` | Named `ToolContract.ts` here, matching the references. |
| 3 | `tools_definitions.md:114` — malformed bullet ``**`mcpResources` / `mcpPrompts**`:`` (backtick/bold mismatch) | Fixed to `**mcpResources / mcpPrompts**`. |
| 4 | `validator_page.md:70` — `$\ge 90$` leaked LaTeX, renders literally | Written as `≥ 90`. |
| 5 | `editor_config_page.md:181` — nested markdown link inside a code span | Written as a plain URL. |

### Content conflicts

| # | Conflict | Resolution |
| --- | --- | --- |
| 6 | **SDK package name.** All human-only files say `claude-agent-sdk-typescript` — the GitHub repo name, not an installable package. | `@anthropic-ai/claude-agent-sdk`, the actual npm package for the TypeScript Claude Agent SDK. |
| 7 | **Model ID.** `validator_page.md:231` hardcodes `claude-3-5-sonnet-latest`, two model generations stale. | `claude-opus-5`, documented as a configurable app setting rather than a hardcoded constant. |
| 8 | **Editor config stub.** `app_ui.md` §2 uses `// Configuration is managed via the Config tab.`; `editor_config_page.md` §1 uses `/* [CONFIG_STUB]: ... */`. | `[CONFIG_STUB]`. `editor_config_page.md` is the later, more complete spec — it also carries the Monaco linter rules that `app_ui.md` lacks. |
| 9 | **Editor imports.** `app_ui.md` §2 shows `import { initToolConfig }` inside the "Config Block Hidden" view, but `initToolConfig` is only called by the `export const config = ...` line the AST engine strips. | Removed from the logic view, with an explicit note. `11-screen-editor.md` follows `editor_config_page.md`, which imports `dispatchToGateway` instead — consistent with `rule_no_global_fetch.py`. |
| 10 | **Health score example.** `validator_page.md` defines −25 per deterministic failure and −5 per warning, then shows 1 failure + 1 warning as **82/100**. The formula gives 70. | Formula is authoritative; the example reads **70/100**, with the arithmetic shown. |
| 11 | **Guidelines filename.** `tool_Generator_Server.md` refers to the authoring guidelines as both `sts_tool_guidelines.md` (§5) and `sts_rules.md` (§3 file tree) — but `sts_rules.md` is a genuinely different file (the LLM heuristic rubric). | Guidelines are `02-tool-authoring-guide.md`; `sts_rules.md` is documented only as the Validator's LLM rubric. |
| 12 | **Product name.** `README.md` at the repo root titles this project "Tool Weaver". Every spec says Tool Generator Server (TGS). | TGS throughout. The README was not modified. |
| 13 | **Python rule count.** `validator_page.md` §3.3 lists 5 built-in rules; both its ASCII layouts show only 4 (`rule_network_allowlist.py` missing). | `rule_network_allowlist.py` added to both layouts so the count matches. |
| 14 | **Save button label.** The sync matrix in `editor_config_page.md` calls the top-bar action "Save All"; the bar itself is labelled `[ 💾 Save ]`. | `[ 💾 Save ]` throughout. |
| 15 | **Raw Data sub-nav labels.** `app_ui.md` ASCII shows `[ tool.ts ] [ tool.json ] [ tool.env ] [ tests.json ]` while the prose and all other docs use `[tool_name].*`; the header row also lost its closing `\|`. | Generic `[ .ts ] [ .json ] [ .env ] [ _tests.json ]` in the layout, with a note that labels render with the active tool's name substituted. Border closed. |

## 4. Verification

* `ToolContract.ts` — `tsc --noEmit --strict --lib es2022,dom` passes.
* No `[cite:` markers, LaTeX escapes, or references to `claude-agent-sdk-typescript`, `claude-3-5-sonnet-latest`, `sts_tool_guidelines.md`, `ToolsContract.ts`, "Save All", or "Tool Weaver" remain in this directory — except inside this index, which quotes them to record the changes.

## 5. Implementation divergences

Recorded per `CLAUDE.md`: the specs in `docs/human_only/` are unchanged; these are
places where the running application in this repository knowingly departs from, or
concretizes, what the specs describe.

| # | Spec says | Implementation | Why |
| --- | --- | --- | --- |
| 16 | AI features run on `@anthropic-ai/claude-agent-sdk` (reconciliation #6). | `@anthropic-ai/sdk` (the Messages API) called from TanStack Start server functions, with a server-side tool-use loop for the assistant and the rubric as a `system` prompt for the validator. | The Agent SDK is the Claude Code harness: it spawns a CLI with filesystem and bash tools. The tool being authored lives in browser state, not on disk, and the Validator needs a strict-JSON structured response. The Messages API with declared tools gives the assistant exactly the five mutations the specs ask for (`replace_execution_logic`, `patch_tool_config`, `add_error_advice`, `add_test`, `run_tests`/`run_validations`) and keeps `ANTHROPIC_API_KEY` server-side. The model is `claude-opus-5` per reconciliation #7, overridable with `TGS_CLAUDE_MODEL`. |
| 17 | "a lightweight local Deno proxy (e.g. `http://localhost:8080`)" — no wire protocol given. | `local-deno-server/` on port 8080 (`TGS_RUNNER_PORT`): `GET /health`, `PUT /tools/:name` to mount `{code, env, tests}`, `POST /:name` to execute with the raw test payload, `OPTIONS /:name` for the `SDKToolManifest`, `DELETE /tools/:name`. See `local-deno-server/README.md`. | The specs fix the boundary (HTTP, zero-trust, fresh `ToolExecutionContext` per request) but not the routes. Mount-then-execute keeps the browser from ever executing TypeScript, exactly as §5 of `01-system-overview.md` requires. |
| 18 | Runner toolbar shows `[ ↻ Restart Local Deno Server ]`. | Labelled "Reconnect / Restart Local Deno Server": it re-probes `/health` and, when the server is down, shows the exact command to start it. | TGS runs in a browser tab and did not spawn the Deno process, so it cannot restart it. Claiming otherwise would be a lie in the UI. |
| 19 | `sts_rules.md` sits beside `/src` in the file tree. | `sts_rules.md` at the repository root, generated from `DEFAULT_LLM_RUBRIC` in `src/lib/tgs/pythonRules.ts`, which is what the `[ LLM Rules ]` editor seeds from. | Keeps one source of truth. The editor's live buffer is the authority at runtime; the file is the checked-in default. |
| 20 | `src/App.tsx` is the main application router. | TanStack Router file routes: `src/routes/__root.tsx` + `src/routes/index.tsx`. | The project was already scaffolded on TanStack Start; the three-zone base44 layout is unchanged. |
| 21 | Health-score example in `14-screen-validator.md` implies a third "warning" outcome from a Python rule, but the execution contract returns `tuple[bool, str]`. | A passing rule whose message begins `WARN:` is counted as a warning (−5) rather than a pass. | The contract has no third state; this adds one without changing `validate`'s signature. |
