import { describe, it, expect } from "vitest";
import { parsePrUrl } from "./prUrl";

describe("parsePrUrl", () => {
  it("parses a canonical pull request URL", () => {
    expect(parsePrUrl("https://github.com/vercel/next.js/pull/12345")).toEqual({
      kind: "github",
      owner: "vercel",
      repo: "next.js",
      number: 12345,
    });
  });

  it("accepts the tab suffixes GitHub itself links to", () => {
    // A reviewer copying the address bar is usually on /files, not the
    // conversation tab. Rejecting those would fail for the commonest paste.
    for (const suffix of ["/files", "/commits", "/checks", "/files#diff-abc"]) {
      expect(parsePrUrl(`https://github.com/vercel/next.js/pull/7${suffix}`)).toEqual({
        kind: "github",
        owner: "vercel",
        repo: "next.js",
        number: 7,
      });
    }
  });

  it("accepts a trailing slash, a query string, and www", () => {
    expect(parsePrUrl("https://www.github.com/a/b/pull/9/?utm_source=x")).toEqual({
      kind: "github",
      owner: "a",
      repo: "b",
      number: 9,
    });
  });

  it("accepts surrounding whitespace from a sloppy paste", () => {
    expect(parsePrUrl("  https://github.com/a/b/pull/9  ")).toEqual({
      kind: "github",
      owner: "a",
      repo: "b",
      number: 9,
    });
  });

  it("accepts the shorthand a reviewer might type", () => {
    expect(parsePrUrl("vercel/next.js#12345")).toEqual({
      kind: "github",
      owner: "vercel",
      repo: "next.js",
      number: 12345,
    });
  });

  it("rejects a host that is not github.com", () => {
    // Without this, a URL on a look-alike host would be turned into a request
    // to api.github.com for a repository under someone else's name.
    expect(parsePrUrl("https://github.com.evil.example/a/b/pull/1")).toBeNull();
    expect(parsePrUrl("https://gitlab.com/a/b/pull/1")).toBeNull();
  });

  it("rejects an issue URL, which is not a pull request", () => {
    expect(parsePrUrl("https://github.com/a/b/issues/1")).toBeNull();
  });

  it("rejects a missing or non-numeric pull request number", () => {
    expect(parsePrUrl("https://github.com/a/b/pull/")).toBeNull();
    expect(parsePrUrl("https://github.com/a/b/pull/abc")).toBeNull();
    expect(parsePrUrl("https://github.com/a/b/pull/0")).toBeNull();
  });

  it("rejects an owner or repo containing a character GitHub cannot produce", () => {
    expect(parsePrUrl("https://github.com/../b/pull/1")).toBeNull();
    expect(parsePrUrl("https://github.com/a/..%2Fb/pull/1")).toBeNull();
  });

  it("returns null rather than throwing for input that is not a URL at all", () => {
    expect(parsePrUrl("")).toBeNull();
    expect(parsePrUrl("hello")).toBeNull();
  });
});
