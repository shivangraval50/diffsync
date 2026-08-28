import { describe, it, expect } from "vitest";
import { createAnchor, relocate } from "@diffsync/anchor";
import { parseUnifiedDiff } from "./parse.js";
import { anchorTargets, toAnchorTarget } from "./target.js";
import type { FileDiff, PullRequest } from "./types.js";

function patchFile(path: string, blobSha: string, patch: string): FileDiff {
  return {
    kind: "patch",
    path,
    previousPath: null,
    blobSha,
    status: "modified",
    hunks: parseUnifiedDiff(patch),
  };
}

const R1 = patchFile(
  "src/total.ts",
  "sha-r1",
  [
    "@@ -10,5 +10,5 @@ function total(items) {",
    "   let sum = 0;",
    "   for (const item of items) {",
    "-    sum += item.price;",
    "+    sum += item.price * item.quantity;",
    "   }",
    "   return sum;",
  ].join("\n")
);

describe("toAnchorTarget", () => {
  it("exposes context and added lines keyed by their new-side line number", () => {
    const target = toAnchorTarget(R1);
    expect([...target.lines.entries()]).toEqual([
      [10, "  let sum = 0;"],
      [11, "  for (const item of items) {"],
      [12, "    sum += item.price * item.quantity;"],
      [13, "  }"],
      [14, "  return sum;"],
    ]);
  });

  it("excludes removed lines, which have no new-side position at all", () => {
    const target = toAnchorTarget(R1);
    expect([...target.lines.values()]).not.toContain("    sum += item.price;");
  });

  it("carries the file path and blob sha through", () => {
    const target = toAnchorTarget(R1);
    expect(target.filePath).toBe("src/total.ts");
    expect(target.blobSha).toBe("sha-r1");
  });

  it("returns an empty target for an omitted file", () => {
    // Nothing may anchor into a file whose content was never delivered.
    const omitted: FileDiff = {
      kind: "omitted",
      path: "assets/logo.png",
      previousPath: null,
      blobSha: "sha-bin",
      status: "modified",
      reason: "binary",
    };
    expect(toAnchorTarget(omitted).lines.size).toBe(0);
  });

  it("does not expose a line number that falls in the gap between two hunks", () => {
    // This is the specific failure mode the brief calls out: backfilling the
    // gap between hunks (or before/after them) as blank strings would let a
    // later fingerprint window read those slots as "present but blank"
    // instead of GAP, defeating relocate()'s distinctive-slot guard. A hunk
    // that starts at new-line 10 and a second hunk starting at new-line 30
    // must leave lines 1-9 and 15-29 entirely absent from the map, not
    // present with empty text.
    const twoHunks = patchFile(
      "src/gap.ts",
      "sha-gap",
      [
        "@@ -10,2 +10,2 @@",
        "  a",
        "  b",
        "@@ -30,2 +30,2 @@",
        "  c",
        "  d",
      ].join("\n")
    );
    const target = toAnchorTarget(twoHunks);
    for (const n of [1, 5, 9, 15, 20, 29]) {
      expect(target.lines.has(n)).toBe(false);
    }
    expect([...target.lines.keys()]).toEqual([10, 11, 30, 31]);
  });
});

describe("relocation across two revisions of a real patch", () => {
  it("reports outdated when a later revision inserts a line inside the window", () => {
    const target1 = toAnchorTarget(R1);
    const anchor = createAnchor(target1, 12);
    if (anchor === null) throw new Error("expected an anchor");

    const r2 = patchFile(
      "src/total.ts",
      "sha-r2",
      [
        // NOTE: the brief's fixture here read "@@ -8,7 +8,8 @@", which
        // over-counts the body below by one on each side (body has 6
        // old-side lines and 7 new-side lines, not 7 and 8). Header
        // validation in parse.ts correctly rejects that as inconsistent, so
        // the header is corrected to match the body's actual content -- the
        // semantic edit intended (insert assertItems, then the item.price
        // change) is unchanged.
        "@@ -8,6 +8,7 @@ function total(items) {",
        "   let sum = 0;",
        "+  assertItems(items);",
        "   for (const item of items) {",
        "-    sum += item.price;",
        "+    sum += item.price * item.quantity;",
        "   }",
        "   return sum;",
        "   // tail",
      ].join("\n")
    );

    expect(relocate(anchor, toAnchorTarget(r2))).toEqual({ kind: "outdated" });
  });
});

describe("anchorTargets", () => {
  it("keys one target per file path", () => {
    const pr: PullRequest = {
      ref: { kind: "fixture", slug: "demo", revision: 1 },
      title: "demo",
      author: "someone",
      headSha: "sha-r1",
      baseSha: "sha-base",
      files: [R1, patchFile("src/other.ts", "sha-o", "@@ -1,1 +1,1 @@\n-a\n+b")],
    };
    expect([...anchorTargets(pr).keys()]).toEqual(["src/total.ts", "src/other.ts"]);
  });
});
