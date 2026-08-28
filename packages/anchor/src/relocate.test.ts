import { describe, it, expect } from "vitest";
import { createAnchor } from "./fingerprint.js";
import { relocate } from "./relocate.js";
import type { Anchor, AnchorTarget } from "./types.js";

function target(
  filePath: string,
  blobSha: string,
  start: number,
  texts: readonly string[]
): AnchorTarget {
  return { filePath, blobSha, lines: new Map(texts.map((t, i) => [start + i, t])) };
}

const V1 = [
  "function total(items) {",
  "  let sum = 0;",
  "  for (const item of items) {",
  "    sum += item.price;",
  "  }",
  "  return sum;",
  "}",
  "",
  "export default total;",
] as const;

function anchorAt(t: AnchorTarget, line: number): Anchor {
  const anchor = createAnchor(t, line);
  if (anchor === null) throw new Error(`no line ${line} in target`);
  return anchor;
}

describe("relocate", () => {
  it("relocates to the new line number when content is pushed down", () => {
    const before = target("src/total.ts", "sha-a", 1, V1);
    const anchor = anchorAt(before, 4); // "    sum += item.price;"
    const after = target("src/total.ts", "sha-b", 1, ["// added", "// added", ...V1]);

    expect(relocate(anchor, after)).toEqual({ kind: "located", line: 6 });
  });

  it("relocates to the new line number when content is pulled up", () => {
    const before = target("src/total.ts", "sha-a", 1, ["// removed", "// removed", ...V1]);
    const anchor = anchorAt(before, 6);
    const after = target("src/total.ts", "sha-b", 1, V1);

    expect(relocate(anchor, after)).toEqual({ kind: "located", line: 4 });
  });

  it("reports outdated when the anchored line itself was rewritten", () => {
    const before = target("src/total.ts", "sha-a", 1, V1);
    const anchor = anchorAt(before, 4);
    const rewritten: string[] = [...V1];
    rewritten[3] = "    sum += item.price * item.quantity;";
    const after = target("src/total.ts", "sha-b", 1, rewritten);

    expect(relocate(anchor, after)).toEqual({ kind: "outdated" });
  });

  it("reports outdated when a surrounding context line changed", () => {
    // The window is the unit of identity, not the single line. A line whose
    // neighbourhood changed is, for review purposes, somewhere else.
    const before = target("src/total.ts", "sha-a", 1, V1);
    const anchor = anchorAt(before, 4);
    const edited: string[] = [...V1];
    edited[2] = "  for (const item of items.filter(Boolean)) {";
    const after = target("src/total.ts", "sha-b", 1, edited);

    expect(relocate(anchor, after)).toEqual({ kind: "outdated" });
  });

  it("reports outdated rather than choosing between two identical windows", () => {
    // The exact failure this project exists to prevent: with the block
    // duplicated, "line 4" is genuinely ambiguous, and picking the nearer one
    // would attach the thread to code the reviewer never read.
    const before = target("src/total.ts", "sha-a", 1, V1);
    const anchor = anchorAt(before, 4);
    const after = target("src/total.ts", "sha-b", 1, [...V1, ...V1]);

    expect(relocate(anchor, after)).toEqual({ kind: "outdated" });
  });

  it("reports outdated for a different file path", () => {
    const before = target("src/total.ts", "sha-a", 1, V1);
    const anchor = anchorAt(before, 4);
    const after = target("src/sum.ts", "sha-b", 1, V1);

    expect(relocate(anchor, after)).toEqual({ kind: "outdated" });
  });

  it("keeps the line when the blob is unchanged and more context is now exposed", () => {
    // Expanding context turns GAP slots into real text, so the window at the
    // anchored line is NOT equal to the stored one. Same blob sha means same
    // bytes, so this must still be located -- a window check on this branch
    // would report a spurious outdated for a file that did not change at all.
    const before = target("src/total.ts", "sha-a", 4, V1.slice(3, 6));
    const anchor = anchorAt(before, 5);
    const after = target("src/total.ts", "sha-a", 1, V1);

    expect(relocate(anchor, after)).toEqual({ kind: "located", line: 5 });
  });

  it("reports outdated when the blob is unchanged but the line is no longer exposed", () => {
    // The line exists in the file, but this rendering does not show it. There
    // is no row to attach to, and inventing one would be a guess.
    const before = target("src/total.ts", "sha-a", 1, V1);
    const anchor = anchorAt(before, 4);
    const after = target("src/total.ts", "sha-a", 40, ["x", "y", "z"]);

    expect(relocate(anchor, after)).toEqual({ kind: "outdated" });
  });

  it("never returns the original line merely because that line number exists", () => {
    // A stub returning {located, anchor.line} whenever the target has that
    // line number would pass several tests above. Here the line number is
    // present and its content is entirely different, so this test fails for
    // exactly that stub.
    const before = target("src/total.ts", "sha-a", 1, V1);
    const anchor = anchorAt(before, 4);
    const after = target("src/total.ts", "sha-b", 1, [
      "// entirely",
      "// different",
      "// file",
      "// contents",
      "// here",
      "// now",
      "// really",
    ]);

    expect(relocate(anchor, after)).toEqual({ kind: "outdated" });
  });

  it("tolerates a trailing-whitespace-only change", () => {
    const before = target("src/total.ts", "sha-a", 1, V1);
    const anchor = anchorAt(before, 4);
    const respaced = V1.map((line) => `${line}  `);
    const after = target("src/total.ts", "sha-b", 1, respaced);

    expect(relocate(anchor, after)).toEqual({ kind: "located", line: 4 });
  });

  it("does not tolerate an indentation change", () => {
    const before = target("src/total.ts", "sha-a", 1, V1);
    const anchor = anchorAt(before, 4);
    const reindented = V1.map((line) => (line.startsWith("  ") ? `  ${line}` : line));
    const after = target("src/total.ts", "sha-b", 1, reindented);

    expect(relocate(anchor, after)).toEqual({ kind: "outdated" });
  });

  it("reports outdated for a too-sparse context even when an exact match exists elsewhere (Fix round 1: reviewer-verified silent mis-anchor)", () => {
    // Before MIN_DISTINCTIVE_SLOTS existed, this exact input produced a
    // verified silent mis-anchor: {kind: "located", line: 50}. The anchor's
    // window has only 2 of 7 slots real ([GAP,GAP,GAP,"foo","bar",GAP,GAP]),
    // which matches every isolated "foo"/"bar" pair in the file -- not just
    // the one the reviewer actually commented on. A version of relocate
    // without the new precondition (rules 1-4 only) would scan, find the
    // single candidate at line 50, and wrongly report it located. This is
    // the failure the whole project exists to forbid, now closed at the
    // precondition rather than left as a documented limitation.
    const before = target("src/total.ts", "sha-a", 1, ["foo", "bar"]);
    const anchor = anchorAt(before, 1);
    const after = target("src/total.ts", "sha-b", 50, ["foo", "bar"]);

    expect(relocate(anchor, after)).toEqual({ kind: "outdated" });
  });

  it("reports outdated for the same sparse-context collision mid-file, which splitting GAP into EOF-vs-unexposed sentinels would not fix", () => {
    // The true occurrence sits at {10,11} -- nowhere near a file boundary.
    // A fix that only distinguished "past EOF" GAP from "unexposed" GAP
    // would not catch this: both {10,11} and {50,51} are surrounded by
    // merely-unexposed neighbours, not EOF, so the two sentinel kinds would
    // still coincide and the windows would still compare equal. This test
    // is what rules out that alternative fix and justifies the threshold
    // instead.
    const before = target("src/total.ts", "sha-a", 10, ["foo", "bar"]);
    const anchor = anchorAt(before, 10);
    const after = target("src/total.ts", "sha-b", 50, ["foo", "bar"]);

    expect(relocate(anchor, after)).toEqual({ kind: "outdated" });
  });

  it("still relocates when context meets the minimum distinctive threshold exactly (4 of 7 slots real)", () => {
    // Pins the boundary itself: a window with exactly MIN_DISTINCTIVE_SLOTS
    // real slots (the centre plus three of the six context slots) must
    // still relocate when it uniquely matches. This is what proves the new
    // precondition narrows relocation rather than disabling it -- a version
    // that rejected anything short of a full 7-real-slot window would fail
    // this test even though the match here is genuinely unambiguous.
    const before = target("src/total.ts", "sha-a", 4, V1.slice(3, 7));
    const anchor = anchorAt(before, 4);
    const after = target("src/total.ts", "sha-b", 6, V1.slice(3, 7));

    expect(relocate(anchor, after)).toEqual({ kind: "located", line: 6 });
  });
});
