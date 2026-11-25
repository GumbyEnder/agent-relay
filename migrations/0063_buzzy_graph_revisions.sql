-- 0063 — CR-3 orchestration spec: the editor's node types, real history,
-- and a thumbnail slot.
--
-- 0049 closed node kinds to the five the first resolver understood. The
-- orchestration editor authors a broader vocabulary (start, tool, decision,
-- parallel, loop, approval, trigger, subflow, end, note) and projects it into
-- these rows; the rows are a rendering of buzzy_graphs.spec, never the record.
-- The old five stay in the CHECK so graphs saved before today still load.
--
-- A version counter is not a history. buzzy_graph_revisions keeps the exact
-- canonical spec per revision, written in the same statement as the version
-- bump (graphs.ts), so a save cannot bump without a snapshot or the reverse.

ALTER TABLE buzzy_graph_nodes DROP CONSTRAINT IF EXISTS buzzy_graph_nodes_kind_check;
ALTER TABLE buzzy_graph_nodes ADD CONSTRAINT buzzy_graph_nodes_kind_check
  CHECK (kind IN (
    'agent', 'skill', 'model', 'review', 'gate',
    'start', 'tool', 'decision', 'parallel', 'loop',
    'approval', 'trigger', 'subflow', 'end', 'note'
  ));

ALTER TABLE buzzy_graphs ADD COLUMN IF NOT EXISTS thumb_asset_id TEXT;

CREATE TABLE IF NOT EXISTS buzzy_graph_revisions (
  id            BIGSERIAL PRIMARY KEY,
  graph_id      TEXT NOT NULL REFERENCES buzzy_graphs(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL,
  revision      INTEGER NOT NULL,
  spec          JSONB NOT NULL,
  thumb_asset_id TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (graph_id, revision)
);

CREATE INDEX IF NOT EXISTS buzzy_graph_revisions_graph_idx
  ON buzzy_graph_revisions (graph_id, revision DESC);
