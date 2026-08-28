"use client";

import type { RejectReason } from "@diffsync/protocol";

const MESSAGES: Record<RejectReason, string> = {
  RATE_LIMITED: "You are commenting too quickly. Wait a moment and try again.",
  UNKNOWN_FILE: "That file is not part of this pull request.",
  UNKNOWN_THREAD: "That thread no longer exists in this review.",
  STALE_ANCHOR:
    "The diff changed under you, so that comment was not saved. Reload to see the current revision.",
};

export function RejectBanner({
  reject,
}: {
  reject: { clientSeq: number; reason: RejectReason } | null;
}): React.JSX.Element | null {
  if (reject === null) return null;
  return (
    <p role="alert" className="notice notice--error">
      {MESSAGES[reject.reason]}
    </p>
  );
}
