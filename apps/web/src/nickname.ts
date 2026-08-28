// A leaf module with NO other imports. `proxy.ts` needs this function but must
// not pull in `identity.ts`, which imports `./auth` and drags next-auth into
// Proxy's module graph -- that resolves under the Next bundler but breaks
// vitest's plain Node resolution of `next/server` from inside next-auth.

const ADJECTIVES = ["brisk", "calm", "keen", "quiet", "swift", "wry"] as const;
const NOUNS = ["otter", "heron", "marten", "kestrel", "vole", "ibex"] as const;
const DISCRIMINATOR_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz".split("");
const DISCRIMINATOR_LENGTH = 3;

// 6 * 6 * 36^3 = 1,679,616 combinations. By the birthday bound, twenty
// concurrent guests collide with probability about 1 in 8,800; the two-word
// pool alone (36 names) would collide with near-certainty at that size, and
// two reviewers sharing a name would merge in presence and in attribution.

function pick<T>(pool: readonly T[], rand: () => number): T {
  const index = Math.floor(rand() * pool.length) % pool.length;
  const value = pool[index];
  // Unreachable for the fixed, non-empty pools above, but narrows honestly
  // under noUncheckedIndexedAccess rather than asserting past the checker.
  if (value === undefined) throw new Error("empty pool");
  return value;
}

export function generateGuestNickname(rand: () => number = Math.random): string {
  let discriminator = "";
  for (let i = 0; i < DISCRIMINATOR_LENGTH; i += 1) {
    discriminator += pick(DISCRIMINATOR_CHARS, rand);
  }
  return `${pick(ADJECTIVES, rand)}-${pick(NOUNS, rand)}-${discriminator}`;
}
