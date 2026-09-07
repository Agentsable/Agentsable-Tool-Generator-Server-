/**
 * [ Editor ] — docs/llm_generated/11-screen-editor.md
 *
 * A Monaco TypeScript environment dedicated to the execution logic. The
 * declarative `baseConfig` block is parsed out by the AST engine and replaced
 * with a single `CONFIG_STUB` comment, so the developer cannot corrupt the JSON
 * schema while writing code. The config is stitched back in at the stub position
 * on save / tab switch / publish (§3 Recombination).
 */
import { useEffect, useMemo, useState } from "react";
import {
  Code2,
  Settings2,
  ShieldAlert,
  TriangleAlert,
  ChevronDown,
  ChevronRight,
  ArrowRight,
} from "lucide-react";

import { MonacoEditor } from "@/components/tgs/MonacoEditor";
import { zeroTrustDiagnostics } from "@/components/tgs/monacoSetup";
import { CONFIG_STUB, recombineTool } from "@/lib/tgs/ast";
import { useTool } from "@/state/toolStore";

/** The shape the inline warning list needs; kept local so this screen tolerates
 *  any future widening of the diagnostics payload. */
type LintWarning = { line: number; message: string };

function isLintWarning(value: unknown): value is LintWarning {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { line?: unknown; message?: unknown };
  return typeof v.line === "number" && typeof v.message === "string";
}

/**
 * Zero-trust / isolate warnings, computed in plain TypeScript so the guidance is
 * visible even when Monaco falls back to the plain pane and never renders its
 * own squiggles. Never throws: an empty list simply hides the section.
 */
function lintLogic(code: string): LintWarning[] {
  try {
    const raw = (zeroTrustDiagnostics as unknown as (c: string) => unknown)(code);
    if (!Array.isArray(raw)) return [];
    return raw.filter(isLintWarning);
  } catch {
    return [];
  }
}

