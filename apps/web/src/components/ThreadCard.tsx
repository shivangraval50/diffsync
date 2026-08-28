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
    <article data-testid={`thread-${thread.threadId}`} data-resolved={thread.resolved}>
      {thread.resolved ? (
        <p data-testid="resolved-by">{`Resolved by ${thread.resolvedBy ?? "someone"}`}</p>
      ) : null}

      <ol>
        {thread.comments.map((comment) => (
          <li key={comment.commentId} data-testid={`comment-${comment.commentId}`}>
            <strong>{comment.nickname}</strong>
            <p>{comment.body}</p>
          </li>
        ))}
      </ol>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed === "") return;
          onReply(trimmed);
          setBody("");
        }}
      >
        <label htmlFor={`reply-${thread.threadId}`}>Reply</label>
        <textarea
          id={`reply-${thread.threadId}`}
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
        <button type="submit" disabled={trimmed === ""}>
          Reply
        </button>
      </form>

      {thread.resolved ? (
        <button type="button" onClick={onUnresolve}>
          Unresolve
        </button>
      ) : (
        <button type="button" onClick={onResolve}>
          Resolve
        </button>
      )}
    </article>
  );
}
