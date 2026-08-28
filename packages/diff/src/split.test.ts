import { describe, it, expect } from "vitest";
import { parseUnifiedDiff } from "./parse";
import { toSplitRows } from "./split";

describe("toSplitRows", () => {
  it("puts a context line on both sides with its own line numbers", () => {
    const [hunk] = parseUnifiedDiff(["@@ -5,1 +9,1 @@", " same"].join("\n"));
    if (hunk === undefined) throw new Error("expected a hunk");
    expect(toSplitRows(hunk)).toEqual([
      { left: { text: "same", line: 5 }, right: { text: "same", line: 9 } },
    ]);
  });

  it("pairs a removed line with the added line that replaced it", () => {
    const [hunk] = parseUnifiedDiff(["@@ -1,1 +1,1 @@", "-old", "+new"].join("\n"));
    if (hunk === undefined) throw new Error("expected a hunk");
    expect(toSplitRows(hunk)).toEqual([
      { left: { text: "old", line: 1 }, right: { text: "new", line: 1 } },
    ]);
  });

  it("leaves the opposite cell null when a run is unbalanced", () => {
    const [hunk] = parseUnifiedDiff(["@@ -1,1 +1,3 @@", "-old", "+a", "+b", "+c"].join("\n"));
    if (hunk === undefined) throw new Error("expected a hunk");
    expect(toSplitRows(hunk)).toEqual([
      { left: { text: "old", line: 1 }, right: { text: "a", line: 1 } },
      { left: null, right: { text: "b", line: 2 } },
      { left: null, right: { text: "c", line: 3 } },
    ]);
  });

  it("does not pair across an intervening context line", () => {
    // A removal, then unchanged code, then an unrelated addition are three
    // separate edits. Pairing them would put unrelated code side by side and
    // read as a rewrite that never happened.
    const [hunk] = parseUnifiedDiff(
      ["@@ -1,2 +1,2 @@", "-old", " same", "+added"].join("\n")
    );
    if (hunk === undefined) throw new Error("expected a hunk");
    expect(toSplitRows(hunk)).toEqual([
      { left: { text: "old", line: 1 }, right: null },
      { left: { text: "same", line: 2 }, right: { text: "same", line: 1 } },
      { left: null, right: { text: "added", line: 2 } },
    ]);
  });

  it("returns an empty array for a hunk with no lines", () => {
    // A degenerate but legal input -- guards against an off-by-one in the
    // while-loop bound (e.g. reading hunk.lines[0] unconditionally) that
    // would throw instead of returning [].
    expect(toSplitRows({ oldStart: 1, oldCount: 0, newStart: 1, newCount: 0, heading: "", lines: [] })).toEqual(
      []
    );
  });

  it("handles a run of only additions with no preceding removal", () => {
    // Exercises the branch where the removed-run collector finds nothing and
    // every added line still gets its own row rather than being dropped.
    const [hunk] = parseUnifiedDiff(["@@ -1,0 +1,2 @@", "+a", "+b"].join("\n"));
    if (hunk === undefined) throw new Error("expected a hunk");
    expect(toSplitRows(hunk)).toEqual([
      { left: null, right: { text: "a", line: 1 } },
      { left: null, right: { text: "b", line: 2 } },
    ]);
  });
});
