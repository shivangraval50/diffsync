export type FileStatus = "added" | "modified" | "removed" | "renamed";

/**
 * A discriminated union rather than one record with `oldLine: number | null`
 * and `newLine: number | null`. That shape is type-legal for an added line
 * carrying an old line number, and for a context line carrying neither --
 * neither of which exists in a unified diff. Making them unrepresentable
 * means the renderer and `toAnchorTarget` never need a runtime null-check to
 * decide which side a line belongs to.
 */
export type DiffLine =
  | { kind: "context"; text: string; oldLine: number; newLine: number }
  | { kind: "added"; text: string; newLine: number }
  | { kind: "removed"; text: string; oldLine: number };

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Whatever followed the closing "@@" on the header line, usually the
   *  enclosing function. May be empty. */
  heading: string;
  lines: DiffLine[];
}

/**
 * `omitted` is a real state, not an error: GitHub drops the `patch` field for
 * files above its size limit and for binaries. Modelling it as a variant
 * rather than `hunks: DiffHunk[] | null` means the renderer must handle it,
 * and `toAnchorTarget` returns an empty target for it -- so nothing can ever
 * anchor into a file whose content was never delivered.
 */
export type FileDiff =
  | {
      kind: "patch";
      path: string;
      previousPath: string | null;
      blobSha: string;
      status: FileStatus;
      hunks: DiffHunk[];
    }
  | {
      kind: "omitted";
      path: string;
      previousPath: string | null;
      blobSha: string;
      status: FileStatus;
      reason: "too_large" | "binary";
    };

export type PrRef =
  | { kind: "github"; owner: string; repo: string; number: number }
  | { kind: "fixture"; slug: string; revision: number };

export interface PullRequest {
  ref: PrRef;
  title: string;
  author: string;
  /** The head commit sha this snapshot of the PR was taken at. Changes on a
   *  force-push, which is what makes threads relocate. */
  headSha: string;
  baseSha: string;
  files: FileDiff[];
}
