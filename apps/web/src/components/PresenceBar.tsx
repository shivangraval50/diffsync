"use client";

import type { Presence } from "@diffsync/protocol";
import type { ConnStatus } from "@/lib/reviewStore";

/**
 * A stable hue per reviewer id, used only for the dot beside a name.
 * Deliberately decorative: the name next to the dot is what identifies the
 * reviewer, so nothing at all is lost if the hue cannot be perceived
 * (Accessibility, Vision -- "convey information with more than color alone").
 */
function hueFor(reviewerId: string): number {
  let hash = 0;
  for (const char of reviewerId) hash = (hash * 31 + char.charCodeAt(0)) % 4096;
  // Stepping by 137 -- the golden angle in degrees -- spreads consecutive
  // hashes as far apart on the wheel as possible, so two reviewers in the
  // same room rarely land on neighbouring hues.
  return (hash * 137) % 360;
}

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
    <div className="presence">
      {status === "open" ? null : (
        <p role="status" className="presence__status">
          {status === "reconnecting" ? "Reconnecting…" : `Connection ${status}`}
        </p>
      )}
      <ul role="list" aria-label="Reviewers here" className="presence__list">
        {presence.map((reviewer) => (
          <li
            key={reviewer.reviewerId}
            data-testid={`reviewer-${reviewer.reviewerId}`}
            className="presence__person"
            style={{ "--dot-hue": hueFor(reviewer.reviewerId) } as React.CSSProperties}
          >
            <span className="presence__name">{reviewer.nickname}</span>
            {reviewer.reviewerId === youAre ? <span className="presence__you"> (you)</span> : null}
            {reviewer.cursor === null ? null : (
              <span className="presence__cursor">
                {` ${reviewer.cursor.filePath}:${reviewer.cursor.line}`}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
