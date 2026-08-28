import type { ReviewEvent } from "@diffsync/threads";
import type { ArchiveOp } from "./archive.js";

type Sql = SqlStorage;

export function initSchema(sql: Sql): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS events (
      seq     INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbox (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT NOT NULL
    );
  `);
}

export function putMeta(sql: Sql, k: string, v: string): void {
  sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = ?", k, v, v);
}

export function getMeta(sql: Sql, k: string): string | null {
  const rows = sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", k).toArray();
  return rows.length > 0 ? rows[0]!.v : null;
}

/** Remove one row outright, rather than overwriting it with a tombstone
 *  value: callers (currently just the AI pass cache on `/refresh`) want a
 *  plain miss afterward, indistinguishable from having never been written. */
export function deleteMeta(sql: Sql, k: string): void {
  sql.exec("DELETE FROM meta WHERE k = ?", k);
}

export function appendEvent(sql: Sql, event: ReviewEvent): number {
  sql.exec("INSERT INTO events (payload) VALUES (?)", JSON.stringify(event));
  return currentSeq(sql);
}

export function currentSeq(sql: Sql): number {
  const rows = sql.exec<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM events").toArray();
  return rows[0]?.seq ?? 0;
}

export function readEventsSince(sql: Sql, seq: number): { seq: number; event: ReviewEvent }[] {
  return sql
    .exec<{ seq: number; payload: string }>(
      "SELECT seq, payload FROM events WHERE seq > ? ORDER BY seq ASC",
      seq
    )
    .toArray()
    .map((row) => ({ seq: row.seq, event: JSON.parse(row.payload) as ReviewEvent }));
}

/** Append one archive op to this object's local outbox. A plain synchronous
 *  `sql.exec` -- like `appendEvent` above, never a `Promise` -- so callers
 *  in `webSocketMessage` can enqueue an archive without introducing a
 *  suspension point into that handler. */
export function enqueue(sql: Sql, op: ArchiveOp): void {
  sql.exec("INSERT INTO outbox (payload) VALUES (?)", JSON.stringify(op));
}

export function readOutbox(sql: Sql): { id: number; op: ArchiveOp }[] {
  return sql
    .exec<{ id: number; payload: string }>("SELECT id, payload FROM outbox ORDER BY id ASC")
    .toArray()
    .map((row) => ({ id: row.id, op: JSON.parse(row.payload) as ArchiveOp }));
}

export function deleteOutbox(sql: Sql, id: number): void {
  sql.exec("DELETE FROM outbox WHERE id = ?", id);
}
