"use client";

import type { Presence } from "@diffsync/protocol";
import type { ConnStatus } from "@/lib/reviewStore";

export function PresenceBar({
  presence,
  youAre,
  status,
}: {
  presence: Presence[];
  youAre: string | null;
  status: ConnStatus;
}): React.JSX.Element {
  return (
    <div>
      {status === "open" ? null : (
        <p role="status">
          {status === "reconnecting" ? "Reconnecting…" : `Connection ${status}`}
        </p>
      )}
      <ul aria-label="Reviewers here">
        {presence.map((reviewer) => (
          <li key={reviewer.reviewerId} data-testid={`reviewer-${reviewer.reviewerId}`}>
            <span>{reviewer.nickname}</span>
            {reviewer.reviewerId === youAre ? <span> (you)</span> : null}
            {reviewer.cursor === null ? null : (
              <span>{` ${reviewer.cursor.filePath}:${reviewer.cursor.line}`}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
