import { describe, it, expect, vi } from "vitest";
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { createAnchor, type Anchor } from "@diffsync/anchor";
import { anchorTargets } from "@diffsync/diff";
import { encodePrKey, sourceResultSchema } from "@diffsync/protocol";
import type { PrDO } from "../src/PrDO.js";
import type { GithubResult } from "../src/github.js";
import { anchorFor, Inbox, join, send } from "./helpers.js";

/** One GitHub pull request, a fresh Durable Object per test. */
function githubKey(): string {
  return encodePrKey(
    { kind: "github", owner: "owner", repo: "repo", number: 7 },
    crypto.randomUUID().replace(/-/gu, "")
  );
}

/** Install a fake GitHub client on the Durable Object behind `key`. */
async function withFakeGithub(
  key: string,
  fake: (ref: { owner: string; repo: string; number: number }) => Promise<GithubResult>
): Promise<{ calls: () => number }> {
  const stub = env.PRS.get(env.PRS.idFromName(key));
  const spy = vi.fn(fake);
  await runInDurableObject(stub, (instance: PrDO) => {
    (instance as unknown as { fetchPr: typeof spy }).fetchPr = spy;
  });
  return { calls: () => spy.mock.calls.length };
}

const OK_PR: GithubResult = {
  kind: "ok",
  pr: {
    ref: { kind: "github", owner: "owner", repo: "repo", number: 7 },
    title: "A real pull request",
    author: "octocat",
    headSha: "gh-head-1",
    baseSha: "gh-base-1",
    files: [
      {
        kind: "patch",
        path: "src/a.ts",
        previousPath: null,
        blobSha: "gh-blob-a",
        status: "modified",
        hunks: [
          {
            oldStart: 1,
            oldCount: 1,
            newStart: 1,
            newCount: 1,
            heading: "",
            lines: [
              { kind: "removed", text: "a", oldLine: 1 },
              { kind: "added", text: "b", newLine: 1 },
            ],
          },
        ],
      },
      {
        // A second, independent anchor target, so two threads opened
        // concurrently can land on genuinely different anchors (matching the
        // existing "serialises two threads opened at the same instant" test
        // in review.test.ts, which uses the seeded fixture's two files the
        // same way).
        kind: "patch",
        path: "src/b.ts",
        previousPath: null,
        blobSha: "gh-blob-b",
        status: "modified",
        hunks: [
          {
            oldStart: 1,
            oldCount: 1,
            newStart: 1,
            newCount: 1,
            heading: "",
            lines: [
              { kind: "removed", text: "x", oldLine: 1 },
              { kind: "added", text: "y", newLine: 1 },
            ],
          },
        ],
      },
    ],
  },
};

/** A genuine anchor computed against `OK_PR`'s own content, the same way
 *  `anchorFor` in helpers.ts does it for the seeded fixture. */
function anchorInOkPr(path: string, line: number): Anchor {
  if (OK_PR.kind !== "ok") throw new Error("OK_PR is not ok");
  const target = anchorTargets(OK_PR.pr).get(path);
  if (target === undefined) throw new Error(`no target for ${path}`);
  const anchor = createAnchor(target, line);
  if (anchor === null) throw new Error(`no line ${line} in ${path}`);
  return anchor;
}

/** A deferred `GithubResult`, so a test can hold `fetchGithubPr` open and
 *  choose exactly when it resolves -- the only way to make `resolveSource`
 *  genuinely suspend rather than settle on the next microtask. */
