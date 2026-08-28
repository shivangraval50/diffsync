import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { PrRef } from "@diffsync/diff";
import { decodePrKey, encodePrKey } from "./prkey";

function payloadKey(payload: string): string {
  return btoa(payload).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

describe("encodePrKey / decodePrKey", () => {
  it("produces a key safe for both a URL path and a Durable Object name", () => {
    const key = encodePrKey({ kind: "github", owner: "vercel", repo: "next.js", number: 12345 });
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it("round-trips a GitHub reference", () => {
    const ref: PrRef = { kind: "github", owner: "vercel", repo: "next.js", number: 12345 };
    expect(decodePrKey(encodePrKey(ref))).toEqual(ref);
  });

  it("round-trips a fixture reference", () => {
    const ref: PrRef = { kind: "fixture", slug: "auth-refactor", revision: 2 };
    expect(decodePrKey(encodePrKey(ref))).toEqual(ref);
  });

  it("distinguishes repositories whose names differ only where a separator would be", () => {
    // A readable "gh-owner-repo-1" key is ambiguous: a repo literally named
    // "repo-1" under owner "gh-owner" collides with repo "repo" number 1. Two
    // different pull requests would then share one Durable Object, and
    // therefore one comment log.
    const a = encodePrKey({ kind: "github", owner: "a-b", repo: "c", number: 1 });
    const b = encodePrKey({ kind: "github", owner: "a", repo: "b-c", number: 1 });
    expect(a).not.toBe(b);
  });

  it("gives a nonce a different key but the same reference", () => {
    // A nonce names a SEPARATE review of the same pull request: same diff,
    // different Durable Object, different threads. Tests use it so no two
    // of them share a comment log; the app never sets one, so everyone opening a
    // sample lands in the same review and can see each other.
    const ref: PrRef = { kind: "fixture", slug: "auth-refactor", revision: 1 };
    const plain = encodePrKey(ref);
    const isolated = encodePrKey(ref, "abc123");
    expect(isolated).not.toBe(plain);
    expect(decodePrKey(isolated)).toEqual(ref);
    expect(decodePrKey(plain)).toEqual(ref);
  });

  it("refuses to encode a nonce that would forge extra segments", () => {
    expect(() =>
      encodePrKey({ kind: "fixture", slug: "auth-refactor", revision: 1 }, "a/gh/x")
    ).toThrow();
  });

  it("rejects a key that is not valid base64url", () => {
    expect(decodePrKey("not a key")).toBeNull();
  });

  it("rejects a well-formed key whose payload is not a reference", () => {
    expect(decodePrKey(payloadKey("hello there"))).toBeNull();
  });

  it("rejects an owner containing a character GitHub cannot produce", () => {
    // The decoded payload is untrusted input from a URL, and it becomes a path
    // in a request to api.github.com. Without this, a crafted key could name a
    // repository nobody asked for.
    expect(decodePrKey(payloadKey("/gh/../repo/1"))).toBeNull();
    expect(decodePrKey(payloadKey("/gh/owner/re po/1"))).toBeNull();
  });

  it("rejects a non-positive pull request number", () => {
    expect(decodePrKey(payloadKey("/gh/owner/repo/0"))).toBeNull();
  });

  it("rejects a payload with the wrong number of segments for its kind", () => {
    expect(decodePrKey(payloadKey("/gh/owner/repo"))).toBeNull();
    expect(decodePrKey(payloadKey("/fx/slug/1/extra"))).toBeNull();
  });

  it("round-trips every legal reference, with and without a nonce", () => {
    const name = fc
      .stringMatching(/^[A-Za-z0-9._-]{1,40}$/u)
      // "." and ".." are valid under the charset above but are path-traversal
      // segments, not names GitHub can ever assign to an owner or a repo --
      // see the matching guard in prkey.ts. Excluded here so this property
      // describes "every legal reference", not every string decodePrKey's
      // regex happens to admit.
      .filter((value) => value !== "." && value !== "..");
    const nonce = fc.stringMatching(/^[A-Za-z0-9]{0,12}$/u);
    fc.assert(
      fc.property(
        name,
        name,
        fc.integer({ min: 1, max: 10_000_000 }),
        nonce,
        (owner, repo, number, salt) => {
          const ref: PrRef = { kind: "github", owner, repo, number };
          expect(decodePrKey(encodePrKey(ref, salt))).toEqual(ref);
        }
      ),
      { numRuns: 300 }
    );
  });
});
