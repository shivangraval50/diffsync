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
    // Playwright owns e2e/**. Without this, vitest's default *.spec.ts
    // include pattern picks those files up and its Node runner imports
    // @playwright/test, which refuses to construct a test() outside the
    // Playwright runner.
    exclude: [...defaultExclude, "e2e/**"],
  },
});
