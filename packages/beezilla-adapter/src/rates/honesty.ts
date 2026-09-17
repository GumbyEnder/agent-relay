export type RateSource = { url?: string; amountUsd?: number };

export const UNCONFIRMED =
  "We could not confirm typical prices from two solid sources.";

export function typicalRange(sources: RateSource[]): {
  display: string;
  invented: false;
} {
  const amounts = sources
    .map((s) => s.amountUsd)
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0);
  if (amounts.length < 2) {
    return { display: UNCONFIRMED, invented: false };
  }
  const min = Math.min(...amounts);
  const max = Math.max(...amounts);
  return { display: `about $${min}–$${max}`, invented: false };
}
