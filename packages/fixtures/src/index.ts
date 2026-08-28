import { parseUnifiedDiff, type FileDiff, type PullRequest } from "@diffsync/diff";
import { authRefactor } from "./data/authRefactor";
import { parserBugfix } from "./data/parserBugfix";
import { docsTypo } from "./data/docsTypo";
import type { Fixture, FixtureFile, FixtureRevision } from "./types";

export type { Fixture, FixtureFile, FixtureRevision } from "./types";

/** Served whenever the GitHub path cannot be. A visitor must never face an
 *  empty app because strangers exhausted a shared quota. */
export const FALLBACK_FIXTURE_SLUG = "auth-refactor";

const FIXTURES: Fixture[] = [authRefactor, parserBugfix, docsTypo];

export function listFixtures(): Fixture[] {
  return FIXTURES;
}

export function getFixture(slug: string): Fixture | null {
  return FIXTURES.find((f) => f.slug === slug) ?? null;
}

function toFileDiff(file: FixtureFile): FileDiff {
  if (file.patch === "") {
    return {
      kind: "omitted",
      path: file.path,
      previousPath: file.previousPath,
      blobSha: file.blobSha,
      status: file.status,
      reason: "binary",
    };
  }
  return {
    kind: "patch",
    path: file.path,
    previousPath: file.previousPath,
    blobSha: file.blobSha,
    status: file.status,
    hunks: parseUnifiedDiff(file.patch),
  };
}

/** `revision` is 1-based, matching the `fx/<slug>/<revision>/` PR key. */
export function fixturePullRequest(slug: string, revision: number): PullRequest | null {
  const fixture = getFixture(slug);
  if (fixture === null) return null;
  const rev: FixtureRevision | undefined = fixture.revisions[revision - 1];
  if (rev === undefined) return null;
  return {
    ref: { kind: "fixture", slug, revision },
    title: fixture.title,
    author: fixture.author,
    headSha: rev.headSha,
    baseSha: rev.baseSha,
    files: rev.files.map(toFileDiff),
  };
}

/** The number of revisions a fixture has, so the UI can offer "re-fetch head"
 *  only where there is a later revision to move to. */
export function fixtureRevisionCount(slug: string): number {
  return getFixture(slug)?.revisions.length ?? 0;
}
