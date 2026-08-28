"use client";

import { useState } from "react";
import type { Thread } from "@diffsync/threads";

export function ThreadCard({
  thread,
  onReply,
  onResolve,
  onUnresolve,
}: {
  thread: Thread;
  onReply: (body: string) => void;
  onResolve: () => void;
  onUnresolve: () => void;
}): React.JSX.Element {
  const [body, setBody] = useState("");
  const trimmed = body.trim();

  // `thread.resolvedBy` is a `reviewerId` (see packages/threads/src/types.ts),
  // not anything fit to print. The resolver has very likely left a comment on
  // this same thread, so their nickname is recovered from there. If they
  // resolved without ever commenting -- or have since disconnected, so they
  // no longer appear in presence either -- there is no human name to show,
  // and the raw id must never stand in for one; "Resolved" alone is printed
  // instead.
  const resolverNickname =
    thread.resolvedBy === null
      ? null
      : (thread.comments.find((comment) => comment.reviewerId === thread.resolvedBy)?.nickname ??
        null);

  return (
    <article
      data-testid={`thread-${thread.threadId}`}
      data-resolved={thread.resolved}
      className="thread"
    >
      {thread.resolved ? (
        <p data-testid="resolved-by" className="thread__resolved">
          {resolverNickname === null ? "Resolved" : `Resolved by ${resolverNickname}`}
        </p>
      ) : null}

      <ol role="list" className="thread__comments">
        {thread.comments.map((comment) => (
          <li
            key={comment.commentId}
            data-testid={`comment-${comment.commentId}`}
            className="comment"
          >
            <strong className="comment__author">{comment.nickname}</strong>
            <p className="comment__body">{comment.body}</p>
          </li>
        ))}
      </ol>

      <form
        className="thread__reply"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed === "") return;
          onReply(trimmed);
          setBody("");
        }}
      >
        {/* The label still names the textarea and still sits in the
            accessibility tree -- `.vh` clips it, it is not `display: none`.
            It is only taken off the page because the button immediately
            beside it already says the same word. */}
        <label htmlFor={`reply-${thread.threadId}`} className="vh">
          Reply
        </label>
        <textarea
          id={`reply-${thread.threadId}`}
          className="field"
          rows={1}
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
        <button type="submit" className="btn" disabled={trimmed === ""}>
          Reply
        </button>
      </form>

      {thread.resolved ? (
        <button type="button" className="btn btn--quiet thread__actions" onClick={onUnresolve}>
          Unresolve
        </button>
      ) : (
        <button type="button" className="btn btn--quiet thread__actions" onClick={onResolve}>
          Resolve
        </button>
      )}
    </article>
  );
}
