"use client";

import { GAP } from "@diffsync/anchor";
import type { PlacedThread } from "@diffsync/threads";

/**
 * Not an error state. Feedback: this panel is the honest answer to "where
 * did my comment go", so it takes the amber "needs your attention" rule
 * rather than the red "something failed" one, keeps the same card language
 * as an inline thread, and quotes the code the comment was written about so
 * a reader can judge the thread for themselves.
 */
export function OutdatedPanel({ threads }: { threads: PlacedThread[] }): React.JSX.Element | null {
  if (threads.length === 0) return null;

  return (
    <section data-testid="outdated-panel" aria-label="Outdated threads" className="outdated">
      <h2 className="outdated__title">Outdated threads</h2>
      <p className="outdated__lead">
        These threads are shown detached because the code it was written about has changed.
        Their original context is quoted below.
      </p>
      {threads.map(({ thread }) => (
        <article
          key={thread.threadId}
          data-testid={`outdated-${thread.threadId}`}
          className="outdated__thread"
        >
          <p className="outdated__where">{`${thread.anchor.filePath}:${thread.anchor.line}`}</p>
          {/* GAP fills window slots past the start or end of the rendered
              file. It is a sentinel beginning with U+0000, not content, so it
              is dropped here rather than printed. */}
          <pre data-testid="quoted-context" className="outdated__quote">
            {thread.anchor.context.filter((line) => line !== GAP).join("\n")}
          </pre>
          <ol role="list" className="outdated__comments">
            {thread.comments.map((comment) => (
              <li key={comment.commentId} className="comment">
                <strong className="comment__author">{comment.nickname}</strong>
                <p className="comment__body">{comment.body}</p>
              </li>
            ))}
          </ol>
        </article>
      ))}
    </section>
  );
}
