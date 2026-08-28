import { describe, it, expect, vi } from "vitest";
import { fetchGithubPr } from "./github.js";

const REF = { owner: "vercel", repo: "next.js", number: 42 };

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

const PULL = {
  title: "Fix the thing",
  user: { login: "octocat" },
  head: { sha: "headsha" },
  base: { sha: "basesha" },
};

const FILES = [
  {
    filename: "src/a.ts",
    sha: "blob-a",
    status: "modified",
    additions: 1,
    deletions: 1,
    patch: "@@ -1,1 +1,1 @@\n-a\n+b",
  },
];

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL) => handler(String(input)));
}

describe("fetchGithubPr", () => {
  it("maps a pull request and its files into a PullRequest", async () => {
    const fetchImpl = stubFetch((url) =>
      url.endsWith("/files?per_page=100&page=1") ? jsonResponse(FILES) : jsonResponse(PULL)
    );

    const result = await fetchGithubPr(REF, fetchImpl as unknown as typeof fetch);
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
    expect(result.pr.title).toBe("Fix the thing");
    expect(result.pr.author).toBe("octocat");
    expect(result.pr.headSha).toBe("headsha");
    expect(result.pr.ref).toEqual({ kind: "github", ...REF });
    const file = result.pr.files[0];
    if (file?.kind !== "patch") throw new Error("expected a patch file");
    expect(file.blobSha).toBe("blob-a");
    expect(file.hunks[0]?.lines).toHaveLength(2);
  });

  it("requests exactly the URL built from the validated ref, nothing traversal-shaped", async () => {
    // The load-bearing assertion for this client: `owner`/`repo`/`number`
    // interpolate directly into the request URL, so a loose mock (any 200
    // JSON body, whatever the URL) would let a traversal-shaped ref sail
    // through undetected. Pin the exact path for both requests this call
    // makes.
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return String(input).includes("/files") ? jsonResponse(FILES) : jsonResponse(PULL);
    });
    await fetchGithubPr(REF, fetchImpl as unknown as typeof fetch);
    expect(seen).toEqual([
      "https://api.github.com/repos/vercel/next.js/pulls/42",
      "https://api.github.com/repos/vercel/next.js/pulls/42/files?per_page=100&page=1",
    ]);
  });

  it("sends a User-Agent, which GitHub rejects the request without", async () => {
    // Not a style preference: api.github.com answers 403 to a request with no
    // User-Agent, so omitting it would make every GitHub PR look rate-limited.
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("user-agent")).toMatch(/diffsync/iu);
      return jsonResponse(PULL);
    });
    await fetchGithubPr(REF, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("reports rate_limited on a 403 with no remaining quota", async () => {
    const fetchImpl = stubFetch(() =>
      jsonResponse(
        { message: "API rate limit exceeded" },
        { status: 403, headers: { "x-ratelimit-remaining": "0" } }
      )
    );
    expect(await fetchGithubPr(REF, fetchImpl as unknown as typeof fetch)).toEqual({
      kind: "rate_limited",
    });
  });

  it("reports unavailable on a 403 that still has quota left", async () => {
    // A 403 with quota remaining is something else -- a blocked repo, an abuse
    // detection trip -- and telling the visitor "rate limited" would be wrong.
    const fetchImpl = stubFetch(() =>
      jsonResponse({ message: "no" }, { status: 403, headers: { "x-ratelimit-remaining": "37" } })
    );
    expect(await fetchGithubPr(REF, fetchImpl as unknown as typeof fetch)).toEqual({
      kind: "unavailable",
    });
  });

  it("reports not_found for a 404", async () => {
    const fetchImpl = stubFetch(() => jsonResponse({ message: "Not Found" }, { status: 404 }));
    expect(await fetchGithubPr(REF, fetchImpl as unknown as typeof fetch)).toEqual({
      kind: "not_found",
    });
  });

  it("reports unavailable when the network throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection reset");
    });
    expect(await fetchGithubPr(REF, fetchImpl as unknown as typeof fetch)).toEqual({
      kind: "unavailable",
    });
  });

  it("reports unavailable when the response is not the shape GitHub documents", async () => {
    const fetchImpl = stubFetch(() => jsonResponse({ unexpected: true }));
    expect(await fetchGithubPr(REF, fetchImpl as unknown as typeof fetch)).toEqual({
      kind: "unavailable",
    });
  });

  it("marks a file with no patch and no line changes as binary", async () => {
    // GitHub omits `patch` for both binaries and over-sized text files and
    // does not say which. additions + deletions == 0 is the signal that
    // distinguishes them, so the UI can say something true.
    const fetchImpl = stubFetch((url) =>
      url.includes("/files")
        ? jsonResponse([
            { filename: "logo.png", sha: "blob-p", status: "modified", additions: 0, deletions: 0 },
          ])
        : jsonResponse(PULL)
    );
    const result = await fetchGithubPr(REF, fetchImpl as unknown as typeof fetch);
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.pr.files[0]).toMatchObject({ kind: "omitted", reason: "binary" });
  });

  it("marks a file with no patch but real line changes as too large", async () => {
    const fetchImpl = stubFetch((url) =>
      url.includes("/files")
        ? jsonResponse([
            {
              filename: "data.sql",
              sha: "blob-d",
              status: "modified",
              additions: 90_000,
              deletions: 0,
            },
          ])
        : jsonResponse(PULL)
    );
    const result = await fetchGithubPr(REF, fetchImpl as unknown as typeof fetch);
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.pr.files[0]).toMatchObject({ kind: "omitted", reason: "too_large" });
  });

  it("maps GitHub's extra file statuses onto the four this app models", async () => {
    const fetchImpl = stubFetch((url) =>
      url.includes("/files")
        ? jsonResponse([
            {
              filename: "a.ts",
              sha: "s1",
              status: "copied",
              additions: 1,
              deletions: 0,
              patch: "@@ -0,0 +1,1 @@\n+a",
            },
            {
              filename: "b.ts",
              sha: "s2",
              status: "changed",
              additions: 1,
              deletions: 1,
              patch: "@@ -1,1 +1,1 @@\n-a\n+b",
            },
            {
              filename: "c.ts",
              previous_filename: "old.ts",
              sha: "s3",
              status: "renamed",
              additions: 0,
              deletions: 0,
              patch: "@@ -1,1 +1,1 @@\n-a\n+b",
            },
          ])
        : jsonResponse(PULL)
    );
    const result = await fetchGithubPr(REF, fetchImpl as unknown as typeof fetch);
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.pr.files.map((f) => f.status)).toEqual(["added", "modified", "renamed"]);
    expect(result.pr.files[2]?.previousPath).toBe("old.ts");
  });

  it("maps a deleted GitHub account (user: null) to author \"unknown\" instead of throwing", async () => {
    // `pullSchema.user` is `z.object({ login: ... }).nullable()` because
    // GitHub sends `user: null` for a pull request whose author's account
    // has since been deleted. Catches: a `pull.user.login` access with no
    // null check, which would throw a TypeError for exactly this PR instead
    // of degrading to a name the UI can still display.
    const fetchImpl = stubFetch((url) =>
      url.includes("/files") ? jsonResponse(FILES) : jsonResponse({ ...PULL, user: null })
    );
    const result = await fetchGithubPr(REF, fetchImpl as unknown as typeof fetch);
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.pr.author).toBe("unknown");
  });

  it("skips a file whose patch does not parse rather than failing the whole PR", async () => {
    // One malformed patch from a third party must not cost the visitor every
    // other file in the review.
    const fetchImpl = stubFetch((url) =>
      url.includes("/files")
        ? jsonResponse([
            {
              filename: "bad.ts",
              sha: "s1",
              status: "modified",
              additions: 1,
              deletions: 1,
              patch: "not a patch",
            },
            ...FILES,
          ])
        : jsonResponse(PULL)
    );
    const result = await fetchGithubPr(REF, fetchImpl as unknown as typeof fetch);
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.pr.files.map((f) => f.path)).toEqual(["bad.ts", "src/a.ts"]);
    expect(result.pr.files[0]).toMatchObject({ kind: "omitted", reason: "too_large" });
  });
});
