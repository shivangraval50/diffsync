import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createAnchor, windowAt } from "./fingerprint";
import { relocate } from "./relocate";
import { CONTEXT_RADIUS, GAP } from "./types";
import type { AnchorTarget } from "./types";

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

  it("Fix round 1: a duplicated block of blank lines whose true occurrence is edited away now correctly reports outdated", () => {
    // This property used to document the opposite (unsafe) behaviour: it
    // asserted `{ kind: "located" }` at the surviving duplicate, because
    // MIN_DISTINCTIVE_SLOTS counted a slot as sufficient evidence whenever it
    // was merely non-GAP -- and a blank line is non-GAP. fast-check shrank
    // that version to seven blank lines (see the pinned regression test
    // below for the exact case) and reported a real, reviewer-confirmed
    // silent mis-anchor: a context of nothing but blank lines, duplicated
    // once in the file, relocated to the wrong copy once the original was
    // edited.
    //
    // The fix (relocate.ts, `isDistinctiveSlot`) now requires a slot to be
    // non-GAP *and* non-blank after normalization to count toward
    // MIN_DISTINCTIVE_SLOTS. A block that is entirely blank has zero
    // distinctive slots, so rule 5 refuses to scan at all -- the aspirational
    // assertion below now holds for the whole blank-line family, not just
    // the one shrunk case. Bug class this guards: a regression back to
    // "non-GAP is enough" (proven below by reverting `isDistinctiveSlot` to
    // `slot !== GAP`, which reproduces the historical failure).
    fc.assert(
      fc.property(
        fc.array(
          fc
            .array(fc.constantFrom(" ", "\t"), { maxLength: 6 })
            .map((chars) => chars.join("")),
          { minLength: 7, maxLength: 7 }
        ),
        fc.integer({ min: 8, max: 500 }),
        (block, siteBStart) => {
          const beforeMap = new Map<number, string>();
          block.forEach((t, i) => beforeMap.set(i + 1, t));
          block.forEach((t, i) => beforeMap.set(siteBStart + i, t));
          const before: AnchorTarget = { filePath: PATH, blobSha: "sha-before", lines: beforeMap };
          const anchor = createAnchor(before, 4); // centre of the 7-line block at site A
          if (anchor === null) throw new Error("expected an anchor");

          const afterMap = new Map<number, string>();
          // Site A: rewritten to genuinely distinctive text -- if it were
          // rewritten to more blank lines this would test nothing new.
          block.forEach((_, i) => afterMap.set(i + 1, `rewritten ${i}`));
          // Site B: the coincidental all-blank duplicate, never touched.
          block.forEach((t, i) => afterMap.set(siteBStart + i, t));
          const after: AnchorTarget = { filePath: PATH, blobSha: "sha-after", lines: afterMap };

          expect(relocate(anchor, after)).toEqual({ kind: "outdated" });
        }
      ),
      { numRuns: 200 }
    );
  });

  it("pins the exact shrunk counterexample fast-check found before the fix (7 blank lines, duplicate at siteBStart=8)", () => {
    // Before Fix round 1, this exact input reproduced a verified silent
    // mis-anchor: relocate(anchor, after) => { kind: "located", line: 11 }.
    // The anchor's window was seven blank lines (all normalize to ""), which
    // scored 7-of-7 under the old "non-GAP" counting rule -- comfortably
    // past MIN_DISTINCTIVE_SLOTS -- while carrying no real information.
    // Pinned literally, with no generator, so this specific regression can
    // never silently return.
    const block = [" ", " ", " ", " ", " ", " ", " "];
    const siteBStart = 8;

    const beforeMap = new Map<number, string>();
    block.forEach((t, i) => beforeMap.set(i + 1, t));
    block.forEach((t, i) => beforeMap.set(siteBStart + i, t));
    const before: AnchorTarget = { filePath: PATH, blobSha: "sha-before", lines: beforeMap };
    const anchor = createAnchor(before, 4);
    if (anchor === null) throw new Error("expected an anchor");

    const afterMap = new Map<number, string>();
    block.forEach((_, i) => afterMap.set(i + 1, `rewritten ${i}`));
    block.forEach((t, i) => afterMap.set(siteBStart + i, t));
    const after: AnchorTarget = { filePath: PATH, blobSha: "sha-after", lines: afterMap };

    expect(relocate(anchor, after)).toEqual({ kind: "outdated" });
  });

  it("still relocates when exactly MIN_DISTINCTIVE_SLOTS slots are genuinely distinctive (the fix must not make relocation useless)", () => {
    // Coordinator's explicit concern after Fix round 1: does requiring
    // "distinctive", not just "present", push ordinary well-contexted code
    // into outdated too? Generalizes relocate.test.ts's fixed boundary
    // example (V1.slice(3,7)) across arbitrary non-blank content: the centre
    // plus exactly 3 of 6 context slots real and distinctive, the rest
    // GAP (unexposed, not blank -- this is a file-start hunk, not a blank-
    // line region). distinctiveSlotCount is then exactly 4, the threshold
    // itself, and the match is unambiguous, so relocation must still
    // succeed.
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ minLength: 1, maxLength: 10 }).filter((s) => s.trim() !== "" && s !== GAP),
          { minLength: 4, maxLength: 4 }
        ),
        (lines) => {
          // Lines exposed at 1..4 only: window at line 4 (the last exposed
          // line, so it is the anchor and also the window's centre) is
          // [lines[0],lines[1],lines[2],lines[3],GAP,GAP,GAP] -- 4 distinctive
          // slots exactly (the minimum), nothing blank, nothing coincidental.
          const before = targetOf(lines, "sha-before");
          const anchor = createAnchor(before, 4);
          if (anchor === null) throw new Error("expected an anchor");

          // Shifted down by 2, content otherwise untouched and unique.
          const after = targetOf(["pad-1", "pad-2", ...lines], "sha-after");
          expect(relocate(anchor, after)).toEqual({ kind: "located", line: 6 });
        }
      ),
      { numRuns: 150 }
    );
  });

  it("documents the still-standing residual risk: a duplicated block of genuinely distinctive (non-blank) content is unaffected by the fix", () => {
    // Fix round 1 closed the blank-line family; it was never meant to close
    // -- and does not close -- the case relocate.ts's own doc comment already
    // named: a long enough duplicated block of real, distinctive content,
    // fully exposed on both occurrences, still relocates to whichever one is
    // visible once the true occurrence is edited away. Every slot here is
    // guaranteed non-blank (each string is prefixed with a literal "x", so
    // `.trim()` can never collapse it), so distinctiveSlotCount is always 7
    // -- this is not a threshold question at all, it is the fundamental
    // limit of content-based (not identity-based) relocation that
    // `MIN_DISTINCTIVE_SLOTS` was never able to address. Re-running this
    // family's aspirational assertion (`outdated`) after the fix still finds
    // a counterexample on the first try -- see task-4-report.md, "Fix round
    // 1" section, for the shrunk case. Asserting the actual behaviour here,
    // as with the file-edge false-outdated test above, so this remaining gap
    // stays a decision on record.
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 12 }).map((s) => `x${s}`), {
          minLength: 7,
          maxLength: 7,
        }),
        fc.integer({ min: 8, max: 500 }),
        (block, siteBStart) => {
          const beforeMap = new Map<number, string>();
          block.forEach((t, i) => beforeMap.set(i + 1, t));
          block.forEach((t, i) => beforeMap.set(siteBStart + i, t));
          const before: AnchorTarget = { filePath: PATH, blobSha: "sha-before", lines: beforeMap };
          const anchor = createAnchor(before, 4);
          if (anchor === null) throw new Error("expected an anchor");

          const afterMap = new Map<number, string>();
          block.map((t) => `${t}_edited`).forEach((t, i) => afterMap.set(i + 1, t));
          block.forEach((t, i) => afterMap.set(siteBStart + i, t));
          const after: AnchorTarget = { filePath: PATH, blobSha: "sha-after", lines: afterMap };

          expect(relocate(anchor, after)).toEqual({ kind: "located", line: siteBStart + 3 });
        }
      ),
      { numRuns: 100 }
    );
  });

  it("documents that the residual risk extends to three-or-more coincidental occurrences, not just two", () => {
    // Cheap to reach from the two-site property above: a third,
    // untouched duplicate of the same distinctive block elsewhere in the
    // file. Rule 4 (ambiguity) only fires when two or more matching
    // candidates are visible in the *same* scan; with the true occurrence
    // (site A) edited away, sites B and C are the only two left standing --
    // both real, both visible together -- so rule 4 correctly refuses to
    // pick between them and reports outdated. This is not a new failure
    // mode: it is rule 4 doing exactly its documented job. Recorded so the
    // 3+-occurrence shape is exercised at all, since every other property in
    // this file caps out at two sites.
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 12 }).map((s) => `x${s}`), {
          minLength: 7,
          maxLength: 7,
        }),
        fc.integer({ min: 8, max: 200 }),
        fc.integer({ min: 8, max: 200 }),
        (block, gapB, gapC) => {
          const siteBStart = 8 + gapB;
          const siteCStart = siteBStart + 7 + gapC;

          const beforeMap = new Map<number, string>();
          block.forEach((t, i) => beforeMap.set(i + 1, t));
          block.forEach((t, i) => beforeMap.set(siteBStart + i, t));
          block.forEach((t, i) => beforeMap.set(siteCStart + i, t));
          const before: AnchorTarget = { filePath: PATH, blobSha: "sha-before", lines: beforeMap };
          const anchor = createAnchor(before, 4);
          if (anchor === null) throw new Error("expected an anchor");

          const afterMap = new Map<number, string>();
          block.map((t) => `${t}_edited`).forEach((t, i) => afterMap.set(i + 1, t));
          block.forEach((t, i) => afterMap.set(siteBStart + i, t));
          block.forEach((t, i) => afterMap.set(siteCStart + i, t));
          const after: AnchorTarget = { filePath: PATH, blobSha: "sha-after", lines: afterMap };

          // Two surviving coincidental matches: ambiguous, so outdated --
          // unlike the single-surviving-duplicate case above, this one
          // *is* the safe answer, produced by rule 4, not a gap in it.
          expect(relocate(anchor, after)).toEqual({ kind: "outdated" });
        }
      ),
      { numRuns: 100 }
    );
  });
});
