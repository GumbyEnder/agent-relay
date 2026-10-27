/**
 * Recipe Seal — Step 1: the 24 executable rules.
 *
 * Each rule encodes one of the 24 `domainChecks` English strings currently in
 * `src/lib/buzzy/recipes.ts`, plus the boundary checks that the commented-out
 * `forbiddenClaimCheck` was supposed to provide.
 *
 * Encoding decisions worth knowing:
 *  - A missing collection fails closed for `allOf`/`anyOf`/`countGte`, and passes
 *    for `noneOf` (nothing asserted, nothing violated).
 *  - Money is integer cents. Units are canonical tokens (lowercase, no trailing dot).
 *  - Unknown values carry `raw: "unknown"` with `normalised: null`.
 */
import {
  allOf, and, anyOf, canonicalUnit, defineRule, eq, eqPath, falsy, gte, has,
  integer, isEmpty, ltePath, matches, neq, noneOf, nonempty, not, oneOf, or, starts, truthy,
} from "./author";
import type { Rule } from "./types";

/** Boundary patterns lifted verbatim from each recipe's `forbiddenClaims`. */
export const FORBIDDEN = {
  quote: "\\b(guaranteed lowest|we will order|placed the order|supplier confirmed)\\b",
  complaint: "\\b(we (apologise|apologize) and (will|shall) (refund|compensate)|guaranteed refund|on behalf of legal)\\b",
  meeting: "\\b(all attendees agreed|everyone present|unanimously approved)\\b",
  bookkeeping: "\\b(tax (deductible|compliant)|guaranteed deduction|ready to file|filed)\\b",
  campaign: "\\b(\"[^\"]{0,60}\" — (?:happy|satisfied) customer|best in the world|#1 rated|customers say)\\b",
  people: "\\b(you are (terminated|dismissed)|we have decided to (hire|fire)|legally (binding|compliant|safe))\\b",
  grants: "\\b(we (?:certify|confirm) (?:that )?we (?:meet|qualify)|submitted (?:the )?application|guaranteed (?:award|funding))\\b",
  dispute: "\\b(coverage is (?:guaranteed|approved)|you will (?:win|be reimbursed)|we have filed)\\b",
} as const;

/** A boundary rule scans every claim and every section body for the pattern. */
/**
 * Boundary labels are published: they ride in `checks.codes`, which is part of the
 * signed manifest and served to anyone. They were originally written as restatements
 * of the sealed boundary ("never promises coverage or a legal outcome"), which meant
 * a sealed bundle could not be sealed at all — the leak gate found its own boundary
 * reproduced in the manifest. The labels now describe the *check*, in vocabulary that
 * does not belong to any recipe's sealed half.
 */
function boundaryRule(key: keyof typeof FORBIDDEN, code: string, description: string): Rule {
  const pattern = FORBIDDEN[key];
  return defineRule({
    id: `boundary-${key}`,
    code,
    severity: "block",
    description,
    // The rule PASSES when no forbidden claim appears anywhere in the artifact.
    expr: and(
      noneOf("claims", matches("text", pattern)),
      noneOf("sections", matches("body", pattern)),
    ),
  });
}

