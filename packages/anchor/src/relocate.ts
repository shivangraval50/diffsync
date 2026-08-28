import { fingerprint, windowAt } from "./fingerprint.js";
import type { Anchor, AnchorTarget, Relocation } from "./types.js";

function sameWindow(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Find where `anchor` points inside `target`, or report that it no longer
 * points anywhere findable.
 *
 * There is no third outcome and no best-effort branch. A thread that quietly
 * re-points at different code makes reviewers argue about code nobody wrote;
 * losing the position and saying so is strictly better.
 */
export function relocate(anchor: Anchor, target: AnchorTarget): Relocation {
  // 1. Renames are out of scope. Following one would be a guess.
  if (anchor.filePath !== target.filePath) return { kind: "outdated" };

  // 2. A blob sha is content-addressed: an equal sha means equal bytes, which
  //    is stronger evidence than any fingerprint. Confirming the window here
  //    would be wrong rather than merely redundant -- re-rendering the same
  //    file with more context legitimately changes the window at a line near a
  //    hunk edge (GAP slots become real text), and the check would then report
  //    outdated for a file that did not change at all.
  //    The line must still be exposed by this rendering: a thread needs a row
  //    to attach to, and there is none for a line the view does not show.
  if (anchor.blobSha === target.blobSha && target.lines.has(anchor.line)) {
    return { kind: "located", line: anchor.line };
  }

  // 3./4. Scan. The fingerprint is the index; `anchor.context` is the proof.
  let found: number | null = null;
  for (const line of target.lines.keys()) {
    const candidate = windowAt(target.lines, line);
    if (fingerprint(candidate) !== anchor.fingerprint) continue;
    if (!sameWindow(candidate, anchor.context)) continue;
    // A second equally good candidate means the anchor is ambiguous. Two
    // answers is the same as no answer: report outdated rather than pick.
    if (found !== null) return { kind: "outdated" };
    found = line;
  }

  return found === null ? { kind: "outdated" } : { kind: "located", line: found };
}
