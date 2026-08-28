import { createStore, type StoreApi } from "zustand/vanilla";
import type { Presence, RejectReason, ServerMessage } from "@diffsync/protocol";
import { applyEvent, emptyThreads, type ThreadsState } from "@diffsync/threads";

export type ConnStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface ReviewState {
  threads: ThreadsState;
  presence: Presence[];
  /**
   * The highest sequence number actually APPLIED to `threads`, via a
   * `snapshot` or a `delta`. Never advanced by an `ack`: an ack means "the
   * server recorded this", not "you have folded it into `threads`". This is
   * the exact composition openbid got wrong -- its `ack` handler advanced
   * this field, so the matching `delta` for the sender's own event (which
   * can arrive after its ack; `PrDO.commit` merely broadcasts before it acks,
   * it does not guarantee order of processing on the receiving end) then
   * looked like a replay of something already applied and was dropped
   * outright, and `socket.ts`'s reconnect -- which resumes from exactly this
   * field -- would then never ask for it again either.
   */
  lastSeenSeq: number;
  youAre: string | null;
  status: ConnStatus;
  lastReject: { clientSeq: number; reason: RejectReason } | null;
  headSha: string | null;
  applyServerMessage(msg: ServerMessage): void;
  setStatus(status: ConnStatus): void;
}

export type ReviewStore = StoreApi<ReviewState>;

export function createReviewStore(): ReviewStore {
  return createStore<ReviewState>((set) => ({
    threads: emptyThreads(),
    presence: [],
    lastSeenSeq: 0,
    youAre: null,
    status: "connecting",
    lastReject: null,
    headSha: null,

    setStatus: (status) => set({ status }),

    applyServerMessage: (msg) =>
      set((state) => {
        switch (msg.t) {
          case "snapshot":
            return {
              threads: msg.threads,
              presence: msg.presence,
              youAre: msg.youAre,
              lastSeenSeq: Math.max(state.lastSeenSeq, msg.seq),
            };
          case "delta":
            return {
              // `applyEvent` is total and idempotent on a repeated id, so a
              // late or out-of-order delta is folded unconditionally rather
              // than skipped by comparing `msg.seq` to `lastSeenSeq` first --
              // there is no seq-based "already applied" shortcut here for an
              // `ack` to accidentally poison.
              threads: applyEvent(state.threads, msg.event),
              // Monotonic via `Math.max`, never regressed by a replayed or
              // out-of-order delta -- see the "does not move lastSeenSeq
              // backwards" test.
              lastSeenSeq: Math.max(state.lastSeenSeq, msg.seq),
            };
          case "presence":
            return { presence: msg.presence };
          case "reject":
            return { lastReject: { clientSeq: msg.clientSeq, reason: msg.reason } };
          case "sourceChanged":
            return { headSha: msg.headSha };
          case "ack":
          case "pong":
            // Deliberately untouched. `ack.seq` and `pong.serverTime` are
            // wire fields for debugging/latency only -- neither is a resume
            // -position input. See `lastSeenSeq`'s own doc comment.
            return {};
        }
      }),
  }));
}
