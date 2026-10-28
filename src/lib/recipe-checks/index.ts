/**
 * Recipe Seal — Step 1 public surface.
 *
 * `compileRecipeChecks(recipeId)` → a sealed `.wasm` artifact plus the public
 * code map. `evaluateRecipeChecks(wasm, draft)` → the verdict. Parsing the
 * artifact requires the loader, which lives platform-side.
 */
export * from "./types";
export * from "./author";
export { evaluateDraft, FUEL_BUDGET } from "./vm";
export { compile, loadRules, codeMap, ENGINE } from "./seal";
export { RECIPE_RULES, FORBIDDEN, rulesFor, ALL_RULES, allCodes } from "./rules";

import { compile, loadRules } from "./seal";
import { evaluateDraft } from "./vm";
import { rulesFor } from "./rules";
import type { CompiledChecks, Draft, EvaluationResult } from "./types";

export function compileRecipeChecks(recipeId: string, opts: { salt?: Uint8Array } = {}): CompiledChecks {
  return compile(rulesFor(recipeId), opts);
}

/** Evaluate a draft against a sealed artifact. Throws if the module is corrupt. */
export function evaluateRecipeChecks(
  wasm: Uint8Array,
  draft: Draft,
  opts: { budget?: number } = {},
): EvaluationResult {
  return evaluateDraft(draft, loadRules(wasm), opts);
}
