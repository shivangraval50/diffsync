import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // These tests share Durable Objects by pull request key, so they must not
  // race each other.
  fullyParallel: false,
  // In CI Playwright switches to the "dot" reporter, which never writes
  // playwright-report/. The CI job uploads that exact path on failure, and
  // upload-artifact only warns when its glob matches nothing -- so without an
  // explicit html reporter the failure artifacts would silently be empty.
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: "http://127.0.0.1:3000", trace: "retain-on-failure" },
  webServer: [
    {
      command: "npx wrangler dev --port 8787",
      cwd: "../../packages/pr-do",
      // Playwright's own readiness probe (`isURLAvailable` in
      // playwright-core) only treats a 200-403 response as "the server is
      // up" -- a 404 does NOT count, except for the special `pathname === "/"`
      // retry-as-"/index.html" case, which does not apply to a Worker that
      // serves no static files. `/prs/none/source` 404s (`"none"` does not
      // decode to a real PR key), so it would poll for the full 60s timeout
      // and fail before any spec ever ran. This key encodes a real,
      // always-present fixture (`auth-refactor` rev 1) under a nonce
      // ("readyprobe") no spec file uses, so it resolves purely from local
      // fixture data -- no network call, no shared GitHub quota touched, and
      // no collision with any test's own Durable Object.
      url: "http://127.0.0.1:8787/prs/cmVhZHlwcm9iZS9meC9hdXRoLXJlZmFjdG9yLzE/source",
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: "npm run dev -- --port 3000",
      url: "http://127.0.0.1:3000",
      reuseExistingServer: true,
      timeout: 120_000,
      env: {
        PRS_BASE_URL: "http://127.0.0.1:8787",
        NEXT_PUBLIC_PRS_BASE_URL: "http://127.0.0.1:8787",
        AUTH_SECRET: "e2e-not-a-real-secret",
      },
    },
  ],
});
