import { describe, it, expect, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { runArchiveOp, type ArchiveOp } from "../src/archive.js";
import { readOutbox } from "../src/sql.js";
import type { PrDO } from "../src/PrDO.js";
import { anchorFor, isolatedKey, join, send } from "./helpers.js";

const OP: ArchiveOp = { op: "removeThread", prKey: "k", threadId: "t" };

describe("runArchiveOp", () => {
  it("throws when no database is configured, so the row stays queued", async () => {
    // Silently succeeding would drop the archive on the floor in exactly the
    // configuration where it is most likely to be wrong: a deploy with the
    // secret unset.
    await expect(runArchiveOp(undefined, OP)).rejects.toThrow(/DATABASE_URL/iu);
    await expect(runArchiveOp("", OP)).rejects.toThrow(/DATABASE_URL/iu);
  });
});

describe("the outbox", () => {
  it("queues an archive on resolve and a delete on unresolve", async () => {
    const key = isolatedKey();
    const ada = await join(key, "ada");
    send(ada.ws, {
      t: "openThread",
      clientSeq: 1,
      anchor: anchorFor("src/auth/session.ts", 15),
      body: "double clock",
    });
    const opened = await ada.inbox.next((m) => m.t === "delta");
    if (opened.t !== "delta" || opened.event.type !== "threadOpened") {
      throw new Error("expected threadOpened");
    }
    const threadId = opened.event.threadId;

    send(ada.ws, { t: "resolve", clientSeq: 2, threadId });
    await ada.inbox.next((m) => m.t === "ack" && m.clientSeq === 2);

    const stub = env.PRS.get(env.PRS.idFromName(key));
    const afterResolve = await runInDurableObject(stub, (_instance: PrDO, state) =>
      readOutbox(state.storage.sql)
    );
    const archived = afterResolve.filter((row) => row.op.op === "archiveThread");
    expect(archived).toHaveLength(1);
    const op = archived[0]?.op;
    if (op?.op !== "archiveThread") throw new Error("expected archiveThread");
    expect(op.filePath).toBe("src/auth/session.ts");
    expect(op.line).toBe(15);
    expect(op.body).toBe("double clock");
    expect(op.commentCount).toBe(1);

    send(ada.ws, { t: "unresolve", clientSeq: 3, threadId });
    await ada.inbox.next((m) => m.t === "ack" && m.clientSeq === 3);

    const afterUnresolve = await runInDurableObject(stub, (_instance: PrDO, state) =>
      readOutbox(state.storage.sql)
    );
    expect(afterUnresolve.filter((row) => row.op.op === "removeThread")).toHaveLength(1);
  });

  it("keeps a failed write queued and drains it on a later alarm", async () => {
    // DATABASE_URL is unset throughout this test environment, so the first
    // drain fails for real rather than by mock.
    const key = isolatedKey();
    const ada = await join(key, "ada");
    send(ada.ws, {
      t: "openThread",
      clientSeq: 1,
      anchor: anchorFor("src/auth/session.ts", 15),
      body: "queue me",
    });
    const opened = await ada.inbox.next((m) => m.t === "delta");
    if (opened.t !== "delta" || opened.event.type !== "threadOpened") {
      throw new Error("expected threadOpened");
    }
    send(ada.ws, { t: "resolve", clientSeq: 2, threadId: opened.event.threadId });
    await ada.inbox.next((m) => m.t === "ack" && m.clientSeq === 2);

    const stub = env.PRS.get(env.PRS.idFromName(key));

    await runInDurableObject(stub, async (instance: PrDO) => {
      await instance.alarm();
    });
    const stillQueued = await runInDurableObject(stub, (_instance: PrDO, state) =>
      readOutbox(state.storage.sql)
    );
    expect(stillQueued.length).toBeGreaterThan(0);

    const fake = vi.fn(async () => {});
    await runInDurableObject(stub, async (instance: PrDO) => {
      (instance as unknown as { archiveFn: typeof fake }).archiveFn = fake;
      await instance.alarm();
    });

    const drained = await runInDurableObject(stub, (_instance: PrDO, state) =>
      readOutbox(state.storage.sql)
    );
    expect(drained).toEqual([]);
    expect(fake.mock.calls.length).toBeGreaterThan(0);
  });

  it("keeps the review fully usable while every archive write fails", async () => {
    // The constraint stated at the top of this plan: no live state depends on
    // Postgres. With DATABASE_URL unset, comments, replies and resolution all
    // have to keep working and stay visible to a second reviewer -- even
    // after a real, failed drain attempt.
    const key = isolatedKey();
    const ada = await join(key, "ada");
    const grace = await join(key, "grace");

    send(ada.ws, {
      t: "openThread",
      clientSeq: 1,
      anchor: anchorFor("src/auth/session.ts", 15),
      body: "still works",
    });
    const delta = await grace.inbox.next((m) => m.t === "delta");
    if (delta.t !== "delta" || delta.event.type !== "threadOpened") {
      throw new Error("expected threadOpened");
    }
    send(ada.ws, { t: "resolve", clientSeq: 2, threadId: delta.event.threadId });
    await ada.inbox.next((m) => m.t === "ack" && m.clientSeq === 2);

    // Force a real, failed drain (DATABASE_URL is unset in this test
    // environment) before checking that anything downstream still works --
    // otherwise this test would prove nothing that an empty archive.ts
    // stub couldn't also satisfy.
    const stub = env.PRS.get(env.PRS.idFromName(key));
    await runInDurableObject(stub, async (instance: PrDO) => {
      await instance.alarm();
    });
    const stillQueued = await runInDurableObject(stub, (_instance: PrDO, state) =>
      readOutbox(state.storage.sql)
    );
    expect(stillQueued.length).toBeGreaterThan(0);

    const observer = await join(key, "hopper");
    expect(observer.snapshot.threads.threads[delta.event.threadId]?.resolved).toBe(true);
  });
});

describe("PrDO#webSocketMessage", () => {
  it("acks two resolves fired back-to-back into one gap-free sequence, proving the archive enqueue adds no suspension point", async () => {
    // If archiving the resolve introduced an `await` into webSocketMessage,
    // a second message for this object could start running its own
    // synchronous work before the first one's tail (the archive enqueue)
    // finished -- the exact interleaving window the class is written to
    // never open. This does not conclusively rule that out, but a
    // gap-free, correctly-ordered pair of acks is what would be put at
    // risk first if it happened.
    const key = isolatedKey();
    const ada = await join(key, "ada");
    const grace = await join(key, "grace");

    send(ada.ws, {
      t: "openThread",
      clientSeq: 1,
      anchor: anchorFor("src/auth/session.ts", 15),
      body: "a",
    });
    const openedA = await ada.inbox.next((m) => m.t === "delta");
    send(grace.ws, {
      t: "openThread",
      clientSeq: 1,
      anchor: anchorFor("src/auth/token.ts", 5),
      body: "b",
    });
    const openedB = await grace.inbox.next((m) => m.t === "delta");
    if (openedA.t !== "delta" || openedA.event.type !== "threadOpened") {
      throw new Error("expected threadOpened");
    }
    if (openedB.t !== "delta" || openedB.event.type !== "threadOpened") {
      throw new Error("expected threadOpened");
    }

    send(ada.ws, { t: "resolve", clientSeq: 2, threadId: openedA.event.threadId });
    send(grace.ws, { t: "resolve", clientSeq: 2, threadId: openedB.event.threadId });

    const adaAck = await ada.inbox.next((m) => m.t === "ack" && m.clientSeq === 2);
    const graceAck = await grace.inbox.next((m) => m.t === "ack" && m.clientSeq === 2);
    if (adaAck.t !== "ack" || graceAck.t !== "ack") throw new Error("expected acks");
    expect([adaAck.seq, graceAck.seq].sort((a, b) => a - b)).toEqual([3, 4]);
  });
});
