import type { AnchorTarget } from "@diffsync/anchor";
import type { FileDiff, PullRequest } from "./types.js";

/**
 * The new-side lines this file exposes: context and additions, keyed by their
 * new-side line number. Removed lines are absent because they have no
 * new-side position -- a comment cannot be anchored to a line that no longer
 * exists in the file.
 */
export function toAnchorTarget(file: FileDiff): AnchorTarget {
  const lines = new Map<number, string>();
  if (file.kind === "patch") {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "removed") continue;
        lines.set(line.newLine, line.text);
      }
    }
  }
  return { filePath: file.path, blobSha: file.blobSha, lines };
}

export function anchorTargets(pr: PullRequest): Map<string, AnchorTarget> {
  return new Map(pr.files.map((file) => [file.path, toAnchorTarget(file)]));
}
