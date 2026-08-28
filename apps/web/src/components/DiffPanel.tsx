"use client";

import { useState, type ReactNode } from "react";
import type { FileDiff } from "@diffsync/diff";
import { DiffFileView, type DiffViewMode } from "./DiffFileView";

export interface DiffPanelProps {
  files: FileDiff[];
  /**
   * The one (path, line) pair currently selected across the whole panel, or
   * null. A bare `number` here -- the shape this prop started as -- cannot
   * name which file it belongs to, so every file that happened to expose the
   * same new-side line number would show it as selected too: two different
   * files sharing line 1 is common, not an edge case. Scoping happens in
   * this component (below), not in `DiffFileView`, which only ever sees the
   * line number that applies to the one file it renders.
   */
  selected: { path: string; line: number } | null;
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
    <div className="diff-panel">
      {/* A segmented control rather than two loose buttons -- Layout, Best
          practices: "group them in logical sections". The selected state is
          drawn straight from `aria-pressed`, so the highlight and the
          accessibility tree cannot drift apart. */}
      <div className="diff-toolbar">
        <div role="group" aria-label="Diff view" className="segmented">
          <button type="button" aria-pressed={view === "unified"} onClick={() => setView("unified")}>
            Unified
          </button>
          <button type="button" aria-pressed={view === "split"} onClick={() => setView("split")}>
            Split
          </button>
        </div>
      </div>

      {props.files.map((file) => (
        <DiffFileView
          key={file.path}
          file={file}
          view={view}
          selectedLine={props.selected !== null && props.selected.path === file.path ? props.selected.line : null}
          cursorsByLine={props.cursorsByLine.get(file.path) ?? EMPTY_CURSORS}
          renderBelow={(line) => props.renderBelow(file.path, line)}
          onLineSelect={(line) => props.onLineSelect(file.path, line)}
        />
      ))}
    </div>
  );
}
