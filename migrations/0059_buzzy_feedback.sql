-- 0059 — feedback, from the yellow pill in the nav on every page.
--
-- Why: the Ask/Feedback control is on every page, signed in or not. A person who
-- is confused has to be able to say so without first finding the right page, and
-- an anonymous visitor has no user row to hang the report off. So `user_id` is
-- nullable and there is NO account_email column: the email is joined from "user"
-- at read time when a user_id exists, and an anonymous report has no identity at
-- all. Storing an email here would be a second copy of an identity that the
-- deletion receipt in portability.ts cannot see.
--
-- ip_hash: the rate limiter needs something stable and non-identifying. It is a
-- salted sha256 of the first x-forwarded-for hop, never the address itself, and
-- it is nullable so a report can outlive the limiter's interest in it. The limiter
-- only ever reads rows with created_at > now() - interval '1 day', which is what
-- the (ip_hash, created_at) index is for.
--
-- diagnostics: the JSON the panel shows the person before they send it (page URL,
-- build sha, browser, viewport, recent console errors). It is null when they do
-- not tick "include diagnostics". Never a screenshot: v1 has none.
--
-- herd: `reference` is the short code read back to the person ("BZ-4F2K"), which
-- is how a report is found without exposing a sequential id.

CREATE TABLE IF NOT EXISTS buzzy_feedback (
  id           TEXT PRIMARY KEY,
  reference    TEXT NOT NULL UNIQUE,
  user_id      TEXT,
  kind         TEXT NOT NULL DEFAULT 'general',
  message      TEXT NOT NULL,
  page_url     TEXT,
  build_sha    TEXT,
  user_agent   TEXT,
  viewport     TEXT,
  diagnostics  JSONB,
  ip_hash      TEXT,
  status       TEXT NOT NULL DEFAULT 'new',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The limiter's only query: one ip_hash, recent first.
CREATE INDEX IF NOT EXISTS buzzy_feedback_ip_created_idx
  ON buzzy_feedback (ip_hash, created_at DESC);

-- The sweep's only query, and the admin list's order.
CREATE INDEX IF NOT EXISTS buzzy_feedback_created_idx
  ON buzzy_feedback (created_at DESC);

-- Account deletion finds a person's reports by user_id.
CREATE INDEX IF NOT EXISTS buzzy_feedback_user_idx
  ON buzzy_feedback (user_id);

-- The limiter's counter, and why it is a table rather than a count(*).
--
-- 7319 allows "pg_advisory_lock or a proven concurrent arm". This is the proven
-- arm: one row per limiter key, incremented by an UPSERT. An UPSERT takes a row
-- lock, so two simultaneous reports from the same ip_hash serialise — the second
-- sees the first's increment. A `count(*) < 15` inside an INSERT ... SELECT does
-- not: under read-committed both readers see the same 14 and both insert.
--
-- `bucket` is the UTC hour the count belongs to, so the window resets without a
-- delete. The route-wide row uses the reserved key '__route__'.
CREATE TABLE IF NOT EXISTS buzzy_feedback_gate (
  gate_key  TEXT PRIMARY KEY,
  bucket    TIMESTAMPTZ NOT NULL,
  n         INTEGER NOT NULL
);

