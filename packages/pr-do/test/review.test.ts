import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { sourceResultSchema } from "@diffsync/protocol";
import { anchorFor, connect, fixtureKey, isolatedKey, join, send } from "./helpers.js";

describe("GET /prs/:key/source", () => {
  it("serves the seeded fixture for a fixture key", async () => {
    const res = await SELF.fetch(`https://do.test/prs/${fixtureKey()}/source`);
    expect(res.status).toBe(200);
    const parsed = sourceResultSchema.parse(await res.json());
    expect(parsed.origin).toBe("fixture");
    expect(parsed.pr.files.map((f) => f.path)).toEqual([
      "src/auth/session.ts",
      "src/auth/token.ts",
      "README.md",
    ]);
  });

  it("404s a key that does not decode", async () => {
    const res = await SELF.fetch("https://do.test/prs/not-a-real-key/source");
    expect(res.status).toBe(404);
  });
});

describe("presence", () => {
  it("tells a joiner who they are and who else is here", async () => {
    const key = isolatedKey();
    const ada = await join(key, "ada");
    expect(ada.snapshot.youAre).toMatch(/.+/u);
    expect(ada.snapshot.presence.map((p) => p.nickname)).toEqual(["ada"]);

    const grace = await join(key, "grace");
    expect(grace.snapshot.presence.map((p) => p.nickname).sort()).toEqual(["ada", "grace"]);

    // And the reviewer already in the room learns about the new one.
    const update = await ada.inbox.next(
      (m) => m.t === "presence" && m.presence.length === 2
    );
    expect(update.t).toBe("presence");
  });

  it("broadcasts a cursor move to the other reviewer", async () => {
    const key = isolatedKey();
    const ada = await join(key, "ada");
    const grace = await join(key, "grace");

    send(ada.ws, { t: "cursor", filePath: "src/auth/token.ts", line: 6 });

    const update = await grace.inbox.next(
      (m) =>
        m.t === "presence" &&
        m.presence.some((p) => p.nickname === "ada" && p.cursor?.line === 6)
    );
    if (update.t !== "presence") throw new Error("expected presence");
    const ada2 = update.presence.find((p) => p.nickname === "ada");
    expect(ada2?.cursor).toEqual({ filePath: "src/auth/token.ts", line: 6 });
  });

  it("drops a departed reviewer from presence", async () => {
    const key = isolatedKey();
    const ada = await join(key, "ada");
    const grace = await join(key, "grace");
    await ada.inbox.next((m) => m.t === "presence" && m.presence.length === 2);

    grace.ws.close();

    const update = await ada.inbox.next(
      (m) => m.t === "presence" && m.presence.length === 1
    );
    if (update.t !== "presence") throw new Error("expected presence");
    expect(update.presence.map((p) => p.nickname)).toEqual(["ada"]);
  });
});

