/**
 * CR-9 — comparable sales: keep them, exclude them, and say why.
 *
 * Two rules govern this file and both come from the spec's failure list:
 *
 *   1. Every exclusion carries a reason code. A comp that disappears without
 *      one is check C27's failure, and in practice it is how a memo quietly
 *      lands on a value the evidence does not support.
 *   2. Nothing is invented. If fewer than `minKeptComps` survive, the indicated
 *      value is `null` with a note — never an average of whatever is left. An
 *      average of two unrelated sales is a number with a source, which is worse
 *      than no number at all.
 *
 * Rule order is the spec's (§6 step 6): age, size band, property type,
 * transaction type, outlier. Source presence is a precondition, checked first:
 * a row with no deed, no report and no sheet cannot be a comparable.
 *
 * The radius rule (comp_rules.radius_miles) is accepted in the rule set but NOT
 * applied, because the v1 comps file has no coordinates. That is reported in
 * `notes` on every result rather than silently skipped — a rule the author
 * thinks is running and is not is worse than one that isn't there.
 */

import type { Bp, Cents } from "./math";
import { assertInt, capRateBp } from "./math";
import { missingColumns, parseCsvTable } from "./csv";

export interface Comp {
  compId: string;
  name: string;
  /** ISO YYYY-MM-DD. */
  saleDate: string;
  priceCents: Cents;
  buildingSf: number;
  propertyType: string;
  transactionType: string;
  source: string;
}

export type CompExclusionReason =
  | "missing_source"
  | "missing_price_or_sf"
  | "transaction_type"
  | "older_than_max_age"
  | "different_property_type"
  | "outside_size_band"
  | "outlier";

export interface EvaluatedComp extends Comp {
  pricePerSfCents: Cents;
  excluded: boolean;
  /** The decisive reason, printed in the memo's comps table. */
  exclusionReason: CompExclusionReason | null;
  /** Every rule the comp failed, in the spec's rule order. */
  exclusionReasons: CompExclusionReason[];
  /** The decisive reason in words. */
  exclusionDetail: string | null;
}

export interface CompRules {
  maxAgeMonths: number;
  /** Accepted but not applied in v1 — see the note at the top of this file. */
  radiusMiles: number | null;
  sizeBandPct: number;
  samePropertyTypeRequired: boolean;
  minKeptComps: number;
  excludeTransactionTypes: string[];
  /** null = no outlier rule. Single pass, no cascade. */
  outlierRule: { maxDeviationPct: number } | null;
}

export interface CompsSubject {
  buildingSf: number;
  propertyType: string;
  /** ISO date the age rule is measured from, normally the analysis date. */
  asOf: string;
}

export interface CompsResult {
  comps: EvaluatedComp[];
  kept: EvaluatedComp[];
  excluded: EvaluatedComp[];
  keptCount: number;
  minKeptComps: number;
  minKeptMet: boolean;
  /** Mean of kept $/SF, cents. null when nothing kept. */
  avgPricePerSfCents: Cents | null;
  medianPricePerSfCents: Cents | null;
  rangePricePerSfCents: [Cents, Cents] | null;
  /** avg $/SF x subject SF. null when minKeptMet is false — never invented. */
  indicatedValueCents: Cents | null;
  /** Implied cap rate on the indicated value at the supplied NOI, bp. */
  indicatedCapRateBp: Bp | null;
  notes: string[];
}

