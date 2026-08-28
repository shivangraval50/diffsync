import type { DiffHunk, DiffLine } from "./types.js";

export class DiffParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiffParseError";
  }
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/u;

/**
 * Parse the hunk body of a unified diff. This is deliberately the GitHub
 * `files[].patch` shape -- hunks only, with no `---`/`+++` file headers --
 * because that is what both diff sources in this project produce.
 *
 * Throws rather than skipping anything it does not recognise. A parser that
 * silently drops a line it cannot classify shifts every subsequent line
 * number, and a shifted line number is exactly the silent mis-anchor this
 * project exists to prevent.
 */
export function parseUnifiedDiff(patch: string): DiffHunk[] {
  if (patch === "") return [];

  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of patch.split("\n")) {
    const header = HEADER.exec(raw);
    if (header !== null) {
      if (current !== null) verifyCounts(current);
      current = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        heading: header[5] ?? "",
        lines: [],
      };
      oldLine = current.oldStart;
      newLine = current.newStart;
      hunks.push(current);
      continue;
    }

    // A trailing newline in the patch string produces one empty final
    // element; that is padding, not a blank context line, so it is only
    // dropped when there is no open hunk to attribute it to.
    if (current === null) {
      if (raw === "") continue;
      throw new DiffParseError(`content before the first hunk header: ${JSON.stringify(raw)}`);
    }

    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"

    const marker = raw.slice(0, 1);
    const text = raw.slice(1);
    let line: DiffLine;
    if (raw === "" || marker === " ") {
      line = { kind: "context", text: raw === "" ? "" : text, oldLine, newLine };
      oldLine += 1;
      newLine += 1;
    } else if (marker === "+") {
      line = { kind: "added", text, newLine };
      newLine += 1;
    } else if (marker === "-") {
      line = { kind: "removed", text, oldLine };
      oldLine += 1;
    } else {
      throw new DiffParseError(`unrecognised diff line: ${JSON.stringify(raw)}`);
    }
    current.lines.push(line);
  }

  if (current !== null) verifyCounts(current);
  return hunks;
}

function verifyCounts(hunk: DiffHunk): void {
  let oldSeen = 0;
  let newSeen = 0;
  for (const line of hunk.lines) {
    if (line.kind !== "added") oldSeen += 1;
    if (line.kind !== "removed") newSeen += 1;
  }
  if (oldSeen !== hunk.oldCount || newSeen !== hunk.newCount) {
    throw new DiffParseError(
      `hunk body contradicts its header counts: header says -${hunk.oldCount} +${hunk.newCount}, ` +
        `body has -${oldSeen} +${newSeen}`
    );
  }
}
