import { neon } from "@neondatabase/serverless";

export interface RecentPr {
  prKey: string;
  label: string;
  title: string;
  origin: string;
}

/**
 * The home page's "recently reviewed" list. Reads Neon, and returns an empty
 * list for any failure at all -- unset credentials, a missing table, an
 * outage. Nothing here is live state: the home page, every pull request page
 * and every socket keep working with Postgres entirely absent.
 */
export async function recentPrs(limit = 8): Promise<RecentPr[]> {
  const url = process.env.DATABASE_URL;
  if (!url) return [];
  try {
    const sql = neon(url);
    const rows = await sql`
      SELECT pr_key, label, title, origin
      FROM pull_requests
      ORDER BY last_seen_at DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => ({
      prKey: String(row.pr_key),
      label: String(row.label),
      title: String(row.title),
      origin: String(row.origin),
    }));
  } catch {
    return [];
  }
}