export function EditorScreen() {
  const { bundle, setLogic, focusRequest, requestFocus, configDivergence, dirty } = useTool();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [revealLine, setRevealLine] = useState<number | undefined>(undefined);

  /* A Validator finding was clicked: jump to the offending line. `focusRequest`
     is a fresh object on every request (it carries a `token`), so repeat clicks
     on the same line still re-trigger the reveal — the prop goes N → undefined → N. */
  useEffect(() => {
    if (!focusRequest || focusRequest.tab !== "Editor" || focusRequest.line === undefined) return;
    setRevealLine(focusRequest.line);
    const timer = setTimeout(() => setRevealLine(undefined), 500);
    return () => clearTimeout(timer);
  }, [focusRequest]);

  const stubPresent = bundle.logic.includes(CONFIG_STUB);
  const warnings = useMemo(() => lintLogic(bundle.logic), [bundle.logic]);

  const config = bundle.config;
  const secretCount = Object.keys(config.secrets ?? {}).length;
  const dependencyCount = (config.tool_dependencies ?? []).length;
  const rateLimit = config.rateLimit?.requestsPerMinute;

  /* Only pay for the AST round-trip while the preview is actually open. */
  const preview = useMemo(() => {
    if (!previewOpen) return "";
    try {
      return recombineTool(bundle.logic, config);
    } catch (error) {
      return `/* Recombination failed: ${(error as Error).message} */`;
    }
  }, [previewOpen, bundle.logic, config]);

  return (
    <section className="panel">
      <div className="panel-head">
        <Code2 className="h-4 w-4 text-primary" />
        <span className="font-semibold">[ TypeScript Logic View — Config Block Hidden ]</span>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <span className="chip font-mono">{bundle.name}.ts</span>
          <span className="chip">
            <span className={dirty ? "text-warning" : "text-success"}>
              {dirty ? "● unsaved" : "● saved"}
            </span>
          </span>
        </div>
      </div>

      <div className="space-y-3 p-3">
        {/* --------------------- the config abstraction --------------------- */}
        <div className="stat-card space-y-3" data-testid="editor-config-banner">
          <div className="flex flex-wrap items-start gap-2">
            <Settings2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1 space-y-1 text-xs">
              <p className="font-semibold text-foreground">
                The <code className="font-mono">config</code> object is hidden — it is managed in
                the Config tab.
              </p>
              <p className="text-muted-foreground">
                The AST engine replaced the <code className="font-mono">baseConfig</code>{" "}
                declaration (and its{" "}
                <code className="font-mono">export const config = await initToolConfig(…)</code>{" "}
                line) with the stub comment below. It is stitched back into that exact position on
                save, tab switch and publish — so the JSON schema cannot be broken by a typo in the
                execution logic.
              </p>
            </div>
            <button type="button" className="btn" onClick={() => requestFocus("Config")}>
              Open Config tab
              <ArrowRight className="h-3 w-3" />
            </button>
          </div>

          {/* current config, so the developer is not flying blind */}
          <dl
            className="grid grid-cols-2 gap-2 text-xs md:grid-cols-5"
            data-testid="editor-config-summary"
          >
            <div>
              <dt className="label">name</dt>
              <dd className="font-mono text-foreground">{config.name ?? "—"}</dd>
            </div>
            <div>
              <dt className="label">version</dt>
              <dd className="font-mono text-foreground">{config.version ?? "—"}</dd>
            </div>
            <div>
              <dt className="label">secrets</dt>
              <dd className="font-mono text-foreground">{secretCount}</dd>
            </div>
            <div>
              <dt className="label">tool dependencies</dt>
              <dd className="font-mono text-foreground">{dependencyCount}</dd>
            </div>
            <div>
              <dt className="label">rate limit</dt>
              <dd className="font-mono text-foreground">
                {rateLimit === undefined ? "—" : `${rateLimit}/min`}
              </dd>
            </div>
          </dl>

          {configDivergence.length > 0 ? (
            <p className="text-xs text-warning" data-testid="editor-config-divergence">
              The embedded config and the standalone .json diverge at {configDivergence.length} path
              {configDivergence.length === 1 ? "" : "s"}:{" "}
              <span className="font-mono">{configDivergence.slice(0, 4).join(", ")}</span>
              {configDivergence.length > 4 ? " …" : ""}
            </p>
          ) : null}
        </div>

        {/* ------------------------- stub guard rail ------------------------- */}
        {stubPresent ? null : (
          <div className="finding" data-state="warn" role="alert" data-testid="editor-stub-warning">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div className="space-y-1 text-xs">
              <p className="font-semibold text-foreground">
                The CONFIG_STUB comment is missing from this buffer.
              </p>
              <p className="text-muted-foreground">
                Recombination has nothing to aim at, so the AST engine will append the config block
                after the last import instead of putting it back where it was. Paste the line below
                to choose the position yourself:
              </p>
              <pre className="code-surface overflow-x-auto rounded-md border border-border px-3 py-2 text-foreground">
                {CONFIG_STUB}
              </pre>
            </div>
          </div>
        )}

        {/* ---------------------------- the editor --------------------------- */}
        <MonacoEditor
          value={bundle.logic}
          onChange={setLogic}
          language="typescript"
          path={`${bundle.name}.ts`}
          height="60vh"
          ariaLabel={`${bundle.name} execution logic`}
          {...(revealLine === undefined ? {} : { revealLine })}
        />

        {/* --------------------- zero-trust linter warnings ------------------- */}
        {warnings.length > 0 ? (
          <div className="space-y-1" data-testid="editor-lint-warnings">
            <p className="label">Zero-trust / isolate warnings ({warnings.length})</p>
            {warnings.map((w, i) => (
              <div className="finding" data-state="warn" key={`${w.line}-${i}`}>
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <p className="text-xs">
                  <button
                    type="button"
                    className="font-mono text-primary underline-offset-2 hover:underline"
                    onClick={() => requestFocus("Editor", { line: w.line })}
                  >
                    line {w.line}
                  </button>{" "}
                  <span className="text-muted-foreground">{w.message}</span>
                </p>
              </div>
            ))}
          </div>
        ) : null}

        {/* ------------------------ recombination preview --------------------- */}
        <div>
          <button
            type="button"
            className="btn"
            aria-expanded={previewOpen}
            onClick={() => setPreviewOpen((v) => !v)}
          >
            {previewOpen ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
            Recombination preview — exactly what {bundle.name}.ts will contain
          </button>

          {previewOpen ? (
            <div className="mt-2 space-y-2" data-testid="editor-recombination-preview">
              <p className="text-xs text-muted-foreground">
                Read-only. This is <code className="font-mono">recombineTool(logic, config)</code>:
                the buffer above with the config block, the{" "}
                <code className="font-mono">initToolConfig</code> import and the{" "}
                <code className="font-mono">ToolConfig</code> type import injected back in. It is
                what Save writes to disk and what the Raw Data tab shows.
              </p>
              <MonacoEditor
                value={preview}
                language="typescript"
                readOnly
                path={`${bundle.name}.recombined.ts`}
                height="40vh"
                ariaLabel="Recombined TypeScript preview (read-only)"
              />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
