import { BeeZillaClientCard } from "./card.js";
import { BEEZILLA_HONCHO_WORKSPACE, factAllowed } from "./honcho.js";

/**
 * Sanitize a BeeZilla client card before sending it to Honcho.
 * Drops any fact or job oneLiner whose text fails factAllowed().
 * The workspace name is always BEEZILLA_HONCHO_WORKSPACE.
 */
export function sanitizeForHoncho(card: BeeZillaClientCard): {
  workspace: string;
  facts: { id: string; text: string }[];
  jobs: { id: string; oneLiner: string; finishedAt: string }[];
  notStored: string[];
} {
  return {
    workspace: BEEZILLA_HONCHO_WORKSPACE,
    facts: card.facts.filter((f) => factAllowed(f.text)),
    jobs: card.jobs
      .filter((j) => factAllowed(j.oneLiner))
      .map((j) => ({
        id: j.id,
        oneLiner: j.oneLiner,
        finishedAt: j.finishedAt,
      })),
    notStored: card.notStored,
  };
}
