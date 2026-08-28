import { relocate, type AnchorTarget } from "@diffsync/anchor";
import type { PlacedThread, ThreadsState } from "./types";

/**
 * Compute, for every thread, where it points in the current revision of the
 * pull request. Nothing is stored: placement is derived on every render from
 * the thread's original anchor and the current targets, so a thread can never
 * be displayed at a position that was true for a revision the reader is not
 * looking at.
 */
export function placeThreads(
  state: ThreadsState,
  targets: ReadonlyMap<string, AnchorTarget>
): PlacedThread[] {
  const placed: PlacedThread[] = [];
  for (const threadId of state.order) {
    const thread = state.threads[threadId];
    if (thread === undefined) continue;
    const target = targets.get(thread.anchor.filePath);
    placed.push({
      thread,
      placement: target === undefined ? { kind: "outdated" } : relocate(thread.anchor, target),
    });
  }
  return placed;
}
