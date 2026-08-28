-- Run once against the Neon database. Nothing here is live state: if this
-- database is unreachable, every pull request still opens, every comment
-- still lands, and only the "recently reviewed" list and the resolved-thread
-- archive are missing.

CREATE TABLE IF NOT EXISTS pull_requests (
  pr_key        TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  label         TEXT NOT NULL,
  title         TEXT NOT NULL,
  head_sha      TEXT NOT NULL,
  origin        TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS resolved_threads (
  pr_key        TEXT NOT NULL,
  thread_id     TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  line          INTEGER NOT NULL,
  body          TEXT NOT NULL,
  comment_count INTEGER NOT NULL,
  opened_by     TEXT NOT NULL,
  resolved_by   TEXT NOT NULL,
  resolved_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (pr_key, thread_id)
);

CREATE INDEX IF NOT EXISTS pull_requests_last_seen_idx ON pull_requests (last_seen_at DESC);
