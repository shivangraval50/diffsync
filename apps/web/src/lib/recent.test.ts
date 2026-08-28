import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const query = vi.fn();
vi.mock("@neondatabase/serverless", () => ({ neon: () => query }));

import { recentPrs } from "./recent";

beforeEach(() => {
  query.mockReset();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe("recentPrs", () => {
  it("returns an empty list when no database is configured", async () => {
    expect(await recentPrs()).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("maps rows into RecentPr", async () => {
    process.env.DATABASE_URL = "postgres://example";
    query.mockResolvedValue([
      { pr_key: "k1", label: "vercel/next.js#1", title: "Fix it", origin: "github" },
    ]);
    expect(await recentPrs()).toEqual([
      { prKey: "k1", label: "vercel/next.js#1", title: "Fix it", origin: "github" },
    ]);
  });

  it("returns an empty list when the query fails, so the page still renders", async () => {
    // The constraint: no live state depends on Postgres. A Neon outage must
    // cost the visitor a list, not the app.
    process.env.DATABASE_URL = "postgres://example";
    query.mockRejectedValue(new Error("connection terminated"));
    expect(await recentPrs()).toEqual([]);
  });
});
