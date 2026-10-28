-- "Time to talk BY USER" — how long the owner actually spoke, and how much of
-- the turn was listening vs generating. Nullable: typed turns have no speech.
ALTER TABLE buzzy_voice_metrics ADD COLUMN IF NOT EXISTS speech_ms INTEGER;
ALTER TABLE buzzy_voice_metrics ADD COLUMN IF NOT EXISTS listen_ms INTEGER;
