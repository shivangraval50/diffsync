/** Lines above and below the anchored line that make up its fingerprint
 *  window. A window is therefore 2 * CONTEXT_RADIUS + 1 = 7 entries. */
export const CONTEXT_RADIUS = 3;

/**
 * Occupies a window slot for which no line text is known -- past the first or
 * last line of the rendered file, or a line number the diff simply does not
 * expose (the space between two hunks).
 *
 * U+0000 cannot occur in a line coming out of a unified diff: a NUL byte
 * would have made the blob binary and the patch omitted. So this sentinel can
 * never compare equal to real content, which is the property that matters --
 * an unknown slot must never look like a known one, or a thread could
 * relocate into territory nobody has seen.
 */
export const GAP = "\u0000GAP";

// --- Fixed-length window type -------------------------------------------
//
// `fingerprint`'s collision-safety argument (see its doc comment in
// fingerprint.ts) only holds when every window it hashes has exactly
// 2 * CONTEXT_RADIUS + 1 slots -- never fewer, never more. A window with a
// slot dropped from either end can encode identically to an unrelated,
// correctly shaped window that happens to contain the literal text "GAP"
// next to a blank line. Rather than document that invariant and hope the
// next reader (Task 3's relocate()) finds the comment, it is enforced as a
// type: `Window` is a fixed-length tuple, its length derived from
// CONTEXT_RADIUS rather than hand-written as "7", so slicing or truncating
// one stops being a `Window` and becomes a compile error anywhere a
// `Window` is required.

type FixedTuple<N extends number, T, Acc extends readonly T[] = []> = Acc["length"] extends N
  ? Acc
  : FixedTuple<N, T, readonly [T, ...Acc]>;

type RadiusSlots = FixedTuple<typeof CONTEXT_RADIUS, unknown>;
type WindowSlots = readonly [...RadiusSlots, unknown, ...RadiusSlots];
type MapToString<T extends readonly unknown[]> = { readonly [K in keyof T]: string };

/**
 * A fingerprint window: CONTEXT_RADIUS slots of context before the anchored
 * line, the anchored line itself, and CONTEXT_RADIUS slots after it --
 * 2 * CONTEXT_RADIUS + 1 slots, always. Produced only by `windowAt`; every
 * other consumer (including `fingerprint`) receives an already-`Window`-
 * shaped value, so a caller that slices or truncates one before hashing it
 * gets a compile error instead of a silently weaker fingerprint.
 */
export type Window = MapToString<WindowSlots>;

/**
 * Where a comment points. `context` is the normalized window itself, not just
 * its hash: `relocate` confirms every fingerprint match against it, so a hash
 * collision degrades to `outdated` instead of to a silent mis-anchor. It is
 * also exactly what the UI quotes when a thread goes outdated.
 */
export interface Anchor {
  filePath: string;
  /** Content hash of the file's new-side blob when the comment was made. */
  blobSha: string;
  /** 1-based line number on the new side of the diff. */
  line: number;
  /** 16 hex characters: FNV-1a 64 over `context`. An index, not the proof. */
  fingerprint: string;
  context: readonly string[];
}

/**
 * The new-side content `relocate` searches. `lines` is deliberately sparse --
 * a unified diff exposes only the lines inside its hunks, and pretending
 * otherwise is what would let a thread land on a line nobody rendered.
 */
export interface AnchorTarget {
  filePath: string;
  blobSha: string;
  /** 1-based new-side line number -> raw line text. */
  lines: ReadonlyMap<number, string>;
}

/**
 * Exactly two outcomes. A discriminated union rather than
 * `{ line: number | null }`, so there is no representable third state for a
 * caller to mishandle and no runtime null-check standing in for a type.
 */
export type Relocation = { kind: "located"; line: number } | { kind: "outdated" };
