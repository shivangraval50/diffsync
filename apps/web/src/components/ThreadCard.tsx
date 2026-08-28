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

  return (
    <article
      data-testid={`thread-${thread.threadId}`}
      data-resolved={thread.resolved}
      className="thread"
    >
      {thread.resolved ? (
        <p data-testid="resolved-by" className="thread__resolved">
          {`Resolved by ${thread.resolvedBy ?? "someone"}`}
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
