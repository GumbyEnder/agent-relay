/**
 * BeeZilla — Skill registry.
 *
 * Reads catalog-v0.json and exposes civilian-facing skill listings.
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
// listSkills
// ---------------------------------------------------------------------------

/**
 * Return every skill from the catalog as {id, civilian_name}.
 *
 * Civilians never see model ids; only the civilian_name is exposed.
 */
let _skillList: SkillEntry[] | null = null;

export function listSkills(): SkillEntry[] {
  if (_skillList) return _skillList;

  const catalog = loadCatalog();
  _skillList = catalog.skills.map((s) => ({
    id: s.id,
    civilian_name: s.civilian_name,
  }));

  return _skillList;
}

// ---------------------------------------------------------------------------
// twoPasses
// ---------------------------------------------------------------------------

/**
 * Return the two-phase pull order.
 *
 * The catalog's pull_rules.selection says "two passes: interview signals,
 * then the draft with a one-line reason per skill".
 */
export function twoPasses(): string[] {
  return ["interview", "draft"];
}
