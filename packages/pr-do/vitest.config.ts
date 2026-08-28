import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        // Cloudflare's own docs: "Using WebSockets with Durable Objects is not
        // supported with per-file storage isolation."
        // https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#websockets
        //
        // With isolation off, every test file shares the same underlying DO
        // storage. `singleWorker: true` stops files running in parallel
        // against it, and every PR key in the tests is suffixed with
        // crypto.randomUUID() so no two tests can collide on one object.
        isolatedStorage: false,
        singleWorker: true,
        wrangler: { configPath: "./wrangler.toml" },
      },
    },
  },
});
