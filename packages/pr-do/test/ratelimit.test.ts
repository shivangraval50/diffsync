import { describe, it, expect } from "vitest";
import { ACTION_CAPACITY } from "../src/ratelimit.js";
import { anchorFor, isolatedKey, join, send } from "./helpers.js";

describe("per-connection rate limiting", () => {
  it("rejects the action past the capacity, and only that connection", async () => {
    // Catches: (a) a limiter wired to the wrong reason (any reject would
    // pass an unchecked assertion, but this pins RATE_LIMITED specifically),
    // and (b) a limiter keyed by PR instead of by connection, which would
    // also refuse Grace's very first, otherwise-fresh request.
    const key = isolatedKey();
    const ada = await join(key, "ada");
    const grace = await join(key, "grace");
    const anchor = anchorFor("src/auth/session.ts", 15);

    for (let i = 0; i < ACTION_CAPACITY; i += 1) {
      send(ada.ws, { t: "openThread", clientSeq: i + 1, anchor, body: `flood ${i}` });
    }
    await ada.inbox.next((m) => m.t === "ack" && m.clientSeq === ACTION_CAPACITY);

    send(ada.ws, { t: "openThread", clientSeq: 999, anchor, body: "one too many" });
    const reject = await ada.inbox.next((m) => m.t === "reject");
    expect(reject).toEqual({ t: "reject", clientSeq: 999, reason: "RATE_LIMITED" });

    // Grace's own budget is untouched: the limit is per connection, not per
    // pull request, or one noisy reviewer would mute the room.
    send(grace.ws, { t: "openThread", clientSeq: 1, anchor, body: "grace still works" });
    const ack = await grace.inbox.next((m) => m.t === "ack");
    expect(ack.t).toBe("ack");
  });

  it("does not append the rate-limited action to the log", async () => {
    // Catches a limiter that lets more than `capacity` commits through (log
    // would be longer than 10), and, symmetrically, one that silently drops
    // an allowed request rather than committing it (log would be shorter
    // than 10) -- a dropped-and-unrejected message looks identical to a
    // correctly-rejected one unless something checks the committed count.
    const key = isolatedKey();
    const ada = await join(key, "ada");
    const anchor = anchorFor("src/auth/session.ts", 15);

    for (let i = 0; i < ACTION_CAPACITY + 5; i += 1) {
      send(ada.ws, { t: "openThread", clientSeq: i + 1, anchor, body: `flood ${i}` });
    }
    await ada.inbox.next((m) => m.t === "reject");

    const observer = await join(key, "grace");
    expect(observer.snapshot.threads.order).toHaveLength(ACTION_CAPACITY);
  });

  it("still counts a token spent on an action that is then rejected for a bad anchor", async () => {
    // Catches a limiter that is only consulted AFTER anchor verification: if
    // invalid-anchor requests were free, a client could flood with
    // deliberately bad anchors at no budget cost, and every one of them
    // would still have made the object do the anchor-verification work the
    // limit exists to bound.
    const key = isolatedKey();
    const ada = await join(key, "ada");
    const bad = { ...anchorFor("src/auth/session.ts", 15), filePath: "src/nope.ts" };

    for (let i = 0; i < ACTION_CAPACITY; i += 1) {
      send(ada.ws, { t: "openThread", clientSeq: i + 1, anchor: bad, body: "bad" });
    }
    await ada.inbox.next((m) => m.t === "reject" && m.clientSeq === ACTION_CAPACITY);

    send(ada.ws, {
      t: "openThread",
      clientSeq: 500,
      anchor: anchorFor("src/auth/session.ts", 15),
      body: "a perfectly good comment",
    });
    const reject = await ada.inbox.next((m) => m.t === "reject" && m.clientSeq === 500);
    if (reject.t !== "reject") throw new Error("expected a reject");
    expect(reject.reason).toBe("RATE_LIMITED");
  });

  it("drops an over-budget cursor move silently instead of rejecting it", async () => {
    // Catches a limiter wired the same way for cursor as for actions (would
    // emit a reject frame the client has nothing to do with), and catches a
    // cursor limiter that is never consulted at all (the 31st move below
    // would then be accepted and presence would show line 31, not 30).
    const CURSOR_CAPACITY = 30;
    const key = isolatedKey();
    const ada = await join(key, "ada");

    // 30 moves, all within budget: lines 1..30.
    for (let i = 0; i < CURSOR_CAPACITY; i += 1) {
      send(ada.ws, { t: "cursor", filePath: "src/auth/token.ts", line: i + 1 });
    }
    // 5 more, over budget: these must be dropped, not applied.
    for (let i = 0; i < 5; i += 1) {
      send(ada.ws, { t: "cursor", filePath: "src/auth/token.ts", line: CURSOR_CAPACITY + i + 1 });
    }

    // Messages on one connection are processed in order, so re-sending
    // `hello` here queues behind every cursor move above; the resulting
    // snapshot is a deterministic read of server state after all of them
    // have landed (or been dropped), with no dependence on wall-clock
    // timing or on catching a specific presence broadcast.
    send(ada.ws, { t: "hello", lastSeenSeq: 0, nickname: "ada", persistent: false });
    const resnapshot = await ada.inbox.next((m) => m.t === "snapshot");
    if (resnapshot.t !== "snapshot") throw new Error("expected a snapshot");
    const adaPresence = resnapshot.presence.find((p) => p.reviewerId === resnapshot.youAre);
    expect(adaPresence?.cursor).toEqual({ filePath: "src/auth/token.ts", line: CURSOR_CAPACITY });

    // And no cursor move ever produced a reject frame. By this point every
    // message sent above has already been processed (proven by the
    // deterministic snapshot read), so this is a short bounded wait, not a
    // real-time race.
    await expect(ada.inbox.next((m) => m.t === "reject", 50)).rejects.toThrow();
  });
});
