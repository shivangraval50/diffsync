import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createAnchor, windowAt } from "./fingerprint.js";
import { relocate } from "./relocate.js";
import { CONTEXT_RADIUS, GAP } from "./types.js";
import type { AnchorTarget } from "./types.js";

const PATH = "src/subject.ts";

/**
 * Distinct, non-repeating line content. Uniqueness is deliberate and is what
 * makes the liveness properties meaningful: with repeated content the
 * ambiguity rule would (correctly) return `outdated`, and a property asserting
 * relocation would fail for the right reason while telling us nothing. The
 * ambiguity behaviour gets its own property below, with content chosen to be
 * ambiguous on purpose.
 */
function uniqueLines(count: number, salt: string): string[] {
  return Array.from({ length: count }, (_, i) => `line ${i} ${salt}`);
}

function targetOf(texts: readonly string[], blobSha: string): AnchorTarget {
  return { filePath: PATH, blobSha, lines: new Map(texts.map((t, i) => [i + 1, t])) };
}

describe("the central claim: same content, or outdated", () => {
  it("a located anchor's window in the target equals the window it stored", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 20 }), { minLength: 8, maxLength: 40 }),
        fc.array(fc.string({ maxLength: 20 }), { minLength: 8, maxLength: 40 }),
        fc.nat(),
        (originalLines, newLines, lineSeed) => {
          const before = targetOf(originalLines, "sha-before");
          const line = (lineSeed % originalLines.length) + 1;
          const anchor = createAnchor(before, line);
          if (anchor === null) return;

          const after = targetOf(newLines, "sha-after");
          const result = relocate(anchor, after);
          if (result.kind === "outdated") return;

          // The only permitted positive outcome: the window at the returned
          // line is element-wise identical to the one the anchor captured.
          expect(windowAt(after.lines, result.line)).toEqual([...anchor.context]);
        }
      ),
      { numRuns: 500 }
    );
  });
});

describe("liveness: the properties a stub returning `outdated` fails", () => {
  it("relocates against an unchanged-content, changed-sha target to the same line", () => {
    fc.assert(
      fc.property(fc.integer({ min: 8, max: 60 }), fc.nat(), (count, lineSeed) => {
        const texts = uniqueLines(count, "a");
        const before = targetOf(texts, "sha-before");
        const line = (lineSeed % count) + 1;
        const anchor = createAnchor(before, line);
        if (anchor === null) throw new Error("expected an anchor");

        // Same bytes, different sha: forces the scan path rather than the
        // sha-equality fast path, so this really exercises fingerprint match.
        const after = targetOf(texts, "sha-after");
        expect(relocate(anchor, after)).toEqual({ kind: "located", line });
      }),
      { numRuns: 200 }
    );
  });

  it("follows content down by exactly the number of lines inserted above it", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 8, max: 60 }),
        fc.nat(),
        fc.integer({ min: 1, max: 20 }),
        (count, lineSeed, inserted) => {
          const texts = uniqueLines(count, "b");
          const before = targetOf(texts, "sha-before");
          // Anchor away from the file edges: near them the window is padded
          // with GAP, and inserting lines above legitimately replaces that
          // padding with real text, which is a genuine content change. That
          // is a false-outdated, it is the safe direction, and it gets its own
          // explicit test below rather than being smuggled in here.
          const line = CONTEXT_RADIUS + 1 + (lineSeed % (count - 2 * CONTEXT_RADIUS));
          const anchor = createAnchor(before, line);
          if (anchor === null) throw new Error("expected an anchor");

          const prefix = uniqueLines(inserted, "prefix");
          const after = targetOf([...prefix, ...texts], "sha-after");
          expect(relocate(anchor, after)).toEqual({ kind: "located", line: line + inserted });
        }
      ),
      { numRuns: 300 }
    );
  });
});

