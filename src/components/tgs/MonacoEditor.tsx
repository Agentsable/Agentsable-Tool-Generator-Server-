/**
 * The shared Monaco editor for the TGS workbench.
 *
 * SSR-safe by construction: this module has NO runtime import of
 * `monaco-editor` or `@monaco-editor/react`. On the server (and on the first
 * client render, so hydration matches) it renders a static, line-numbered code
 * pane. Monaco is pulled in from a `useEffect` with a dynamic `import()`, which
 * only ever runs in the browser. If that import fails, the fallback pane stays
 * up and degrades to a plain `<textarea>` when the caller passed `onChange`, so
 * the user is never locked out of their code.
 *
 * Everything is self-hosted: the workers come from the bundled `monaco-editor`
 * package via Vite `?worker` imports and `@monaco-editor/react`'s loader is
 * pointed at that same bundled copy, so no CDN request is ever made.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type JSX,
  type ReactNode,
} from "react";
import type * as MonacoNs from "monaco-editor";
import type { EditorProps } from "@monaco-editor/react";

import {
  configureMonaco,
  externalMarkersToMonaco,
  TGS_EXTERNAL_MARKER_OWNER,
  TGS_THEME_NAME,
  type ExternalMarker,
  type MonacoApi,
} from "./monacoSetup";

export type MonacoLanguage = "typescript" | "json" | "python" | "markdown" | "ini";

export type MonacoMarker = ExternalMarker;

export type MonacoEditorProps = {
  value: string;
  onChange?: (value: string) => void;
  language: MonacoLanguage;
  readOnly?: boolean;
  /** @default "60vh" */
  height?: string | number;
  /** Model path, e.g. `"calc.ts"` — gives each file its own model + undo stack. */
  path?: string;
  markers?: MonacoMarker[];
  /** When set, scrolls to and highlights that line (Validator "jump to finding"). */
  revealLine?: number;
  ariaLabel?: string;
};

/* -------------------------------------------------------------------------- */
/* Browser-only Monaco bootstrap                                               */
/* -------------------------------------------------------------------------- */

type LoadedMonaco = {
  monaco: MonacoApi;
  Editor: ComponentType<EditorProps>;
};

let monacoPromise: Promise<LoadedMonaco> | null = null;
let alreadyWarned = false;

function warnOnce(error: unknown): void {
  if (alreadyWarned) return;
  alreadyWarned = true;
  // Log once — a broken editor should not spam the console on every re-render.
  console.warn("[tgs] Monaco failed to load; using the read-only fallback pane.", error);
}

async function bootstrapMonaco(): Promise<LoadedMonaco> {
  // `import.meta.env.SSR` is inlined per build environment, so this whole body
  // is dead code in the server bundle — Monaco (7.8 MB) never ships to the
  // Worker/Node output, only to the browser chunk.
  if (import.meta.env.SSR) {
    throw new Error("[tgs] Monaco is browser-only");
  }

  const [monacoMod, reactMod, editorWorker, tsWorker, jsonWorker, cssWorker, htmlWorker] =
    await Promise.all([
      import("monaco-editor"),
      // NOTE: monaco 0.56's package "exports" map is `"./*": "./esm/vs/*.js"`,
      // so the worker specifiers are `monaco-editor/editor/...`, NOT the
      // `monaco-editor/esm/vs/...` paths used by older versions.
      import("@monaco-editor/react"),
      import("monaco-editor/editor/editor.worker.js?worker"),
      import("monaco-editor/languages/features/typescript/ts.worker.js?worker"),
      import("monaco-editor/languages/features/json/json.worker.js?worker"),
      import("monaco-editor/languages/features/css/css.worker.js?worker"),
      import("monaco-editor/languages/features/html/html.worker.js?worker"),
    ]);

  const workers: Record<string, new () => Worker> = {
    editorWorkerService: editorWorker.default,
    typescript: tsWorker.default,
    javascript: tsWorker.default,
    json: jsonWorker.default,
    css: cssWorker.default,
    scss: cssWorker.default,
    less: cssWorker.default,
    html: htmlWorker.default,
    handlebars: htmlWorker.default,
    razor: htmlWorker.default,
  };

  // Self-hosted workers: no `getWorkerUrl`, no CDN, no `MonacoEnvironment.baseUrl`.
  (
    globalThis as unknown as {
      MonacoEnvironment?: { getWorker: (workerId: string, label: string) => Worker };
    }
  ).MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      const Ctor = workers[label] ?? editorWorker.default;
      return new Ctor();
    },
  };

  const monaco = monacoMod as unknown as MonacoApi;
  // Point @monaco-editor/react at the bundled copy instead of the jsDelivr CDN.
  reactMod.loader.config({ monaco: monacoMod as never });
  configureMonaco(monaco);

  return { monaco, Editor: reactMod.default as unknown as ComponentType<EditorProps> };
}

