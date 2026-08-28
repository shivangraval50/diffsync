"use client";

import { useState, type ReactNode } from "react";
import type { FileDiff } from "@diffsync/diff";
import { DiffFileView, type DiffViewMode } from "./DiffFileView";

export interface DiffPanelProps {
  files: FileDiff[];
  selectedLine: number | null;
  cursorsByLine: ReadonlyMap<string, ReadonlyMap<number, readonly string[]>>;
  renderBelow: (path: string, line: number) => ReactNode;
  onLineSelect: (path: string, line: number) => void;
}

const EMPTY_CURSORS: ReadonlyMap<number, readonly string[]> = new Map();

/**
 * Owns the unified/split toggle for every file in the pull request at once.
 * One `view` for the whole panel, not one per file: the spec's motivating
 * scenario is a reviewer switching layout mid-review, and a toggle that only
 * flipped the file they happened to be looking at would leave every other
 * file's threads rendered against a layout nobody is seeing.
 */
export function DiffPanel(props: DiffPanelProps): React.JSX.Element {
  const [view, setView] = useState<DiffViewMode>("unified");

  return (
    <div>
      <div role="group" aria-label="Diff view">
        <button type="button" aria-pressed={view === "unified"} onClick={() => setView("unified")}>
          Unified
        </button>
        <button type="button" aria-pressed={view === "split"} onClick={() => setView("split")}>
          Split
        </button>
      </div>

      {props.files.map((file) => (
        <DiffFileView
          key={file.path}
          file={file}
          view={view}
          selectedLine={props.selectedLine}
          cursorsByLine={props.cursorsByLine.get(file.path) ?? EMPTY_CURSORS}
          renderBelow={(line) => props.renderBelow(file.path, line)}
          onLineSelect={(line) => props.onLineSelect(file.path, line)}
        />
      ))}
    </div>
  );
}
