import type { Comment, ReviewEvent, Thread, ThreadsState } from "./types.js";

export function emptyThreads(): ThreadsState {
  return { threads: {}, order: [] };
}

function withThread(state: ThreadsState, threadId: string, next: Thread): ThreadsState {
  return {
    threads: { ...state.threads, [threadId]: next },
    order: state.order.includes(threadId) ? state.order : [...state.order, threadId],
  };
}

function appended(thread: Thread, comment: Comment): Thread {
  if (thread.comments.some((c) => c.commentId === comment.commentId)) return thread;
  return { ...thread, comments: [...thread.comments, comment] };
}

/**
 * Fold one event into the thread state. Total: every event either produces a
 * new state or returns the state unchanged. It never throws, because both
 * consumers -- the Durable Object rebuilding from SQLite and the browser
 * folding a delta stream -- would be left with no usable state if it did.
 */
export function applyEvent(state: ThreadsState, event: ReviewEvent): ThreadsState {
  switch (event.type) {
    case "threadOpened": {
      // Idempotent on re-delivery: keep the thread already folded, replies
      // and all, rather than resetting it to its first comment.
      if (state.threads[event.threadId] !== undefined) return state;
      return withThread(state, event.threadId, {
        threadId: event.threadId,
        anchor: event.anchor,
        comments: [event.comment],
        resolved: false,
        resolvedBy: null,
      });
    }
    case "replyAdded": {
      const thread = state.threads[event.threadId];
      if (thread === undefined) return state;
      return withThread(state, event.threadId, appended(thread, event.comment));
    }
    case "threadResolved": {
      const thread = state.threads[event.threadId];
      if (thread === undefined) return state;
      return withThread(state, event.threadId, {
        ...thread,
        resolved: true,
        resolvedBy: event.reviewerId,
      });
    }
    case "threadUnresolved": {
      const thread = state.threads[event.threadId];
      if (thread === undefined) return state;
      return withThread(state, event.threadId, { ...thread, resolved: false, resolvedBy: null });
    }
  }
}
