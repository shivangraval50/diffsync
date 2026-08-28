import { describe, it, expect, vi, beforeEach } from "vitest";
import { LlmConfigError } from "@openbid/llm";

const selectProvider = vi.fn();
vi.mock("@openbid/llm", async () => {
  const actual = await vi.importActual<typeof import("@openbid/llm")>("@openbid/llm");
  return { ...actual, selectProvider: (...args: unknown[]) => selectProvider(...args) };
});

const fetchSource = vi.fn();
vi.mock("@/lib/prs", async () => {
  const actual = await vi.importActual<typeof import("@/lib/prs")>("@/lib/prs");
  return { ...actual, fetchSource: (key: string) => fetchSource(key) };
});

import { GET } from "./[key]/route";

const SOURCE = {
  origin: "fixture",
  pr: {
    ref: { kind: "fixture", slug: "demo", revision: 1 },
    title: "A pull request",
    author: "octo",
    headSha: "head",
    baseSha: "base",
    files: [],
  },
};

function params() {
  return { params: Promise.resolve({ key: "abc" }) };
}

function request(): Request {
  return new Request("https://diffsync.test/api/ai/abc");
}

beforeEach(() => {
  // `vi.restoreAllMocks()` must run BEFORE the `vi.fn()` mocks below are
  // configured, not after: for a bare `vi.fn()` (as opposed to a
  // `vi.spyOn()` of a real method) there is no "original implementation" to
  // restore, so `restoreAllMocks` clears it back to "returns undefined" --
  // silently wiping out a `mockResolvedValue` set before it in the same
  // callback. The brief's own draft had this the other way round, which
  // starves `fetchSource` of its resolved value and breaks every test that
  // actually reaches the fetch-and-run branch below.
  vi.restoreAllMocks();
  selectProvider.mockReset();
  fetchSource.mockReset();
  fetchSource.mockResolvedValue(SOURCE);
  process.env.PRS_BASE_URL = "https://prs.test";
});

describe("GET /api/ai/[key]", () => {
  it("degrades silently when no provider is configured", async () => {
    // The whole contract, asserted rather than described: a 200 carrying an
    // explicit absence, so the review surface renders with no AI section and
    // no error anywhere.
    selectProvider.mockImplementation(() => {
      throw new LlmConfigError("no LLM provider configured");
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 404 })));

    const res = await GET(request(), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pass: null });
  });

  it("does not fetch the pull request source when nothing is configured", async () => {
    // Cheap proof that the unconfigured path short-circuits before doing any
    // work at all, rather than doing the work and discarding it.
    selectProvider.mockImplementation(() => {
      throw new LlmConfigError("no LLM provider configured");
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 404 })));

    await GET(request(), params());
    expect(fetchSource).not.toHaveBeenCalled();
  });

  it("re-throws a configuration error that is not LlmConfigError, rather than swallowing it", async () => {
    // The route's catch branch is written to check `instanceof LlmConfigError`
    // specifically. A version that caught anything and returned `{ pass:
    // null }` unconditionally would silently hide a real bug (e.g. a typo'd
    // env var read that throws a plain TypeError) behind the exact same
    // "unconfigured" response this suite otherwise expects.
    selectProvider.mockImplementation(() => {
      throw new TypeError("boom");
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 404 })));

    await expect(GET(request(), params())).rejects.toThrow(TypeError);
  });

  it("returns the Durable Object's cached pass without calling the model", async () => {
    const cached = {
      summary: "Cached summary.",
      flags: [],
      generatedBy: "gemini",
      generatedAtMs: 1,
    };
    const complete = vi.fn();
    selectProvider.mockReturnValue({ name: "gemini", complete });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(cached)));

    const res = await GET(request(), params());
    expect(await res.json()).toEqual({ pass: cached });
    // One call per pull request, not one per view.
    expect(complete).not.toHaveBeenCalled();
  });

  it("runs the pass and caches it when there is nothing cached", async () => {
    const complete = vi.fn(async (_request: { prompt: string }) =>
      JSON.stringify({ summary: "Fresh summary.", flags: [] })
    );
    selectProvider.mockReturnValue({ name: "gemini", complete });
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "PUT"
        ? new Response(null, { status: 200 })
        : new Response("no", { status: 404 })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const res = await GET(request(), params());
    const body = (await res.json()) as { pass: { summary: string } | null };
    expect(body.pass?.summary).toBe("Fresh summary.");
    expect(complete).toHaveBeenCalledTimes(1);
    // The provider actually saw this pull request's title, not some fixed or
    // empty prompt -- proof the route wired `runAiPass` to the fetched
    // source rather than to a stale or default value.
    expect(complete.mock.calls[0]?.[0].prompt).toContain("A pull request");
    expect(fetchSpy.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(true);
  });

  it("degrades silently when the provider itself fails", async () => {
    selectProvider.mockReturnValue({
      name: "gemini",
      complete: async () => {
        throw new Error("upstream 500");
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 404 })));

    const res = await GET(request(), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pass: null });
  });
});
