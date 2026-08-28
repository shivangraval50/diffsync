import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchSource, prsBaseUrl, refreshSource } from "./prs";

const SOURCE = {
  origin: "fixture",
  pr: {
    ref: { kind: "fixture", slug: "auth-refactor", revision: 1 },
    title: "Refactor session issuance",
    author: "octo-reviewer",
    headSha: "head",
    baseSha: "base",
    files: [],
  },
};

beforeEach(() => {
  process.env.PRS_BASE_URL = "https://prs.test";
  vi.restoreAllMocks();
});

describe("prsBaseUrl", () => {
  it("reads PRS_BASE_URL", () => {
    expect(prsBaseUrl()).toBe("https://prs.test");
  });

  it("throws a clear error when unset, rather than fetching 'undefined/prs/...'", () => {
    delete process.env.PRS_BASE_URL;
    expect(() => prsBaseUrl()).toThrow(/PRS_BASE_URL/u);
  });
});

describe("fetchSource", () => {
  it("returns the parsed source on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(SOURCE)));
    const source = await fetchSource("abc");
    expect(source?.origin).toBe("fixture");
    expect(source?.pr.title).toBe("Refactor session issuance");
  });

  it("returns null for a 404", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 404 })));
    expect(await fetchSource("ghost")).toBeNull();
  });

  it("returns null when the Worker is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      })
    );
    expect(await fetchSource("abc")).toBeNull();
  });

  it("returns null rather than a half-typed object when the payload is wrong", async () => {
    // A version skew between an older Worker and a newer app is a normal
    // deploy state here; the page must 404 rather than render undefined.
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ origin: "fixture" })));
    expect(await fetchSource("abc")).toBeNull();
  });
});

describe("refreshSource", () => {
  it("posts the requested revision", async () => {
    const spy = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", spy);
    expect(await refreshSource("abc", 2)).toBe(true);
    expect(spy).toHaveBeenCalledWith(
      "https://prs.test/prs/abc/refresh",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ revision: 2 }) })
    );
  });

  it("posts an empty body for a GitHub re-fetch", async () => {
    const spy = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", spy);
    await refreshSource("abc", null);
    expect(spy).toHaveBeenCalledWith(
      "https://prs.test/prs/abc/refresh",
      expect.objectContaining({ body: "{}" })
    );
  });

  it("reports failure rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 400 })));
    expect(await refreshSource("abc", 9)).toBe(false);
  });
});
