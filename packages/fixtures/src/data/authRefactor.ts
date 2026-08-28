import type { Fixture } from "../types.js";

/**
 * The demo fixture, and the fallback whenever the GitHub path is unavailable.
 *
 * Its two revisions are chosen so that all three relocation outcomes appear in
 * one force-push, which is what Task 19's Playwright test drives:
 *
 *  - `src/auth/session.ts`  a guard clause is inserted ABOVE the anchored
 *    region, so a thread on it relocates from line 15 to line 18.
 *  - `src/auth/token.ts`    the anchored region is rewritten, so a thread on
 *    it goes outdated and shows its quoted context detached.
 *  - `README.md`            untouched by the force-push, so its blob sha is
 *    identical across revisions and a thread on it stays exactly where it is
 *    via the sha-equality path in `relocate`.
 */
export const authRefactor: Fixture = {
  slug: "auth-refactor",
  title: "Refactor session issuance and token signing",
  author: "octo-reviewer",
  blurb: "Three files, two revisions. The second revision is a force-push.",
  revisions: [
    {
      headSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      baseSha: "0000111122223333444455556666777788889999",
      files: [
        {
          path: "src/auth/session.ts",
          previousPath: null,
          blobSha: "blob-session-r1",
          status: "modified",
          patch: [
            "@@ -12,8 +12,9 @@ export function createSession(user) {",
            "   const now = Date.now();",
            "   const session = {",
            "     userId: user.id,",
            "-    expiresAt: now + ONE_HOUR,",
            "+    expiresAt: now + SESSION_TTL_MS,",
            "+    issuedAt: now,",
            "   };",
            "   store.set(session.userId, session);",
            "   return session;",
            " }",
          ].join("\n"),
        },
        {
          path: "src/auth/token.ts",
          previousPath: null,
          blobSha: "blob-token-r1",
          status: "modified",
          patch: [
            "@@ -4,4 +4,5 @@ export function signToken(payload) {",
            '   const header = { alg: "HS256" };',
            "-  const body = encode(payload);",
            "+  const body = encode({ ...payload, iat: Date.now() });",
            "+  const sig = sign(header, body, SECRET);",
            '   return [header, body].join(".");',
            " }",
          ].join("\n"),
        },
        {
          path: "README.md",
          previousPath: null,
          blobSha: "blob-readme-r1",
          status: "modified",
          patch: [
            "@@ -1,3 +1,4 @@",
            " # Example service",
            " ",
            "+Sessions now carry an issue time.",
            " Run `npm start` to boot it.",
          ].join("\n"),
        },
      ],
    },
    {
      headSha: "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432",
      baseSha: "0000111122223333444455556666777788889999",
      files: [
        {
          path: "src/auth/session.ts",
          previousPath: null,
          blobSha: "blob-session-r2",
          status: "modified",
          patch: [
            "@@ -11,9 +11,13 @@ export function createSession(user) {",
            "   assertUser(user);",
            "+  if (user.banned) {",
            '+    throw new Error("banned");',
            "+  }",
            "   const now = Date.now();",
            "   const session = {",
            "     userId: user.id,",
            "-    expiresAt: now + ONE_HOUR,",
            "+    expiresAt: now + SESSION_TTL_MS,",
            "+    issuedAt: now,",
            "   };",
            "   store.set(session.userId, session);",
            "   return session;",
            " }",
          ].join("\n"),
        },
        {
          path: "src/auth/token.ts",
          previousPath: null,
          blobSha: "blob-token-r2",
          status: "modified",
          patch: [
            "@@ -3,5 +3,6 @@",
            " export function signToken(payload) {",
            '-  const header = { alg: "HS256" };',
            "-  const body = encode(payload);",
            '+  const header = { alg: "HS512" };',
            "+  const body = encodeCompact(payload, { iat: now() });",
            "+  const sig = signHmac(header, body, readSecret());",
            '   return [header, body].join(".");',
            " }",
          ].join("\n"),
        },
        {
          path: "README.md",
          previousPath: null,
          // Identical to revision 1: this file is untouched by the force-push,
          // which is what exercises `relocate`'s sha-equality path end to end.
          blobSha: "blob-readme-r1",
          status: "modified",
          patch: [
            "@@ -1,3 +1,4 @@",
            " # Example service",
            " ",
            "+Sessions now carry an issue time.",
            " Run `npm start` to boot it.",
          ].join("\n"),
        },
      ],
    },
  ],
};
