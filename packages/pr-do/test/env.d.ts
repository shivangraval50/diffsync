import type { PrDO } from "../src/PrDO.js";

/**
 * `cloudflare:test`'s `ProvidedEnv` is an empty interface by design --
 * augmented per-project so `env.<BINDING>` in a test file is typed the same
 * way `env` is inside a Worker. `PRS` mirrors the binding declared in
 * `wrangler.toml` and consumed by `src/index.ts`.
 */
declare module "cloudflare:test" {
  interface ProvidedEnv {
    PRS: DurableObjectNamespace<PrDO>;
  }
}
