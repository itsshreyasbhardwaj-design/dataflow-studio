"use client";

import Editor, { loader } from "@monaco-editor/react";
// Import the editor core and only the two grammars this app needs, rather than
// the whole `monaco-editor` package. The full package pulls in every language
// (and their web workers), which makes a cold dev compile take minutes and adds
// megabytes to the production bundle for grammars nothing here uses.
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution";
import { useEffect, useState } from "react";
import { Spinner } from "../ui";

// Serve Monaco from the bundle rather than a CDN, so the editor works offline
// and in an air-gapped deployment.
loader.config({ monaco });

// No language services are loaded, so no workers are needed; returning a stub
// keeps Monaco from attempting to fetch worker scripts that do not exist.
if (typeof window !== "undefined") {
  (window as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
    getWorker: () => ({
      postMessage: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      terminate: () => undefined,
    }),
  };
}

const THEME_DARK = "dataflow-dark";
const THEME_LIGHT = "dataflow-light";
let themesRegistered = false;

function registerThemes(instance: typeof monaco): void {
  if (themesRegistered) return;
  themesRegistered = true;
  instance.editor.defineTheme(THEME_DARK, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "7aa2f7", fontStyle: "bold" },
      { token: "string", foreground: "9ece6a" },
      { token: "number", foreground: "ff9e64" },
      { token: "comment", foreground: "565f89", fontStyle: "italic" },
      { token: "operator", foreground: "89ddff" },
    ],
    colors: {
      "editor.background": "#141821",
      "editorGutter.background": "#141821",
      "editorLineNumber.foreground": "#3b4261",
      "editor.lineHighlightBackground": "#1b202b",
    },
  });
  instance.editor.defineTheme(THEME_LIGHT, {
    base: "vs",
    inherit: true,
    rules: [],
    colors: { "editor.background": "#ffffff" },
  });
}

export interface CodeEditorImplProps {
  value: string;
  language: "sql" | "python" | "json";
  onChange: (value: string) => void;
  height?: number;
  readOnly?: boolean;
  /** Squiggles rendered from the server's validation response. */
  markers?: Array<{ message: string; severity: "error" | "warning" }>;
  ariaLabel?: string;
}

/**
 * Monaco wrapper.
 *
 * Kept deliberately small: the editor is configured once, themed to match the
 * app, and given the SQL dialect completions that matter for the transform node.
 * Everything else about the node's configuration lives in the config panel.
 */
export function CodeEditorImpl({ value, language, onChange, height = 220, readOnly, markers, ariaLabel }: CodeEditorImplProps) {
  const [theme, setTheme] = useState(THEME_DARK);

  useEffect(() => {
    const resolve = (): void => {
      setTheme(document.documentElement.dataset["theme"] === "light" ? THEME_LIGHT : THEME_DARK);
    };
    resolve();
    const observer = new MutationObserver(resolve);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  return (
    <div
      className="overflow-hidden rounded border border-[var(--color-border-strong)]"
      aria-label={ariaLabel ?? `${language} editor`}
    >
      <Editor
        height={height}
        language={language}
        value={value}
        theme={theme}
        loading={<div className="flex h-full items-center justify-center gap-2 text-[12px] text-[var(--color-text-subtle)]"><Spinner /> Loading editor…</div>}
        onChange={(next) => onChange(next ?? "")}
        beforeMount={(instance) => registerThemes(instance)}
        onMount={(editor, instance) => {
          if (!markers?.length) return;
          const model = editor.getModel();
          if (!model) return;
          instance.editor.setModelMarkers(model, "dataflow", markers.map((marker) => ({
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: model.getLineCount(),
            endColumn: model.getLineMaxColumn(model.getLineCount()),
            message: marker.message,
            severity: marker.severity === "error" ? instance.MarkerSeverity.Error : instance.MarkerSeverity.Warning,
          })));
        }}
        options={{
          readOnly: readOnly ?? false,
          minimap: { enabled: false },
          fontSize: 12.5,
          fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
          lineNumbers: "on",
          scrollBeyondLastLine: false,
          renderLineHighlight: "line",
          tabSize: 2,
          wordWrap: "on",
          automaticLayout: true,
          padding: { top: 8, bottom: 8 },
          scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
          overviewRulerLanes: 0,
          suggest: { showWords: true },
        }}
      />
    </div>
  );
}