/** Memoized so a page full of panes loads Monaco exactly once. */
function loadMonaco(): Promise<LoadedMonaco> {
  monacoPromise ??= bootstrapMonaco();
  return monacoPromise;
}

/* -------------------------------------------------------------------------- */
/* Static fallback pane (server render, loading, and hard failure)             */
/* -------------------------------------------------------------------------- */

function resolveHeight(height: string | number): string {
  return typeof height === "number" ? `${height}px` : height;
}

function FallbackPane({
  value,
  height,
  ariaLabel,
  onChange,
}: {
  value: string;
  height: string | number;
  ariaLabel?: string | undefined;
  onChange?: ((value: string) => void) | undefined;
}): JSX.Element {
  const lineCount = Math.max(1, value.split("\n").length);
  const gutter: ReactNode[] = [];
  for (let i = 1; i <= lineCount; i++) gutter.push(<div key={i}>{i}</div>);

  return (
    <div
      data-tgs-monaco-fallback="true"
      className="code-surface flex overflow-hidden rounded-md border border-border"
      style={{ height: resolveHeight(height) }}
    >
      <div
        aria-hidden="true"
        className="select-none overflow-hidden border-r border-border px-3 py-3 text-right text-gutter"
      >
        {gutter}
      </div>
      {onChange ? (
        <textarea
          spellCheck={false}
          aria-label={ariaLabel ?? "Code editor"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="code-surface flex-1 resize-none overflow-auto px-4 py-3 text-foreground outline-none"
        />
      ) : (
        <pre
          aria-label={ariaLabel ?? "Code"}
          className="flex-1 overflow-auto px-4 py-3 text-foreground"
        >
          {value}
        </pre>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

type Phase = "static" | "loading" | "ready" | "failed";

type Instances = {
  editor: MonacoNs.editor.IStandaloneCodeEditor;
  monaco: MonacoApi;
};

export function MonacoEditor({
  value,
  onChange,
  language,
  readOnly,
  height = "60vh",
  path,
  markers,
  revealLine,
  ariaLabel,
}: MonacoEditorProps): JSX.Element {
  // "static" on the server AND on the first client render, so hydration matches.
  const [phase, setPhase] = useState<Phase>("static");
  const [loaded, setLoaded] = useState<LoadedMonaco | null>(null);
  const [instances, setInstances] = useState<Instances | null>(null);
  const decorationsRef = useRef<MonacoNs.editor.IEditorDecorationsCollection | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    loadMonaco().then(
      (result) => {
        if (cancelled) return;
        setLoaded(result);
        setPhase("ready");
      },
      (error: unknown) => {
        warnOnce(error);
        if (!cancelled) setPhase("failed");
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // `keepCurrentModel` keeps a model alive across unmounts so each file keeps its
  // undo stack. The cost is that remounting on a path whose model already exists
  // reuses that model verbatim — @monaco-editor/react does not push the incoming
  // `value` into it — so a pane could show content from before the store changed
  // (e.g. leaving [ Config ], saving, and coming back to [ Raw Data ]).
  // Re-sync whenever the model has drifted from the prop; while the user types,
  // `onChange` keeps the two identical, so this never fights an active edit.
  useEffect(() => {
    if (!instances) return;
    const model = instances.editor.getModel();
    if (!model || model.getValue() === value) return;
    const selections = instances.editor.getSelections();
    model.setValue(value);
    if (selections) instances.editor.setSelections(selections);
  }, [instances, value, path]);

  // Validator findings -> model markers.
  useEffect(() => {
    if (!instances) return;
    const model = instances.editor.getModel();
    if (!model) return;
    instances.monaco.editor.setModelMarkers(
      model,
      TGS_EXTERNAL_MARKER_OWNER,
      externalMarkersToMonaco(instances.monaco, markers ?? [], model),
    );
  }, [instances, markers, value, path]);

  // "Click a finding -> jump to the line".
  useEffect(() => {
    if (!instances) return;
    const { editor, monaco } = instances;
    const collection =
      decorationsRef.current ?? (decorationsRef.current = editor.createDecorationsCollection());
    if (revealLine === undefined) {
      collection.clear();
      return;
    }
    const model = editor.getModel();
    if (!model) return;
    const line = Math.min(Math.max(1, Math.floor(revealLine)), model.getLineCount());
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    collection.set([
      {
        range: new monaco.Range(line, 1, line, model.getLineMaxColumn(line)),
        // `rangeHighlight` is Monaco's own class; its color comes from the
        // `editor.rangeHighlightBackground` token of the tgs-light theme.
        options: { isWholeLine: true, className: "rangeHighlight" },
      },
    ]);
  }, [instances, revealLine, path]);

  const options = useMemo<MonacoNs.editor.IStandaloneEditorConstructionOptions>(() => {
    const base: MonacoNs.editor.IStandaloneEditorConstructionOptions = {
      readOnly: readOnly === true,
      domReadOnly: readOnly === true,
      minimap: { enabled: false },
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
      fontSize: 12.5,
      lineHeight: 20,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      tabSize: 2,
      insertSpaces: true,
      renderLineHighlight: readOnly === true ? "none" : "line",
      renderWhitespace: "selection",
      overviewRulerBorder: false,
      fixedOverflowWidgets: true,
      padding: { top: 10, bottom: 10 },
      scrollbar: { alwaysConsumeMouseWheel: false },
      wordWrap: language === "markdown" ? "on" : "off",
      smoothScrolling: true,
    };
    return ariaLabel === undefined ? base : { ...base, ariaLabel };
  }, [readOnly, language, ariaLabel]);

  const handleChange = useCallback(
    (next: string | undefined) => {
      onChange?.(next ?? "");
    },
    [onChange],
  );

  const handleMount = useCallback(
    (editor: MonacoNs.editor.IStandaloneCodeEditor, monacoInstance: unknown) => {
      decorationsRef.current = null;
      setInstances({ editor, monaco: monacoInstance as MonacoApi });
    },
    [],
  );

  const fallback = (
    <FallbackPane
      value={value}
      height={height}
      ariaLabel={ariaLabel}
      // Read-only while Monaco is still loading; editable once we know it failed.
      onChange={phase === "failed" ? onChange : undefined}
    />
  );

  if (phase !== "ready" || !loaded) return fallback;

  const { Editor } = loaded;
  const editorProps: EditorProps = {
    value,
    language,
    theme: TGS_THEME_NAME,
    options,
    onMount: handleMount,
    onChange: handleChange,
    loading: fallback,
    height: "100%",
    width: "100%",
    keepCurrentModel: true,
    ...(path === undefined ? {} : { path }),
  };

  return (
    <div
      data-tgs-monaco="true"
      className="overflow-hidden rounded-md border border-border bg-code"
      style={{ height: resolveHeight(height) }}
    >
      <Editor {...editorProps} />
    </div>
  );
}

export default MonacoEditor;
