-- 0062 — deal-memo runs: one job row and one row per pipeline stage.
--
-- Why a table rather than a promise: the runner is in-process and detached. The
-- chat turn starts it and answers, and the page polls GET /api/buzzy/deal-memo/<id>.
-- A promise would vanish with the process; the row is what the poll reads and
-- what the boot sweep can fail closed after a redeploy.
--
-- THE FAIL-CLOSED RULE. A run that was queued or running when the process died
-- is 'interrupted', never 'done'. `scripts/deal-memo-reaper.mjs` performs that
-- transition at boot, and it also zeroes charged_cents. A run is 'done' only
-- after every file has been stored and the checks have passed; there is no path
-- from a dead process to "done".
--
-- What is stored: the manifest of inputs is the intake ledger only (role,
-- sha256, byte count, derived counts). Listing text, tenant names and rents are
-- never written to this table, to a log line or to a stage note. The memo files
-- themselves live in buzzy_assets, job_id = this job.

CREATE TABLE IF NOT EXISTS buzzy_deal_memo_jobs (
  job_id         TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  recipe_hash    TEXT NOT NULL,
  -- The service that started the run. The boot reaper sweeps only its own rows,
  -- so a restart of the sibling service cannot mark a live run interrupted.
  owner_host     TEXT NOT NULL DEFAULT '',
  title          TEXT,
  -- queued | running | done | failed | interrupted
  state          TEXT NOT NULL DEFAULT 'queued',
  message        TEXT,
  -- Money is only ever moved after a run reaches 'done'. Interrupted and failed
  -- runs carry 0, and the reaper enforces that rather than trusting the runner.
  charged_cents  INTEGER NOT NULL DEFAULT 0,
  -- Intake ledger only: [{role, sha256, bytes, ...counts}]. Never document text.
  inputs         JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Verdict + stored asset ids + renderer page count. JSON so a later phase can
  -- add a field without a migration; the poll returns it as-is.
  summary        JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT buzzy_deal_memo_jobs_state_check
    CHECK (state IN ('queued', 'running', 'done', 'failed', 'interrupted'))
);

CREATE INDEX IF NOT EXISTS buzzy_deal_memo_jobs_user_created_idx
  ON buzzy_deal_memo_jobs (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS buzzy_deal_memo_stages (
  id          BIGSERIAL PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES buzzy_deal_memo_jobs(job_id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  stage_key   TEXT NOT NULL,
  label       TEXT NOT NULL,
  -- pending | running | done | failed | skipped | interrupted
  state       TEXT NOT NULL DEFAULT 'pending',
  -- A stage note is a derived count or a code. Never a tenant name, a rent or
  -- a line of the listing: the stage line is shown in the chat card.
  note        TEXT,
  started_at  TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  CONSTRAINT buzzy_deal_memo_stages_state_check
    CHECK (state IN ('pending', 'running', 'done', 'failed', 'skipped', 'interrupted')),
  CONSTRAINT buzzy_deal_memo_stages_seq_unique UNIQUE (job_id, seq)
);

CREATE INDEX IF NOT EXISTS buzzy_deal_memo_stages_job_idx
  ON buzzy_deal_memo_stages (job_id, seq);
