-- Recipe ratings, and the seller's view of their own sales.
--
-- Two rules, both about not leaking people:
--
--   1. A rating belongs to a recipe, not to a person. The rater is stored so one
--      account cannot vote twice, and is never returned by any endpoint.
--   2. Only someone who owns the recipe may rate it. A rating from a shopper who
--      never ran the thing is a review of the description, not of the work.

CREATE TABLE IF NOT EXISTS ar_recipe_rating (
  hash       TEXT NOT NULL,
  rater_id   TEXT NOT NULL,
  stars      SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (hash, rater_id)
);

CREATE INDEX IF NOT EXISTS ar_recipe_rating_hash_idx ON ar_recipe_rating (hash);
