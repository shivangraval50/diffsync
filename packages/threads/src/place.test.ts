import { describe, it, expect } from "vitest";
import { createAnchor, type AnchorTarget } from "@diffsync/anchor";
import { applyEvent, emptyThreads } from "./reduce.js";
import { placeThreads } from "./place.js";
import type { ReviewEvent, ThreadsState } from "./types.js";

const LINES = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"] as const;

function target(blobSha: string, texts: readonly string[]): AnchorTarget {
  return {
    filePath: "src/x.ts",
    blobSha,
    lines: new Map(texts.map((t, i) => [i + 1, t])),
  };
}

function stateWithThreadAt(line: number): ThreadsState {
  const anchor = createAnchor(target("sha-1", LINES), line);
  if (anchor === null) throw new Error("expected an anchor");
  const event: ReviewEvent = {
    type: "threadOpened",
    threadId: "t1",
    anchor,
    comment: { commentId: "c1", reviewerId: "r1", nickname: "ada", body: "look", atMs: 1 },
  };
  return applyEvent(emptyThreads(), event);
}

describe("placeThreads", () => {
  it("reports the relocated line when the content moved", () => {
    const state = stateWithThreadAt(6);
    const targets = new Map([["src/x.ts", target("sha-2", ["x", "y", ...LINES])]]);
    expect(placeThreads(state, targets)).toEqual([
      { thread: state.threads["t1"], placement: { kind: "located", line: 8 } },
    ]);
  });

  it("reports outdated when the file is no longer in the pull request", () => {
    // A force-push that drops a file entirely must not leave its threads
    // pointing at a stale line number in a file nobody is looking at.
    const state = stateWithThreadAt(6);
    expect(placeThreads(state, new Map())).toEqual([
      { thread: state.threads["t1"], placement: { kind: "outdated" } },
    ]);
  });

  it("preserves thread order", () => {
    let state = stateWithThreadAt(6);
    const second = createAnchor(target("sha-1", LINES), 8);
    if (second === null) throw new Error("expected an anchor");
    state = applyEvent(state, {
      type: "threadOpened",
      threadId: "t2",
      anchor: second,
      comment: { commentId: "c2", reviewerId: "r2", nickname: "grace", body: "also", atMs: 2 },
    });
    const targets = new Map([["src/x.ts", target("sha-1", LINES)]]);
    expect(placeThreads(state, targets).map((p) => p.thread.threadId)).toEqual(["t1", "t2"]);
  });

  it("keeps a resolved thread in the list rather than hiding it", () => {
    // Resolution is a display state, not a deletion: the UI needs the thread
    // in order to offer unresolve.
    let state = stateWithThreadAt(6);
    state = applyEvent(state, {
      type: "threadResolved",
      threadId: "t1",
      reviewerId: "r2",
      atMs: 3,
    });
    const targets = new Map([["src/x.ts", target("sha-1", LINES)]]);
    const placed = placeThreads(state, targets);
    expect(placed).toHaveLength(1);
    expect(placed[0]?.thread.resolved).toBe(true);
  });

  it("reports outdated -- never a fabricated line -- when context is too sparse to relocate safely", () => {
    // relocate() refuses to trust a window with fewer than MIN_DISTINCTIVE_SLOTS
    // distinctive slots (Task 4's fix for the blank-slot false-positive). This
    // exercises that guard through placeThreads specifically, so a future
    // change here cannot quietly add a fallback ("use the original line
    // number if relocate can't find one") that would reintroduce a silent
    // mis-anchor -- the whole point of the anchor/relocate design.
    const blankTarget: AnchorTarget = {
      filePath: "src/blank.ts",
      blobSha: "sha-1",
      lines: new Map([
        [1, ""],
        [2, ""],
        [3, ""],
        [4, "}"],
        [5, ""],
        [6, ""],
        [7, ""],
      ]),
    };
    const anchor = createAnchor(blankTarget, 4);
    if (anchor === null) throw new Error("expected an anchor");
    const event: ReviewEvent = {
      type: "threadOpened",
      threadId: "t1",
      anchor,
      comment: { commentId: "c1", reviewerId: "r1", nickname: "ada", body: "look", atMs: 1 },
    };
    const state = applyEvent(emptyThreads(), event);

    // A different revision: same blob (so the blobSha fast path in relocate
    // does not fire) with the same sparse shape elsewhere in the file. If
    // placement ever fell back to "closest guess" this would locate to line
    // 14 instead of reporting outdated.
    const otherLines = new Map<number, string>();
    for (let i = 1; i <= 20; i += 1) otherLines.set(i, "");
    otherLines.set(4, "}");
    otherLines.set(14, "}");
    const revised: AnchorTarget = { filePath: "src/blank.ts", blobSha: "sha-2", lines: otherLines };

    const placed = placeThreads(state, new Map([["src/blank.ts", revised]]));
    expect(placed).toEqual([{ thread: state.threads["t1"], placement: { kind: "outdated" } }]);
  });
});
