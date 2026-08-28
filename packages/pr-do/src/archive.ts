import { neon } from "@neondatabase/serverless";

/**
 * One write to the Neon archive. `upsertPr` carries `kind` (github/fixture)
 * alongside `label` -- both are invariant for a given `prKey` (they come
 * straight out of the decoded `PrRef`), but `schema.sql`'s `pull_requests.kind`
 * column is `NOT NULL`, so the op has to carry it even though this plan's own
 * interface summary omitted it.
 */
export type ArchiveOp =
  | {
      op: "upsertPr";
      prKey: string;
      kind: string;
      label: string;
      title: string;
      headSha: string;
      origin: string;
    }
  | {
      op: "archiveThread";
      prKey: string;
      threadId: string;
      filePath: string;
      line: number;
      body: string;
      commentCount: number;
      openedBy: string;
      resolvedBy: string;
      resolvedAtMs: number;
    }
  | { op: "removeThread"; prKey: string; threadId: string };

/**
 * Apply one archive operation to Neon.
 *
 * Throws -- rather than returning quietly -- when there is no database
 * configured, so the caller's outbox keeps the row and retries. Succeeding
 * silently would discard archives in precisely the configuration most likely
 * to be a mistake: a deploy with the secret unset. Any other failure (a
 * network error, Postgres being down, a malformed query) is left to
 * propagate too -- this function has no `catch` of its own. The outbox
 * that calls it (`PrDO.alarm`) is what decides a failure is not fatal to
 * the live review; this function's job is only to tell the truth about
 * whether the write landed.
 *
 * Nothing here ever reads a row back (no `RETURNING`, no `SELECT`): every
 * branch is a one-way write, so there is no Neon response for a Zod schema
 * to validate and nowhere for the classic "NUMERIC comes back as a string"
 * driver surprise to bite. The numeric fields that travel the other
 * direction (`line`, `commentCount`, `resolvedAtMs`) are plain JS numbers
 * supplied by this process, passed as ordinary query parameters -- not
 * values parsed out of a Postgres response.
 */
export async function runArchiveOp(
  databaseUrl: string | undefined,
  op: ArchiveOp
): Promise<void> {
  if (!databaseUrl) throw new Error("DATABASE_URL is not configured");
  const sql = neon(databaseUrl);

  if (op.op === "upsertPr") {
    await sql`
      INSERT INTO pull_requests (pr_key, kind, label, title, head_sha, origin, last_seen_at)
      VALUES (${op.prKey}, ${op.kind}, ${op.label}, ${op.title}, ${op.headSha}, ${op.origin}, now())
      ON CONFLICT (pr_key) DO UPDATE
        SET title = EXCLUDED.title,
            head_sha = EXCLUDED.head_sha,
            origin = EXCLUDED.origin,
            last_seen_at = now()
    `;
    return;
  }

  if (op.op === "archiveThread") {
    await sql`
      INSERT INTO resolved_threads
        (pr_key, thread_id, file_path, line, body, comment_count, opened_by, resolved_by, resolved_at)
      VALUES
        (${op.prKey}, ${op.threadId}, ${op.filePath}, ${op.line}, ${op.body},
         ${op.commentCount}, ${op.openedBy}, ${op.resolvedBy},
         to_timestamp(${op.resolvedAtMs} / 1000.0))
      ON CONFLICT (pr_key, thread_id) DO UPDATE
        SET comment_count = EXCLUDED.comment_count,
            resolved_by = EXCLUDED.resolved_by,
            resolved_at = EXCLUDED.resolved_at
    `;
    return;
  }

  await sql`
    DELETE FROM resolved_threads WHERE pr_key = ${op.prKey} AND thread_id = ${op.threadId}
  `;
}
