/**
 * PUBLIC BUILD STUB — the deal-memo lane is not in this build.
 *
 * The real module is `private/dealMemo.ts` + `private/dealMemoRun.ts` in
 * github.com:GumbyEnder/beezilla-recipes, copied into `src/lib/private/` before
 * the build. An open build still typechecks and still answers: the lane reports
 * itself as unconfigured, and the chat says exactly that rather than pretending
 * a memo was started.
 */
export interface DealMemoLoanRequest {
  loanAmountCents: number;
  noteRateBp: number;
  amortizationYears: number;
  termYears: number;
  askingPriceCents: number | null;
  asOf: string;
  purpose?: string;
}

export interface DealMemoStartInput {
  userId: string;
  recipeHash: string;
  loan: DealMemoLoanRequest;
  memoFormat?: string;
  title?: string | null;
}

export type DealMemoStartResult =
  | { ok: true; jobId: string }
  | { ok: false; code: string; message: string; ask?: string };

export function dealMemoConfigured(): boolean {
  return false;
}

export function dealMemoRecipeHash(): string | null {
  return null;
}

export async function startDealMemoRun(_input: DealMemoStartInput): Promise<DealMemoStartResult> {
  return { ok: false, code: "not_configured", message: "the deal-memo lane is not in this build" };
}
