/** @type {import('next').NextConfig} */
export default {
  transpilePackages: [
    "@diffsync/anchor",
    "@diffsync/diff",
    "@diffsync/fixtures",
    "@diffsync/protocol",
    "@diffsync/threads",
  ],
  // The Playwright config drives the app at http://127.0.0.1:3000, and Next's
  // dev-only cross-origin guard does not treat that as the same origin as
  // localhost by default -- it then refuses every HMR and static-chunk
  // request from the Playwright browser, so the page server-renders but never
  // hydrates and no interactive control ever enables.
  allowedDevOrigins: ["127.0.0.1"],
  // Every @diffsync/* package (this repo's own convention, shared with the
  // Cloudflare Worker target) writes relative imports with an explicit ".js"
  // extension pointing at a sibling ".ts" file -- valid under tsconfig's
  // "bundler" moduleResolution and under Vitest, but not automatically
  // resolved by webpack: an import specifier that already carries an
  // extension is treated as fully specified and not retried with another
  // one. Without this, every transpiled package fails to bundle with
  // "Module not found: Can't resolve './parse.js'" even though "parse.ts"
  // is right there. Webpack-only: see the "dev"/"build" scripts, which pin
  // this app off Turbopack (Next 16's default) because Turbopack has no
  // equivalent for an already-extensioned specifier -- its own
  // "resolveExtensions" only extends extension-less lookups.
  experimental: {
    extensionAlias: { ".js": [".ts", ".tsx", ".js"] },
  },
};
