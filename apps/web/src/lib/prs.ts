import { sourceResultSchema, type SourceResult } from "@diffsync/protocol";

export function prsBaseUrl(): string {
  const base = process.env.PRS_BASE_URL;
  if (!base) throw new Error("PRS_BASE_URL is not set");
  return base;
}

/**
 * The pull request as the Durable Object sees it. Parsed through the shared
 * schema rather than cast: this crosses a real process boundary (Vercel to a
 * Cloudflare Worker) and the two deploy independently, so a version skew is a
 * normal state rather than an exotic one.
 */
export async function fetchSource(key: string): Promise<SourceResult | null> {
  let res: Response;
  try {
    res = await fetch(`${prsBaseUrl()}/prs/${key}/source`, { cache: "no-store" });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const parsed = sourceResultSchema.safeParse(await res.json());
  return parsed.success ? parsed.data : null;
}

/** Re-resolve a pull request's source. `revision` advances a seeded fixture to
 *  a later revision (the force-push demo); pass `null` for a GitHub re-fetch. */
export async function refreshSource(key: string, revision: number | null): Promise<boolean> {
  try {
    const res = await fetch(`${prsBaseUrl()}/prs/${key}/refresh`, {
      method: "POST",
      body: JSON.stringify(revision === null ? {} : { revision }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
