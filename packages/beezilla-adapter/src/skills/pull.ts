/**
 * BeeZilla — Skill puller for civilian jobs.
 *
 * Reads the catalog and returns the skill IDs relevant to a given job type.
 * SOW and letter jobs must never include github or railway (hard exclusions).
 * Website jobs may include them (later path only).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JobType = "sow" | "letter" | "website";

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
// pullForJob
// ---------------------------------------------------------------------------

/**
 * Return the skill IDs that should be pulled for the given job type.
 *
 * - "sow" and "letter": civilian document jobs — github and railway
 *   are hard-excluded per the catalog's pull_rules.
 * - "website": may include github and railway (later path).
 */
export function pullForJob(job: JobType): string[] {
  const catalog = loadCatalog();
  const skillIds = catalog.skills.map((s) => s.id);

  if (job === "website") {
    // Website jobs get the full catalog (github/railway allowed later)
    return skillIds;
  }

  // sow and letter: exclude github and railway
  const exclusions = catalog.pull_rules.hard_exclusions;
  return skillIds.filter((id) => !exclusions.includes(id));
}
