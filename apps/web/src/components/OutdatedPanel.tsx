"use client";

import { GAP } from "@diffsync/anchor";
import type { PlacedThread } from "@diffsync/threads";

export function OutdatedPanel({ threads }: { threads: PlacedThread[] }): React.JSX.Element | null {
  if (threads.length === 0) return null;

  return (
    <section data-testid="outdated-panel" aria-label="Outdated threads">
      <h2>Outdated threads</h2>
      <p>
        These threads are shown detached because the code it was written about has changed.
        Their original context is quoted below.
      </p>
      {threads.map(({ thread }) => (
        <article key={thread.threadId} data-testid={`outdated-${thread.threadId}`}>
          <p>{`${thread.anchor.filePath}:${thread.anchor.line}`}</p>
          {/* GAP fills window slots past the start or end of the rendered
              file. It is a sentinel beginning with U+0000, not content, so it
              is dropped here rather than printed. */}
          <pre data-testid="quoted-context">
            {thread.anchor.context.filter((line) => line !== GAP).join("\n")}
          </pre>
          <ol>
            {thread.comments.map((comment) => (
              <li key={comment.commentId}>
                <strong>{comment.nickname}</strong>
                <p>{comment.body}</p>
              </li>
            ))}
          </ol>
        </article>
      ))}
    </section>
  );
}
