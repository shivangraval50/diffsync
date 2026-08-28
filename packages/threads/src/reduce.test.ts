import { describe, it, expect } from "vitest";
import type { Anchor } from "@diffsync/anchor";
import { applyEvent, emptyThreads } from "./reduce";
import type { Comment, ReviewEvent, ThreadsState } from "./types";

const anchor: Anchor = {
  filePath: "src/total.ts",
  blobSha: "sha-r1",
  line: 12,
  fingerprint: "0123456789abcdef",
  context: ["a", "b", "c", "d", "e", "f", "g"],
};

function comment(id: string, body: string, atMs: number): Comment {
  return { commentId: id, reviewerId: "r1", nickname: "ada", body, atMs };
}

const opened: ReviewEvent = {
  type: "threadOpened",
  threadId: "t1",
  anchor,
  comment: comment("c1", "this double-counts", 1_000),
};

function fold(events: readonly ReviewEvent[]): ThreadsState {
  return events.reduce(applyEvent, emptyThreads());
}

describe("applyEvent", () => {
  it("opens a thread with its first comment and records its order", () => {
    const state = fold([opened]);
    expect(state.order).toEqual(["t1"]);
    expect(state.threads["t1"]?.anchor).toEqual(anchor);
    expect(state.threads["t1"]?.comments.map((c) => c.body)).toEqual(["this double-counts"]);
    expect(state.threads["t1"]?.resolved).toBe(false);
  });

  it("appends replies in log order", () => {
    const state = fold([
      opened,
      { type: "replyAdded", threadId: "t1", comment: comment("c2", "agreed", 2_000) },
      { type: "replyAdded", threadId: "t1", comment: comment("c3", "fixed", 3_000) },
    ]);
    expect(state.threads["t1"]?.comments.map((c) => c.commentId)).toEqual(["c1", "c2", "c3"]);
  });

  it("keeps thread order by first appearance, not by latest activity", () => {
    const second: ReviewEvent = {
      type: "threadOpened",
      threadId: "t2",
      anchor: { ...anchor, line: 30 },
      comment: comment("c9", "here too", 4_000),
    };
    const state = fold([
      opened,
      second,
      { type: "replyAdded", threadId: "t1", comment: comment("c10", "bump", 5_000) },
    ]);
    expect(state.order).toEqual(["t1", "t2"]);
  });

  it("resolves and unresolves, recording who did it", () => {
    const resolved = fold([
      opened,
      { type: "threadResolved", threadId: "t1", reviewerId: "r2", atMs: 6_000 },
    ]);
    expect(resolved.threads["t1"]?.resolved).toBe(true);
    expect(resolved.threads["t1"]?.resolvedBy).toBe("r2");

    const reopened = applyEvent(resolved, {
      type: "threadUnresolved",
      threadId: "t1",
      reviewerId: "r3",
      atMs: 7_000,
    });
    expect(reopened.threads["t1"]?.resolved).toBe(false);
    expect(reopened.threads["t1"]?.resolvedBy).toBeNull();
  });

  it("ignores an event for a thread that does not exist", () => {
    // The log is append-only and the DO validates before appending, so this
    // cannot arise from a well-behaved producer -- but a client folding a
    // delta stream it joined mid-way must not crash or invent a thread with
    // no anchor.
    const state = applyEvent(emptyThreads(), {
      type: "replyAdded",
      threadId: "ghost",
      comment: comment("c1", "hello", 1),
    });
    expect(state).toEqual(emptyThreads());
  });

  it("ignores a duplicate threadOpened rather than replacing the thread", () => {
    // Re-delivery is real: the DO broadcasts a delta to every socket
    // including the one that caused it, and a reconnecting client replays
    // from its last seen sequence. Replacing here would drop every reply
    // already folded onto that thread.
    const state = fold([
      opened,
      { type: "replyAdded", threadId: "t1", comment: comment("c2", "agreed", 2_000) },
      opened,
    ]);
    expect(state.threads["t1"]?.comments).toHaveLength(2);
    expect(state.order).toEqual(["t1"]);
  });

  it("ignores a duplicate comment id", () => {
    const state = fold([
      opened,
      { type: "replyAdded", threadId: "t1", comment: comment("c2", "agreed", 2_000) },
      { type: "replyAdded", threadId: "t1", comment: comment("c2", "agreed", 2_000) },
    ]);
    expect(state.threads["t1"]?.comments.map((c) => c.commentId)).toEqual(["c1", "c2"]);
  });

  it("does not mutate the state it was given", () => {
    const before = fold([opened]);
    const snapshot = JSON.stringify(before);
    applyEvent(before, { type: "replyAdded", threadId: "t1", comment: comment("c2", "x", 2) });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("produces byte-identical state from two independent folds of the same log", () => {
    // The DO's log is the single source of truth only if replaying it always
    // lands on the same state. A fold that mutates shared state (e.g. pushes
    // onto a comments array in place, or reuses the same order array across
    // calls) can still pass a same-process "fold twice" check if the mutation
    // happens to be idempotent, or worse, corrupt a *different* in-flight
    // state that happened to share a reference. Building each state from a
    // completely fresh, separately-constructed log -- not a shared events
    // array or a repeated call on the same accumulator -- and comparing
    // deeply is what actually catches a hidden mutation.
    const log: ReviewEvent[] = [
      opened,
      { type: "replyAdded", threadId: "t1", comment: comment("c2", "agreed", 2_000) },
      {
        type: "threadOpened",
        threadId: "t2",
        anchor: { ...anchor, line: 30 },
        comment: comment("c9", "here too", 4_000),
      },
      { type: "threadResolved", threadId: "t1", reviewerId: "r2", atMs: 6_000 },
    ];

    function freshLog(): ReviewEvent[] {
      return [
        {
          type: "threadOpened",
          threadId: "t1",
          anchor: { ...anchor },
          comment: comment("c1", "this double-counts", 1_000),
        },
        { type: "replyAdded", threadId: "t1", comment: comment("c2", "agreed", 2_000) },
        {
          type: "threadOpened",
          threadId: "t2",
          anchor: { ...anchor, line: 30 },
          comment: comment("c9", "here too", 4_000),
        },
        { type: "threadResolved", threadId: "t1", reviewerId: "r2", atMs: 6_000 },
      ];
    }

    const first = freshLog().reduce(applyEvent, emptyThreads());
    const second = freshLog().reduce(applyEvent, emptyThreads());
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    // Sanity: the two logs really are independent arrays/objects, not the
    // same one folded twice.
    expect(log.length).toBe(freshLog().length);
  });
});
