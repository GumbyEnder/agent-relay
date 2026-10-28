import { BeeZillaClientCard } from "./card.js";
import { BEEZILLA_HONCHO_WORKSPACE, factAllowed } from "./honcho.js";

/** Fields that must never appear in any Honcho payload. */
const NEVER_INCLUDE = new Set(["wallet", "model_id", "token_count", "transcript"]);

/**
 * Sanitize a BeeZilla client card before sending to Honcho.
 *
 * - Drops any fact or job oneLiner whose text fails `factAllowed()`.
 * - Never includes wallet, model_id, token_count, transcript.
 * - Returns the workspace name from `BEEZILLA_HONCHO_WORKSPACE`.
 */
export function sanitizeForHoncho(card: BeeZillaClientCard): {
  workspace: string;
  facts: { id: string; text: string }[];
  jobs: { id: string; oneLiner: string; finishedAt: string }[];
} {
  const sanitizedFacts = card.facts.filter((f) => {
    if (!factAllowed(f.text)) return false;
    for (const key of NEVER_INCLUDE) {
      if (f.text.toLowerCase().includes(key)) return false;
    }
    return true;
  });

  const sanitizedJobs = card.jobs.filter((j) => {
    if (!factAllowed(j.oneLiner)) return false;
    for (const key of NEVER_INCLUDE) {
      if (j.oneLiner.toLowerCase().includes(key)) return false;
    }
    return true;
  });

  return {
    workspace: BEEZILLA_HONCHO_WORKSPACE,
    facts: sanitizedFacts,
    jobs: sanitizedJobs.map((j) => ({
      id: j.id,
      oneLiner: j.oneLiner,
      finishedAt: j.finishedAt,
    })),
  };
}
