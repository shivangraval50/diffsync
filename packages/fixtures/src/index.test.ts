import { describe, it, expect } from "vitest";
import { createAnchor, relocate } from "@diffsync/anchor";
import { anchorTargets, parseUnifiedDiff } from "@diffsync/diff";
import { FALLBACK_FIXTURE_SLUG, fixturePullRequest, getFixture, listFixtures } from "./index.js";

describe("the fixture catalogue", () => {
  it("lists every fixture with a unique slug", () => {
    const slugs = listFixtures().map((f) => f.slug);
    expect(slugs).toEqual(["auth-refactor", "parser-bugfix", "docs-typo"]);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("names a fallback fixture that actually exists", () => {
    // Task 11 serves this when GitHub is rate-limited. A typo here would only
    // surface as an empty app at exactly the moment the fallback is needed.
    expect(getFixture(FALLBACK_FIXTURE_SLUG)).not.toBeNull();
  });

  it("returns null for an unknown slug", () => {
    expect(getFixture("no-such-fixture")).toBeNull();
  });

  it("returns null for a revision that does not exist", () => {
    expect(fixturePullRequest("parser-bugfix", 2)).toBeNull();
    expect(fixturePullRequest("parser-bugfix", 0)).toBeNull();
  });
});

describe("every committed patch is well-formed", () => {
  it("parses, and its hunk bodies agree with their headers", () => {
    // parseUnifiedDiff throws DiffParseError when a @@ header contradicts its
    // body, so this is a real integrity check on hand-written data, not a
    // smoke test: a miscounted header would make every line number after it
    // wrong, and a wrong line number is a mis-anchor.
    for (const fixture of listFixtures()) {
      for (const revision of fixture.revisions) {
        for (const file of revision.files) {
          expect(() => parseUnifiedDiff(file.patch)).not.toThrow();
        }
      }
    }
  });

  it("marks a file with no patch as omitted rather than as an empty diff", () => {
    const pr = fixturePullRequest("docs-typo", 1);
    const binary = pr?.files.find((f) => f.path === "docs/architecture.png");
    expect(binary?.kind).toBe("omitted");
  });

  it("exposes the parser-bugfix hunk's exact new-side line numbers", () => {
    // Pins the parsed shape, not merely that parsing succeeded: a header
    // miscount that still balances old/new counts overall (e.g. transposed
    // digits summing to the same total) would slip past a bare
    // `not.toThrow()` check but would shift every line number here.
    const pr = fixturePullRequest("parser-bugfix", 1);
    const file = pr?.files.find((f) => f.path === "src/tokenize.ts");
    expect(file?.kind).toBe("patch");
    if (file?.kind !== "patch") throw new Error("expected a patch file");
    expect(file.hunks).toHaveLength(1);
    const hunk = file.hunks[0];
    expect(hunk).toMatchObject({ oldStart: 22, oldCount: 7, newStart: 22, newCount: 7 });
    const target = anchorTargets(pr!).get("src/tokenize.ts");
    expect(target?.lines.get(25)).toBe("    if (i > start) tokens.push(input.slice(start, i));");
  });

  it("exposes the docs-typo hunk's exact new-side line numbers", () => {
    const pr = fixturePullRequest("docs-typo", 1);
    const target = anchorTargets(pr!).get("docs/deploy.md");
    expect(target?.lines.get(8)).toBe("Then deploy the worker.");
    expect(target?.lines.has(9)).toBe(true);
  });
});

describe("the auth-refactor force-push scenario", () => {
  const r1 = fixturePullRequest("auth-refactor", 1);
  const r2 = fixturePullRequest("auth-refactor", 2);

  it("changes the head sha between revisions", () => {
    // Without this the force-push demo would be vacuous: two identical
    // revisions relocate trivially and prove nothing.
    expect(r1?.headSha).not.toBe(r2?.headSha);
  });

  it("relocates a session.ts thread from line 15 to line 18", () => {
    const targets1 = anchorTargets(r1!);
    const anchor = createAnchor(targets1.get("src/auth/session.ts")!, 15);
    expect(anchor?.context[3]).toBe("    expiresAt: now + SESSION_TTL_MS,");

    const targets2 = anchorTargets(r2!);
    expect(relocate(anchor!, targets2.get("src/auth/session.ts")!)).toEqual({
      kind: "located",
      line: 18,
    });
  });

  it("outdates a token.ts thread whose region was rewritten", () => {
    const targets1 = anchorTargets(r1!);
    const anchor = createAnchor(targets1.get("src/auth/token.ts")!, 5);
    expect(anchor?.context[3]).toBe("  const body = encode({ ...payload, iat: Date.now() });");

    const targets2 = anchorTargets(r2!);
    expect(relocate(anchor!, targets2.get("src/auth/token.ts")!)).toEqual({ kind: "outdated" });
  });

  it("keeps a README.md thread in place, because that file was untouched", () => {
    const targets1 = anchorTargets(r1!);
    const anchor = createAnchor(targets1.get("README.md")!, 3);

    const targets2 = anchorTargets(r2!);
    expect(relocate(anchor!, targets2.get("README.md")!)).toEqual({ kind: "located", line: 3 });
  });
});
