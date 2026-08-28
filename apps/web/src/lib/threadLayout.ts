import type { PlacedThread } from "@diffsync/threads";

export interface ThreadLayout {
  /** file path -> relocated new-side line -> the threads on that line. */
  located: Map<string, Map<number, PlacedThread[]>>;
  outdated: PlacedThread[];
}

/**
 * Split placed threads into the ones the diff can show and the ones it cannot.
 *
 * Grouping is by the RELOCATED line, never by the anchor's stored line: the
 * stored line was true for the revision the comment was written against, and
 * rendering a thread there in a later revision is exactly the failure this
 * project exists to prevent.
 */
export function layoutThreads(placed: readonly PlacedThread[]): ThreadLayout {
  const located = new Map<string, Map<number, PlacedThread[]>>();
  const outdated: PlacedThread[] = [];

  for (const entry of placed) {
    if (entry.placement.kind === "outdated") {
      outdated.push(entry);
      continue;
    }
    const path = entry.thread.anchor.filePath;
    const byLine = located.get(path) ?? new Map<number, PlacedThread[]>();
    byLine.set(entry.placement.line, [...(byLine.get(entry.placement.line) ?? []), entry]);
    located.set(path, byLine);
  }

  return { located, outdated };
}
