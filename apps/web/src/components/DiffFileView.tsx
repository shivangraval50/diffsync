"use client";

import type { ReactNode } from "react";
import { toSplitRows, type DiffHunk, type FileDiff } from "@diffsync/diff";

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
    <span data-testid={`cursors-${path}-${line}`} aria-label="reviewers here" className="cursors">
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
 *
 * `kind` is presentation only. It picks the row's tint, its left rule and
 * the glyph in front of the code -- three independent channels, so an added
 * line still reads as added in greyscale (Accessibility, Vision: "convey
 * information with more than color alone"). It never gates the anchor
 * control: an unchanged context line is exactly as commentable as an added
 * one, and widening or narrowing what can be anchored is not a layout
 * decision.
 */
function NewSideRow({
  path,
  line,
  text,
  kind,
  selected,
  cursorsByLine,
  onLineSelect,
}: {
  path: string;
  line: number;
  text: string;
  kind: "added" | "context";
  selected: boolean;
  cursorsByLine: ReadonlyMap<number, readonly string[]>;
  onLineSelect: (line: number) => void;
}): React.JSX.Element {
  return (
    <div
      data-testid={`line-${path}-${line}`}
      data-selected={selected ? "true" : "false"}
      data-kind={kind}
      className="row"
    >
      <button
        type="button"
        data-testid={`anchor-${path}-${line}`}
        aria-label={`Comment on line ${line} of ${path}`}
        className="anchor"
        onClick={() => onLineSelect(line)}
      >
        +
      </button>
      <span data-testid="new-line-number" className="ln">
        {line}
      </span>
      <code className="src">{text}</code>
      <Cursors path={path} line={line} cursorsByLine={cursorsByLine} />
    </div>
  );
}

function OldSideCell({ line, text }: { line: number; text: string }): React.JSX.Element {
  return (
    <>
      <span data-testid="old-line-number" className="ln">
        {line}
      </span>
      <code className="src">{text}</code>
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
    <div data-testid={`removed-${path}-${oldLine}`} data-kind="removed" className="removed-row">
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
 * Which line numbers a hunk actually changed, on each side.
 *
 * `SplitRow` carries only text and a line number, so the split view cannot
 * tell an addition from an unchanged line by looking at a cell alone, and
 * comparing the two sides' text would misread a removed `}` paired with an
 * added `}` as unchanged. Reading the kinds straight off the hunk is exact,
 * and keeps the knowledge here rather than widening `SplitRow` -- which is
 * shared with `toAnchorTarget` and has no business growing a presentation
 * field.
 */
function changedLines(hunk: DiffHunk): { added: Set<number>; removed: Set<number> } {
  const added = new Set<number>();
  const removed = new Set<number>();
  for (const line of hunk.lines) {
    if (line.kind === "added") added.add(line.newLine);
    else if (line.kind === "removed") removed.add(line.oldLine);
  }
  return { added, removed };
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
      <section aria-label={file.path} className="file">
        <h3 className="file__path">{file.path}</h3>
        <p data-testid={`omitted-${file.path}`} className="file__note">
          {explainOmission(file.reason)}
        </p>
      </section>
    );
  }

  if (file.hunks.length === 0) {
    // A patch with no hunks -- in practice a pure rename with no content
    // change -- exposes no new-side lines at all (toAnchorTarget returns an
    // empty map for it). Saying so explicitly keeps a bare heading from
    // reading as "the diff failed to load".
    return (
      <section aria-label={file.path} className="file">
        <h3 className="file__path">{file.path}</h3>
        <p data-testid={`no-changes-${file.path}`} className="file__note">
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
    <section aria-label={file.path} className="file">
      <h3 className="file__path">{file.path}</h3>
      {file.hunks.map((hunk, hunkIndex) => {
        const changed = changedLines(hunk);
        return (
          <div
            key={`hunk-${hunk.newStart}-${hunkIndex}`}
            data-testid={`hunk-${file.path}-${hunkIndex}`}
            className="hunk"
          >
            <p className="hunk__header">{`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@ ${hunk.heading}`}</p>

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
                    // The wrapper that makes "this comment is on this line"
                    // structurally true: the row and whatever `renderBelow`
                    // returns are bare siblings inside it, and nothing else
                    // is. `force-push.spec.ts` reads exactly this
                    // relationship with `locator("..")`, so nothing may be
                    // inserted between them.
                    <div key={`new-${line.newLine}`} className="row-wrap">
                      <NewSideRow
                        path={file.path}
                        line={line.newLine}
                        text={line.text}
                        kind={line.kind}
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
                    <div
                      key={`split-${rowKey}`}
                      data-testid={`split-row-${file.path}-${rowKey}`}
                      className="split-row"
                    >
                      <span
                        data-testid="split-left"
                        className="split-cell split-cell--left"
                        data-kind={
                          row.left !== null && changed.removed.has(row.left.line)
                            ? "removed"
                            : "context"
                        }
                      >
                        {row.left === null ? null : (
                          <OldSideCell line={row.left.line} text={row.left.text} />
                        )}
                      </span>
                      {row.right === null ? (
                        // A removal with nothing to its right: a layout-only
                        // spacer. No NewSideRow, no anchor, no line-* testid --
                        // there is no new-side line here to comment on.
                        <span data-testid="split-right" className="split-cell split-cell--right" />
                      ) : (
                        <>
                          <span data-testid="split-right" className="split-cell split-cell--right">
                            <NewSideRow
                              path={file.path}
                              line={row.right.line}
                              text={row.right.text}
                              kind={changed.added.has(row.right.line) ? "added" : "context"}
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
        );
      })}
    </section>
  );
}