describe("ambiguity and destruction both report outdated", () => {
  it("never picks between two identical windows", () => {
    fc.assert(
      fc.property(fc.integer({ min: 8, max: 30 }), fc.nat(), (count, lineSeed) => {
        const texts = uniqueLines(count, "c");
        const before = targetOf(texts, "sha-before");
        const line = CONTEXT_RADIUS + 1 + (lineSeed % (count - 2 * CONTEXT_RADIUS));
        const anchor = createAnchor(before, line);
        if (anchor === null) throw new Error("expected an anchor");

        // The whole body duplicated: every interior window now occurs twice.
        const after = targetOf([...texts, ...texts], "sha-after");
        expect(relocate(anchor, after)).toEqual({ kind: "outdated" });
      }),
      { numRuns: 200 }
    );
  });

  it("reports outdated when the anchored window is overwritten", () => {
    fc.assert(
      fc.property(fc.integer({ min: 8, max: 40 }), fc.nat(), (count, lineSeed) => {
        const texts = uniqueLines(count, "d");
        const before = targetOf(texts, "sha-before");
        const line = CONTEXT_RADIUS + 1 + (lineSeed % (count - 2 * CONTEXT_RADIUS));
        const anchor = createAnchor(before, line);
        if (anchor === null) throw new Error("expected an anchor");

        const rewritten = [...texts];
        for (let n = line - CONTEXT_RADIUS; n <= line + CONTEXT_RADIUS; n += 1) {
          rewritten[n - 1] = `rewritten ${n}`;
        }
        const after = targetOf(rewritten, "sha-after");
        expect(relocate(anchor, after)).toEqual({ kind: "outdated" });
      }),
      { numRuns: 200 }
    );
  });

  it("is idempotent: relocating the same anchor twice lands in the same place", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 8, max: 40 }),
        fc.nat(),
        fc.integer({ min: 1, max: 10 }),
        (count, lineSeed, inserted) => {
          const texts = uniqueLines(count, "e");
          const before = targetOf(texts, "sha-before");
          const line = CONTEXT_RADIUS + 1 + (lineSeed % (count - 2 * CONTEXT_RADIUS));
          const anchor = createAnchor(before, line);
          if (anchor === null) throw new Error("expected an anchor");

          const after = targetOf([...uniqueLines(inserted, "pre"), ...texts], "sha-after");
          const first = relocate(anchor, after);
          if (first.kind === "outdated") return;
          expect(relocate(anchor, after)).toEqual(first);
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe("the documented false-outdated at a file edge", () => {
  it("reports outdated for a line whose GAP padding became real text", () => {
    // Not a defect: the window genuinely changed. Recorded as a test so the
    // behaviour is a decision rather than a surprise, and so anyone who later
    // "fixes" it by loosening GAP comparison breaks a named test.
    const texts = uniqueLines(20, "f");
    const before = targetOf(texts, "sha-before");
    const anchor = createAnchor(before, 1);
    if (anchor === null) throw new Error("expected an anchor");

    const after = targetOf(["prepended", ...texts], "sha-after");
    expect(relocate(anchor, after)).toEqual({ kind: "outdated" });
  });
});

// ---------------------------------------------------------------------------
// Beyond the brief: generators aimed at the space Task 3's reviewer found a
// real silent mis-anchor in -- sparse, GAP-heavy windows and duplicated
// blocks -- rather than the well-contexted, non-repeating content the
// properties above deliberately use. Every property above still passes if
// `relocate` trusted a fingerprint match without confirming `sameWindow`, or
// if `MIN_DISTINCTIVE_SLOTS` were deleted outright: none of their generators
// ever produce a duplicate or a context this sparse. These do.
// ---------------------------------------------------------------------------

/** Two-real-slot window: exactly the shape of the Task 3 bug --
 *  `[GAP,GAP,GAP,foo,bar,GAP,GAP]` -- built at a file's first line, where the
 *  window is padded with GAP on the left by construction and there is
 *  nothing on the right past `foo`/`bar`. */
function sparseTwoSlotTarget(foo: string, bar: string): AnchorTarget {
  return {
    filePath: PATH,
    blobSha: "sha-before",
    lines: new Map([
      [1, foo],
      [2, bar],
    ]),
  };
}

describe("beyond the brief: the historical bug shape and its documented survivor", () => {
  it("refuses a sub-threshold sparse window even when an identical one exists elsewhere (MIN_DISTINCTIVE_SLOTS regression guard)", () => {
    // This is a generalisation of the exact case Task 3's reviewer executed:
    // an anchor whose stored context is real only at the centre and one
    // neighbour (2 of 7 slots -- below MIN_DISTINCTIVE_SLOTS = 4) relocates
    // by scanning a target where the *true* line 1/2 are gone, but the same
    // two short lines coincidentally recur far away. Bug class this catches:
    // any change that lets the scan run (or trust a match) on a context this
    // thin -- i.e. a regression of rule 5 -- reproduces the historical wrong
    // `located`. Proven to fail (see task-4-report.md) by disabling rule 5:
    // both this property and the one below immediately go red and reproduce
    // the historical `{ kind: "located" }` at the coincidental line.
    fc.assert(
      fc.property(
        fc.string().filter((s) => s !== GAP),
        fc.string().filter((s) => s !== GAP),
        fc.integer({ min: 50, max: 500 }),
        (foo, bar, relocatedLine) => {
          const before = sparseTwoSlotTarget(foo, bar);
          const anchor = createAnchor(before, 1);
          if (anchor === null) throw new Error("expected an anchor");

          // The true location (lines 1/2) is entirely absent from `after` --
          // rewritten, or simply not rendered by this diff -- and the only
          // trace of "foo"/"bar" left anywhere is a coincidence far away.
          const after: AnchorTarget = {
            filePath: PATH,
            blobSha: "sha-after",
            lines: new Map([
              [relocatedLine, foo],
              [relocatedLine + 1, bar],
            ]),
          };
          expect(relocate(anchor, after)).toEqual({ kind: "outdated" });
        }
      ),
      { numRuns: 200 }
    );
  });

  it("documents the residual risk: a fully-real duplicated block whose true occurrence is edited away still relocates to the surviving duplicate", () => {
    // This is the case rule 5 was explicitly documented NOT to close (see
    // relocate.ts's doc comment on `relocate` and on `MIN_DISTINCTIVE_SLOTS`):
    // a 7-line block -- every slot real, nothing sparse about it at all --
    // that happens to occur twice in the file. The anchor is created against
    // the first occurrence ("site A"). By the time of relocation, site A has
    // been edited into something unrecognisable (a real code change), but an
    // unrelated, coincidentally-identical block ("site B") elsewhere in the
    // file was never touched and still carries the exact window the anchor
    // stored.
    //
    // Asserting the *aspirational* invariant here -- that a thread whose
    // real code changed should never silently relocate onto unrelated code
    // -- is exactly the property fast-check falsifies; run with that
    // assertion instead of the one below, it shrinks in a handful of tries to
    // a block of seven blank lines (a wholly realistic file shape, e.g.
    // spacing between two classes) and reports `{ kind: "located" }` at the
    // surviving duplicate. See task-4-report.md for the full shrunk
    // counterexample and the run that produced it.
    //
    // `relocate` cannot be blamed for this by its own contract: content at
    // the returned line is genuinely, byte-for-byte identical to
    // `anchor.context` (the "central claim" property above holds throughout
    // this whole family of inputs), and distinguishing "the code moved here"
    // from "this is an unrelated coincidence" is explicitly out of scope for
    // a fixed-radius text window (see relocate.ts's doc comment). This test
    // asserts the actual, accepted behaviour -- not the aspirational one --
    // so the residual risk is a decision on record rather than a surprise,
    // exactly like the file-edge false-outdated test above.
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 12 }), { minLength: 7, maxLength: 7 }),
        fc.integer({ min: 8, max: 500 }),
        (block, siteBStart) => {
          const beforeMap = new Map<number, string>();
          block.forEach((t, i) => beforeMap.set(i + 1, t));
          block.forEach((t, i) => beforeMap.set(siteBStart + i, t));
          const before: AnchorTarget = { filePath: PATH, blobSha: "sha-before", lines: beforeMap };
          const anchor = createAnchor(before, 4); // centre of the 7-line block at site A
          if (anchor === null) throw new Error("expected an anchor");

          const afterMap = new Map<number, string>();
          // Site A: genuinely edited -- every line changed, so its window can
          // no longer match the anchor's stored context.
          block.map((t) => `${t}_edited`).forEach((t, i) => afterMap.set(i + 1, t));
          // Site B: the coincidental duplicate, never touched.
          block.forEach((t, i) => afterMap.set(siteBStart + i, t));
          const after: AnchorTarget = { filePath: PATH, blobSha: "sha-after", lines: afterMap };

          expect(relocate(anchor, after)).toEqual({ kind: "located", line: siteBStart + 3 });
        }
      ),
      { numRuns: 100 }
    );
  });
});
