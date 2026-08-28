import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { createAnchor, type Anchor } from "@diffsync/anchor";
import { toAnchorTarget, type PullRequest } from "@diffsync/diff";
import {
  fixturePullRequest,
  fixtureRevisionCount,
  FALLBACK_FIXTURE_SLUG,
} from "@diffsync/fixtures";
import {
  decodePrKey,
  encode,
  parseClientMessage,
  prLabel,
  type Presence,
  type RejectReason,
  type ServerMessage,
  type SourceResult,
} from "@diffsync/protocol";
import { applyEvent, emptyThreads, type ReviewEvent, type ThreadsState } from "@diffsync/threads";
import { runArchiveOp, type ArchiveOp } from "./archive.js";
import { fetchGithubPr } from "./github.js";
import {
  ACTION_CAPACITY,
  ACTION_WINDOW_MS,
  CURSOR_CAPACITY,
  CURSOR_WINDOW_MS,
  newBucket,
  takeToken,
  type Bucket,
} from "./ratelimit.js";
import {
  appendEvent,
  currentSeq,
  deleteOutbox,
  enqueue,
  getMeta,
  initSchema,
  putMeta,
  readEventsSince,
  readOutbox,
} from "./sql.js";

interface Attachment {
  reviewerId: string;
  nickname: string;
  /** Client-asserted (this Worker has no Auth.js session) and used only to
   *  label a reviewer as signed in. Not a security boundary. */
  persistent: boolean;
  cursor: { filePath: string; line: number } | null;
  actions: Bucket;
  cursors: Bucket;
}

export interface PrEnv {
  DATABASE_URL?: string;
}

/** Above this many missed events, a reconnecting client gets a fresh snapshot
 *  instead of a long replay. */
export const SNAPSHOT_THRESHOLD = 500;

/**
 * Replay the gap, or send a snapshot alone? `lastSeenSeq === 0` means "I have
 * seen nothing yet", which the snapshot already covers. Pure transport
 * bookkeeping; no review rule lives here.
 */
export function shouldReplay(lastSeenSeq: number, latestSeq: number, threshold: number): boolean {
  if (lastSeenSeq <= 0) return false;
  return latestSeq - lastSeenSeq <= threshold;
}

/**
 * `POST /prs/:key/refresh`'s body, for the fixture branch only (the GitHub
 * branch takes no body). Parsed with `.safeParse`, not cast: a top-level
 * JSON `null` is valid JSON but not an object, and `(body as { revision?:
 * unknown }).revision` on it throws a synchronous `TypeError` that this
 * function's caller (`fetch()`) never catches -- an unhandled 500 instead of
 * a clean 400 for a malformed request.
 */
const refreshBodySchema = z.object({ revision: z.number().int().optional() });

export class PrDO extends DurableObject {
  private cachedThreads: ThreadsState | null = null;

  /**
   * The most recently resolved pull request, of ANY origin -- including
   * "fallback". Read synchronously by `currentSource()` (see
   * `webSocketMessage`) and by `resolveSource` below. Never awaited on: every
   * write to this field happens at the end of an already-resolved async
   * function, never mid-await, so a synchronous read of it is never torn.
   */
  private cachedSource: SourceResult | null = null;

  /**
   * Coalesces concurrent callers of `loadSource` (e.g. two `/ws` handshakes
   * racing a cold cache) onto the one fetch already in flight, rather than
   * spending a second request from the 60-per-hour quota every visitor
   * shares.
   */
  private sourceLoad: Promise<SourceResult | null> | null = null;

  /**
   * Production always uses the real client. Tests replace this through
   * `runInDurableObject`, because the alternative -- letting the suite reach
   * api.github.com -- would make the rate-limit and fallback tests depend on a
   * shared, exhaustible, third-party quota.
   */
  private fetchPr: typeof fetchGithubPr = fetchGithubPr;

  /**
   * Production always uses the real writer. Tests install a resolving fake:
   * DATABASE_URL is deliberately unset across this package's test environment
   * so the failure path is exercised for real, which otherwise makes the
   * success path -- a row actually disappearing after a successful write --
   * unreachable from any test.
   */
  private archiveFn: typeof runArchiveOp = runArchiveOp;

  private static readonly RETRY_MS = 60_000;

  private readonly roomEnv: PrEnv;

  constructor(ctx: DurableObjectState, env: PrEnv) {
    super(ctx, env as never);
    this.roomEnv = env;
    initSchema(this.ctx.storage.sql);
  }

