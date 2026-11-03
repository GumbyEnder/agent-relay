-- 0049 — node-graph orchestration (6a: data model).
--
-- A graph is authored once and run many times, so the authored definition and
-- each run are separate tables: editing a graph must never rewrite the history
-- of runs that already happened. Every run freezes `spec` at start, which is
-- what makes a run reproducible from its stored graph.
--
-- Node kinds are a closed set on purpose (agent, skill, model, review, gate).
-- 'review' is its own kind, not a flag on 'model', because a review node has a
-- different contract: it must be able to run on a *different provider* than the
-- node it checks, and that independence is recorded per result.

CREATE TABLE IF NOT EXISTS buzzy_graphs (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  spec          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS buzzy_graphs_user_idx
  ON buzzy_graphs (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS buzzy_graph_nodes (
  id            TEXT PRIMARY KEY,
  graph_id      TEXT NOT NULL REFERENCES buzzy_graphs(id) ON DELETE CASCADE,
  node_key      TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('agent', 'skill', 'model', 'review', 'gate')),
  title         TEXT,
  -- config carries the pins: an AGENT.md path, a skill id, a model family or a
  -- frontier position ("N in category Y"), retry bound, approval requirement.
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  pos_x         DOUBLE PRECISION,
  pos_y         DOUBLE PRECISION,
  UNIQUE (graph_id, node_key)
);

CREATE TABLE IF NOT EXISTS buzzy_graph_edges (
  id            BIGSERIAL PRIMARY KEY,
  graph_id      TEXT NOT NULL REFERENCES buzzy_graphs(id) ON DELETE CASCADE,
  from_key      TEXT NOT NULL,
  to_key        TEXT NOT NULL,
  -- 'review' edges carry the cross-provider requirement; 'gate' edges stop the
  -- run for a human decision like the rest of the product.
  kind          TEXT NOT NULL DEFAULT 'data' CHECK (kind IN ('data', 'review', 'gate')),
  UNIQUE (graph_id, from_key, to_key, kind)
);

CREATE TABLE IF NOT EXISTS buzzy_graph_runs (
  id            TEXT PRIMARY KEY,
  graph_id      TEXT NOT NULL REFERENCES buzzy_graphs(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'running', 'awaiting_approval', 'done', 'failed', 'cancelled')),
  -- Frozen authored graph. A run is reproducible from this, even after the
  -- graph is edited or deleted.
  spec          JSONB NOT NULL,
  error         TEXT,
  cost_usd      NUMERIC(10, 4) NOT NULL DEFAULT 0,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS buzzy_graph_runs_graph_idx
  ON buzzy_graph_runs (graph_id, started_at DESC);
CREATE INDEX IF NOT EXISTS buzzy_graph_runs_user_idx
  ON buzzy_graph_runs (user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS buzzy_graph_node_results (
  id            BIGSERIAL PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES buzzy_graph_runs(id) ON DELETE CASCADE,
  node_key      TEXT NOT NULL,
  attempt       INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped', 'awaiting_approval')),
  provider      TEXT,
  model         TEXT,
  -- True when this review node ran on a provider different from the node it
  -- checks. Recorded, not inferred: the whole value of a review node is that
  -- the second opinion is independent.
  independent   BOOLEAN,
  input         JSONB,
  output        JSONB,
  latency_ms    INTEGER,
  cost_usd      NUMERIC(10, 4) NOT NULL DEFAULT 0,
  error         TEXT,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  UNIQUE (run_id, node_key, attempt)
);

CREATE INDEX IF NOT EXISTS buzzy_graph_node_results_run_idx
  ON buzzy_graph_node_results (run_id, node_key, attempt);
