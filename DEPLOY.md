# Deploying diffsync

Written from the deploy that actually happened on 2026-08-28, not from the plan. Where
the two differ, the difference is called out. Anything marked **UNVERIFIED** was not
executed, because the credential it needs was not available on the deploying machine —
those sections are a runbook, not a report.

Current state:

| Piece | Status | URL |
| --- | --- | --- |
| Worker (`packages/pr-do`) | deployed, verified | https://diffsync-prs.shivangraval5789.workers.dev |
| Web app (`apps/web`) | deployed, verified, public | https://diffsync-shivangraval50-5211s-projects.vercel.app |
| Neon Postgres | **not provisioned** | — |
| GitHub OAuth app | **not created** | — |
| LLM key | **not set** (`LLM_PROVIDER=gemini`, no `GEMINI_API_KEY`) | — |

The last three are genuinely optional. The live app runs without all of them: the archive
and "recently reviewed" list are absent, the AI panel is silent, and every visitor is a
guest with a generated nickname. Nothing else changes.

---

## 1. The Worker

```bash
cd packages/pr-do
npx wrangler deploy
```

That is the whole thing. It applies the Durable Object migration `tag = "v1"` with
`new_sqlite_classes = ["PrDO"]`.

**The migration is now frozen.** Cloudflare migrations are append-only *once applied*.
`wrangler.toml` records the applied date, the script name and the deployed version id in
the comment above the block. Do not edit the tag or the class list again — adding a class
later needs a **new** `[[migrations]]` block with a new tag (`v2`), or Cloudflare's record
of what has been applied desynchronises from this file and the next deploy either fails or
succeeds against the wrong assumption.

Verify:

```bash
KEY=$(printf '/fx/auth-refactor/1' | base64 | tr '+/' '-_' | tr -d '=')
curl -s "https://diffsync-prs.shivangraval5789.workers.dev/prs/$KEY/source" | head -c 40
# => {"origin":"fixture","pr":{"ref":{"kind
```

Then verify the live socket, which the HTTP check does not touch. Two connections to the
same pull request key should each receive a `snapshot`, then see each other in `presence`,
and a `cursor` from one should appear on the other's presence entry. A short Node script
using the built-in `WebSocket` is enough; that is how this deploy was checked.

### `DATABASE_URL` must never be a `[vars]` entry

This is the one that fails silently, so it is worth stating twice. A plaintext `[vars]`
value **takes precedence over a Workers secret of the same name at deploy time**. Adding
even an empty placeholder to `wrangler.toml` would reset the real credential to `""` on
every `wrangler deploy` — archiving stops, no error is raised, no test fails, and the app
looks entirely healthy. `wrangler.toml` carries a comment saying so; leave it there.

Set it as a secret instead:

```bash
npx wrangler secret put DATABASE_URL   # UNVERIFIED: no Neon project exists yet
```

For local development, put it in a gitignored `.dev.vars` file in `packages/pr-do`.

---

## 2. Neon — **UNVERIFIED**

No Neon connection string was available, so this was not run. The Worker is deployed
*without* `DATABASE_URL`, which means the outbox drains, fails, and retries on each alarm,
logging `archive write failed; will retry on the next alarm`. That is by design —
`runArchiveOp` throws rather than returning quietly when nothing is configured, precisely
so a deploy with the secret unset does not discard archives silently.

To finish it:

1. Create a Neon project (free tier) and copy the pooled connection string.
2. Apply the schema:
   ```bash
   psql "$DATABASE_URL" -f packages/pr-do/schema.sql
   ```
   Confirm `pull_requests` and `resolved_threads` both exist.
