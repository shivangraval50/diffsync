import type { SourceResult } from "@diffsync/protocol";

const FALLBACK_TEXT: Record<"rate_limited" | "unavailable" | "not_found", string> = {
  rate_limited:
    "GitHub's public API quota is shared by everyone and is used up right now, so this is a sample pull request instead.",
  unavailable: "GitHub could not be reached, so this is a sample pull request instead.",
  not_found: "That pull request could not be found, so this is a sample pull request instead.",
};

/**
 * Says where the diff came from. The fallback case is the one that matters:
 * a visitor looking at a sample pull request has to be told, or they will
 * think they are reviewing the URL they pasted.
 */
export function SourceBanner({ source }: { source: SourceResult }): React.JSX.Element | null {
  if (source.origin === "github") return null;

  if (source.origin === "fixture") {
    return (
      <p role="status" data-testid="source-banner">
        This is a seeded sample pull request. It works offline and is never rate-limited.
      </p>
    );
  }

  return (
    <p role="alert" data-testid="source-banner">
      {FALLBACK_TEXT[source.reason]}
    </p>
  );
}
