import { fileURLToPath } from "node:url";
import { defaultExclude, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Mirrors tsconfig's "@/*" mapping so components imported via "@/..."
  // resolve the same way under vitest as under `next build`.
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    // next-auth@5's lib/env.js does `import { NextRequest } from "next/server"`
    // with no extension -- its own source flags this with `@ts-expect-error
    // ... Next.js does not yet correctly use the package.json#exports field`.
    // Next's own bundler tolerates that; Vitest normally runs node_modules
    // deps like next-auth through Node's native ESM loader (it "externalizes"
    // them), which has no extension-probing fallback for a bare specifier
    // outside an "exports" map and fails with "Cannot find module
    // '.../next/server'". Forcing next-auth through Vite's own transform
    // pipeline instead (which does resolve it) is what makes `./auth.ts`
    // importable under vitest at all.
    server: { deps: { inline: [/next-auth/] } },
    // Playwright owns e2e/**. Without this, vitest's default *.spec.ts
    // include pattern picks those files up and its Node runner imports
    // @playwright/test, which refuses to construct a test() outside the
    // Playwright runner.
    exclude: [...defaultExclude, "e2e/**"],
  },
});