3. Give it to *both* sides — they use it for different things:
   ```bash
   cd packages/pr-do && npx wrangler secret put DATABASE_URL   # the Worker writes
   ```
   and add `DATABASE_URL` as an encrypted environment variable on the Vercel project
   (the web app reads it for the home page's "recently reviewed" list).

Nothing here is live state. Skipping it entirely leaves every page and every socket
working; only the archive and the "recently reviewed" list are missing. That claim was
checked on the live deployment, which is running exactly this way.

---

## 3. The GitHub repository

```bash
gh repo create diffsync --public --source=. --remote=origin
git push -u origin main
```

`main` is the production branch for both CI and Vercel.

Before pushing, confirm no secret is in the history:

```bash
git grep -nIE 'sk-ant-|AIza[0-9A-Za-z_-]{20,}|gh[pous]_[0-9A-Za-z]{20,}|github_pat_|postgres(ql)?://[^ "]*:[^ "]*@|-----BEGIN [A-Z ]*PRIVATE KEY' $(git rev-list --all)
git log --all --pretty=format: --name-only --diff-filter=A | sort -u | grep -iE '\.env|dev\.vars|\.pem$|\.key$'
```

The only match should be `apps/web/.env.example`, whose values are all empty. That file is
**deliberately tracked**, which matters for the Vercel trap in section 4.

### The submodule

`vendor/openbid` is a git submodule supplying `@openbid/llm`, and it is a **workspace of
this repo**. Without it the root `npm ci` cannot resolve the workspace list and every
subsequent step fails with an unhelpful error — including steps that have nothing to do
with the AI pass.

- `.gitmodules` must use the `https://` URL, not `git@`. Vercel and `actions/checkout`
  clone submodules over HTTPS for public repositories; SSH would need a deploy key.
- The submodule repository must be **public**, and the pinned commit must actually be
  reachable on its remote. A commit that only exists locally clones fine on your machine
  and fails on Vercel and in CI. Check with
  `git -C vendor/openbid ls-remote origin | grep $(git rev-parse HEAD:vendor/openbid)`.
- Both CI jobs pass `submodules: recursive` to `actions/checkout`. Vercel clones
  submodules automatically for public HTTPS submodules — verified here by the production
  build succeeding, since a missing `@openbid/llm` would have broken it.

### Worker deploy automation

`.github/workflows/deploy-worker.yml` redeploys the Worker on any push to `main` touching
`packages/**`. The path filter is deliberately `packages/**` and **not**
`packages/pr-do/**`: the Worker bundles `@diffsync/anchor`, `@diffsync/diff`,
`@diffsync/fixtures`, `@diffsync/protocol` and `@diffsync/threads`, so a change to any of
them changes what gets deployed.

It needs a repository secret **`CLOUDFLARE_API_TOKEN`** — **UNVERIFIED**, not yet added.
`wrangler` on the deploying machine is authenticated by OAuth, which cannot mint an API
token, and none was available otherwise.

The first version of this workflow ran on the docs push (which touched
`packages/pr-do/wrangler.toml`) and failed with *"In a non-interactive environment, it's
necessary to set a CLOUDFLARE_API_TOKEN environment variable"* — a red X on `main` for a
missing credential rather than a real fault. It now guards on the secret and skips with a
notice when it is absent. The guard is a **step-level** `if`, because the `secrets`
context is not available in a job-level one (only `github`, `needs`, `vars` and `inputs`
are), and the token is read through `env` so it never lands on a command line.

To turn it on: create a token in the Cloudflare dashboard from the "Edit Cloudflare
Workers" template (or, at minimum, Account → Workers Scripts → Edit), then
`gh secret set CLOUDFLARE_API_TOKEN`. Until then, deploy the Worker by hand per section 1.
`workflow_dispatch` is enabled so you can exercise the workflow without pushing a no-op
change to `packages/**`.

---

## 4. Vercel

The project was created through the REST API rather than `vercel link`, with these
settings:

| Setting | Value | Why |
| --- | --- | --- |
| Framework | `nextjs` | |
| **Root Directory** | **`apps/web`** | Not the repo root. Without this the build has no Next.js app to find. |
| **Node version** | **`22.x`** | Vercel created the project at `24.x`. See below. |
| Git repository | `shivangraval50/diffsync`, production branch `main` | |
| Build / install command | default | The workspace install at the repo root is what resolves `@diffsync/*` and `@openbid/llm`. |

Environment variables actually set (all three targets — production, preview, development):

| Key | Value | Type |
| --- | --- | --- |
| `PRS_BASE_URL` | `https://diffsync-prs.shivangraval5789.workers.dev` | plain |
| `NEXT_PUBLIC_PRS_BASE_URL` | same | plain |
| `AUTH_SECRET` | freshly generated 32 random bytes, base64 | encrypted |
| `LLM_PROVIDER` | `gemini` | plain |

Deliberately **not** set: `DATABASE_URL`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`,
`GEMINI_API_KEY`, and — see below — `ANTHROPIC_API_KEY`.

### Four traps, three of which bit

**1. `typescript` must be in `apps/web`'s own devDependencies.** Vercel installs and builds
one workspace, so a `typescript` present only in the root `devDependencies` passes CI
(which runs `npm ci` at the repo root) and fails on Vercel with a confusing "please install
typescript" error. It is declared in `apps/web/package.json` — verified still present
before this deploy. *Did not bite, because it was already right.*

**2. Vercel defaults new projects to Node 24.** It did exactly that here, despite the repo
having `.nvmrc` = 22 and `engines: { node: ">=22" }` at the root. Fixed two ways, both
worth keeping:

- `"engines": { "node": "22.x" }` was added to `apps/web/package.json`, which is the
  `package.json` Vercel reads under the Root Directory. This is the in-repo fix, so a
  project recreated later gets it for free.
- The project's `nodeVersion` was also patched to `22.x` directly.

**3. New projects are behind Vercel Authentication.** The first production deployment
succeeded and then answered `302` to the world, redirecting to a Vercel SSO login. A
portfolio link that a hiring engineer cannot open is worse than no link. This was turned
off for this project during the deploy; do the same for any new one (`ssoProtection: null`, or Settings → Deployment
Protection → Vercel Authentication → Disabled), then re-check for a `200`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://diffsync-shivangraval50-5211s-projects.vercel.app/
```

**4. `vercel link` appends a blanket `.env*` line to `.gitignore`.** That would hide
`apps/web/.env.example`, which is deliberately tracked and is what the README's setup
instructions tell you to copy. This deploy used the REST API and never ran `vercel link`,
so it did not happen — but if you ever do run it, check `git status` and `git diff
.gitignore` immediately after, and narrow the entry back to `.env`, `.env.local`,
`.env*.local`.

### Do not set `ANTHROPIC_API_KEY` here

`selectProvider` (`vendor/openbid/packages/llm/src/index.ts`) prefers Anthropic whenever
`LLM_PROVIDER` is unset and an Anthropic key is present, and it bills per call. The
deployed project therefore sets `LLM_PROVIDER=gemini` explicitly and has no Anthropic key
at all.

With `LLM_PROVIDER=gemini` and no `GEMINI_API_KEY`, `selectProvider` throws
`LlmConfigError`, the `/api/ai/[key]` route catches that specific class and returns
`{ "pass": null }`, and the AI panel renders nothing. Verified on the live deployment:

```bash
curl -s https://diffsync-shivangraval50-5211s-projects.vercel.app/api/ai/L2Z4L2F1dGgtcmVmYWN0b3IvMQ
# => {"pass":null}
```

To enable the AI pass, add `GEMINI_API_KEY` as an encrypted environment variable and
redeploy. Nothing else changes.

### GitHub sign-in — **UNVERIFIED**

`AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` are unset because no OAuth app was created. This
is invisible in the running app: there is no sign-in control in the UI at all, so the
GitHub provider is configured but never reached, and every visitor is a guest with a
generated nickname. To enable it, register a GitHub OAuth app with callback URL
`https://<your-vercel-url>/api/auth/callback/github`, set both variables, and redeploy.
`AUTH_SECRET` is already set and is required regardless.

---

## 5. Verifying a deploy

What was actually checked on the live deployment:

1. Home page returns `200` and lists all three seeded pull requests.
2. A sample pull request page server-renders the diff, the head sha, the
   "seeded sample pull request" banner, and a generated guest nickname — which proves the
   Vercel → Worker `/source` call works across the origin boundary.
3. Two `wss://` connections to the same pull request key each get a `snapshot`, appear in
   each other's `presence`, and propagate a `cursor` between them.
4. `/api/ai/<key>` returns `{"pass":null}` with no LLM key configured.

Not yet done by hand on production: opening two browser windows, commenting in one and
watching it arrive in the other, then pressing "Fetch new head" to watch one thread move
and one drop into the outdated panel. That exact scenario is what
`apps/web/e2e/force-push.spec.ts` and `apps/web/e2e/two-reviewers.spec.ts` assert, and both
pass locally and in CI against the same code — but against a locally-run Worker, not the
deployed one.

## 6. Rollback

- **Web:** promote the previous deployment from the Vercel dashboard, or
  `vercel rollback <deployment-url>`.
- **Worker:** `npx wrangler rollback` from `packages/pr-do`, or `wrangler deployments
  list` and roll back to a named version. This does **not** roll back the Durable Object
  migration and must not be expected to — `v1` stays applied.
- **Durable Object data** is per-object SQLite inside Cloudflare. There is no backup and no
  export path. The comment log for a review is not recoverable if an object is deleted;
  only resolved threads reach the Neon archive.
