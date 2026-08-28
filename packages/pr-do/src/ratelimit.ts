export interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

/** Comments, replies, resolves and unresolves share one budget. */
export const ACTION_CAPACITY = 10;
export const ACTION_WINDOW_MS = 10_000;

/** Cursor moves get their own, larger budget: they are decoration, they are
 *  frequent, and rejecting one would be noise rather than feedback. */
export const CURSOR_CAPACITY = 30;
export const CURSOR_WINDOW_MS = 10_000;

export function newBucket(nowMs: number, capacity: number): Bucket {
  return { tokens: capacity, lastRefillMs: nowMs };
}

/**
 * Pure token-bucket step. `nowMs` is a parameter, never read from the clock
 * in here, so the exact boundary and refill arithmetic can be tested without
 * a Durable Object, workerd, or a wall clock -- and so the caller controls
 * every millisecond a test cares about.
 */
export function takeToken(
  bucket: Bucket,
  nowMs: number,
  capacity: number,
  windowMs: number
): { allowed: boolean; bucket: Bucket } {
  // `Math.max(0, ...)` so a clock that moves backwards cannot subtract tokens.
  const elapsed = Math.max(0, nowMs - bucket.lastRefillMs);
  const refilled = Math.min(capacity, bucket.tokens + (elapsed * capacity) / windowMs);
  if (refilled < 1) {
    return { allowed: false, bucket: { tokens: refilled, lastRefillMs: nowMs } };
  }
  return { allowed: true, bucket: { tokens: refilled - 1, lastRefillMs: nowMs } };
}
