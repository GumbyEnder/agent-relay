-- 0073 — the pictures someone added to a conversation (Talk's paperclip), kept with it.
--
-- Reopened from History, a conversation used to come back as its words only: "make this
-- photo 3D" then had no photo and made a model from words instead (independent review,
-- 2026-11-25). The turn that carries an added picture writes it down here; the transcript
-- hands the ids back with the conversation. Ids only: the picture itself stays in
-- buzzy_assets and goes with it.

CREATE TABLE IF NOT EXISTS buzzy_chat_pictures (
  user_id    TEXT NOT NULL,
  session_id TEXT NOT NULL,
  asset_id   BIGINT NOT NULL REFERENCES buzzy_assets(id) ON DELETE CASCADE,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, session_id, asset_id)
);

CREATE INDEX IF NOT EXISTS buzzy_chat_pictures_session ON buzzy_chat_pictures (user_id, session_id, added_at DESC);
