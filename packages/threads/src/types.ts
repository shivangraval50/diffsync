import type { Anchor, Relocation } from "@diffsync/anchor";

export interface Comment {
  commentId: string;
  reviewerId: string;
  nickname: string;
  body: string;
  atMs: number;
}

export interface Thread {
  threadId: string;
  /** Captured once, when the thread was opened, and never rewritten. The
   *  thread's position in any later revision is computed by `relocate`, never
   *  stored -- storing it would make a stale position indistinguishable from
   *  a fresh one. */
  anchor: Anchor;
  comments: Comment[];
  resolved: boolean;
  resolvedBy: string | null;
}

/** `order` is first-appearance order of thread ids; `threads` is the lookup.
 *  Kept as plain JSON-serialisable data so the whole state can be sent in a
 *  snapshot frame without a custom encoder. */
export interface ThreadsState {
  threads: Record<string, Thread>;
  order: string[];
}

export type ReviewEvent =
  | { type: "threadOpened"; threadId: string; anchor: Anchor; comment: Comment }
  | { type: "replyAdded"; threadId: string; comment: Comment }
  | { type: "threadResolved"; threadId: string; reviewerId: string; atMs: number }
  | { type: "threadUnresolved"; threadId: string; reviewerId: string; atMs: number };

export interface PlacedThread {
  thread: Thread;
  placement: Relocation;
}