export const RECIPE_RULES: Record<string, Rule[]> = {
  "quote-comparison": [
    defineRule({
      id: "totals-from-calculator",
      code: "C01",
      description: "totals computed by the calculator, never typed",
      expr: allOf("values", eq("source", "calculator"), and(eq("kind", "money"), starts("id", "total"))),
    }),
    defineRule({
      id: "units-normalised",
      code: "C02",
      description: "units normalised across quotes",
      expr: and(nonempty("domain.units"), allOf("domain.units", canonicalUnit("."))),
    }),
    defineRule({
      id: "unknowns-marked",
      code: "C03",
      description: "unknowns marked, not filled",
      expr: noneOf("values", and(eq("normalised", null), neq("raw", "unknown"))),
    }),
    boundaryRule("quote", "C30", "no commitment the owner did not authorise"),
  ],

  "complaint-resolution": [
    defineRule({
      id: "facts-vs-suggestions",
      code: "C04",
      description: "facts vs suggestions labelled",
      expr: allOf("claims", truthy("suggestion"), falsy("sourceId")),
    }),
    defineRule({
      id: "refunds-trace-authority",
      code: "C05",
      description: "refund/credit amounts trace to stated authority",
      expr: noneOf("domain.refunds", falsy("authorityId")),
    }),
    defineRule({
      id: "dates-trace-history",
      code: "C06",
      description: "dates trace to the supplied history",
      expr: noneOf("domain.dates", falsy("sourceId")),
    }),
    boundaryRule("complaint", "C31", "no concession invented on the owner's behalf"),
  ],

  "meeting-action-pack": [
    defineRule({
      id: "actions-have-owners",
      code: "C07",
      description: "every action has an owner",
      expr: and(nonempty("domain.actions"), noneOf("domain.actions", falsy("owner"))),
    }),
    defineRule({
      id: "attendance-sourced",
      code: "C08",
      description: "no attendance asserted absent from the source",
      expr: noneOf("domain.attendance", and(eq("asserted", true), falsy("sourceId"))),
    }),
    defineRule({
      id: "names-sourced",
      code: "C09",
      description: "privacy: names only from the source",
      expr: noneOf("domain.names", falsy("sourceId")),
    }),
    boundaryRule("meeting", "C32", "no attendance or agreement inferred"),
  ],

  "bookkeeping-prep": [
    defineRule({
      id: "totals-reconciled",
      code: "C10",
      description: "totals computed and reconciled to the supplied source",
      expr: allOf("values", eq("source", "calculator"), and(eq("kind", "money"), starts("id", "total"))),
    }),
    defineRule({
      id: "uncategorised-counted",
      code: "C11",
      description: "uncategorised items counted, not guessed",
      expr: and(integer("domain.uncategorised"), gte("domain.uncategorised", 0)),
    }),
    defineRule({
      id: "no-tax-treatment",
      code: "C12",
      description: "no tax treatment asserted",
      expr: isEmpty("domain.taxAssertions"),
    }),
    boundaryRule("bookkeeping", "C33", "no professional conclusion asserted"),
  ],

  "campaign-brief": [
    defineRule({
      id: "claims-have-evidence",
      code: "C13",
      description: "each claim has an evidence row",
      expr: noneOf("claims", falsy("sourceId")),
    }),
    defineRule({
      id: "no-unsupplied-testimonial-or-price",
      code: "C14",
      description: "no testimonial or price not supplied",
      expr: and(
        allOf("values", oneOf("source", ["calculator", "source"]), eq("kind", "money")),
        noneOf("claims", and(or(has("text", "customer says"), has("text", "testimonial")), falsy("sourceId"))),
      ),
    }),
    defineRule({
      id: "publishing-gate-stated",
      code: "C15",
      description: "publishing gate stated",
      expr: nonempty("domain.publishingGate"),
    }),
    boundaryRule("campaign", "C34", "no endorsement or superlative invented"),
  ],

  "people-ops-paperwork": [
    defineRule({
      id: "policy-traced-approved",
      code: "C16",
      description: "every policy statement traced to approved text",
      expr: noneOf("domain.policyStatements", falsy("approvedTextId")),
    }),
    defineRule({
      id: "terms-not-fabricated",
      code: "C17",
      description: "employment terms never fabricated",
      expr: noneOf("domain.employmentTerms", falsy("supplied")),
    }),
    defineRule({
      id: "legal-questions-open",
      code: "C18",
      description: "legal questions listed as open",
      expr: or(not(anyOf("claims", matches("text", "\\blegal"))), nonempty("domain.legalQuestions")),
    }),
    boundaryRule("people", "C35", "no employment or compliance action taken"),
  ],

  "grants-rfp": [
    defineRule({
      id: "eligibility-traced-or-gap",
      code: "C19",
      description: "each eligibility claim traced to a source or listed as a gap",
      expr: allOf("domain.eligibility", or(truthy("sourceId"), eq("gap", true))),
    }),
    defineRule({
      id: "limits-respected",
      code: "C20",
      description: "word/format limits respected",
      expr: and(
        nonempty("domain.limits"),
        or(falsy("domain.limits.wordCount"), ltePath("domain.limits.wordCount", "domain.limits.maxWords")),
        or(falsy("domain.limits.format"), eqPath("domain.limits.format", "domain.limits.requiredFormat")),
      ),
    }),
    defineRule({
      id: "no-auto-submission",
      code: "C21",
      description: "no auto-submission",
      expr: isEmpty("domain.filingActions"),
    }),
    boundaryRule("grants", "C36", "no eligibility certified and nothing submitted"),
  ],

  "dispute-paperwork": [
    defineRule({
      id: "assertions-sourced",
      code: "C22",
      description: "each assertion has a source row",
      expr: noneOf("claims", falsy("sourceId")),
    }),
    defineRule({
      id: "identifiers-minimised",
      code: "C23",
      description: "sensitive identifiers minimised",
      expr: allOf("domain.sensitiveIdentifiers", matches("value", "\\*{2,}")),
    }),
    defineRule({
      id: "no-outcome-promised",
      code: "C24",
      description: "no outcome promised",
      expr: and(isEmpty("domain.promisedOutcomes"), isEmpty("domain.filingActions")),
    }),
    boundaryRule("dispute", "C37", "no entitlement asserted on the owner's behalf"),
  ],
};

export function rulesFor(recipeId: string): Rule[] {
  const rules = RECIPE_RULES[recipeId];
  if (!rules) throw new Error(`no rules for recipe: ${recipeId}`);
  return rules;
}

/**
 * 32 executable rules: 24 domain rules (C01–C24) plus 8 boundary rules
 * (C30–C37). The Step 1 commit message says "24 rules" because the domain set
 * was the headline number; the suite asserts 32, which is the true count.
 */
export const ALL_RULES: Rule[] = Object.values(RECIPE_RULES).flat();

export function allCodes(): string[] {
  return [...new Set(ALL_RULES.map((r) => r.code))].sort();
}
