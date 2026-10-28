/**
 * BeeZilla — Skill definition lookup.
 *
 * Reads catalog-v0.json and exposes a single getSkill(id) that returns the
 * full record {id, civilian_name, dana_sow} for a given skill id.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single skill entry as seen by civilians. */
export interface SkillEntry {
  id: string;
  civilian_name: string;
  dana_sow: boolean;
}

interface CatalogSkill {
  id: string;
  civilian_name: string;
  when_pulled: string;
  cost_class: string;
  dana_sow: boolean;
}

interface Catalog {
  version: string;
  job_scope: string;
  note: string;
  skills: CatalogSkill[];
  pull_rules: {
    selection: string;
    model_policy: string;
    hard_exclusions: string[];
  };
}

// ---------------------------------------------------------------------------
// Load the catalog once
// ---------------------------------------------------------------------------

let _catalog: Catalog | null = null;

function loadCatalog(): Catalog {
  if (_catalog) return _catalog;

  const catalogPath = resolve(__dirname, "catalog-v0.json");
  const raw = readFileSync(catalogPath, "utf-8");
  _catalog = JSON.parse(raw) as Catalog;
  return _catalog;
}

// ---------------------------------------------------------------------------
// getSkill
// ---------------------------------------------------------------------------

/**
 * Look up a single skill by id and return {id, civilian_name, dana_sow}.
 *
 * @param id - the skill id from the catalog
 * @returns the skill entry, or undefined if not found
 */
export function getSkill(id: string): SkillEntry | undefined {
  const catalog = loadCatalog();
  const skill = catalog.skills.find((s) => s.id === id);
  if (!skill) return undefined;
  return {
    id: skill.id,
    civilian_name: skill.civilian_name,
    dana_sow: skill.dana_sow,
  };
}
