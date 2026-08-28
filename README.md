# diffsync

Several reviewers on one pull request at once — live presence, threaded comments
anchored to lines of the diff, and an optional AI reading-order pass. Comments are
anchored to lines, and lines move, so a thread either follows its code or says out
loud that it is outdated; it never quietly re-points at different code.

**Stack:** Next.js 16 (App Router) + TypeScript on Vercel · Cloudflare Durable Objects
(SQLite) · Neon Postgres · Zod · Vitest + fast-check · Playwright

**Live:** https://diffsync-shivangraval50-5211s-projects.vercel.app
 · Worker: https://diffsync-prs.shivangraval5789.workers.dev

---

## The hard part

It is not the real-time layer. One Durable Object per pull request is single-threaded,
comments are append-only, and nothing is ever edited or deleted — so ordering is
serialised by construction and there is no conflict resolution to get wrong.

The hard part is that **a comment is anchored to a line, and lines move.** Someone
force-pushes, or you fetch a new head, and the line a thread was written about is now
three rows further down — or gone. The failure that matters is not a lost thread. It is
a *silent mis-anchor*: a thread that quietly re-points at different code, so two
reviewers end up arguing about code nobody wrote, each convinced the other is reading
the diff wrong. Nothing in the UI would look broken.

So relocation is a total, pure function with exactly two outcomes:

```ts
relocate(anchor, target) -> { kind: "located"; line: number } | { kind: "outdated" }
```

There is no third outcome, no `line: number | null`, and no best-effort branch. Two
equally good candidate positions resolves to `outdated`, not "the nearer one". Losing a
thread's position and saying so is strictly cheaper than pointing at the wrong code.

### How that is actually enforced

An anchor is `(filePath, blobSha, line, fingerprint, context)`. The `context` is a
seven-slot window centred on the anchored line — three either side, `CONTEXT_RADIUS = 3` —
normalised and stored **verbatim**, alongside a 64-bit FNV-1a hash of it. A slot the diff
does not expose holds a sentinel rather than being dropped, so the window is always
exactly seven entries wide.

`relocate` applies five rules, in order (`packages/anchor/src/relocate.ts`):

1. **Path mismatch → `outdated`.** Renames are not followed; following one would be a
   guess.
2. **Equal `blobSha` → `located` at the same line.** A blob sha is content-addressed, so
   equal sha means equal bytes — strictly stronger evidence than any window. The line
   must still be exposed by this rendering, because a thread needs a row to attach to.
3. **The fingerprint is an index, not the proof.** Every hash hit is confirmed
   element-wise against the stored `context` before it counts. A hash collision degrades
   to `outdated`, never to a silent mis-anchor.
