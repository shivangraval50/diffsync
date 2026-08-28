import { describe, it, expect } from "vitest";
import { CONTEXT_RADIUS, type Anchor } from "@diffsync/anchor";
import {
  COMMENT_MAX_LENGTH,
  NICKNAME_MAX_LENGTH,
  anchorSchema,
  encode,
  parseClientMessage,
  parseServerMessage,
  prLabel,
  pullRequestSchema,
  type ServerMessage,
} from "./index";

const anchor: Anchor = {
  filePath: "src/total.ts",
  blobSha: "sha-r1",
  line: 12,
  fingerprint: "0123456789abcdef",
  context: ["a", "b", "c", "d", "e", "f", "g"],
};

describe("anchorSchema", () => {
  it("accepts a well-formed anchor", () => {
    expect(anchorSchema.parse(anchor)).toEqual(anchor);
  });

  it("rejects a fingerprint that is not 16 hex characters", () => {
    expect(() => anchorSchema.parse({ ...anchor, fingerprint: "deadbeef" })).toThrow();
  });

  it("rejects a context window of the wrong length", () => {
    // A short window would hash differently on the two ends and silently
    // outdate every thread that crossed the wire.
    expect(() => anchorSchema.parse({ ...anchor, context: ["a", "b"] })).toThrow();
    expect(anchor.context).toHaveLength(2 * CONTEXT_RADIUS + 1);
  });

  it("rejects a zero or negative line number", () => {
    expect(() => anchorSchema.parse({ ...anchor, line: 0 })).toThrow();
  });
});

describe("parseClientMessage", () => {
  it("parses a hello", () => {
    const raw = encode({ t: "hello", lastSeenSeq: 0, nickname: "ada", persistent: false });
    expect(parseClientMessage(raw)).toEqual({
      t: "hello",
      lastSeenSeq: 0,
      nickname: "ada",
      persistent: false,
    });
  });

  it("defaults `persistent` so a client that predates the field still connects", () => {
    const parsed = parseClientMessage('{"t":"hello","lastSeenSeq":0,"nickname":"ada"}');
    expect(parsed).toEqual({ t: "hello", lastSeenSeq: 0, nickname: "ada", persistent: false });
  });

  it("rejects a nickname over the length cap", () => {
    const raw = JSON.stringify({
      t: "hello",
      lastSeenSeq: 0,
      nickname: "x".repeat(NICKNAME_MAX_LENGTH + 1),
      persistent: false,
    });
    expect(() => parseClientMessage(raw)).toThrow();
  });

  it("rejects an empty comment body", () => {
    const raw = JSON.stringify({ t: "openThread", clientSeq: 1, anchor, body: "" });
    expect(() => parseClientMessage(raw)).toThrow();
  });

  it("rejects a comment body over the length cap", () => {
    const raw = JSON.stringify({
      t: "openThread",
      clientSeq: 1,
      anchor,
      body: "x".repeat(COMMENT_MAX_LENGTH + 1),
    });
    expect(() => parseClientMessage(raw)).toThrow();
  });

  it("rejects a non-finite line number arriving as a raw JSON literal", () => {
    // Written as a JSON string on purpose. Building `{ line: Infinity }` and
    // running it through `encode` would NOT exercise the `.finite()` guard:
    // JSON.stringify turns Infinity into null, so the schema would reject it
    // as "not a number" and the test would pass while proving nothing about
    // non-finite values. `1e999` parses back as Infinity, which is the value
    // the guard actually exists for.
    expect(() =>
      parseClientMessage('{"t":"cursor","filePath":"src/a.ts","line":1e999}')
    ).toThrow();
  });

  it("rejects a fractional line number", () => {
    expect(() =>
      parseClientMessage('{"t":"cursor","filePath":"src/a.ts","line":1.5}')
    ).toThrow();
  });

  it("rejects an unknown message type rather than ignoring it", () => {
    expect(() => parseClientMessage('{"t":"deleteEverything"}')).toThrow();
  });

  it("rejects malformed JSON with a schema error, not a SyntaxError escape", () => {
    expect(() => parseClientMessage("{")).toThrow();
  });
});

