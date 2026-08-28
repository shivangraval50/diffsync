import { describe, it, expect } from "vitest";
import { createAnchor, type Anchor } from "@diffsync/anchor";
import { anchorTargets } from "@diffsync/diff";
import { fixturePullRequest } from "@diffsync/fixtures";
import { applyEvent, emptyThreads, placeThreads, type PlacedThread, type Thread } from "@diffsync/threads";
import { layoutThreads } from "./threadLayout";

function thread(id: string, path: string, line: number): Thread {
  const anchor: Anchor = {
    filePath: path,
    blobSha: "sha-1",
    line,
    fingerprint: "0123456789abcdef",
    context: ["a", "b", "c", "d", "e", "f", "g"],
  };
  return {
    threadId: id,
    anchor,
    comments: [{ commentId: `c-${id}`, reviewerId: "r", nickname: "ada", body: id, atMs: 1 }],
    resolved: false,
    resolvedBy: null,
  };
}

describe("layoutThreads", () => {
  it("groups located threads by file and by their RELOCATED line", () => {
    // Not by the anchor's original line. Using the stored line would put the
    // thread beside whatever now occupies that row -- the silent mis-anchor.
    const placed: PlacedThread[] = [
      { thread: thread("t1", "src/a.ts", 15), placement: { kind: "located", line: 18 } },
    ];
    const layout = layoutThreads(placed);
    expect(layout.located.get("src/a.ts")?.get(18)?.map((p) => p.thread.threadId)).toEqual(["t1"]);
    expect(layout.located.get("src/a.ts")?.get(15)).toBeUndefined();
  });

  it("keeps several threads on one line in their original order", () => {
    const placed: PlacedThread[] = [
      { thread: thread("t1", "src/a.ts", 4), placement: { kind: "located", line: 4 } },
      { thread: thread("t2", "src/a.ts", 4), placement: { kind: "located", line: 4 } },
    ];
    expect(
      layoutThreads(placed).located.get("src/a.ts")?.get(4)?.map((p) => p.thread.threadId)
    ).toEqual(["t1", "t2"]);
  });

  it("collects outdated threads separately and keeps them out of the diff", () => {
    const placed: PlacedThread[] = [
      { thread: thread("t1", "src/a.ts", 4), placement: { kind: "located", line: 4 } },
      { thread: thread("t2", "src/a.ts", 9), placement: { kind: "outdated" } },
    ];
    const layout = layoutThreads(placed);
    expect(layout.outdated.map((p) => p.thread.threadId)).toEqual(["t2"]);
    expect(layout.located.get("src/a.ts")?.size).toBe(1);
  });

  it("splits a real force-pushed revision into a genuine relocation and a genuine outdated", () => {
    // The three tests above hand-build a `Relocation` directly, which would
    // pass even if `relocate()` itself, or its wiring through `placeThreads`,
    // were broken -- the exact trap this project's brief warns about ("never
    // rendering the outdated case at all, because the fixture always
    // relocates"). This drives the real pipeline instead: real anchors, built
    // with `createAnchor` from revision 1 of the seeded `auth-refactor`
    // fixture, relocated against revision 2's actual content.
    //
    // Per the fixture's own doc comment: `src/auth/session.ts` gets a guard
    // clause inserted above the anchored line, so that thread relocates
    // (15 -> 18); `src/auth/token.ts` has its anchored region rewritten, so
    // that thread goes outdated.
    const rev1 = fixturePullRequest("auth-refactor", 1);
    const rev2 = fixturePullRequest("auth-refactor", 2);
    if (rev1 === null || rev2 === null) throw new Error("fixture missing");
    const targets1 = anchorTargets(rev1);
    const targets2 = anchorTargets(rev2);

    const sessionTarget = targets1.get("src/auth/session.ts");
    const tokenTarget = targets1.get("src/auth/token.ts");
    if (sessionTarget === undefined || tokenTarget === undefined) {
      throw new Error("fixture shape changed under this test");
    }

    const sessionAnchor = createAnchor(sessionTarget, 15);
    const tokenAnchor = createAnchor(tokenTarget, 6);
    if (sessionAnchor === null || tokenAnchor === null) {
      throw new Error("fixture shape changed under this test");
    }

    let state = emptyThreads();
    state = applyEvent(state, {
      type: "threadOpened",
      threadId: "session-thread",
      anchor: sessionAnchor,
      comment: { commentId: "c1", reviewerId: "r1", nickname: "ada", body: "ttl?", atMs: 1 },
    });
    state = applyEvent(state, {
      type: "threadOpened",
      threadId: "token-thread",
      anchor: tokenAnchor,
      comment: { commentId: "c2", reviewerId: "r1", nickname: "ada", body: "sig order?", atMs: 1 },
    });

    const layout = layoutThreads(placeThreads(state, targets2));

    expect(layout.outdated.map((p) => p.thread.threadId)).toEqual(["token-thread"]);
    expect(layout.located.get("src/auth/session.ts")?.get(18)?.map((p) => p.thread.threadId)).toEqual([
      "session-thread",
    ]);
  });
});
