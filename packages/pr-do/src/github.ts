import { z } from "zod";
import {
  DiffParseError,
  parseUnifiedDiff,
  type FileDiff,
  type FileStatus,
  type PullRequest,
} from "@diffsync/diff";

export type GithubResult =
  | { kind: "ok"; pr: PullRequest }
  | { kind: "rate_limited" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

const API = "https://api.github.com";

/** api.github.com answers 403 to a request without a User-Agent. Without this
 *  header every GitHub pull request would look rate-limited. */
const USER_AGENT = "diffsync (+https://github.com/shivangraval50/diffsync)";

/** GitHub caps a pull request's file list at 300 (3 pages of 100). Asking for
 *  more is not an error, it simply returns nothing further. */
const MAX_PAGES = 3;

// Third-party wire format, validated on one side only -- which is why this
// schema lives here rather than in @diffsync/protocol, the package for
// contracts this repo owns on both ends. Permissive about fields it does not
// use, strict about the shape of the ones it does.
const pullSchema = z.object({
  title: z.string().min(1),
  user: z.object({ login: z.string().min(1) }).nullable(),
  head: z.object({ sha: z.string().min(1) }),
  base: z.object({ sha: z.string().min(1) }),
});

const fileSchema = z.object({
  filename: z.string().min(1),
  previous_filename: z.string().min(1).optional(),
  sha: z.string().min(1),
  status: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string().optional(),
});

function mapStatus(status: string): FileStatus {
  switch (status) {
    case "added":
    case "copied":
      return "added";
    case "removed":
      return "removed";
    case "renamed":
      return "renamed";
    default:
      // "modified", "changed", "unchanged", and anything GitHub adds later.
      return "modified";
  }
}

function toFileDiff(file: z.infer<typeof fileSchema>): FileDiff {
  const common = {
    path: file.filename,
    previousPath: file.previous_filename ?? null,
    blobSha: file.sha,
    status: mapStatus(file.status),
  };

  if (file.patch === undefined) {
    return {
      kind: "omitted",
      ...common,
      // GitHub omits `patch` for binaries and for over-sized text files
      // without saying which. Zero line changes is the signal that separates
      // them, and it is the only one available.
      reason: file.additions + file.deletions === 0 ? "binary" : "too_large",
    };
  }

  try {
    return { kind: "patch", ...common, hunks: parseUnifiedDiff(file.patch) };
  } catch (error) {
    if (!(error instanceof DiffParseError)) throw error;
    // One unparseable patch must not cost the reviewer every other file.
    return { kind: "omitted", ...common, reason: "too_large" };
  }
}

function classifyFailure(res: Response): GithubResult {
  if (res.status === 404) return { kind: "not_found" };
  if (
    (res.status === 403 || res.status === 429) &&
    res.headers.get("x-ratelimit-remaining") === "0"
  ) {
    return { kind: "rate_limited" };
  }
  return { kind: "unavailable" };
}

/**
 * `ref.owner` and `ref.repo` become path segments of the request URL below.
 * Callers MUST pass values that already went through `decodePrKey`'s
 * `isSafeName` guard (rejects "/", ".", and ".."): this function does not
 * re-validate them, so an unvalidated string here is a path-traversal
 * vulnerability into api.github.com's URL space, not just a broken request.
 */
export async function fetchGithubPr(
  ref: { owner: string; repo: string; number: number },
  fetchImpl: typeof fetch = fetch
): Promise<GithubResult> {
  const base = `${API}/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": USER_AGENT,
    "x-github-api-version": "2022-11-28",
  };

  try {
    const pullRes = await fetchImpl(base, { headers });
    if (!pullRes.ok) return classifyFailure(pullRes);
    const pull = pullSchema.parse(await pullRes.json());

    const files: FileDiff[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const filesRes = await fetchImpl(`${base}/files?per_page=100&page=${page}`, { headers });
      if (!filesRes.ok) return classifyFailure(filesRes);
      const parsed = z.array(fileSchema).parse(await filesRes.json());
      files.push(...parsed.map(toFileDiff));
      if (parsed.length < 100) break;
    }

    return {
      kind: "ok",
      pr: {
        ref: { kind: "github", owner: ref.owner, repo: ref.repo, number: ref.number },
        title: pull.title,
        author: pull.user?.login ?? "unknown",
        headSha: pull.head.sha,
        baseSha: pull.base.sha,
        files,
      },
    };
  } catch {
    // A network failure, or a response that is not the shape GitHub
    // documents. Either way the visitor gets the fallback, not an error page.
    return { kind: "unavailable" };
  }
}