  /** Rebuild thread state from the event log. Survives eviction with no extra
   *  bookkeeping, and uses the same reducer the browser runs. */
  private threads(): ThreadsState {
    if (this.cachedThreads !== null) return this.cachedThreads;
    const state = readEventsSince(this.ctx.storage.sql, 0).reduce(
      (acc, row) => applyEvent(acc, row.event),
      emptyThreads()
    );
    this.cachedThreads = state;
    return state;
  }

  /**
   * The pull request this object is about, resolved (and possibly fetched
   * from GitHub) if necessary. Called ONLY from `fetch()` -- the `/source`
   * and `/ws` branches below -- never from `webSocketMessage`. That split is
   * deliberate: this function is allowed to make a real, slow, occasionally
   * failing network call, and the two places that call it are exactly the
   * two places where nothing else can be racing it yet (no socket exists
   * before `/ws` returns one; `/source` is a plain one-shot HTTP response).
   * `webSocketMessage`, which DOES run concurrently with itself once a
   * socket is live, uses `currentSource()` instead -- a synchronous read
   * that never awaits a fetch. See the comment there for why that split is
   * load-bearing, not just tidy.
   *
   * A `fallback` result is deliberately treated as "not resolved": it is
   * kept on `this.cachedSource` (so `currentSource()` has something to serve
   * meanwhile) but never persisted, and this function does not short-circuit
   * on it. The next `/source` view or `/ws` connection attempt tries GitHub
   * again -- required because the shared 60-per-hour quota resets in an
   * hour, long before this object is likely to be evicted.
   */
  protected async resolveSource(key: string): Promise<SourceResult | null> {
    if (this.cachedSource !== null && this.cachedSource.origin !== "fallback") {
      return this.cachedSource;
    }

    const persisted = getMeta(this.ctx.storage.sql, "source");
    if (persisted !== null) {
      this.cachedSource = JSON.parse(persisted) as SourceResult;
      return this.cachedSource;
    }

    return this.loadSource(key);
  }

  /**
   * Resolve the pull request from its true source, replacing anything
   * cached, and coalescing concurrent callers onto one attempt.
   */
  private loadSource(key: string): Promise<SourceResult | null> {
    if (this.sourceLoad !== null) return this.sourceLoad;
    const promise = this.doLoadSource(key).finally(() => {
      this.sourceLoad = null;
    });
    this.sourceLoad = promise;
    return promise;
  }

  private async doLoadSource(key: string): Promise<SourceResult | null> {
    const ref = decodePrKey(key);
    if (ref === null) return null;

    if (ref.kind === "fixture") {
      const pr = fixturePullRequest(ref.slug, ref.revision);
      if (pr === null) return null;
      const result: SourceResult = { origin: "fixture", pr };
      this.cacheSource(result);
      return result;
    }

    // `ref` came out of `decodePrKey`, whose `isSafeName` guard rejects "/",
    // ".", and ".." for `owner` and `repo` -- the traversal guard that makes
    // it safe for `fetchGithubPr` to interpolate these into a request URL.
    const fetched = await this.fetchPr({ owner: ref.owner, repo: ref.repo, number: ref.number });
    if (fetched.kind === "ok") {
      const result: SourceResult = { origin: "github", pr: fetched.pr, fetchedAtMs: Date.now() };
      this.cacheSource(result);
      return result;
    }

    // A failed fetch must never erase a source someone is already relying
    // on. That includes a `/refresh` that could not reach GitHub this time:
    // without this check, a DO already serving a confirmed `github` result
    // would have it silently replaced by the unrelated fallback fixture on
    // every transient network blip. If anything at all is already cached --
    // a good result OR a previous fallback -- keep serving exactly that
    // (including its original `reason`, if it was a fallback) rather than
    // manufacturing a new one from this attempt's failure.
    if (this.cachedSource !== null) return this.cachedSource;

    const fallbackPr = fixturePullRequest(FALLBACK_FIXTURE_SLUG, 1);
    if (fallbackPr === null) return null;
    const fallback: SourceResult = { origin: "fallback", pr: fallbackPr, reason: fetched.kind };
    // Held on `this.cachedSource` (see its own docstring) but never written
    // to storage -- caching a rate-limit outcome there would keep serving
    // the sample pull request for as long as this object lives, long after
    // the shared quota reset an hour later.
    this.cachedSource = fallback;
    return fallback;
  }

