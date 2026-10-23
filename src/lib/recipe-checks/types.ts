/**
 * Recipe Seal — Step 1: types for the check DSL.
 *
 * The Draft AST is the *normalised* artifact a recipe produces. Checks never run
 * against raw model text: that is what makes them deterministic, and what stops
 * the model from dodging a check by reformatting.
 *
 * Spec: Main Vault/01_Projects/Dev Boards/Sealed Recipes/01-Check-DSL-and-Compiler.md
 */

export type Severity = "block" | "warn";

/** A monetary/date/number value the recipe produced, with its provenance. */
export interface DraftValue {
  id: string;
  kind: "money" | "date" | "number" | "text";
  raw: string;
  /** Integer cents for money, ISO string for date, number for number. */
  normalised: number | string | null;
  /** Where the value came from. `typed` means the model asserted it directly. */
  source: "calculator" | "source" | "typed";
  sourceId?: string | null;
}

export interface DraftCitation {
  id: string;
  text: string;
  /** Reference into the recipe's permitted sources; null means unsourced. */
  sourceId: string | null;
  locator?: string | null;
}

export interface DraftClaim {
  id: string;
  text: string;
  sourceId: string | null;
  /** true when the sentence is presented as a suggestion, not a fact. */
  suggestion?: boolean;
}

export interface DraftSection {
  id: string;
  title: string;
  body: string;
}

export interface DraftTable {
  id: string;
  columns: string[];
  rows: Record<string, string | number | null>[];
}

/**
 * Domain blocks. A rule that needs a block fails closed when the block is absent:
 * "could not verify" is never "verified".
 */
export interface DraftDomain {
  /** unit tokens used anywhere in the artifact (must be canonical) */
  units?: string[];
  /** team handover / meeting packs */
  actions?: { id: string; owner: string | null; sourceId?: string | null }[];
  /** people ops */
  policyStatements?: { id: string; text: string; approvedTextId: string | null }[];
  employmentTerms?: { id: string; text: string; supplied: boolean }[];
  legalQuestions?: string[];
  /** grants / RFP */
  eligibility?: { id: string; text: string; sourceId: string | null; gap: boolean }[];
  limits?: { wordCount?: number | null; maxWords?: number | null; format?: string | null; requiredFormat?: string | null };
  /** bookkeeping */
  uncategorised?: number | null;
  taxAssertions?: string[];
  /** campaign / publishing */
  testimonialIds?: string[];
  suppliedPrices?: number[];
  publishingGate?: string | null;
  /** attendance */
  attendance?: { id: string; asserted: boolean; sourceId: string | null }[];
  /** privacy */
  names?: { id: string; value: string; sourceId: string | null }[];
  /** complaint resolution */
  refunds?: { id: string; amountCents: number; authorityId: string | null }[];
  dates?: { id: string; iso: string; sourceId: string | null }[];
  /** dispute paperwork */
  coverageClaims?: { id: string; text: string; sourceId: string | null }[];
  promisedOutcomes?: string[];
  filingActions?: string[];
  /** identifiers that must be masked before they reach a document */
  sensitiveIdentifiers?: { id: string; value: string }[];
}

export interface Draft {
  version: 1;
  recipeId?: string;
  sections?: DraftSection[];
  tables?: DraftTable[];
  citations?: DraftCitation[];
  values?: DraftValue[];
  claims?: DraftClaim[];
  domain?: DraftDomain;
  meta?: { generatedAt?: string; [k: string]: unknown };
}

/** A compiled rule: an expression tree over the Draft. */
export interface Rule {
  id: string;
  code: string;
  severity: Severity;
  /** Author-side only. Stripped from the sealed artifact. */
  description: string;
  expr: Expr;
}

export type Expr =
  | { op: "and"; args: Expr[] }
  | { op: "or"; args: Expr[] }
  | { op: "not"; arg: Expr }
  | { op: "eq"; path: string; value: Literal }
  | { op: "neq"; path: string; value: Literal }
  | { op: "in"; path: string; values: Literal[] }
  | { op: "lt" | "lte" | "gt" | "gte"; path: string; value: number }
  | { op: "starts"; path: string; value: string }
  | { op: "ends"; path: string; value: string }
  | { op: "has"; path: string; value: string }
  | { op: "truthy"; path: string }
  | { op: "falsy"; path: string }
  | { op: "empty"; path: string }
  | { op: "nonempty"; path: string }
  | { op: "matches"; path: string; pattern: string; flags?: string }
  | { op: "canonicalUnit"; path: string }
  | { op: "integer"; path: string }
  | { op: "ltePath"; a: string; b: string }
  | { op: "eqPath"; a: string; b: string }
  | { op: "allOf"; path: string; where?: Expr; check: Expr }
  | { op: "anyOf"; path: string; where?: Expr; check: Expr }
  | { op: "noneOf"; path: string; where?: Expr; check: Expr }
  | { op: "countGte"; path: string; n: number; where?: Expr };

export type Literal = string | number | boolean | null;

export interface EvaluationResult {
  ok: boolean;
  codes: string[];
  warnings: string[];
  ms: number;
  /** number of expression nodes visited — the fuel counter */
  nodes: number;
  budgetExceeded?: boolean;
}

export interface CompiledChecks {
  /** WebAssembly container carrying the folded rule program. */
  wasm: Uint8Array;
  /** Public code -> one-line description. Never contains a predicate. */
  codes: Record<string, string>;
  manifest: { sha256: string; rules: number; codes: string[]; engine: string };
}

export class BudgetExceededError extends Error {
  constructor() {
    super("check budget exceeded");
    this.name = "BudgetExceededError";
  }
}
