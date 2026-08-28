import type { PrRef } from "@diffsync/diff";

const NAME = /^[A-Za-z0-9._-]+$/u;
const SHORTHAND = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#([1-9][0-9]*)$/u;

/**
 * Turn what a reviewer pasted into a pull request reference, or `null`.
 *
 * Deliberately strict about the host: this reference becomes a path in a
 * request to api.github.com, so accepting a look-alike host would let a
 * crafted link address a repository the visitor did not name.
 */
export function parsePrUrl(input: string): PrRef | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;

  const short = SHORTHAND.exec(trimmed);
  if (short !== null) {
    return {
      kind: "github",
      owner: short[1]!,
      repo: short[2]!,
      number: Number(short[3]!),
    };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;

  const segments = url.pathname.split("/").filter((s) => s !== "");
  const [owner, repo, kind, number] = segments;
  if (owner === undefined || repo === undefined || number === undefined) return null;
  if (kind !== "pull") return null;
  if (!NAME.test(owner) || !NAME.test(repo)) return null;
  if (!/^[1-9][0-9]*$/u.test(number)) return null;

  return { kind: "github", owner, repo, number: Number(number) };
}
