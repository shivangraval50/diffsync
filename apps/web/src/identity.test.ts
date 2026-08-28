import { describe, it, expect, vi, beforeEach } from "vitest";
import { NICKNAME_MAX_LENGTH } from "@diffsync/protocol";

const cookieStore = { get: vi.fn() };
vi.mock("next/headers", () => ({ cookies: async () => cookieStore }));

const session = vi.fn();
vi.mock("./auth", () => ({ auth: () => session() }));

import { resolveIdentity } from "./identity";

beforeEach(() => {
  cookieStore.get.mockReset();
  session.mockReset();
  session.mockResolvedValue(null);
});

describe("resolveIdentity", () => {
  it("prefers a signed-in GitHub login", async () => {
    session.mockResolvedValue({ user: { name: "octocat" } });
    cookieStore.get.mockReturnValue({ value: "brisk-otter-7f3" });
    expect(await resolveIdentity()).toEqual({ nickname: "octocat", persistent: true });
  });

  it("falls back to the guest cookie", async () => {
    cookieStore.get.mockReturnValue({ value: "brisk-otter-7f3" });
    expect(await resolveIdentity()).toEqual({ nickname: "brisk-otter-7f3", persistent: false });
  });

  it("generates a name when there is no cookie yet", async () => {
    cookieStore.get.mockReturnValue(undefined);
    const identity = await resolveIdentity();
    expect(identity.nickname.length).toBeGreaterThan(0);
    expect(identity.persistent).toBe(false);
  });

  it("truncates an over-long guest cookie to the wire cap", async () => {
    // The cookie is set with httpOnly: false, so the browser can write it.
    // An over-long value fails clientMessageSchema, the Durable Object closes
    // the socket with 1003, and the client's own reconnect resends it -- an
    // endless loop that locks that browser out of every pull request until
    // the cookie is cleared by hand. This truncation is the whole fix.
    cookieStore.get.mockReturnValue({ value: "x".repeat(500) });
    const identity = await resolveIdentity();
    expect(identity.nickname).toHaveLength(NICKNAME_MAX_LENGTH);
  });

  it("generates a fresh nickname when the cookie is present but empty", async () => {
    // An empty string is falsy but is NOT "no cookie" -- a naive `=== undefined`
    // check would let "" through to the wire, where `.min(1)` on the wire
    // schema rejects it. That is the same 1003-close/reconnect-loop failure
    // mode as the over-long case, just from the other end of the length
    // range, and a hostile or buggy client could set exactly this.
    cookieStore.get.mockReturnValue({ value: "" });
    const identity = await resolveIdentity();
    expect(identity.nickname.length).toBeGreaterThan(0);
    expect(identity.persistent).toBe(false);
  });

  it("truncates an over-long GitHub display name too", async () => {
    session.mockResolvedValue({ user: { name: "y".repeat(200) } });
    expect((await resolveIdentity()).nickname).toHaveLength(NICKNAME_MAX_LENGTH);
  });

  it("never splits a surrogate pair, and never overshoots the cap", async () => {
    // Slicing by UTF-16 unit can cut an emoji in half: the result still
    // passes `.max(NICKNAME_MAX_LENGTH)` (a lone surrogate counts as one
    // unit) but renders as a replacement character. Taking whole code points
    // instead can overshoot the cap by one unit and fail the schema outright.
    // Both failure modes are real; this asserts against both.
    const emoji = "🙂".repeat(40);
    cookieStore.get.mockReturnValue({ value: emoji });
    const { nickname } = await resolveIdentity();
    expect(nickname.length).toBeLessThanOrEqual(NICKNAME_MAX_LENGTH);
    expect(nickname).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    expect(nickname).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  });
});