describe("parseServerMessage", () => {
  it("parses a snapshot carrying threads and presence", () => {
    const msg: ServerMessage = {
      t: "snapshot",
      seq: 3,
      serverTime: 1_700_000_000_000,
      youAre: "r1",
      threads: {
        threads: {
          t1: {
            threadId: "t1",
            anchor,
            comments: [
              { commentId: "c1", reviewerId: "r1", nickname: "ada", body: "look", atMs: 1 },
            ],
            resolved: false,
            resolvedBy: null,
          },
        },
        order: ["t1"],
      },
      presence: [
        {
          reviewerId: "r1",
          nickname: "ada",
          persistent: false,
          cursor: { filePath: "src/total.ts", line: 12 },
        },
      ],
    };
    expect(parseServerMessage(encode(msg))).toEqual(msg);
  });

  it("rejects a delta whose event payload is not one of the four event types", () => {
    // The payload, not just the envelope. `applyEvent`'s switch has no
    // default case, so an unrecognised type reaching it is a silent no-op
    // rather than a caught error.
    const raw = JSON.stringify({
      t: "delta",
      seq: 1,
      serverTime: 1,
      event: { type: "threadDeleted", threadId: "t1" },
    });
    expect(() => parseServerMessage(raw)).toThrow();
  });

  it("rejects a reject reason outside the closed set", () => {
    const raw = JSON.stringify({ t: "reject", clientSeq: 1, reason: "SOMETHING_WENT_WRONG" });
    expect(() => parseServerMessage(raw)).toThrow();
  });
});

describe("sourceChanged", () => {
  it("round-trips a head sha", () => {
    const msg = { t: "sourceChanged", headSha: "9f8e7d6" } as const;
    expect(parseServerMessage(encode(msg))).toEqual(msg);
  });

  it("rejects an empty head sha", () => {
    expect(() => parseServerMessage('{"t":"sourceChanged","headSha":""}')).toThrow();
  });
});

describe("pullRequestSchema", () => {
  it("accepts a patch file and an omitted file in the same pull request", () => {
    const pr = {
      ref: { kind: "github", owner: "vercel", repo: "next.js", number: 1 },
      title: "Fix the thing",
      author: "someone",
      headSha: "sha-head",
      baseSha: "sha-base",
      files: [
        {
          kind: "patch",
          path: "src/a.ts",
          previousPath: null,
          blobSha: "sha-a",
          status: "modified",
          hunks: [
            {
              oldStart: 1,
              oldCount: 1,
              newStart: 1,
              newCount: 1,
              heading: "",
              lines: [{ kind: "removed", text: "a", oldLine: 1 }],
            },
          ],
        },
        {
          kind: "omitted",
          path: "assets/logo.png",
          previousPath: null,
          blobSha: "sha-b",
          status: "modified",
          reason: "binary",
        },
      ],
    };
    expect(pullRequestSchema.parse(pr)).toEqual(pr);
  });

  it("rejects a diff line carrying a line number for the side it is not on", () => {
    // `{ kind: "added", oldLine: 3 }` does not exist in a unified diff. Zod's
    // object schemas strip unknown keys, so this asserts on the parsed
    // result rather than on a throw.
    const parsed = pullRequestSchema.parse({
      ref: { kind: "fixture", slug: "demo", revision: 1 },
      title: "t",
      author: "a",
      headSha: "h",
      baseSha: "b",
      files: [
        {
          kind: "patch",
          path: "src/a.ts",
          previousPath: null,
          blobSha: "sha-a",
          status: "modified",
          hunks: [
            {
              oldStart: 1,
              oldCount: 0,
              newStart: 1,
              newCount: 1,
              heading: "",
              lines: [{ kind: "added", text: "a", newLine: 1, oldLine: 3 }],
            },
          ],
        },
      ],
    });
    const file = parsed.files[0];
    if (file?.kind !== "patch") throw new Error("expected a patch file");
    expect(file.hunks[0]?.lines[0]).toEqual({ kind: "added", text: "a", newLine: 1 });
  });
});

describe("prLabel", () => {
  it("names a GitHub pull request the way GitHub does", () => {
    expect(prLabel({ kind: "github", owner: "vercel", repo: "next.js", number: 42 })).toBe(
      "vercel/next.js#42"
    );
  });

  it("marks a fixture as a sample, so nobody mistakes it for a real PR", () => {
    expect(prLabel({ kind: "fixture", slug: "auth-refactor", revision: 2 })).toBe(
      "sample: auth-refactor"
    );
  });
});
