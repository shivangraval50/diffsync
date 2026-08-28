import { z } from "zod";
import { CONTEXT_RADIUS, type Anchor } from "@diffsync/anchor";
import type { FileDiff, PrRef, PullRequest } from "@diffsync/diff";
import type { ReviewEvent, ThreadsState } from "@diffsync/threads";

export const PROTOCOL_VERSION = 1;

// Shared with apps/web's identity.ts, which truncates every nickname it
// resolves -- a signed-in user's GitHub login, and the client-writable guest
// cookie -- to this same limit before it can reach a "hello". Imported from
// here rather than duplicated, so truncation and this wire cap cannot drift:
// if they did, an over-long nickname would fail the schema, the DO would
// close the socket, and the client's own reconnect would resend it forever.
export const NICKNAME_MAX_LENGTH = 32;
export const COMMENT_MAX_LENGTH = 2000;

export { decodePrKey, encodePrKey } from "./prkey.js";

/**
 * Compile-time proof that an inferred schema type is exactly the hand-written
 * interface it is supposed to mirror. Cheaper and stricter than the usual
 * "assign the parsed result somewhere typed" trick: a field added to `Anchor`
 * but not to `anchorSchema` fails here, whereas assignment would silently
 * accept the narrower parsed object and `z.object` would strip the field off
 * every message that carried it.
 */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

const seq = z.number().int().nonnegative();
const lineNumber = z.number().int().positive();
const timestamp = z.number().finite();

export const anchorSchema = z.object({
  filePath: z.string().min(1),
  blobSha: z.string().min(1),
  line: lineNumber,
  fingerprint: z.string().regex(/^[0-9a-f]{16}$/u),
  context: z
    .array(z.string())
    .length(2 * CONTEXT_RADIUS + 1)
    .readonly(),
});
export type _AnchorMatches = Assert<Equals<z.infer<typeof anchorSchema>, Anchor>>;

export const commentSchema = z.object({
  commentId: z.string().min(1),
  reviewerId: z.string().min(1),
  nickname: z.string().min(1).max(NICKNAME_MAX_LENGTH),
  body: z.string().min(1).max(COMMENT_MAX_LENGTH),
  atMs: timestamp,
});

export const threadSchema = z.object({
  threadId: z.string().min(1),
  anchor: anchorSchema,
  comments: z.array(commentSchema),
  resolved: z.boolean(),
  resolvedBy: z.string().min(1).nullable(),
});

export const threadsStateSchema = z.object({
  threads: z.record(z.string(), threadSchema),
  order: z.array(z.string()),
});
export type _ThreadsStateMatches = Assert<
  Equals<z.infer<typeof threadsStateSchema>, ThreadsState>
>;

export const reviewEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("threadOpened"),
    threadId: z.string().min(1),
    anchor: anchorSchema,
    comment: commentSchema,
  }),
  z.object({
    type: z.literal("replyAdded"),
    threadId: z.string().min(1),
    comment: commentSchema,
  }),
  z.object({
    type: z.literal("threadResolved"),
    threadId: z.string().min(1),
    reviewerId: z.string().min(1),
    atMs: timestamp,
  }),
  z.object({
    type: z.literal("threadUnresolved"),
    threadId: z.string().min(1),
    reviewerId: z.string().min(1),
    atMs: timestamp,
  }),
]);
export type _ReviewEventMatches = Assert<Equals<z.infer<typeof reviewEventSchema>, ReviewEvent>>;

export const presenceSchema = z.object({
  reviewerId: z.string().min(1),
  nickname: z.string().min(1).max(NICKNAME_MAX_LENGTH),
  persistent: z.boolean(),
  // A single nullable object rather than two independently nullable fields:
  // "on a file but no line" and "on a line but no file" are not states a
  // cursor can be in, so they should not be representable.
  cursor: z.object({ filePath: z.string().min(1), line: lineNumber }).nullable(),
});
export type Presence = z.infer<typeof presenceSchema>;

export const rejectReasonSchema = z.enum([
  "RATE_LIMITED",
  "UNKNOWN_FILE",
  "UNKNOWN_THREAD",
  "STALE_ANCHOR",
]);
export type RejectReason = z.infer<typeof rejectReasonSchema>;

const fileStatusSchema = z.enum(["added", "modified", "removed", "renamed"]);

const diffLineSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("context"),
    text: z.string(),
    oldLine: lineNumber,
    newLine: lineNumber,
  }),
  z.object({ kind: z.literal("added"), text: z.string(), newLine: lineNumber }),
  z.object({ kind: z.literal("removed"), text: z.string(), oldLine: lineNumber }),
]);

const diffHunkSchema = z.object({
  oldStart: z.number().int().nonnegative(),
  oldCount: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newCount: z.number().int().nonnegative(),
  heading: z.string(),
  lines: z.array(diffLineSchema),
});