describe("the append-only comment log", () => {
  it("acks the author and broadcasts the thread to everyone else", async () => {
    const key = isolatedKey();
    const ada = await join(key, "ada");
    const grace = await join(key, "grace");
    const anchor = anchorFor("src/auth/session.ts", 15);

    send(ada.ws, { t: "openThread", clientSeq: 1, anchor, body: "why two clocks?" });

    const ack = await ada.inbox.next((m) => m.t === "ack");
    if (ack.t !== "ack") throw new Error("expected an ack");
    expect(ack.clientSeq).toBe(1);

    const delta = await grace.inbox.next((m) => m.t === "delta");
    if (delta.t !== "delta") throw new Error("expected a delta");
    if (delta.event.type !== "threadOpened") throw new Error("expected threadOpened");
    expect(delta.event.comment.body).toBe("why two clocks?");
    expect(delta.event.comment.nickname).toBe("ada");
    expect(delta.event.anchor.line).toBe(15);
    expect(delta.seq).toBe(ack.seq);
  });

  it("stores the anchor the SERVER computed, not the one the client sent", async () => {
    // The client's anchor is verified, then discarded. Trusting the client's
    // stored `context` would let a browser put words in the diff's mouth:
    // an outdated thread quotes that context back to every reviewer.
    const key = isolatedKey();
    const ada = await join(key, "ada");
    const anchor = anchorFor("src/auth/session.ts", 15);

    send(ada.ws, { t: "openThread", clientSeq: 1, anchor, body: "check this" });
    await ada.inbox.next((m) => m.t === "ack");

    const later = await join(key, "grace");
    const threadId = later.snapshot.threads.order[0];
    if (threadId === undefined) throw new Error("expected a thread");
    expect(later.snapshot.threads.threads[threadId]?.anchor.context).toEqual([
      ...anchor.context,
    ]);
  });

  it("serialises two threads opened at the same instant into one order", async () => {
    const key = isolatedKey();
    const ada = await join(key, "ada");
    const grace = await join(key, "grace");

    send(ada.ws, {
      t: "openThread",
      clientSeq: 1,
      anchor: anchorFor("src/auth/session.ts", 15),
      body: "from ada",
    });
    send(grace.ws, {
      t: "openThread",
      clientSeq: 1,
      anchor: anchorFor("src/auth/token.ts", 5),
      body: "from grace",
    });

    const adaAck = await ada.inbox.next((m) => m.t === "ack");
    const graceAck = await grace.inbox.next((m) => m.t === "ack");
    if (adaAck.t !== "ack" || graceAck.t !== "ack") throw new Error("expected acks");
    // Two opens fired without awaiting either ack in between still land as
    // one definite, gap-free sequence -- the property the Durable Object
    // provides for free from being single-threaded. This is a fresh
    // `isolatedKey()`, so the pair is exactly {1, 2}, in whichever order the
    // DO actually processed them.
    expect([adaAck.seq, graceAck.seq].sort((a, b) => a - b)).toEqual([1, 2]);

    const third = await join(key, "hopper");
    // Both threads are present, in one definite order.
    expect(third.snapshot.threads.order).toHaveLength(2);
    const bodies = third.snapshot.threads.order.map(
      (id) => third.snapshot.threads.threads[id]?.comments[0]?.body
    );
    expect(bodies.sort()).toEqual(["from ada", "from grace"]);
  });

  it("appends replies and folds resolve then unresolve", async () => {
    const key = isolatedKey();
    const ada = await join(key, "ada");
    send(ada.ws, {
      t: "openThread",
      clientSeq: 1,
      anchor: anchorFor("src/auth/session.ts", 15),
      body: "first",
    });
    const opened = await ada.inbox.next((m) => m.t === "delta");
    if (opened.t !== "delta" || opened.event.type !== "threadOpened") {
      throw new Error("expected threadOpened");
    }
    const threadId = opened.event.threadId;

    send(ada.ws, { t: "reply", clientSeq: 2, threadId, body: "second" });
    await ada.inbox.next((m) => m.t === "ack" && m.clientSeq === 2);

    send(ada.ws, { t: "resolve", clientSeq: 3, threadId });
    await ada.inbox.next((m) => m.t === "ack" && m.clientSeq === 3);

    const afterResolve = await join(key, "grace");
    expect(afterResolve.snapshot.threads.threads[threadId]?.resolved).toBe(true);
    expect(afterResolve.snapshot.threads.threads[threadId]?.comments.map((c) => c.body)).toEqual([
      "first",
      "second",
    ]);

    send(ada.ws, { t: "unresolve", clientSeq: 4, threadId });
    await ada.inbox.next((m) => m.t === "ack" && m.clientSeq === 4);

    const afterUnresolve = await join(key, "hopper");
    expect(afterUnresolve.snapshot.threads.threads[threadId]?.resolved).toBe(false);
  });

  it("replays only the events a reconnecting client missed", async () => {
    const key = isolatedKey();
    const ada = await join(key, "ada");
    send(ada.ws, {
      t: "openThread",
      clientSeq: 1,
      anchor: anchorFor("src/auth/session.ts", 15),
      body: "before the drop",
    });
    const first = await ada.inbox.next((m) => m.t === "delta");
    if (first.t !== "delta") throw new Error("expected a delta");
    ada.ws.close();

    const grace = await join(key, "grace");
    send(grace.ws, {
      t: "openThread",
      clientSeq: 1,
      anchor: anchorFor("src/auth/token.ts", 5),
      body: "while ada was away",
    });
    await grace.inbox.next((m) => m.t === "ack");

    const back = await connect(key);
    send(back.ws, { t: "hello", lastSeenSeq: first.seq, nickname: "ada", persistent: false });

    const replayed = await back.inbox.next((m) => m.t === "delta");
    if (replayed.t !== "delta" || replayed.event.type !== "threadOpened") {
      throw new Error("expected a replayed threadOpened");
    }
    expect(replayed.event.comment.body).toBe("while ada was away");
    expect(replayed.seq).toBeGreaterThan(first.seq);
  });
});

