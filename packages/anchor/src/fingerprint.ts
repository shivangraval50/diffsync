import { CONTEXT_RADIUS, GAP, type Anchor, type AnchorTarget } from "./types.js";

/**
 * Trailing whitespace and carriage returns are normalized away because the
 * same file arrives with different line endings depending on where it came
 * from (GitHub's API, a committed fixture, a checkout on Windows), and a
 * thread must not go outdated over a transport detail.
 *
 * Nothing else is normalized. Leading whitespace in particular is preserved:
 * a re-indent is a real change to the code, and treating it as equal would
 * let a thread relocate onto a statement that had been moved into or out of a
 * block -- different code with the same fingerprint.
 */
export function normalizeLine(text: string): string {
  return text.replace(/[ \t\r]+$/u, "");
}

/** The normalized CONTEXT_RADIUS-radius window centred on `line`. */
export function windowAt(lines: ReadonlyMap<number, string>, line: number): string[] {
  const out: string[] = [];
  for (let n = line - CONTEXT_RADIUS; n <= line + CONTEXT_RADIUS; n += 1) {
    const text = lines.get(n);
    out.push(text === undefined ? GAP : normalizeLine(text));
  }
  return out;
}

// FNV-1a, 64-bit. BigInt rather than the usual 32-bit number trick because
// this package may not import node:crypto (it is pure, and runs in a Worker,
// a browser and Node), and 32 bits collide often enough at PR scale to be
// worth avoiding in an index. Collisions are not a correctness risk here --
// `relocate` confirms every fingerprint hit against the stored window -- but
// 64 bits makes even a wasted comparison vanishingly rare.
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** Separator that cannot occur inside a normalized source line, so two
 *  different slot splits can never produce the same byte sequence. */
const SLOT_SEPARATOR = "\u0000";

export function fingerprint(window: readonly string[]): string {
  const encoded = window.join(SLOT_SEPARATOR);
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < encoded.length; i += 1) {
    const unit = encoded.charCodeAt(i);
    // Both bytes of the UTF-16 code unit, low byte first. Folding to one byte
    // would collide "A" (U+0041) with U+0141 and every other pair sharing a
    // low byte -- see the non-ASCII test.
    hash = ((hash ^ BigInt(unit & 0xff)) * FNV_PRIME) & MASK_64;
    hash = ((hash ^ BigInt(unit >>> 8)) * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Build an anchor for `line` within `target`, or `null` when the target does
 * not expose that line at all.
 */
export function createAnchor(target: AnchorTarget, line: number): Anchor | null {
  if (!target.lines.has(line)) return null;
  const context = windowAt(target.lines, line);
  return {
    filePath: target.filePath,
    blobSha: target.blobSha,
    line,
    fingerprint: fingerprint(context),
    context,
  };
}
