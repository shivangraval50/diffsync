import type { PrRef } from "@diffsync/diff";

/** GitHub's own charset for owner and repository names. Also the guard that
 *  stops a decoded key smuggling "/" or ".." into a URL path. */
const NAME = /^[A-Za-z0-9._-]+$/u;
const SLUG = /^[a-z0-9-]+$/u;
const NONCE = /^[A-Za-z0-9]*$/u;

/**
 * `NAME` alone is not enough: "." and ".." both match its charset (both are
 * made only of ".") but neither is a name GitHub can ever assign to an owner
 * or a repository. Left unblocked, a crafted key with owner ".." decodes
 * successfully and later becomes the path segment in a request to
 * `api.github.com/repos/../repo/1` -- exactly the traversal this function
 * exists to stop.
 */
function isSafeName(value: string): boolean {
  return NAME.test(value) && value !== "." && value !== "..";
}

function toBase64Url(ascii: string): string {
  return btoa(ascii).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function fromBase64Url(key: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(key)) return null;
  const standard = key.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
  try {
    return atob(padded);
  } catch {
    return null;
  }
}

/**
 * A pull request reference as one opaque, URL-safe token, and the name of the
 * Durable Object that owns its review.
 *
 * Base64url of a slash-delimited payload rather than a readable
 * `gh-owner-repo-number` composition, because that form is ambiguous: both
 * owner and repository names may contain "-", so two different pull requests
 * can produce the same string and would then share one Durable Object -- and
 * therefore one comment log.
 *
 * The leading segment is a `nonce`, empty for every link the app itself
 * produces. A non-empty nonce names a SEPARATE review of the same pull
 * request: same diff, different object, different threads. Tests use it so no
 * two of them share a comment log. Production never sets one, so everyone who
 * opens a sample lands in the same review and can see each other.
 */
export function encodePrKey(ref: PrRef, nonce = ""): string {
  // Guarded rather than escaped: a nonce containing "/" would forge extra
  // segments and could make a fixture key decode as a GitHub one.
  if (!NONCE.test(nonce)) throw new Error(`invalid pr key nonce: ${JSON.stringify(nonce)}`);
  const payload =
    ref.kind === "github"
      ? `${nonce}/gh/${ref.owner}/${ref.repo}/${ref.number}`
      : `${nonce}/fx/${ref.slug}/${ref.revision}`;
  return toBase64Url(payload);
}

export function decodePrKey(key: string): PrRef | null {
  const payload = fromBase64Url(key);
  if (payload === null) return null;
  const parts = payload.split("/");

  const nonce = parts[0];
  if (nonce === undefined || !NONCE.test(nonce)) return null;

  if (parts[1] === "gh" && parts.length === 5) {
    const owner = parts[2];
    const repo = parts[3];
    const number = parts[4];
    if (owner === undefined || repo === undefined || number === undefined) return null;
    if (!isSafeName(owner) || !isSafeName(repo)) return null;
    if (!/^[1-9][0-9]*$/u.test(number)) return null;
    return { kind: "github", owner, repo, number: Number(number) };
  }

  if (parts[1] === "fx" && parts.length === 4) {
    const slug = parts[2];
    const revision = parts[3];
    if (slug === undefined || revision === undefined) return null;
    if (!SLUG.test(slug)) return null;
    if (!/^[1-9][0-9]*$/u.test(revision)) return null;
    return { kind: "fixture", slug, revision: Number(revision) };
  }

  return null;
}
