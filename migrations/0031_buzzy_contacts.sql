-- BZ-F030: confirmed customer / supplier / people directory.
-- Imported or suggested contacts land as 'proposed' until the owner accepts
-- them; a name match alone NEVER merges entities (disambiguation is explicit).
CREATE TABLE IF NOT EXISTS buzzy_contacts (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  company_id   TEXT,
  kind         TEXT NOT NULL DEFAULT 'person',  -- customer | supplier | person
  name         TEXT NOT NULL,
  role         TEXT,
  contact      JSONB NOT NULL DEFAULT '{}'::jsonb,  -- approved contact details only
  status       TEXT NOT NULL DEFAULT 'proposed',    -- proposed | confirmed
  source_label TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS buzzy_contacts_user ON buzzy_contacts (user_id, updated_at DESC);