describe("rejects, before anything reaches the log", () => {
  it("rejects a comment on a file that is not in this pull request", async () => {
    const key = isolatedKey();
    const ada = await join(key, "ada");
    const anchor = { ...anchorFor("src/auth/session.ts", 15), filePath: "src/not-here.ts" };

    send(ada.ws, { t: "openThread", clientSeq: 7, anchor, body: "nowhere" });

    const reject = await ada.inbox.next((m) => m.t === "reject");
    expect(reject).toEqual({ t: "reject", clientSeq: 7, reason: "UNKNOWN_FILE" });

    const later = await join(key, "grace");
    expect(later.snapshot.threads.order).toEqual([]);
  });

  it("rejects an anchor whose fingerprint does not match the server's source", async () => {
    // The client was looking at a different revision. Accepting this would
    // attach the comment to whatever is at that line NOW -- code the reviewer
    // never read, which is the whole failure this project exists to prevent.
    const key = isolatedKey();
    const ada = await join(key, "ada");
    const anchor = { ...anchorFor("src/auth/session.ts", 15), fingerprint: "0000000000000000" };

    send(ada.ws, { t: "openThread", clientSeq: 8, anchor, body: "stale" });

    const reject = await ada.inbox.next((m) => m.t === "reject");
    expect(reject).toEqual({ t: "reject", clientSeq: 8, reason: "STALE_ANCHOR" });
  });

  it("rejects an anchor on a line the file does not expose", async () => {
    const key = isolatedKey();
    const ada = await join(key, "ada");
    const anchor = { ...anchorFor("src/auth/session.ts", 15), line: 999 };

    send(ada.ws, { t: "openThread", clientSeq: 9, anchor, body: "off the end" });

    const reject = await ada.inbox.next((m) => m.t === "reject");
    expect(reject).toEqual({ t: "reject", clientSeq: 9, reason: "STALE_ANCHOR" });
  });

  it("rejects a reply to a thread that does not exist", async () => {
    const key = isolatedKey();
    const ada = await join(key, "ada");

    send(ada.ws, { t: "reply", clientSeq: 10, threadId: "no-such-thread", body: "hello?" });

    const reject = await ada.inbox.next((m) => m.t === "reject");
    expect(reject).toEqual({ t: "reject", clientSeq: 10, reason: "UNKNOWN_THREAD" });
  });

  it("closes a socket that comments before saying hello", async () => {
    const key = isolatedKey();
    const { ws } = await connect(key);
    const closed = new Promise<number>((resolve) => {
      ws.addEventListener("close", (event: CloseEvent) => resolve(event.code));
    });

    send(ws, {
      t: "openThread",
      clientSeq: 1,
      anchor: anchorFor("src/auth/session.ts", 15),
      body: "no hello",
    });

    expect(await closed).toBe(1008);
  });

  it("closes a socket that sends something the protocol does not define", async () => {
    const key = isolatedKey();
    const { ws } = await connect(key);
    const closed = new Promise<number>((resolve) => {
      ws.addEventListener("close", (event: CloseEvent) => resolve(event.code));
    });

    ws.send('{"t":"drop-tables"}');

    expect(await closed).toBe(1003);
  });
});

