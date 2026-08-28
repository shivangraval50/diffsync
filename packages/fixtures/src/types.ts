import type { FileStatus } from "@diffsync/diff";

export interface FixtureFile {
  path: string;
  previousPath: string | null;
  blobSha: string;
  status: FileStatus;
  /** Hunks only, exactly the shape GitHub's `files[].patch` has, so the same
   *  parser serves both diff sources. */
  patch: string;
}

export interface FixtureRevision {
  headSha: string;
  baseSha: string;
  files: FixtureFile[];
}

export interface Fixture {
  slug: string;
  title: string;
  author: string;
  blurb: string;
  /** Index 0 is revision 1. A fixture with two entries models a force-push:
   *  the same pull request, a new head sha, and threads that must relocate or
   *  say they are outdated. */
  revisions: FixtureRevision[];
}
