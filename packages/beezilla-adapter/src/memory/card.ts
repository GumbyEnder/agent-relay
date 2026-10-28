/** Long-term client card. Honcho stores this; BeeZilla shows it. */
export interface BeeZillaClientCard {
  clientId: string;
  facts: { id: string; text: string }[];
  jobs: { id: string; oneLiner: string; finishedAt: string }[];
  notStored: string[];
}

export const EMPTY_CARD_NOT_STORED = [
  "Model names and token counts",
  "Your wallet or payment details",
  "Full interview transcripts forever",
];

export function emptyCard(clientId: string): BeeZillaClientCard {
  return { clientId, facts: [], jobs: [], notStored: [...EMPTY_CARD_NOT_STORED] };
}

export function forgetFact(card: BeeZillaClientCard, factId: string): BeeZillaClientCard {
  return { ...card, facts: card.facts.filter((f) => f.id !== factId) };
}

export function forgetEverything(card: BeeZillaClientCard): BeeZillaClientCard {
  return emptyCard(card.clientId);
}

export function addJobSummary(
  card: BeeZillaClientCard,
  oneLiner: string,
  at = new Date().toISOString(),
): BeeZillaClientCard {
  return {
    ...card,
    jobs: [...card.jobs, { id: `job_${card.jobs.length + 1}`, oneLiner, finishedAt: at }],
  };
}
