"use client";

import type { ReactNode } from "react";
import { toSplitRows, type FileDiff } from "@diffsync/diff";

export type DiffViewMode = "unified" | "split";

export interface DiffFileViewProps {
  file: FileDiff;
  view: DiffViewMode;
  selectedLine: number | null;
  cursorsByLine: ReadonlyMap<number, readonly string[]>;
  /** Rendered directly beneath the row for that new-side line. */
  renderBelow: (line: number) => ReactNode;
  onLineSelect: (line: number) => void;
}

function Cursors({
  path,
  line,
  cursorsByLine,
}: {
  path: string;
  line: number;
  cursorsByLine: ReadonlyMap<number, readonly string[]>;
}): React.JSX.Element | null {
  const names = cursorsByLine.get(line);
  if (names === undefined || names.length === 0) return null;
  return (
    <span data-testid={`cursors-${path}-${line}`} aria-label="reviewers here">
      {names.join(", ")}
    </span>
  );
}

/**
 * The row for one new-side line -- the only kind of row that can ever carry
 * an anchor control, in either view. It is rendered from exactly this one
 * place for both unified and split, so the `line-*` / `anchor-*` testids for
 * a given new-side line are identical no matter which layout is showing.
 * That is what keeps a thread anchored to the same code across a view
 * toggle: the row *is* the new-side line, not a position on screen.
 */
function NewSideRow({
  path,
  line,
  text,
  selected,
  cursorsByLine,
  onLineSelect,
}: {
  path: string;
  line: number;
  text: string;
  selected: boolean;
  cursorsByLine: ReadonlyMap<number, readonly string[]>;
  onLineSelect: (line: number) => void;
}): React.JSX.Element {
  return (
    <div data-testid={`line-${path}-${line}`} data-selected={selected ? "true" : "false"}>
      <button
        type="button"
        data-testid={`anchor-${path}-${line}`}
        aria-label={`Comment on line ${line} of ${path}`}
        onClick={() => onLineSelect(line)}
      >
        +
      </button>
      <span data-testid="new-line-number">{line}</span>
      <code>{text}</code>
      <Cursors path={path} line={line} cursorsByLine={cursorsByLine} />
    </div>
  );
}

function OldSideCell({ line, text }: { line: number; text: string }): React.JSX.Element {
  return (
    <>
      <span data-testid="old-line-number">{line}</span>
      <code>{text}</code>
    </>
  );
}

/**
 * A removed line has no position in the new file: no `line-*` testid, no
 * anchor button, nothing that could be clicked. Numbering it on the new side
 * or giving it any control at all would let a reviewer anchor a comment to
 * code that is gone.
 */
function RemovedRow({
  path,
  oldLine,
  text,
}: {
  path: string;
  oldLine: number;
  text: string;
}): React.JSX.Element {
  return (
    <div data-testid={`removed-${path}-${oldLine}`}>
      <OldSideCell line={oldLine} text={text} />
    </div>
  );
}

function explainOmission(reason: "too_large" | "binary"): string {
  return reason === "binary"
    ? "This file is binary, so there is no diff to show."
    : "This file is too large for GitHub to return a diff.";
}

/**
 * The diff for one file, in either view. Every anchorable row goes through
 * `NewSideRow`; nothing else in this component renders an anchor button, a
 * `line-*` testid, or a click handler -- which is what keeps a comment from
 * ever attaching to a removed line, a layout-only split-view spacer, an
 * omitted file, or a line number the diff's hunks never covered.
 */
export function DiffFileView(props: DiffFileViewProps): React.JSX.Element {
  const { file, view, selectedLine, cursorsByLine, renderBelow, onLineSelect } = props;

  if (file.kind === "omitted") {
    return (
      <section aria-label={file.path}>
        <h3>{file.path}</h3>
        <p data-testid={`omitted-${file.path}`}>{explainOmission(file.reason)}</p>
      </section>
    );
  }

  if (file.hunks.length === 0) {
    // A patch with no hunks -- in practice a pure rename with no content
    // change -- exposes no new-side lines at all (toAnchorTarget returns an
    // empty map for it). Saying so explicitly keeps a bare heading from
    // reading as "the diff failed to load".
    return (
      <section aria-label={file.path}>
        <h3>{file.path}</h3>
        <p data-testid={`no-changes-${file.path}`}>
          {file.status === "renamed" && file.previousPath !== null
            ? `Renamed from ${file.previousPath}. No content changed.`
            : "No changes to show."}
        </p>
      </section>
    );
  }

  // A running index over split rows across every hunk in this file, not
  // reset per hunk. A per-hunk index would make hunk 2's row 0 collide with
  // hunk 1's row 0 the moment a file has more than one hunk, aliasing one
  // hunk's rows onto another's under query.
  let splitRowIndex = 0;

  return (
    <section aria-label={file.path}>
      <h3>{file.path}</h3>
      {file.hunks.map((hunk, hunkIndex) => (
        <div key={`hunk-${hunk.newStart}-${hunkIndex}`} data-testid={`hunk-${file.path}-${hunkIndex}`}>
          <p>{`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@ ${hunk.heading}`}</p>

          {view === "unified"
            ? hunk.lines.map((line) =>
                line.kind === "removed" ? (
                  <RemovedRow
                    key={`removed-${line.oldLine}`}
                    path={file.path}
                    oldLine={line.oldLine}
                    text={line.text}
                  />
                ) : (
                  <div key={`new-${line.newLine}`}>
                    <NewSideRow
                      path={file.path}
                      line={line.newLine}
                      text={line.text}
                      selected={selectedLine === line.newLine}
                      cursorsByLine={cursorsByLine}
                      onLineSelect={onLineSelect}
                    />
                    {renderBelow(line.newLine)}
                  </div>
                )
              )
            : toSplitRows(hunk).map((row) => {
                const rowKey = splitRowIndex;
                splitRowIndex += 1;
                return (
                  <div key={`split-${rowKey}`} data-testid={`split-row-${file.path}-${rowKey}`}>
                    <span data-testid="split-left">
                      {row.left === null ? null : <OldSideCell line={row.left.line} text={row.left.text} />}
                    </span>
                    {row.right === null ? (
                      // A removal with nothing to its right: a layout-only
                      // spacer. No NewSideRow, no anchor, no line-* testid --
                      // there is no new-side line here to comment on.
                      <span data-testid="split-right" />
                    ) : (
                      <>
                        <span data-testid="split-right">
                          <NewSideRow
                            path={file.path}
                            line={row.right.line}
                            text={row.right.text}
                            selected={selectedLine === row.right.line}
                            cursorsByLine={cursorsByLine}
                            onLineSelect={onLineSelect}
                          />
                        </span>
                        {renderBelow(row.right.line)}
                      </>
                    )}
                  </div>
                );
              })}
        </div>
      ))}
    </section>
  );
}
