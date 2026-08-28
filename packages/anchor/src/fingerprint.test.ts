import { describe, it, expect } from "vitest";
import { CONTEXT_RADIUS, GAP } from "./types";
import { createAnchor, fingerprint, normalizeLine, windowAt } from "./fingerprint";

function linesOf(start: number, texts: readonly string[]): Map<number, string> {
  return new Map(texts.map((text, i) => [start + i, text]));
}

describe("normalizeLine", () => {
  it("strips a trailing carriage return, so CRLF and LF sources agree", () => {
    expect(normalizeLine("const x = 1;\r")).toBe("const x = 1;");
  });

  it("strips trailing spaces and tabs", () => {
    expect(normalizeLine("const x = 1;  \t")).toBe("const x = 1;");
  });

  it("preserves leading whitespace, because indentation is real content", () => {
    // If this normalized, a thread anchored inside an if-block could relocate
    // onto the same statement after it was dedented out of that block --
    // different code, identical fingerprint. That is precisely the silent
    // mis-anchor this project exists to prevent.
    expect(normalizeLine("    return x;")).toBe("    return x;");
    expect(normalizeLine("  return x;")).not.toBe(normalizeLine("    return x;"));
  });

  it("preserves interior whitespace", () => {
    expect(normalizeLine("a  +  b")).toBe("a  +  b");
  });
});

describe("windowAt", () => {
  it("returns 2 * CONTEXT_RADIUS + 1 entries centred on the line", () => {
    const lines = linesOf(1, ["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
    expect(windowAt(lines, 5)).toEqual(["b", "c", "d", "e", "f", "g", "h"]);
    expect(windowAt(lines, 5)).toHaveLength(2 * CONTEXT_RADIUS + 1);
  });

  it("fills unknown slots with GAP rather than an empty string", () => {
    // An empty string is a legal source line (a blank line in a file). Padding
    // with "" would make a window at the top of a file compare equal to a
    // window surrounded by blank lines somewhere in the middle.
    const lines = linesOf(1, ["a", "b", "c", "d"]);
    expect(windowAt(lines, 1)).toEqual([GAP, GAP, GAP, "a", "b", "c", "d"]);
  });

  it("fills the space between two hunks with GAP", () => {
    const lines = new Map([
      [10, "a"],
      [11, "b"],
      [40, "y"],
      [41, "z"],
    ]);
    expect(windowAt(lines, 11)).toEqual([GAP, GAP, "a", "b", GAP, GAP, GAP]);
  });

  it("normalizes each slot", () => {
    const lines = linesOf(1, ["a\r", "b  ", "c"]);
    expect(windowAt(lines, 2)).toEqual([GAP, GAP, "a", "b", "c", GAP, GAP]);
  });
});

describe("fingerprint", () => {
  // fingerprint() takes a Window -- a fixed 2 * CONTEXT_RADIUS + 1 = 7 slot
  // tuple, not an arbitrary-length array (see Window's doc comment in
  // types.ts). Every window below is padded to that exact shape so these
  // tests exercise the shape the code actually accepts, not a shape
  // `relocate` could never legally construct.
  it("is stable for the same window", () => {
    expect(fingerprint(["a", "b", "c", "d", "e", "f", "g"])).toBe(
      fingerprint(["a", "b", "c", "d", "e", "f", "g"]),
    );
  });

  it("is 16 lowercase hex characters", () => {
    expect(fingerprint(["a", "b", "c", "d", "e", "f", "g"])).toMatch(/^[0-9a-f]{16}$/u);
  });

  it("distinguishes windows that differ only in where the slots are split", () => {
    // Joining with a plain "\n" would hash ["a\nb", "c", ...] and
    // ["a", "b\nc", ...] identically. The separator used cannot occur
    // inside a line, so these must differ. The trailing GAP padding is
    // identical in both, isolating the difference to where the split falls.
    expect(fingerprint(["a\nb", "c", GAP, GAP, GAP, GAP, GAP])).not.toBe(
      fingerprint(["a", "b\nc", GAP, GAP, GAP, GAP, GAP]),
    );
  });

  it("distinguishes windows that differ only in order", () => {
    expect(fingerprint(["a", "b", "c", "d", "e", "f", "g"])).not.toBe(
      fingerprint(["g", "f", "e", "d", "c", "b", "a"]),
    );
  });

  it("distinguishes non-ASCII content differing above the low byte", () => {
    // A hash folding each character to its low byte would collide these:
    // U+0041 "A" and U+0141 both have low byte 0x41.
    expect(fingerprint(["A", GAP, GAP, GAP, GAP, GAP, GAP])).not.toBe(
      fingerprint(["Ł", GAP, GAP, GAP, GAP, GAP, GAP]),
    );
  });

  it("gives the same fingerprint for lines sourced with CRLF/trailing-whitespace noise as for clean lines", () => {
    // "is stable for the same window" above would still pass for a
    // fingerprint that just returns e.g. JSON.stringify(window) verbatim --
    // it never checks that two *differently-sourced* copies of the same
    // code converge. This is the property normalizeLine's own docstring
    // calls load-bearing: "a thread must not go outdated over a transport
    // detail." Exercised through createAnchor so it covers the composed
    // windowAt -> normalizeLine -> fingerprint path, not just normalizeLine
    // in isolation.
    const clean = {
      filePath: "src/app.ts",
      blobSha: "sha-lf",
      lines: linesOf(1, ["a", "b", "c", "d", "e", "f", "g"]),
    };
    const noisy = {
      filePath: "src/app.ts",
      blobSha: "sha-crlf",
      lines: linesOf(1, ["a\r", "b  ", "c\t", "d\r", "e", "f  \t", "g\r"]),
    };

    const cleanAnchor = createAnchor(clean, 4);
    const noisyAnchor = createAnchor(noisy, 4);

    expect(cleanAnchor?.fingerprint).toBe(noisyAnchor?.fingerprint);
    expect(cleanAnchor?.context).toEqual(noisyAnchor?.context);
  });
});

describe("createAnchor", () => {
  const target = {
    filePath: "src/app.ts",
    blobSha: "sha-1",
    lines: linesOf(1, ["a", "b", "c", "d", "e", "f", "g"]),
  };

  it("captures file, blob, line, fingerprint and window together", () => {
    const anchor = createAnchor(target, 4);
    expect(anchor).not.toBeNull();
    expect(anchor?.filePath).toBe("src/app.ts");
    expect(anchor?.blobSha).toBe("sha-1");
    expect(anchor?.line).toBe(4);
    expect(anchor?.context).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    expect(anchor?.fingerprint).toBe(fingerprint(["a", "b", "c", "d", "e", "f", "g"]));
  });

  it("returns null for a line the target does not expose", () => {
    // Not a weaker anchor: an anchor on a line nobody can see is not an
    // anchor. The Durable Object turns this into an explicit reject.
    expect(createAnchor(target, 99)).toBeNull();
  });
});