  private cacheSource(result: SourceResult): void {
    putMeta(this.ctx.storage.sql, "source", JSON.stringify(result));
    this.cachedSource = result;
    this.queue({
      op: "upsertPr",
      prKey: this.prKey(),
      kind: result.pr.ref.kind,
      label: prLabel(result.pr.ref),
      title: result.pr.title,
      headSha: result.pr.headSha,
      origin: result.origin,
    });
  }

  /**
   * Append one archive op to the outbox and make sure an alarm exists to
   * drain it later. Deliberately synchronous -- no `async`, no `await` --
   * because this is also called from `webSocketMessage`'s resolve/unresolve
   * branch, and that handler must contain no suspension point at all (see
   * `currentSource`'s docstring above): an `await` there would let a second,
   * concurrently-arriving message for this same object start running before
   * this one's tail finished, exactly the interleaving window the class is
   * written to keep closed.
   *
   * The outbox insert (`enqueue`) is a plain synchronous `sql.exec` call, so
   * it is already safe to call from anywhere. Only the alarm write is a
   * `Promise`; it is handed to `ctx.waitUntil` rather than dropped, so the
   * write still lands even if this Durable Object would otherwise hibernate
   * before it settles -- without `queue` itself ever suspending.
   */
  private queue(op: ArchiveOp): void {
    enqueue(this.ctx.storage.sql, op);
    this.ctx.waitUntil(this.ensureAlarm());
  }