const REQUIRED_COLUMNS = [
  "comp_id",
  "name",
  "sale_date",
  "price_usd",
  "building_sf",
  "property_type",
  "transaction_type",
  "source",
];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function normalise(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function parseNumber(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export interface ParsedComps {
  comps: Comp[];
  rejected: { compId: string; reason: CompExclusionReason; detail: string }[];
}

export function parseCompsCsv(text: string): ParsedComps {
  const table = parseCsvTable(text);
  const missing = missingColumns(table.headers, REQUIRED_COLUMNS);
  if (missing) throw new Error(`COMPS_HEADER missing ${missing.join(", ")}`);

  const comps: Comp[] = [];
  const rejected: ParsedComps["rejected"] = [];

  table.rows.forEach((raw, index) => {
    const compId = (raw.comp_id ?? "").trim() || `row-${index + 2}`;
    const price = parseNumber(raw.price_usd ?? "");
    const sf = parseNumber(raw.building_sf ?? "");
    if (price === null || sf === null || price <= 0 || !Number.isInteger(sf) || sf <= 0) {
      rejected.push({ compId, reason: "missing_price_or_sf", detail: `price_usd "${raw.price_usd ?? ""}", building_sf "${raw.building_sf ?? ""}"` });
      return;
    }
    const saleDate = (raw.sale_date ?? "").trim();
    if (!ISO_DATE.test(saleDate)) {
      rejected.push({ compId, reason: "missing_price_or_sf", detail: `sale_date "${saleDate}" is not YYYY-MM-DD` });
      return;
    }
    comps.push({
      compId,
      name: (raw.name ?? "").trim(),
      saleDate,
      priceCents: Math.round(price * 100),
      buildingSf: sf,
      propertyType: (raw.property_type ?? "").trim(),
      transactionType: (raw.transaction_type ?? "").trim(),
      source: (raw.source ?? "").trim(),
    });
  });

  return { comps, rejected };
}

function monthsBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Math.abs(to - from) / 86_400_000 / 30.4375;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface EvaluateCompsInput {
  comps: Comp[];
  rules: CompRules;
  subject: CompsSubject;
  /** NOI, cents — only to report the implied cap rate on the indicated value. */
  noiCents?: Cents;
}

export function evaluateComps(input: EvaluateCompsInput): CompsResult {
  const { comps, rules, subject } = input;
  assertInt("subject.buildingSf", subject.buildingSf);
  if (subject.buildingSf <= 0) throw new RangeError("subject building SF must be greater than zero");
  if (!ISO_DATE.test(subject.asOf)) throw new RangeError(`asOf must be YYYY-MM-DD, got ${subject.asOf}`);
  assertInt("maxAgeMonths", rules.maxAgeMonths);
  assertInt("minKeptComps", rules.minKeptComps);

  const excludedTypes = new Set(rules.excludeTransactionTypes.map(normalise));
  const subjectType = normalise(subject.propertyType);
  const bandPct = rules.sizeBandPct;

  // Precedence for the reason the memo prints. Spec order decides WHICH rules
  // run and in what order they are listed, but a structural fact about a sale
  // outranks a geometric one: a 41,000 SF portfolio sale is not reported as
  // "the wrong size", because no size band makes a portfolio sale comparable.
  const SPECIFICITY: CompExclusionReason[] = [
    "transaction_type",
    "different_property_type",
    "older_than_max_age",
    "outside_size_band",
    "outlier",
    "missing_source",
    "missing_price_or_sf",
  ];

  function decide(failures: { reason: CompExclusionReason; detail: string }[]): {
    excluded: boolean;
    exclusionReason: CompExclusionReason | null;
    exclusionReasons: CompExclusionReason[];
    exclusionDetail: string | null;
  } {
    if (!failures.length) {
      return { excluded: false, exclusionReason: null, exclusionReasons: [], exclusionDetail: null };
    }
    const primary = SPECIFICITY.find((r) => failures.some((f) => f.reason === r)) ?? failures[0].reason;
    const detail = failures.find((f) => f.reason === primary)?.detail ?? failures[0].detail;
    return {
      excluded: true,
      exclusionReason: primary,
      exclusionReasons: failures.map((f) => f.reason),
      exclusionDetail: detail,
    };
  }

  const evaluated: EvaluatedComp[] = comps.map((comp) => {
    const pricePerSfCents = Math.round(comp.priceCents / comp.buildingSf);
    const failures: { reason: CompExclusionReason; detail: string }[] = [];

    // Precondition: a comp with no source cannot be cited, so it cannot count.
    if (!comp.source) failures.push({ reason: "missing_source", detail: "no deed, report or sheet is cited" });

    // 1. Age.
    const ageMonths = monthsBetween(comp.saleDate, subject.asOf);
    if (ageMonths > rules.maxAgeMonths) {
      failures.push({
        reason: "older_than_max_age",
        detail: `sold ${comp.saleDate}, ${ageMonths.toFixed(1)} months before ${subject.asOf} (rule: ${rules.maxAgeMonths})`,
      });
    }

    // 2. Size band.
    if (bandPct > 0) {
      const deviationPct = (Math.abs(comp.buildingSf - subject.buildingSf) / subject.buildingSf) * 100;
      if (deviationPct > bandPct) {
        failures.push({
          reason: "outside_size_band",
          detail: `${comp.buildingSf} SF vs subject ${subject.buildingSf} SF (${deviationPct.toFixed(1)}% away, rule: ±${bandPct}%)`,
        });
      }
    }

    // 3. Property type.
    if (rules.samePropertyTypeRequired && normalise(comp.propertyType) !== subjectType) {
      failures.push({ reason: "different_property_type", detail: `${comp.propertyType} vs subject ${subject.propertyType}` });
    }

    // 4. Transaction type.
    if (excludedTypes.has(normalise(comp.transactionType))) {
      failures.push({ reason: "transaction_type", detail: `${comp.transactionType} is in the excluded list` });
    }

    return { ...comp, pricePerSfCents, ...decide(failures) };
  });

  const notes: string[] = [];
  if (rules.radiusMiles !== null) {
    notes.push("radius rule not applied: the comps file has no coordinates in v1");
  }

  // 5. Outlier: one pass against the median of the survivors, no cascade.
  let surviving = evaluated.filter((c) => !c.excluded);
  if (rules.outlierRule && surviving.length >= 3) {
    const med = median(surviving.map((c) => c.pricePerSfCents));
    if (med !== null && med > 0) {
      const maxDev = rules.outlierRule.maxDeviationPct;
      for (const comp of surviving) {
        const deviation = (Math.abs(comp.pricePerSfCents - med) / med) * 100;
        if (deviation > maxDev) {
          comp.excluded = true;
          comp.exclusionReason = "outlier";
          comp.exclusionReasons = [...comp.exclusionReasons, "outlier"];
          comp.exclusionDetail = `$${(comp.pricePerSfCents / 100).toFixed(2)}/SF is ${deviation.toFixed(1)}% from the median $${(med / 100).toFixed(2)}/SF (rule: ${maxDev}%)`;
        }
      }
      surviving = evaluated.filter((c) => !c.excluded);
    }
  }

  const kept = surviving;
  const excluded = evaluated.filter((c) => c.excluded);
  const minKeptMet = kept.length >= rules.minKeptComps;

  const pricePerSf = kept.map((c) => c.pricePerSfCents);
  const exactMean =
    kept.length > 0
      ? kept.reduce((sum, c) => sum + c.priceCents / c.buildingSf, 0) / kept.length
      : null;
  const avgPricePerSfCents = exactMean === null ? null : Math.round(exactMean);
  const med = median(pricePerSf);
  const indicatedValueCents =
    exactMean === null || !minKeptMet ? null : Math.round(exactMean * subject.buildingSf);

  if (!minKeptMet) {
    notes.push(
      `only ${kept.length} of ${comps.length} comps kept (rule: at least ${rules.minKeptComps}); no indicated value`,
    );
  }
  if (excluded.length > 0 && kept.length === 0) {
    notes.push("no comparable sales survived the rules; the memo must say so");
  }

  const indicatedCapRateBp =
    indicatedValueCents !== null && input.noiCents !== undefined
      ? capRateBp(input.noiCents, indicatedValueCents)
      : null;

  return {
    comps: evaluated,
    kept,
    excluded,
    keptCount: kept.length,
    minKeptComps: rules.minKeptComps,
    minKeptMet,
    avgPricePerSfCents,
    medianPricePerSfCents: med === null ? null : Math.round(med),
    rangePricePerSfCents: pricePerSf.length
      ? [Math.min(...pricePerSf), Math.max(...pricePerSf)]
      : null,
    indicatedValueCents,
    indicatedCapRateBp,
    notes,
  };
}
