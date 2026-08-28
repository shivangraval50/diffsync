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
};