export const fileDiffSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("patch"),
    path: z.string().min(1),
    previousPath: z.string().min(1).nullable(),
    blobSha: z.string().min(1),
    status: fileStatusSchema,
    hunks: z.array(diffHunkSchema),
  }),
  z.object({
    kind: z.literal("omitted"),
    path: z.string().min(1),
    previousPath: z.string().min(1).nullable(),
    blobSha: z.string().min(1),
    status: fileStatusSchema,
    reason: z.enum(["too_large", "binary"]),
  }),
]);
export type _FileDiffMatches = Assert<Equals<z.infer<typeof fileDiffSchema>, FileDiff>>;

export const prRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("github"),
    owner: z.string().regex(/^[A-Za-z0-9._-]+$/u),
    repo: z.string().regex(/^[A-Za-z0-9._-]+$/u),
    number: lineNumber,
  }),
  z.object({
    kind: z.literal("fixture"),
    slug: z.string().regex(/^[a-z0-9-]+$/u),
    revision: lineNumber,
  }),
]);
export type _PrRefMatches = Assert<Equals<z.infer<typeof prRefSchema>, PrRef>>;

export const pullRequestSchema = z.object({
  ref: prRefSchema,
  title: z.string().min(1),
  author: z.string().min(1),
  headSha: z.string().min(1),
  baseSha: z.string().min(1),
  files: z.array(fileDiffSchema),
});
export type _PullRequestMatches = Assert<Equals<z.infer<typeof pullRequestSchema>, PullRequest>>;

/**
 * What `GET /prs/:key/source` returns. A discriminated union rather than
 * `{ pr, origin, reason? }`, because "origin: github with a fallback reason"
 * and "origin: fallback with no reason" are both nonsense, and the UI has to
 * tell a visitor *why* they are looking at a sample PR.
 */
export const sourceResultSchema = z.discriminatedUnion("origin", [
  z.object({ origin: z.literal("fixture"), pr: pullRequestSchema }),
  z.object({ origin: z.literal("github"), pr: pullRequestSchema, fetchedAtMs: timestamp }),
  z.object({
    origin: z.literal("fallback"),
    pr: pullRequestSchema,
    reason: z.enum(["rate_limited", "unavailable", "not_found"]),
  }),
]);
export type SourceResult = z.infer<typeof sourceResultSchema>;

export const aiPassSchema = z.object({
  summary: z.string().min(1),
  flags: z.array(
    z.object({
      path: z.string().min(1),
      hunkIndex: z.number().int().nonnegative(),
      reason: z.string().min(1),
    })
  ),
  /** The provider that produced this, surfaced in the UI so the output is
   *  always attributed rather than presented as the app's own findings. */
  generatedBy: z.string().min(1),
  generatedAtMs: timestamp,
});
export type AiPass = z.infer<typeof aiPassSchema>;

export const clientMessageSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    lastSeenSeq: seq,
    nickname: z.string().min(1).max(NICKNAME_MAX_LENGTH),
    // Whether `nickname` is a signed-in GitHub login rather than a guest
    // cookie value. Defaulted rather than required so a client deployed
    // before this field existed still connects: rejecting the hello would
    // close the socket and send that client into an endless reconnect, and
    // the Worker and the web app deploy independently of each other.
    // Client-asserted and unverifiable here -- the socket goes browser to
    // Worker directly, with no Auth.js session on this side.
    persistent: z.boolean().default(false),
  }),
  z.object({ t: z.literal("cursor"), filePath: z.string().min(1), line: lineNumber }),
  z.object({
    t: z.literal("openThread"),
    clientSeq: seq,
    anchor: anchorSchema,
    body: z.string().min(1).max(COMMENT_MAX_LENGTH),
  }),
  z.object({
    t: z.literal("reply"),
    clientSeq: seq,
    threadId: z.string().min(1),
    body: z.string().min(1).max(COMMENT_MAX_LENGTH),
  }),
  z.object({ t: z.literal("resolve"), clientSeq: seq, threadId: z.string().min(1) }),
  z.object({ t: z.literal("unresolve"), clientSeq: seq, threadId: z.string().min(1) }),
  z.object({ t: z.literal("ping"), clientTime: timestamp }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const serverMessageSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("snapshot"),
    seq,
    serverTime: timestamp,
    youAre: z.string().min(1),
    threads: threadsStateSchema,
    presence: z.array(presenceSchema),
  }),
  z.object({ t: z.literal("delta"), seq, serverTime: timestamp, event: reviewEventSchema }),
  z.object({ t: z.literal("presence"), presence: z.array(presenceSchema) }),
  z.object({ t: z.literal("ack"), clientSeq: seq, seq }),
  z.object({ t: z.literal("reject"), clientSeq: seq, reason: rejectReasonSchema }),
  z.object({ t: z.literal("pong"), clientTime: timestamp, serverTime: timestamp }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

const jsonEnvelope = z.string().transform((raw, ctx): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid JSON" });
    return z.NEVER;
  }
});

const clientEnvelopeSchema = jsonEnvelope.pipe(clientMessageSchema);
const serverEnvelopeSchema = jsonEnvelope.pipe(serverMessageSchema);

export function parseClientMessage(raw: string): ClientMessage {
  return clientEnvelopeSchema.parse(raw);
}

export function parseServerMessage(raw: string): ServerMessage {
  return serverEnvelopeSchema.parse(raw);
}

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}