function deferredGithub(): {
  promise: Promise<GithubResult>;
  resolve: (result: GithubResult) => void;
} {
  let resolve!: (result: GithubResult) => void;
  const promise = new Promise<GithubResult>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Starts the `/ws` upgrade without awaiting it. Because `resolveSource` now
 *  runs inside this call (see PrDO.ts), the returned promise will not settle
 *  -- and therefore no message can be sent on the resulting socket -- until
 *  whatever `fetchPr` is doing finishes. */
function beginConnect(key: string): Promise<Response> {
  return SELF.fetch(`https://do.test/prs/${key}/ws`, { headers: { Upgrade: "websocket" } });
}

async function acceptConnection(pending: Promise<Response>): Promise<{ ws: WebSocket; inbox: Inbox }> {
  const res = await pending;
  const ws = res.webSocket;
  if (!ws) throw new Error(`no websocket in response (status ${res.status})`);
  ws.accept();
  return { ws, inbox: new Inbox(ws) };
}

/**
 * Yields real macrotask turns until `fetchPr` has actually been called, so a
 * test can prove the deferred promise it is about to resolve was genuinely
 * still pending -- something already in flight, not a promise that settles
 * before anything ever subscribes to it. Without this, resolving `deferred`
 * synchronously right after issuing two connection attempts (with no
 * `await` in between) would race the DO's own code for the CPU: Workers run
 * single-threaded, so nothing on the DO side can run at all until this test
 * function itself yields, and if `resolve()` runs before that first yield,
 * `fetchPr` is called against an ALREADY-settled promise -- a same-tick
 * resolution, not a suspension.
 */
async function waitForCalls(github: { calls: () => number }, atLeast: number): Promise<void> {
  for (let i = 0; i < 100 && github.calls() < atLeast; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(github.calls()).toBeGreaterThanOrEqual(atLeast);
}

describe("the GitHub source path", () => {
  it("serves a fetched pull request and caches it", async () => {
    const key = githubKey();
    const github = await withFakeGithub(key, async () => OK_PR);

    const first = sourceResultSchema.parse(
      await (await SELF.fetch(`https://do.test/prs/${key}/source`)).json()
    );
    expect(first.origin).toBe("github");
    expect(first.pr.title).toBe("A real pull request");

    const second = sourceResultSchema.parse(
      await (await SELF.fetch(`https://do.test/prs/${key}/source`)).json()
    );
    expect(second.pr.headSha).toBe("gh-head-1");
    // Cached per PR in the Durable Object: the second view must not spend
    // another request from a 60-per-hour quota shared by every visitor.
    // Catches: a resolveSource that forgets its own confirmed cache and
    // re-fetches on every view, burning through the shared quota for no
    // reason.
    expect(github.calls()).toBe(1);
  });

  it("falls back to the seeded fixture when the quota is exhausted", async () => {
    const key = githubKey();
    await withFakeGithub(key, async () => ({ kind: "rate_limited" }));

    const result = sourceResultSchema.parse(
      await (await SELF.fetch(`https://do.test/prs/${key}/source`)).json()
    );
    if (result.origin !== "fallback") throw new Error(`expected fallback, got ${result.origin}`);
    expect(result.reason).toBe("rate_limited");
    // And it is a real, reviewable pull request, not an empty shell. Catches:
    // a fallback path that returns something schema-valid but content-empty
    // (e.g. files: []), which would satisfy `sourceResultSchema` while still
    // leaving the visitor facing an empty app.
    expect(result.pr.files.length).toBeGreaterThan(0);
    expect(result.pr.files.map((f) => f.path)).toContain("src/auth/session.ts");
  });

  it("falls back with the reason `not_found` for a pull request that does not exist", async () => {
    const key = githubKey();
    await withFakeGithub(key, async () => ({ kind: "not_found" }));
    const result = sourceResultSchema.parse(
      await (await SELF.fetch(`https://do.test/prs/${key}/source`)).json()
    );
    if (result.origin !== "fallback") throw new Error("expected fallback");
    expect(result.reason).toBe("not_found");
  });

  it("does not cache a fallback, so the next view retries GitHub", async () => {
    // Caching a rate-limit outcome would keep serving the fixture for as long
    // as the object lives, long after the quota reset an hour later. Catches:
    // the naive fix for the caching test above -- "if cachedSource !== null,
    // return it" -- which would also freeze a fallback in place forever,
    // since a fallback DOES get stored on `cachedSource` (so live sockets can
    // read it synchronously; see the resilience tests below).
    const key = githubKey();
    let outcome: GithubResult = { kind: "rate_limited" };
    const github = await withFakeGithub(key, async () => outcome);

    const first = sourceResultSchema.parse(
      await (await SELF.fetch(`https://do.test/prs/${key}/source`)).json()
    );
    expect(first.origin).toBe("fallback");

    outcome = OK_PR;
    const second = sourceResultSchema.parse(
      await (await SELF.fetch(`https://do.test/prs/${key}/source`)).json()
    );
    expect(second.origin).toBe("github");
    expect(github.calls()).toBe(2);
  });

  it("reviewers can still comment on a fallback pull request, without spending another request per message", async () => {
    // The fallback is a working review surface, not a placeholder. If the
    // anchors did not match the fixture that was actually served, every
    // comment would be rejected as STALE_ANCHOR. Catches: a test that only
    // checks the snapshot and calls it "commenting works" (the thing this
    // test's own name would be lying about if it stopped at `join`) -- and,
    // separately, a `webSocketMessage` that re-attempts GitHub on every
    // message while stuck serving a fallback, which would turn a rate limit
    // into a network round-trip on every keystroke-equivalent action.
    const key = githubKey();
    const github = await withFakeGithub(key, async () => ({ kind: "unavailable" }));
    const ada = await join(key, "ada");
    expect(ada.snapshot.threads.order).toEqual([]);
    expect(github.calls()).toBe(1);

    send(ada.ws, {
      t: "openThread",
      clientSeq: 1,
      anchor: anchorFor("src/auth/session.ts", 15),
      body: "commenting on the fallback",
    });
    const ack = await ada.inbox.next((m) => m.t === "ack", 2_000);
    if (ack.t !== "ack") throw new Error("expected an ack, not a reject");
    expect(ack.seq).toBe(1);

    // Several more messages on the still-rate-limited connection must not
    // cost another request from the shared quota.
    send(ada.ws, { t: "cursor", filePath: "src/auth/token.ts", line: 5 });
    send(ada.ws, { t: "ping", clientTime: Date.now() });
    await ada.inbox.next((m) => m.t === "pong", 2_000);
    expect(github.calls()).toBe(1);
  });
});

describe("POST /prs/:key/refresh", () => {
  it("advances a fixture to its next revision and tells connected reviewers", async () => {
    // Its own nonce: advancing the shared sample would change what
    // review.test.ts's /source assertions see.
    const key = encodePrKey(
      { kind: "fixture", slug: "auth-refactor", revision: 1 },
      crypto.randomUUID().replace(/-/gu, "")
    );
    const ada = await join(key, "ada");

    const res = await SELF.fetch(`https://do.test/prs/${key}/refresh`, {
      method: "POST",
      body: JSON.stringify({ revision: 2 }),
    });
    expect(res.status).toBe(200);

    const changed = await ada.inbox.next((m) => m.t === "sourceChanged");
    if (changed.t !== "sourceChanged") throw new Error("expected sourceChanged");
    expect(changed.headSha).toBe("9f8e7d6c5b4a39281706f5e4d3c2b1a098765432");

    const source = sourceResultSchema.parse(
      await (await SELF.fetch(`https://do.test/prs/${key}/source`)).json()
    );
    expect(source.pr.headSha).toBe("9f8e7d6c5b4a39281706f5e4d3c2b1a098765432");
  });

  it("400s a revision the fixture does not have", async () => {
    const key = encodePrKey({ kind: "fixture", slug: "parser-bugfix", revision: 1 });
    const res = await SELF.fetch(`https://do.test/prs/${key}/refresh`, {
      method: "POST",
      body: JSON.stringify({ revision: 9 }),
    });
    expect(res.status).toBe(400);
  });

  it("re-fetches from GitHub for a GitHub key", async () => {
    const key = githubKey();
    const github = await withFakeGithub(key, async () => OK_PR);
    await SELF.fetch(`https://do.test/prs/${key}/source`);
    await SELF.fetch(`https://do.test/prs/${key}/refresh`, { method: "POST", body: "{}" });
    expect(github.calls()).toBe(2);
  });
});

/**
 * Task 9 proved two things about `webSocketMessage` under the assumption
 * that `resolveSource` never genuinely suspends (the fixture-only path had
 * zero real `await`s). Task 11 makes `resolveSource` a real, occasionally
 * slow, network fetch. These tests re-prove the same two properties against
 * a `fetchPr` that is DEFERRED -- under the test's control, not the
 * microtask queue's -- to force genuine concurrency rather than assume it
 * away.
 *
 * The fix landed in PrDO.ts is exactly the one the brief for this task
 * predicted: `webSocketMessage` never calls `resolveSource` any more. It
 * reads `currentSource()`, a synchronous field read, and the genuinely
 * suspending call only ever happens in `fetch()`'s `/source` and `/ws`
 * branches -- both of which complete (or fail) before a socket exists or a
 * request resolves, so nothing can ever race a suspended `webSocketMessage`
 * invocation, because there is no such thing any more. The tests below
 * construct the closest thing to the brief's literal scenario that this
 * architecture actually allows: two independent connections racing a single,
 * still-pending, shared fetch (the only place a real suspension can still
 * coincide with live traffic), then drive the exact Task 9 assertions
 * against the sockets that come out of it.
 */
describe("resilience: the repeat-hello guard and the append log under a genuinely suspending resolveSource", () => {
  it("keeps the repeat-hello guard correct when the fetch behind it is still pending while two sockets race it", async () => {
    const key = githubKey();
    const { promise, resolve } = deferredGithub();
    const github = await withFakeGithub(key, () => promise);

    // Two browser tabs opening the same cold pull request at once. Neither
    // `/ws` call can return -- and therefore neither socket can exist,
    // client-side -- until `fetchPr` settles. Both invocations are
    // genuinely, concurrently suspended on the exact same unresolved
    // promise right now.
    const pendingA = beginConnect(key);
    const pendingB = beginConnect(key);

    // Prove the suspension is real before ending it: `fetchPr` must have
    // actually been reached (and be genuinely waiting on `promise`) before
    // this test resolves it.
    await waitForCalls(github, 1);
    resolve(OK_PR);
    const [a, b] = await Promise.all([acceptConnection(pendingA), acceptConnection(pendingB)]);

    // Coalesced onto the one fetch already in flight, not spent twice from
    // the quota every visitor shares. This is also the proof that the race
    // above was real: two connection attempts landed on ONE `fetchPr` call.
    expect(github.calls()).toBe(1);

    // The Task 9 property itself: two hellos fired on one socket without
    // awaiting a reply in between.
    send(a.ws, { t: "hello", lastSeenSeq: 0, nickname: "ada", persistent: false });
    send(a.ws, { t: "hello", lastSeenSeq: 0, nickname: "ada", persistent: false });

    const first = await a.inbox.next((m) => m.t === "snapshot", 2_000);
    const second = await a.inbox.next((m) => m.t === "snapshot", 2_000);
    if (first.t !== "snapshot" || second.t !== "snapshot") {
      throw new Error("expected two snapshots");
    }
    // Both hellos must resolve to the SAME reviewer id -- a second id would
    // orphan the first, silently burying whichever identity lost the race.
    expect(second.youAre).toBe(first.youAre);

    send(b.ws, { t: "hello", lastSeenSeq: 0, nickname: "grace", persistent: false });
    const graceSnapshot = await b.inbox.next((m) => m.t === "snapshot", 2_000);
    if (graceSnapshot.t !== "snapshot") throw new Error("expected a snapshot");
    expect(graceSnapshot.presence.filter((p) => p.nickname === "ada")).toHaveLength(1);

    // And nothing about the race consumed a sequence number that never got
    // broadcast: `hello` never appends to the log, so the very next real
    // event still lands on seq 1.
    send(b.ws, { t: "openThread", clientSeq: 1, anchor: anchorInOkPr("src/a.ts", 1), body: "first" });
    const ack = await b.inbox.next((m) => m.t === "ack", 2_000);
    if (ack.t !== "ack") throw new Error("expected an ack");
    expect(ack.seq).toBe(1);
  });

  it("keeps the append-only log correctly ordered when two openThreads come from connections that raced a shared, in-flight fetch", async () => {
    const key = githubKey();
    const { promise, resolve } = deferredGithub();
    const github = await withFakeGithub(key, () => promise);

    const pendingA = beginConnect(key);
    const pendingB = beginConnect(key);
    await waitForCalls(github, 1);
    resolve(OK_PR);
    const [a, b] = await Promise.all([acceptConnection(pendingA), acceptConnection(pendingB)]);
    expect(github.calls()).toBe(1);

    send(a.ws, { t: "hello", lastSeenSeq: 0, nickname: "ada", persistent: false });
    send(b.ws, { t: "hello", lastSeenSeq: 0, nickname: "grace", persistent: false });
    await a.inbox.next((m) => m.t === "snapshot");
    await b.inbox.next((m) => m.t === "snapshot");

    // Two opens, on two different anchors, fired without awaiting either ack
    // in between. This is the property Task 9 proved for the fixture-only
    // path: a gap-free, definite sequence -- {1, 2} in whichever order the
    // DO actually processed them -- produced for free by the Durable Object
    // being single-threaded. Re-proved here with the connections that
    // produced these sockets having themselves raced a genuine, shared,
    // in-flight network fetch to get here.
    send(a.ws, {
      t: "openThread",
      clientSeq: 1,
      anchor: anchorInOkPr("src/a.ts", 1),
      body: "from ada",
    });
    send(b.ws, {
      t: "openThread",
      clientSeq: 1,
      anchor: anchorInOkPr("src/b.ts", 1),
      body: "from grace",
    });

    const adaAck = await a.inbox.next((m) => m.t === "ack", 2_000);
    const graceAck = await b.inbox.next((m) => m.t === "ack", 2_000);
    if (adaAck.t !== "ack" || graceAck.t !== "ack") throw new Error("expected acks");
    expect([adaAck.seq, graceAck.seq].sort((x, y) => x - y)).toEqual([1, 2]);

    // And both threads landed, in one definite order, with the right bodies
    // -- not just "two acks came back", which would also pass if one thread
    // silently clobbered the other's storage row.
    const third = await join(key, "hopper");
    expect(third.snapshot.threads.order).toHaveLength(2);
    const bodies = third.snapshot.threads.order.map(
      (id) => third.snapshot.threads.threads[id]?.comments[0]?.body
    );
    expect(bodies.sort()).toEqual(["from ada", "from grace"]);
  });
});
