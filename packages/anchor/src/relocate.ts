import { fingerprint, windowAt } from "./fingerprint.js";
import { GAP } from "./types.js";
import type { Anchor, AnchorTarget, Relocation } from "./types.js";

function sameWindow(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Minimum number of real (non-`GAP`) slots an anchor's stored `context` must
 * carry before the scan path (rules 3/4) is allowed to trust a window match
 * at all. A window is 2 * CONTEXT_RADIUS + 1 = 7 slots; the centre slot is
 * always real (an anchor can only be created for a line the target exposes),
 * so requiring 4 of 7 means at least 3 of the 6 *context* slots -- on either
 * side, in any combination -- must be real text, i.e. at least 3 lines of
 * genuine surrounding context, not just the anchored line plus one neighbour.
 *
 * This exists because a window with only the centre and one neighbour real --
 * e.g. `[GAP,GAP,GAP,"}",GAP,GAP,GAP]` or `[GAP,GAP,GAP,"foo","bar",GAP,GAP]`
 * -- is not distinctive: short, common lines produce that exact shape at
 * every isolated occurrence of the same one or two tokens, anywhere in the
 * file. If the anchor's true location stops being exposed (edited elsewhere,
 * or simply not rendered by this diff) while an unrelated, coincidentally
 * identical occurrence elsewhere still is, rules 3/4 cannot tell them apart --
 * verified by constructing exactly that case (see "insufficient context"
 * below). Rule 4 only saves you when *both* occurrences are visible in the
 * same scan; this precondition instead refuses to scan at all when the
 * anchor never had enough evidence to relocate safely, independent of what
 * the target exposes.
 *
 * Splitting `GAP` into an "past EOF" sentinel and an "unexposed" sentinel
 * does not fix this: two *mid-file* locations, each merely unexposed on
 * every side, still produce identical windows regardless of why the
 * neighbours are missing (see the mid-file test below). Insufficient
 * evidence, not the sentinel's meaning, is the actual defect, so the fix is
 * a precondition on the anchor's own context, not a new sentinel kind.
 *
 * The cost is real: an anchor near the start or end of a short file, or one
 * made from a diff hunk that renders very little context around a line,
 * will report `outdated` on relocation attempts a human could plausibly
 * have resolved correctly. That is intentional and matches the spec's own
 * ordering of failures -- losing the thread's position and saying so is
 * strictly cheaper than a silent mis-anchor -- but it is a real cost, not a
 * free one, and it will show up as "outdated more often than expected" for
 * short files and file edges.
 */
export const MIN_DISTINCTIVE_SLOTS = 4;

function realSlotCount(context: readonly string[]): number {
  let count = 0;
  for (const slot of context) {
    if (slot !== GAP) count += 1;
  }
  return count;
}

/**
 * Find where `anchor` points inside `target`, or report that it no longer
 * points anywhere findable.
 *
 * There is no third outcome and no best-effort branch. A thread that quietly
 * re-points at different code makes reviewers argue about code nobody wrote;
 * losing the position and saying so is strictly better.
 *
 * Residual risk, by design: this is content-based, not identity-based,
 * relocation. If the *original* occurrence of an anchor's context stops
 * being exposed -- the file changed elsewhere, or this rendering simply
 * doesn't show it -- and a *different* place in the file happens to carry a
 * window equal to the stored one, this function cannot distinguish the two
 * and will locate to the coincidental match. Rule 4 catches this only when
 * both occurrences are visible in the same scan. `MIN_DISTINCTIVE_SLOTS`
 * (below) shrinks how often a coincidental match can pass rule 3 at all, by
 * refusing to trust windows that are mostly unknown -- but it does not
 * eliminate the risk: a long enough duplicated block, fully exposed on both
 * occurrences, still relocates to whichever one is visible, because that is
 * the operational definition of "same code" this function uses. Closing
 * this fully would require anchoring on something beyond a fixed-radius
 * text window, which is out of scope here.
 */
export function relocate(anchor: Anchor, target: AnchorTarget): Relocation {
  // 1. Renames are out of scope. Following one would be a guess.
  if (anchor.filePath !== target.filePath) return { kind: "outdated" };

  // 2. A blob sha is content-addressed: an equal sha means equal bytes, which
  //    is stronger evidence than any fingerprint. Confirming the window here
  //    would be wrong rather than merely redundant -- re-rendering the same
  //    file with more context legitimately changes the window at a line near a
  //    hunk edge (GAP slots become real text), and the check would then report
  //    outdated for a file that did not change at all. This fast path does
  //    not go through the distinctiveness precondition below: content-address
  //    equality is strictly stronger evidence than any window, distinctive or
  //    not, so the threshold does not apply to it.
  //    The line must still be exposed by this rendering: a thread needs a row
  //    to attach to, and there is none for a line the view does not show.
  if (anchor.blobSha === target.blobSha && target.lines.has(anchor.line)) {
    return { kind: "located", line: anchor.line };
  }

  // 5. Precondition on the anchor itself, checked before scanning: a window
  //    this sparse is not distinctive enough to relocate on safely, no
  //    matter what the target contains. See MIN_DISTINCTIVE_SLOTS.
  if (realSlotCount(anchor.context) < MIN_DISTINCTIVE_SLOTS) {
    return { kind: "outdated" };
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
