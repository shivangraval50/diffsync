import { describe, it, expect } from "vitest";
import {
  ACTION_CAPACITY,
  ACTION_WINDOW_MS,
  newBucket,
  takeToken,
  type Bucket,
} from "./ratelimit.js";

function drain(bucket: Bucket, n: number, nowMs: number): Bucket {
  let current = bucket;
  for (let i = 0; i < n; i += 1) {
    current = takeToken(current, nowMs, ACTION_CAPACITY, ACTION_WINDOW_MS).bucket;
  }
  return current;
}

describe("takeToken", () => {
  it("allows exactly the capacity within one window", () => {
    // Catches an off-by-one in either direction: a limiter that allows
    // capacity+1, or one that starts refusing before capacity is reached.
    let bucket = newBucket(0, ACTION_CAPACITY);
    for (let i = 0; i < ACTION_CAPACITY; i += 1) {
      const result = takeToken(bucket, 0, ACTION_CAPACITY, ACTION_WINDOW_MS);
      expect(result.allowed).toBe(true);
      bucket = result.bucket;
    }
    expect(takeToken(bucket, 0, ACTION_CAPACITY, ACTION_WINDOW_MS).allowed).toBe(false);
  });

  it("refills proportionally to elapsed time", () => {
    // Catches a limiter that only refills in discrete steps (e.g. a whole
    // token per window boundary) instead of continuously, and proves an
    // allowed request still succeeds mid-window after some refill.
    const drained = drain(newBucket(0, ACTION_CAPACITY), ACTION_CAPACITY, 0);
    // Half a window elapsed: half the capacity is back.
    const half = takeToken(drained, ACTION_WINDOW_MS / 2, ACTION_CAPACITY, ACTION_WINDOW_MS);
    expect(half.allowed).toBe(true);
    expect(half.bucket.tokens).toBeCloseTo(ACTION_CAPACITY / 2 - 1, 5);
  });

  it("never refills above capacity, however long the gap", () => {
    // Without a clamp, an object idle overnight would grant thousands of
    // tokens at once and the limit would not exist for the first burst.
    const drained = drain(newBucket(0, ACTION_CAPACITY), ACTION_CAPACITY, 0);
    const later = takeToken(drained, 86_400_000, ACTION_CAPACITY, ACTION_WINDOW_MS);
    expect(later.bucket.tokens).toBeLessThanOrEqual(ACTION_CAPACITY);
  });

  it("does not go backwards if the clock does", () => {
    // Catches a limiter that computes elapsed as (now - lastRefill) without
    // clamping to zero: a backwards clock would then subtract tokens (or
    // worse, refill negatively), letting the count run outside [0, capacity].
    const drained = drain(newBucket(1_000, ACTION_CAPACITY), 3, 1_000);
    const backwards = takeToken(drained, 500, ACTION_CAPACITY, ACTION_WINDOW_MS);
    expect(backwards.bucket.tokens).toBeLessThanOrEqual(ACTION_CAPACITY);
    expect(backwards.bucket.tokens).toBeGreaterThanOrEqual(0);
  });

  it("returns a new bucket rather than mutating the one it was given", () => {
    // Catches an in-place mutation, which would corrupt the DO's cached
    // attachment before serializeAttachment is even called.
    const bucket = newBucket(0, ACTION_CAPACITY);
    const before = bucket.tokens;
    takeToken(bucket, 0, ACTION_CAPACITY, ACTION_WINDOW_MS);
    expect(bucket.tokens).toBe(before);
  });

  it("still advances refill bookkeeping on a refusal, rather than resetting it", () => {
    // Catches a limiter that returns { allowed: false, bucket } but hands
    // back the ORIGINAL bucket unchanged (stale lastRefillMs, discarding the
    // partial refill that already accrued). If refusals didn't persist the
    // advanced clock and partial tokens, a caller could not build the DO's
    // "a token spent on a rejected action must still count" guarantee on
    // top of this primitive.
    const drained = drain(newBucket(0, ACTION_CAPACITY), ACTION_CAPACITY, 0);
    // 500ms of a 10s window at capacity 10 refills 0.5 tokens -- refused,
    // but the partial refill and the later clock must both be preserved.
    const refused = takeToken(drained, 500, ACTION_CAPACITY, ACTION_WINDOW_MS);
    expect(refused.allowed).toBe(false);
    expect(refused.bucket.lastRefillMs).toBe(500);
    expect(refused.bucket.tokens).toBeCloseTo(0.5, 5);
  });
});
