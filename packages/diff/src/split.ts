import type { DiffHunk, DiffLine } from "./types";

export interface SplitCell {
  text: string;
  line: number;
}

/** One row of the side-by-side view. Either side may be empty. */
export interface SplitRow {
  left: SplitCell | null;
  right: SplitCell | null;
}

/**
 * Pair each run of removals with the run of additions that immediately
 * follows it. Runs are bounded by context lines: a removal, some unchanged
 * code, and then an addition are three separate edits, and pairing across the
 * gap would show unrelated code side by side as though it were a rewrite.
 */
export function toSplitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  let index = 0;

  while (index < hunk.lines.length) {
    const line = hunk.lines[index];
    if (line === undefined) break;

    if (line.kind === "context") {
      rows.push({
        left: { text: line.text, line: line.oldLine },
        right: { text: line.text, line: line.newLine },
      });
      index += 1;
      continue;
    }

    const removed: Extract<DiffLine, { kind: "removed" }>[] = [];
    while (hunk.lines[index]?.kind === "removed") {
      removed.push(hunk.lines[index] as Extract<DiffLine, { kind: "removed" }>);
      index += 1;
    }
    const added: Extract<DiffLine, { kind: "added" }>[] = [];
    while (hunk.lines[index]?.kind === "added") {
      added.push(hunk.lines[index] as Extract<DiffLine, { kind: "added" }>);
      index += 1;
    }

    for (let i = 0; i < Math.max(removed.length, added.length); i += 1) {
      const l = removed[i];
      const r = added[i];
      rows.push({
        left: l === undefined ? null : { text: l.text, line: l.oldLine },
        right: r === undefined ? null : { text: r.text, line: r.newLine },
      });
    }
  }

  return rows;
}
