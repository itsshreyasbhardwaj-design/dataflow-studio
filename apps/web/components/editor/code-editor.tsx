"use client";

import dynamic from "next/dynamic";
import type { CodeEditorImplProps } from "./code-editor-impl";
import { Spinner } from "../ui";

export type CodeEditorProps = CodeEditorImplProps;

/**
 * Monaco, loaded only in the browser.
 *
 * The editor touches `window` and `document` while its modules evaluate, so it
 * cannot be part of the server render of this client component. Loading it
 * through `next/dynamic` with `ssr: false` also keeps it out of the initial
 * payload for every page that does not open the pipeline editor.
 */
export const CodeEditor = dynamic<CodeEditorProps>(
  () => import("./code-editor-impl").then((module) => module.CodeEditorImpl),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[200px] items-center justify-center gap-2 rounded border border-[var(--color-border-strong)] bg-[var(--color-canvas)] text-[12px] text-[var(--color-text-subtle)]">
        <Spinner /> Loading editor…
      </div>
    ),
  },
);