4. **Two confirmed matches → `outdated`.** Two answers is the same as no answer.
5. **A distinctiveness precondition, checked before the scan runs at all.** An anchor
   whose stored window carries fewer than `MIN_DISTINCTIVE_SLOTS = 4` distinctive slots
   out of 7 is refused outright. A slot is distinctive when it is neither the `GAP`
   sentinel (a line this diff does not expose, or past the file's end) nor blank. A
   window like `[GAP, GAP, GAP, "}", GAP, GAP, GAP]` matches every isolated `}` in the
   file; it is not evidence, and rule 4 only helps when both occurrences happen to be
   visible in the same scan. Rule 5 refuses to scan on evidence that thin regardless of
   what the target contains.

The window is a fixed-length tuple type, not `string[]`, so slicing or truncating one
before hashing it is a compile error rather than a silently weaker fingerprint. That
sentinel is `GAP`, the string `"\u0000GAP"` — a NUL byte cannot appear in a line that
survived a unified diff, so an unknown slot can never compare equal to a known one.

`packages/anchor` has no I/O and no platform imports. The same code runs in the Durable
Object, in the browser, and under Node in the test suite.

---

## Architecture

**One Durable Object per pull request is the sole authority for its live state.** The
pull-request key — base64url of `<nonce>/gh/<owner>/<repo>/<number>` or
`<nonce>/fx/<slug>/<revision>` — *is* the object's name, so two different pull requests
cannot collide onto one comment log.

**The log is append-only and the state is a pure fold.** Events (`threadOpened`,
`replyAdded`, `threadResolved`, `threadUnresolved`) go into a SQLite table inside the
object; `applyEvent` folds them into thread state. It is total — every event either
produces a new state or returns the state unchanged, and it never throws, because both
consumers would be left with nothing usable if it did. The Durable Object rebuilds from
the log after eviction with no extra bookkeeping, and the browser folds the same delta
stream with the same reducer. A reconnecting client that missed more than
`SNAPSHOT_THRESHOLD = 500` events gets a snapshot instead of a replay.

**Placement is derived, never stored.** `placeThreads` recomputes every thread's position
on every render from its original anchor and the current revision's targets, so a thread
can never be displayed at a position that was true for a revision the reader is not
looking at.

**`AnchorTarget` is deliberately sparse.** It is a `Map<number, string>` of new-side line
number to text, populated only from lines the diff actually exposes — context and
additions, never removals. A unified diff shows only the inside of its hunks, and
pretending otherwise is exactly what would let a thread land on a line nobody rendered.
A file GitHub omitted (binary, or over the size limit) yields an empty target, so nothing
can anchor into content that was never delivered.

**The diff source is a fixture or GitHub.** Three seeded pull requests are committed to
this repo — they work offline and are never rate-limited — and any public GitHub pull
request URL resolves through the unauthenticated API. When that quota is gone, the
visitor gets a sample *and a banner saying why*, rather than an empty app.

**Neon is an archive the live path does not depend on.** The Durable Object only ever
writes to it, through a local SQLite outbox drained by an alarm, so a failed write costs
a retry and nothing else. The single read is the home page's "recently reviewed" list.
With Postgres unreachable or unconfigured, every page renders and every socket works —
`recentPrs` returns `[]` for any failure at all, and the archive rows are simply missing.

**The AI pass is decoration.** One call per pull request, cached in the Durable Object,
never re-run per view. It reuses `@openbid/llm`'s `LlmProvider` port (a git submodule at
`vendor/openbid`, from this portfolio's previous project). Its reply is parsed with
`safeParse` and never cast; flags naming a file that is not in this pull request are
dropped; any failure at all degrades to `null`. With no key configured it is silent, and
that silence is a test.

---

## Testing

**333 unit, property and component tests across 39 files**, plus **4 Playwright tests in
2 spec files**. 55 non-test source files (4,114 lines) are covered by 41 test files
(5,909 lines).

The strongest tests are the property tests in `packages/anchor/src/properties.test.ts` —
13 of them, 11 driven by fast-check across 2,350 generated cases, 2 deterministic pins of
shrunk counterexamples that were found the hard way.

The central property: **a located anchor's window in the new revision is element-wise
identical to the window it captured, or it reported outdated.** That claim alone is
satisfied by a stub that always returns `outdated`, so it is paired with liveness
properties such a stub fails:

- unchanged content with a *changed* sha relocates to the same line — which forces the
  scan path rather than the sha fast path;
- content shifted down by *k* inserted lines relocates by exactly *k*;
- relocation is idempotent.

And with safety properties:

- a duplicated body, where every interior window now occurs twice, is `outdated`;
- an overwritten window is `outdated`;
- a sub-threshold sparse window is `outdated` **even when an identical one exists
  elsewhere** — this is the regression guard for rule 5, and it goes red immediately if
  rule 5 is removed.

Two properties assert behaviour that is *not* ideal, on purpose, so it stays a recorded
decision rather than a surprise: the file-edge false-outdated, and the residual
duplicate-block risk in the limitations below. A later "fix" that loosens `GAP`
comparison breaks a named test.

The Playwright specs run two independent browser contexts — separate cookies, so separate
guest identities, genuinely two reviewers rather than two tabs:

- `two-reviewers.spec.ts` proves a thread opened by one reviewer arrives for the other
  attributed and *on the line it was written about*; that replies flow back; that both
  reviewers see comments in the same order (the Durable Object's serialisation, observed
  through the UI); that resolve and unresolve converge; and that one reviewer's cursor is
  visible and attributed to the other.
- `force-push.spec.ts` is the one that proves the anchoring claim end to end. Two threads
  are opened, then the head is advanced. One thread must appear at line 18 having been
  written at line 15 — asserted by its position in the diff, since a thread rendered at
  its old line number would pass a "still visible" check while pointing at different
  code. The other must appear detached in the outdated panel, named, quoting the original
  source line — and must *not* also be rendered inline pretending to be current.

```bash
npm test        # 333 tests, 39 files — includes the Durable Object tests, which run
                # under @cloudflare/vitest-pool-workers against a real workerd
npm run e2e     # Playwright: two reviewers, and a force-push
npm run typecheck
```

---

## Running it

Node 22 (`.nvmrc`). These are the exact commands the Playwright suite brings the app
up with, so they are exercised on every `npm run e2e`.

```bash
git clone --recurse-submodules https://github.com/shivangraval50/diffsync
cd diffsync
npm install
cp apps/web/.env.example apps/web/.env.local
# AUTH_SECRET: any random string (`openssl rand -base64 32`). Everything else
# in that file is optional and may be left blank.
```

Then two terminals:

```bash
npx wrangler dev --config packages/pr-do/wrangler.toml   # :8787
npm run dev --workspace @diffsync/web                     # :3000
```

Open http://127.0.0.1:3000 in two windows and pick a sample pull request.

If you cloned without `--recurse-submodules`, run `git submodule update --init` before
`npm install` — `vendor/openbid` supplies `@openbid/llm`, which is a workspace of this
repo, and the root install cannot resolve the workspace list without it.

Only `AUTH_SECRET` needs a value. With no `DATABASE_URL` the archive and the "recently
reviewed" list are absent and nothing else changes. With no LLM key the AI panel is
silent. With no `AUTH_GITHUB_*` there is no sign-in control in the UI at all and you are
a guest with a generated nickname, which is all the review surface requires. The live
deployment runs in exactly that configuration.

Deploying it is a separate document: [DEPLOY.md](./DEPLOY.md).

---

## Limitations

These are real. Most of them are recorded as tests.

**1. Content-based anchoring can still be fooled.** If a block of genuinely identical
lines appears more than once and the *true* occurrence is edited away while a coincidental
copy survives, `relocate` returns `located` for the wrong copy. Property testing found
this after the distinctiveness threshold was added, and it is asserted as current
behaviour in `properties.test.ts` rather than papered over. Rule 5 shrinks the window but
cannot close it: when the content really is identical, there is nothing left to
distinguish the copies with. Rule 4 catches it whenever both copies remain visible in the
same scan — including the three-or-more-occurrence case, which is also a test. Closing it
fully would need identity-based anchoring rather than a fixed-radius text window, which
is out of scope here.

**2. The distinctiveness threshold has a cost.** Anchors near the first or last lines of
a file, in very short files, or in hunks that render little context, report `outdated`
more readily than a human would. Inserting a line above an anchor at the top of a file
turns `GAP` padding into real text — the window genuinely changed, and the answer is
genuinely `outdated`. That is the safe direction and it is deliberate, but it is a real
cost, not a free win, and it shows up as "outdated more often than expected" at file
edges and in sparsely-rendered regions.

**3. A no-content rename is mislabelled.** `packages/pr-do/src/github.ts` separates
"binary" from "too large" by `additions + deletions === 0`, because GitHub omits the
`patch` field for both without saying which. A pure rename with no content change also has
zero line changes, so it is reported as `reason: "binary"`. Wrong label, right behaviour —
the file is correctly treated as omitted either way.

**4. The AI prompt has no per-pull-request size cap.** Each hunk is truncated to its
first 12 lines and the completion is capped at 1024 tokens, but a pull request with
hundreds of hunks builds one proportionally large prompt. Nothing breaks — the call fails
and the pass degrades to `null` — but the cost is unbounded before that point.

**5. GitHub's unauthenticated API is 60 requests/hour, shared by IP.** That is why the
seeded fixtures exist. On a shared host the quota may already be gone when you arrive;
the banner tells you so, and concurrent socket handshakes are coalesced onto one fetch so
a busy pull request does not spend the quota faster than it has to. There is no
authenticated path.

**6. There is no styling.** Zero CSS files, zero `className` attributes, zero inline
styles — the UI is unstyled semantic HTML throughout, which is why the Playwright specs
can select almost everything by role and label. It reads as a browser default page.
That is a genuine gap in a portfolio piece, not a minimalist choice, and it is listed
here rather than left for you to discover.

**Out of scope by design:** no co-editing, no write-back to GitHub, no suggested patches,
no repository browsing. The diff is read-only, and there is no write path to make it
otherwise.
