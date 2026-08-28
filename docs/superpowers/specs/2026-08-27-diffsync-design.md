# diffsync — design

**Status:** approved 2026-08-27
**Program context:** Project 2 of 3 in a front-end-forward portfolio program (`openbid`, then `diffsync`, then `rag-console`).

## Why this exists

Of 22 public repos, 19 are Python/C++/OCaml systems work. `openbid` (project 1, shipped and deployed) established the Next.js App Router / TypeScript / real-time / tested front-end stack. `diffsync` is the second project closing that gap, and is deliberately the harder of the two remaining: it has a genuine correctness problem at its centre rather than only an integration one.

It is built second because it reuses every piece of platform work `openbid` retired — Cloudflare Durable Objects, Vercel, Neon, Auth.js, Vitest/RTL, Playwright, GitHub Actions, the `LlmProvider` port, and the deploy runbook including its three documented traps.

## What it is

A code-review surface where several reviewers work the same pull request at once: live presence and cursors, threaded comments anchored to lines of a diff, resolve/unresolve, and an AI pass that summarises the change and ranks the hunks worth attention first.

The diff is **read-only**. This is review, not collaborative editing.

## The hard part

Not the real-time layer — `openbid` already proved that, and comments are append-only, so the Durable Object provides ordering and there is no conflict resolution to do.

The hard part is that **a comment is anchored to a line, and lines move.** Re-rendering with more context, switching to split view, or a force-push to the branch all mean "line 42" is no longer the line the reviewer meant.

**The failure that matters is silent mis-anchoring.** A thread that quietly re-points at different code makes reviewers argue about code nobody wrote. That is strictly worse than losing the thread's position and saying so.

### Anchoring model

A comment anchor is:

- `filePath`
- `blobSha` — the file's content hash at the time of comment
- `line` — position within that blob
- `fingerprint` — a hash of the N lines surrounding the anchor

Relocation is a pure function:

```
relocate(anchor, newDiff) -> { kind: "located", line } | { kind: "outdated" }
```

It attempts to find the anchor's fingerprint in the new content. On a match, the thread moves to the new line. On no match, the thread is marked **outdated** and displayed detached from the code, with its original quoted context preserved.

There is no third outcome. A guess is not permitted.

## Architecture

- **One Durable Object per pull request** is the sole authority for that PR's live state: connected reviewers, presence/cursors, and the append-only comment log. Single-threaded, so ordering is serialised by construction — the same property `openbid` relies on, and for the same reason.
- **Next.js 16 App Router.** The diff renders in a server component; presence and threads are a client island.
- **Neon** stores PR metadata and resolved threads. Live state stays in the DO. No live state depends on Postgres.
- **`@openbid/llm`'s `LlmProvider` port** is reused for the AI pass — its second consumer, which is the one shared artifact the `openbid` spec committed to.

## Diff sources

1. **Seeded fixture PRs**, committed to the repo. The demo works cold, offline, with no auth, and can never be rate-limited.
2. **Any public GitHub PR URL**, pasted by the visitor, fetched through GitHub's unauthenticated public API (60 req/hr, shared) and cached per PR in the Durable Object.

The seeded PRs are the fallback whenever the API is unavailable or rate-limited. A visitor must never face an empty app because strangers exhausted a shared quota.

## The AI pass

One call per pull request:

- a 2–3 sentence plain-language summary of what changed
- ranked hunks worth reading first, each with a one-line reason

Rules:

- Output is **labelled as model output**, never presented as findings.
- Cached per PR; not re-run on every view.
- **Silent when unconfigured.** No key means no summary and a fully usable review surface — the same degradation discipline as `openbid`'s commentary, which was verified by test rather than asserted.

## Testing

- **Property tests on relocation.** The invariant: a relocated anchor points at the *same content* it originally pointed at, or it reports `outdated`. It may never point at different content. This is the project's central claim and gets its strongest test.
- **Playwright, two browser contexts.** Two reviewers on one PR: a thread opened by one appears for the other, in order, and resolve state converges.
- Unit and RTL coverage for the diff renderer, thread UI, and the fetch/fallback path.

## Out of scope

- Co-editing of any kind. No CRDT, no OT.
- Write-back to GitHub. Nothing is posted to a real PR.
- Inline suggested patches.
- Repo browsing beyond the changed files of the PR under review.

Each exclusion is a deliberate boundary that keeps this a review surface rather than a GitHub client.

## Open decisions deferred to the plan

- Identity: expected to reuse `openbid`'s guest-cookie + optional GitHub sign-in shape, including the lesson that a client-writable cookie must be length-truncated before it reaches the wire.
- Whether resolved threads archive to Neon on resolve or on PR close.
