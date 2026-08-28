import { DurableObject } from "cloudflare:workers";
import { createAnchor, type Anchor } from "@diffsync/anchor";
import { toAnchorTarget, type PullRequest } from "@diffsync/diff";
import { fixturePullRequest, FALLBACK_FIXTURE_SLUG } from "@diffsync/fixtures";
import {
  decodePrKey,
  encode,
  parseClientMessage,
  type Presence,
  type RejectReason,
  type ServerMessage,
  type SourceResult,
} from "@diffsync/protocol";
import { applyEvent, emptyThreads, type ReviewEvent, type ThreadsState } from "@diffsync/threads";
import {
  ACTION_CAPACITY,
  ACTION_WINDOW_MS,
  CURSOR_CAPACITY,
  CURSOR_WINDOW_MS,
  newBucket,
  takeToken,
  type Bucket,
} from "./ratelimit.js";
import { appendEvent, currentSeq, getMeta, initSchema, putMeta, readEventsSince } from "./sql.js";

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

export class PrDO extends DurableObject {
  private cachedThreads: ThreadsState | null = null;
  private cachedSource: SourceResult | null = null;

  constructor(ctx: DurableObjectState, env: PrEnv) {
    super(ctx, env as never);
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
   * The pull request this object is about. Task 11 replaces the GitHub branch
   * with a real fetch plus a cache; until then a GitHub key falls back to the
   * seeded fixture, which is already the correct behaviour when GitHub cannot
   * be reached.
   */
  protected async resolveSource(key: string): Promise<SourceResult | null> {
    if (this.cachedSource !== null) return this.cachedSource;

    const cached = getMeta(this.ctx.storage.sql, "source");
    if (cached !== null) {
      this.cachedSource = JSON.parse(cached) as SourceResult;
      return this.cachedSource;
    }

    const ref = decodePrKey(key);
    if (ref === null) return null;

    let result: SourceResult | null = null;
    if (ref.kind === "fixture") {
      const pr = fixturePullRequest(ref.slug, ref.revision);
      result = pr === null ? null : { origin: "fixture", pr };
    } else {
      const pr = fixturePullRequest(FALLBACK_FIXTURE_SLUG, 1);
      result = pr === null ? null : { origin: "fallback", pr, reason: "unavailable" };
    }

    if (result === null) return null;
    putMeta(this.ctx.storage.sql, "source", JSON.stringify(result));
    this.cachedSource = result;
    return result;
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

    if (url.pathname.endsWith("/source")) {
      const source = await this.resolveSource(key);
      if (source === null) return new Response("no such pull request", { status: 404 });
      return Response.json(source);
    }

    if (url.pathname.endsWith("/ws")) {
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

    const source = await this.resolveSource(this.prKey());
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
    // the first (and only) `await` in this handler is the `resolveSource`
    // call already completed above, so this check cannot reopen the
    // interleaving window `commit()` depends on staying closed.
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
      return;
    }
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
