import { describe, it, expect } from "vitest";
import type { Anchor } from "@diffsync/anchor";
import type { ServerMessage } from "@diffsync/protocol";
import { createReviewStore } from "./reviewStore";

const anchor: Anchor = {
  filePath: "src/a.ts",
  blobSha: "sha-1",
  line: 5,
  fingerprint: "0123456789abcdef",
  context: ["a", "b", "c", "d", "e", "f", "g"],
};

function comment(id: string, body: string) {
  return { commentId: id, reviewerId: "r1", nickname: "ada", body, atMs: 1 };
}

const snapshot: ServerMessage = {
  t: "snapshot",
  seq: 4,
  serverTime: 1,
  youAre: "r1",
  threads: { threads: {}, order: [] },
  presence: [{ reviewerId: "r1", nickname: "ada", persistent: false, cursor: null }],
};

describe("the review store", () => {
  it("adopts a snapshot wholesale", () => {
    const store = createReviewStore();
    store.getState().applyServerMessage(snapshot);
    expect(store.getState().youAre).toBe("r1");
    expect(store.getState().lastSeenSeq).toBe(4);
    expect(store.getState().presence).toHaveLength(1);
  });

  it("folds a delta with the same reducer the server uses", () => {
    const store = createReviewStore();
    store.getState().applyServerMessage(snapshot);
    store.getState().applyServerMessage({
      t: "delta",
      seq: 5,
      serverTime: 2,
      event: { type: "threadOpened", threadId: "t1", anchor, comment: comment("c1", "look") },
    });
    expect(store.getState().threads.order).toEqual(["t1"]);
    expect(store.getState().lastSeenSeq).toBe(5);
  });

  it("does not move lastSeenSeq backwards on a replayed delta", () => {
    // Resume position must never regress, or a reconnect would ask the
    // Durable Object to replay events it has already folded and the thread
    // list would double up.
    const store = createReviewStore();
    store.getState().applyServerMessage(snapshot);
    store.getState().applyServerMessage({
      t: "delta",
      seq: 9,
      serverTime: 2,
      event: { type: "threadOpened", threadId: "t1", anchor, comment: comment("c1", "a") },
    });
    store.getState().applyServerMessage({
      t: "delta",
      seq: 6,
      serverTime: 3,
      event: { type: "replyAdded", threadId: "t1", comment: comment("c2", "b") },
    });
    expect(store.getState().lastSeenSeq).toBe(9);
    // The event is still applied -- it is a real event, just delivered late.
    expect(store.getState().threads.threads["t1"]?.comments).toHaveLength(2);
  });

  it("does not advance lastSeenSeq on an ack", () => {
    // An ack says "the server recorded this", not "you have applied it". The
    // matching delta may not have arrived; resuming from an ack would skip it
    // permanently.
    const store = createReviewStore();
    store.getState().applyServerMessage(snapshot);
    store.getState().applyServerMessage({ t: "ack", clientSeq: 1, seq: 99 });
    expect(store.getState().lastSeenSeq).toBe(4);
  });

  it("applies the sender's own delta even though its ack for the same event arrived first", () => {
    // This is the composition openbid got wrong: its `ack` handler advanced
    // `lastSeenSeq` to the ack's seq, so when the matching `delta` for the
    // SENDER'S OWN event later arrived at that same seq, it looked like a
    // replay of something already applied and was silently dropped -- the
    // winning bidder's own client never applied their own winning bid. `ack`
    // and `delta` each passed in isolation (see the two tests immediately
    // above and below this one); only running them back-to-back, in the
    // order the Durable Object's own `commit()` can actually deliver them in
    // (broadcast the delta, but an ack can still be processed by this store
    // before that delta if messages are handled one at a time and something
    // reorders delivery), catches the regression.
    const store = createReviewStore();
    store.getState().applyServerMessage(snapshot); // seq 4, nothing folded yet

    store.getState().applyServerMessage({ t: "ack", clientSeq: 1, seq: 5 });
    expect(store.getState().lastSeenSeq).toBe(4); // ack alone must not advance it
    expect(store.getState().threads.order).toEqual([]); // and must not fold anything

    store.getState().applyServerMessage({
      t: "delta",
      seq: 5,
      serverTime: 2,
      event: { type: "threadOpened", threadId: "t1", anchor, comment: comment("c1", "look") },
    });
    // The delta for the sender's own event is still applied, and still
    // advances the resume position -- it is not treated as a duplicate of
    // something the ack already covered.
    expect(store.getState().lastSeenSeq).toBe(5);
    expect(store.getState().threads.order).toEqual(["t1"]);
  });

  it("replaces presence on a presence frame", () => {
    const store = createReviewStore();
    store.getState().applyServerMessage(snapshot);
    store.getState().applyServerMessage({
      t: "presence",
      presence: [
        { reviewerId: "r1", nickname: "ada", persistent: false, cursor: null },
        {
          reviewerId: "r2",
          nickname: "grace",
          persistent: true,
          cursor: { filePath: "src/a.ts", line: 5 },
        },
      ],
    });
    expect(store.getState().presence.map((p) => p.nickname)).toEqual(["ada", "grace"]);
  });

  it("records a reject so the UI can explain it", () => {
    const store = createReviewStore();
    store.getState().applyServerMessage({ t: "reject", clientSeq: 3, reason: "STALE_ANCHOR" });
    expect(store.getState().lastReject).toEqual({ clientSeq: 3, reason: "STALE_ANCHOR" });
  });

  it("records a changed head sha", () => {
    const store = createReviewStore();
    store.getState().applyServerMessage({ t: "sourceChanged", headSha: "9f8e7d6" });
    expect(store.getState().headSha).toBe("9f8e7d6");
  });

  it("leaves lastSeenSeq and threads alone on a pong", () => {
    // `pong` carries no review state at all; folding it must be a pure no-op,
    // not just "doesn't crash".
    const store = createReviewStore();
    store.getState().applyServerMessage(snapshot);
    store.getState().applyServerMessage({ t: "pong", clientTime: 1, serverTime: 2 });
    expect(store.getState().lastSeenSeq).toBe(4);
    expect(store.getState().threads.order).toEqual([]);
  });
});