  private async ensureAlarm(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) await this.ctx.storage.setAlarm(Date.now() + PrDO.RETRY_MS);
  }

  /**
   * The synchronous counterpart to `resolveSource`, for `webSocketMessage`
   * only. Contains no `await` at all: a plain field read, falling back to a
   * plain (synchronous) SQL read for a socket whose Durable Object just woke
   * from hibernation with an empty `cachedSource`. Never attempts a fetch --
   * that is the whole point. If GitHub is being retried in the background
   * (another connection's fresh `resolveSource` call) this may serve a
   * `fallback` a beat longer than strictly necessary, which is a fine trade
   * for never blocking a live message on a network call.
   */
  private currentSource(): SourceResult | null {
    if (this.cachedSource !== null) return this.cachedSource;
    const persisted = getMeta(this.ctx.storage.sql, "source");
    if (persisted === null) return null;
    this.cachedSource = JSON.parse(persisted) as SourceResult;
    return this.cachedSource;
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(encode(msg));
    } catch {
      // The socket may already be closing. One dead peer must not blow up the
      // caller, and in particular must not blow up `broadcast`'s loop.
    }
  }

  private broadcast(msg: ServerMessage): void {
    const payload = encode(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // Same as `send`: a socket mid-close must not take the room down.
      }
    }
  }

  private presence(): Presence[] {
    const out: Presence[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment === null) continue; // connected but has not said hello
      out.push({
        reviewerId: attachment.reviewerId,
        nickname: attachment.nickname,
        persistent: attachment.persistent,
        cursor: attachment.cursor,
      });
    }
    return out;
  }

  private broadcastPresence(): void {
    this.broadcast({ t: "presence", presence: this.presence() });
  }

  private reject(ws: WebSocket, clientSeq: number, reason: RejectReason): void {
    this.send(ws, { t: "reject", clientSeq, reason });
  }

  /**
   * Append an event, broadcast it to the room, and ack its author.
   *
   * Broadcast happens before the ack, and on purpose: `broadcast` reaches the
   * author's own socket too, so that socket sees the delta and then the ack
   * for the same sequence. Any client that clears optimistic state on the ack
   * therefore never has a frame where the optimistic comment is gone but the
   * authoritative one has not arrived.
   */
  private commit(ws: WebSocket, clientSeq: number, event: ReviewEvent): void {
    const seq = appendEvent(this.ctx.storage.sql, event);
    this.cachedThreads = applyEvent(this.threads(), event);
    const serverTime = Date.now();
    this.broadcast({ t: "delta", seq, serverTime, event });
    this.send(ws, { t: "ack", clientSeq, seq });
  }

  private prKey(): string {
    return getMeta(this.ctx.storage.sql, "prKey") ?? "";
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const key = url.pathname.split("/")[2] ?? "";
    putMeta(this.ctx.storage.sql, "prKey", key);

    if (request.method === "POST" && url.pathname.endsWith("/refresh")) {
      const ref = decodePrKey(key);
      if (ref === null) return new Response("no such pull request", { status: 404 });

      if (ref.kind === "fixture") {
        const parsedBody = refreshBodySchema.safeParse(await request.json().catch(() => ({})));
        if (!parsedBody.success) return new Response("invalid refresh body", { status: 400 });
        const revision = parsedBody.data.revision ?? ref.revision;
        if (revision < 1 || revision > fixtureRevisionCount(ref.slug)) {
          return new Response("no such revision", { status: 400 });
        }
        const pr = fixturePullRequest(ref.slug, revision);
        if (pr === null) return new Response("no such revision", { status: 400 });
        // Models a force-push: same pull request, same comment log, new head.
        this.cacheSource({ origin: "fixture", pr });
      } else {
        // Deliberately do NOT null `cachedSource` or delete the persisted
        // row before this await. `currentSource()` -- read by every
        // in-flight `webSocketMessage`, on this connection AND every
        // sibling connected to this same pull request -- has no visibility
        // into "a reload is in progress"; it just reads whatever is
        // cached. Clearing it first would make it return null for the
        // whole GitHub round trip, and `webSocketMessage` closes any
        // socket whose source is null with 1011 -- disconnecting every
        // reviewer in the room over a routine refresh, not just whoever
        // asked for it. `loadSource` holds the existing `cachedSource`
        // live until a replacement is actually ready, and (per
        // `doLoadSource`'s failure branch above) leaves it untouched
        // rather than wiping it if the refetch fails -- so a refresh that
        // fails is invisible, not disruptive.
        const previousHeadSha = this.cachedSource?.pr.headSha ?? null;
        const reloaded = await this.loadSource(key);
        if (reloaded === null) return new Response("no such pull request", { status: 404 });
        if (reloaded.pr.headSha === previousHeadSha) {
          // Nothing actually changed (the refetch failed and the old
          // source was held, or genuinely found nothing new): a routine
          // refresh should be invisible to connected reviewers, so there is
          // nothing for anyone to reload and nothing to broadcast.
          return new Response(null, { status: 200 });
        }
      }

      const current = this.cachedSource;
      if (current !== null) {
        // Everyone looking at this pull request needs to reload the diff, or
        // half the room would be commenting against a revision that no
        // longer exists and every one of those comments would be rejected as
        // stale.
        this.broadcast({ t: "sourceChanged", headSha: current.pr.headSha });
      }
      return new Response(null, { status: 200 });
    }

    if (url.pathname.endsWith("/source")) {
      const source = await this.resolveSource(key);
      if (source === null) return new Response("no such pull request", { status: 404 });
      return Response.json(source);
    }

    if (url.pathname.endsWith("/ws")) {
      // Resolved here, before the socket exists -- possibly with a real,
      // slow, occasionally-failing fetch to GitHub. That is deliberate: it
      // means no message can ever arrive on this socket while its source is
      // still being resolved, because the client has no socket to send one
      // on until this call returns. See `resolveSource`'s docstring.
      const source = await this.resolveSource(key);
      if (source === null) return new Response("no such pull request", { status: 404 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      // Hibernatable: an idle pull request costs no duration billing.
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("not found", { status: 404 });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let msg;
    try {
      msg = parseClientMessage(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      // A peer that cannot speak the protocol is not a peer. Do NOT throw: an
      // unhandled error here would tear down every socket on this object.
      ws.close(1003, "unsupported payload");
      return;
    }

    // `currentSource()`, not `resolveSource()`: this handler must never
    // await a fetch. `resolveSource` is real, possibly-slow network I/O now
    // (Task 11), and once ANY `await` sits inside `webSocketMessage`, a
    // second invocation for this same socket -- fired before the first
    // finishes, exactly the shape of the two tests below -- can run its own
    // synchronous work while the first is still parked. `currentSource()` is
    // a plain field read (falling back to a synchronous SQL read); nothing
    // below this line ever awaits, which is what keeps everything after it
    // atomic with respect to every OTHER invocation of this handler.
    const source = this.currentSource();
    if (source === null) {
      ws.close(1011, "pull request unavailable");
      return;
    }

    if (msg.t === "ping") {
      this.send(ws, { t: "pong", clientTime: msg.clientTime, serverTime: Date.now() });
      return;
    }

    if (msg.t === "hello") {
      const existing = ws.deserializeAttachment() as Attachment | null;
      if (existing !== null) {
        // Already joined on this socket. Re-sending the snapshot is enough;
        // minting a second reviewer id would duplicate this person in
        // presence forever.
        this.send(ws, this.snapshotFor(existing.reviewerId));
        return;
      }

      const reviewerId = crypto.randomUUID();
      ws.serializeAttachment({
        reviewerId,
        nickname: msg.nickname,
        persistent: msg.persistent,
        cursor: null,
        actions: newBucket(Date.now(), ACTION_CAPACITY),
        cursors: newBucket(Date.now(), CURSOR_CAPACITY),
      } satisfies Attachment);

      // Resume before the snapshot, so a client that asked for a gap gets the
      // deltas it missed and then a snapshot that already includes them.
      const latest = currentSeq(this.ctx.storage.sql);
      if (shouldReplay(msg.lastSeenSeq, latest, SNAPSHOT_THRESHOLD)) {
        for (const row of readEventsSince(this.ctx.storage.sql, msg.lastSeenSeq)) {
          this.send(ws, { t: "delta", seq: row.seq, serverTime: Date.now(), event: row.event });
        }
      }

      this.send(ws, this.snapshotFor(reviewerId));
      this.broadcastPresence();
      return;
    }

    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (attachment === null) {
      ws.close(1008, "hello required first");
      return;
    }

    if (msg.t === "cursor") {
      const limit = takeToken(attachment.cursors, Date.now(), CURSOR_CAPACITY, CURSOR_WINDOW_MS);
      if (!limit.allowed) {
        // Persist the spent bucket anyway, then drop the move silently: a
        // reject frame for a cursor would be noise the UI has nothing to do
        // with, and the next accepted move supersedes this one regardless.
        ws.serializeAttachment({ ...attachment, cursors: limit.bucket } satisfies Attachment);
        return;
      }
      ws.serializeAttachment({
        ...attachment,
        cursor: { filePath: msg.filePath, line: msg.line },
        cursors: limit.bucket,
      } satisfies Attachment);
      this.broadcastPresence();
      return;
    }

    // Checked before any validation, and persisted whether or not the action
    // is allowed: a flood must cost no anchor verification, and a token spent
    // on a rejected action must still count or the limit is not a limit. No
    // `await` sits between this read of `attachment` and `commit()` below --
    // in fact no `await` sits anywhere in this handler any more (see
    // `currentSource()` above), so this check cannot reopen the interleaving
    // window `commit()` depends on staying closed.
    const limit = takeToken(attachment.actions, Date.now(), ACTION_CAPACITY, ACTION_WINDOW_MS);
    ws.serializeAttachment({ ...attachment, actions: limit.bucket } satisfies Attachment);
    if (!limit.allowed) {
      this.reject(ws, msg.clientSeq, "RATE_LIMITED");
      return;
    }

    const atMs = Date.now();

    if (msg.t === "openThread") {
      const verified = this.verifyAnchor(source.pr, msg.anchor);
      if (verified.ok === false) {
        this.reject(ws, msg.clientSeq, verified.reason);
        return;
      }
      this.commit(ws, msg.clientSeq, {
        type: "threadOpened",
        threadId: crypto.randomUUID(),
        // The SERVER's anchor, not the client's. The client's was only ever
        // evidence that it was looking at this revision; the stored `context`
        // is quoted back to every reviewer when the thread goes outdated, so
        // it must come from the source this object holds.
        anchor: verified.anchor,
        comment: {
          commentId: crypto.randomUUID(),
          reviewerId: attachment.reviewerId,
          nickname: attachment.nickname,
          body: msg.body,
          atMs,
        },
      });
      return;
    }

    if (msg.t === "reply") {
      if (this.threads().threads[msg.threadId] === undefined) {
        this.reject(ws, msg.clientSeq, "UNKNOWN_THREAD");
        return;
      }
      this.commit(ws, msg.clientSeq, {
        type: "replyAdded",
        threadId: msg.threadId,
        comment: {
          commentId: crypto.randomUUID(),
          reviewerId: attachment.reviewerId,
          nickname: attachment.nickname,
          body: msg.body,
          atMs,
        },
      });
      return;
    }

    if (msg.t === "resolve" || msg.t === "unresolve") {
      if (this.threads().threads[msg.threadId] === undefined) {
        this.reject(ws, msg.clientSeq, "UNKNOWN_THREAD");
        return;
      }
      this.commit(ws, msg.clientSeq, {
        type: msg.t === "resolve" ? "threadResolved" : "threadUnresolved",
        threadId: msg.threadId,
        reviewerId: attachment.reviewerId,
        atMs,
      });

      // `commit` has already folded the event, so `this.threads()` is
      // current. `queue` is synchronous (see its own docstring) -- no
      // suspension point is added here, matching the rest of this handler.
      if (msg.t === "resolve") {
        const thread = this.threads().threads[msg.threadId];
        if (thread !== undefined) {
          this.queue({
            op: "archiveThread",
            prKey: this.prKey(),
            threadId: thread.threadId,
            filePath: thread.anchor.filePath,
            // The line as of the revision the comment was made against,
            // which is the only line number that is a fact rather than a
            // derivation.
            line: thread.anchor.line,
            body: thread.comments[0]?.body ?? "",
            commentCount: thread.comments.length,
            openedBy: thread.comments[0]?.nickname ?? "unknown",
            resolvedBy: attachment.nickname,
            resolvedAtMs: atMs,
          });
        }
      } else {
        this.queue({ op: "removeThread", prKey: this.prKey(), threadId: msg.threadId });
      }
      return;
    }
  }

  /**
   * Drain the archive outbox. Anything that fails -- an unset DATABASE_URL, a
   * network error, Postgres being down -- stays queued and is retried. A Neon
   * outage must never lose an archive or touch a live review.
   *
   * A failure is caught, never rethrown -- rethrowing here would be the
   * alarm equivalent of a socket-path exception, and this object has live
   * reviewers who owe nothing to Postgres's availability. But caught must
   * not mean silent: a `catch` with nothing in it is exactly how openbid's
   * archive shipped broken with a fully green test suite (see the sibling
   * project's `replay.ts` and the comment on `runArchiveOp`) -- every failed
   * validation vanished into an empty `catch {}` and nothing ever surfaced
   * it. This logs instead, so a real outage or a misconfigured secret shows
   * up somewhere even though it never reaches a client.
   *
   * This object has no other use for its single alarm: unlike an auction, a
   * review has no deadline, so there is no expiry clock to protect here.
   */
  override async alarm(): Promise<void> {
    const rows = readOutbox(this.ctx.storage.sql);
    if (rows.length === 0) return;

    let anyFailed = false;
    for (const row of rows) {
      try {
        await this.archiveFn(this.roomEnv.DATABASE_URL, row.op);
        deleteOutbox(this.ctx.storage.sql, row.id);
      } catch (err) {
        console.error("diffsync archive write failed; will retry on the next alarm", {
          op: row.op.op,
          prKey: row.op.prKey,
          error: err instanceof Error ? err.message : String(err),
        });
        anyFailed = true;
      }
    }

    if (anyFailed) await this.ctx.storage.setAlarm(Date.now() + PrDO.RETRY_MS);
  }

  private snapshotFor(reviewerId: string): ServerMessage {
    return {
      t: "snapshot",
      seq: currentSeq(this.ctx.storage.sql),
      serverTime: Date.now(),
      youAre: reviewerId,
      threads: this.threads(),
      presence: this.presence(),
    };
  }

  /**
   * Recompute the anchor from this object's own copy of the pull request and
   * require the client's to match it exactly. A mismatch means the client was
   * looking at a different revision, and the honest answer is to say so rather
   * than to attach the comment to whatever occupies that line now.
   */
  private verifyAnchor(
    pr: PullRequest,
    claimed: Anchor
  ): { ok: true; anchor: Anchor } | { ok: false; reason: RejectReason } {
    const file = pr.files.find((f) => f.path === claimed.filePath);
    if (file === undefined) return { ok: false, reason: "UNKNOWN_FILE" };

    const expected = createAnchor(toAnchorTarget(file), claimed.line);
    if (expected === null) return { ok: false, reason: "STALE_ANCHOR" };
    if (expected.blobSha !== claimed.blobSha) return { ok: false, reason: "STALE_ANCHOR" };
    if (expected.fingerprint !== claimed.fingerprint) return { ok: false, reason: "STALE_ANCHOR" };
    return { ok: true, anchor: expected };
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
    // The socket is gone from `getWebSockets()` by the time this runs, so this
    // broadcast is what removes the departed reviewer from everyone's list.
    this.broadcastPresence();
  }
}