describe("resilience", () => {
  it("a repeat hello on one socket resolves to the same reviewer, not a second one", async () => {
    const key = isolatedKey();
    const { ws, inbox } = await connect(key);

    // Fired without awaiting a response in between: this is what actually
    // contends. Both `webSocketMessage` invocations for this socket's two
    // `hello`s are in flight together -- exactly the shape that would let a
    // stray `await` before the dedup check interleave them.
    send(ws, { t: "hello", lastSeenSeq: 0, nickname: "ada", persistent: false });
    send(ws, { t: "hello", lastSeenSeq: 0, nickname: "ada", persistent: false });

    const first = await inbox.next((m) => m.t === "snapshot", 2_000);
    const second = await inbox.next((m) => m.t === "snapshot", 2_000);
    if (first.t !== "snapshot" || second.t !== "snapshot") {
      throw new Error("expected two snapshots");
    }

    // Both hellos must resolve to the SAME reviewer id. Two different ids
    // would orphan the first one: it would never appear in presence again
    // (the socket's single attachment slot can only hold one), silently
    // burying whichever identity lost the race.
    expect(second.youAre).toBe(first.youAre);

    const grace = await join(key, "grace");
    expect(grace.snapshot.presence.filter((p) => p.nickname === "ada")).toHaveLength(1);

    // And nothing about the race consumed a sequence number that never got
    // broadcast -- the sibling project's actual bug. `hello` never appends to
    // the log, so the very next real event must still land on seq 1, not
    // seq 2 with a silent, unbroadcast gap at 1.
    send(grace.ws, {
      t: "openThread",
      clientSeq: 1,
      anchor: anchorFor("src/auth/session.ts", 15),
      body: "first comment after the hello race",
    });
    const ack = await grace.inbox.next((m) => m.t === "ack", 2_000);
    if (ack.t !== "ack") throw new Error("expected an ack");
    expect(ack.seq).toBe(1);
  });

  it("keeps broadcasting to the rest of the room after one socket goes bad", async () => {
    const key = isolatedKey();
    const bad = await join(key, "ada");
    const good = await join(key, "grace");

    let badClosed = false;
    bad.ws.addEventListener("close", () => {
      badClosed = true;
    });
    // A malformed message closes only the sender (see the earlier "closes a
    // socket" tests) -- but per the sibling project's Important 5, the
    // just-closed socket can still be enumerable by `ctx.getWebSockets()` for
    // a beat afterwards. Wait for the CLOSE to actually land client-side,
    // then force a broadcast and prove the room survives regardless.
    bad.ws.send('{"t":"drop-tables"}');
    for (let i = 0; i < 100 && !badClosed; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(badClosed).toBe(true);

    send(good.ws, {
      t: "openThread",
      clientSeq: 1,
      anchor: anchorFor("src/auth/session.ts", 15),
      body: "after a neighbor went bad",
    });

    // The actual property: the OTHER socket must still get its ack and its
    // own delta. An unguarded `ws.send` to the dead socket inside `broadcast`
    // would throw mid-loop, and depending on iteration order could silence
    // this delta (or the whole room) instead of just skipping the dead peer.
    const ack = await good.inbox.next((m) => m.t === "ack", 2_000);
    if (ack.t !== "ack") throw new Error("expected an ack");
    const delta = await good.inbox.next((m) => m.t === "delta" && m.seq === ack.seq, 2_000);
    if (delta.t !== "delta" || delta.event.type !== "threadOpened") {
      throw new Error("expected the threadOpened delta");
    }
    expect(delta.event.comment.body).toBe("after a neighbor went bad");
  });
});
