import { describe, it, expect } from "vitest";
import { DiffParseError, parseUnifiedDiff } from "./parse";

const PATCH = [
  "@@ -10,6 +10,7 @@ function total(items) {",
  "   let sum = 0;",
  "   for (const item of items) {",
  "-    sum += item.price;",
  "+    sum += item.price * item.quantity;",
  "+    audit(item);",
  "   }",
  "   return sum;",
  " }",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("reads the hunk header, including the trailing heading", () => {
    const [hunk] = parseUnifiedDiff(PATCH);
    expect(hunk?.oldStart).toBe(10);
    expect(hunk?.oldCount).toBe(6);
    expect(hunk?.newStart).toBe(10);
    expect(hunk?.newCount).toBe(7);
    expect(hunk?.heading).toBe("function total(items) {");
  });

  it("numbers each line on the side it belongs to", () => {
    const [hunk] = parseUnifiedDiff(PATCH);
    expect(hunk?.lines).toEqual([
      { kind: "context", text: "  let sum = 0;", oldLine: 10, newLine: 10 },
      { kind: "context", text: "  for (const item of items) {", oldLine: 11, newLine: 11 },
      { kind: "removed", text: "    sum += item.price;", oldLine: 12 },
      { kind: "added", text: "    sum += item.price * item.quantity;", newLine: 12 },
      { kind: "added", text: "    audit(item);", newLine: 13 },
      { kind: "context", text: "  }", oldLine: 13, newLine: 14 },
      { kind: "context", text: "  return sum;", oldLine: 14, newLine: 15 },
      { kind: "context", text: "}", oldLine: 15, newLine: 16 },
    ]);
  });

  it("treats an omitted count as 1, per the unified diff format", () => {
    const [hunk] = parseUnifiedDiff(["@@ -5 +5 @@", "-a", "+b"].join("\n"));
    expect(hunk?.oldCount).toBe(1);
    expect(hunk?.newCount).toBe(1);
  });

  it("parses several hunks in one patch", () => {
    const patch = ["@@ -1,1 +1,1 @@", "-a", "+b", "@@ -20,1 +20,1 @@", "-c", "+d"].join("\n");
    const hunks = parseUnifiedDiff(patch);
    expect(hunks.map((h) => h.newStart)).toEqual([1, 20]);
  });

  it("treats a bare empty line as an empty context line", () => {
    // Some patch producers strip the single leading space from a blank
    // context line. Dropping it here would shift every following line number
    // by one -- and a shifted line number is a mis-anchor.
    const hunks = parseUnifiedDiff(["@@ -1,3 +1,3 @@", " a", "", " c"].join("\n"));
    expect(hunks[0]?.lines).toEqual([
      { kind: "context", text: "a", oldLine: 1, newLine: 1 },
      { kind: "context", text: "", oldLine: 2, newLine: 2 },
      { kind: "context", text: "c", oldLine: 3, newLine: 3 },
    ]);
  });

  it("ignores the no-newline-at-end-of-file marker without consuming a line number", () => {
    const hunks = parseUnifiedDiff(
      ["@@ -1,1 +1,1 @@", "-a", "\\ No newline at end of file", "+b"].join("\n")
    );
    expect(hunks[0]?.lines).toEqual([
      { kind: "removed", text: "a", oldLine: 1 },
      { kind: "added", text: "b", newLine: 1 },
    ]);
  });

  it("returns an empty array for an empty patch", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  it("throws DiffParseError when content appears before any hunk header", () => {
    expect(() => parseUnifiedDiff([" a", "@@ -1,1 +1,1 @@", "-a", "+b"].join("\n"))).toThrow(
      DiffParseError
    );
  });

  it("throws DiffParseError when a line has an unrecognised prefix", () => {
    expect(() => parseUnifiedDiff(["@@ -1,1 +1,1 @@", "?a"].join("\n"))).toThrow(DiffParseError);
  });

  it("throws DiffParseError when the body contradicts the header counts", () => {
    // This is the check that makes Task 8's fixture-integrity test meaningful:
    // a hand-written fixture whose @@ header lies would otherwise produce
    // silently wrong line numbers for every line after it.
    expect(() => parseUnifiedDiff(["@@ -1,5 +1,5 @@", " a", " b"].join("\n"))).toThrow(
      /counts/i
    );
  });

  // --- Additional coverage beyond the brief -------------------------------
  //
  // The standing requirement calls out real diffs that a single well-formed
  // generator won't produce: CRLF line endings, an addition-only hunk with no
  // context at all, and a hunk whose header the parser must still trust even
  // when a CR sneaks onto the end of a content line.

  it("preserves a trailing CR on a context line rather than stripping it", () => {
    // A CRLF-sourced patch splits on "\n" and leaves "\r" attached to each
    // line. Silently trimming it would make the exposed text disagree with
    // the actual bytes in the file, which is exactly the kind of drift the
    // anchoring core's exact-match fallback depends on not happening.
    const hunks = parseUnifiedDiff(["@@ -1,1 +1,1 @@", " same\r"].join("\n"));
    expect(hunks[0]?.lines).toEqual([
      { kind: "context", text: "same\r", oldLine: 1, newLine: 1 },
    ]);
  });

  it("parses a pure-addition hunk with zero old-side lines", () => {
    // A brand new file's first hunk has "-0,0" on the old side and no context
    // at all -- every line is a "+". A parser that assumes at least one
    // context line per hunk, or that mishandles an old count of 0, would
    // throw or misnumber here.
    const hunks = parseUnifiedDiff(["@@ -0,0 +1,2 @@", "+a", "+b"].join("\n"));
    expect(hunks[0]?.lines).toEqual([
      { kind: "added", text: "a", newLine: 1 },
      { kind: "added", text: "b", newLine: 2 },
    ]);
    expect(hunks[0]?.oldCount).toBe(0);
  });
});
