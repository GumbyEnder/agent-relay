/**
 * CR-9 — the rent roll: parse it, then say what it means in integers.
 *
 * The rent roll is where the memo's income comes from, so this module has one
 * rule above all others: **a missing value stays missing**. It never turns a
 * blank rent into zero, never guesses a lease end, and never infers that a row
 * is vacant because it could not parse it. Anything it cannot read becomes an
 * entry in `issues` with the suite and a code the runner can act on (ask the
 * user, or refuse the run) — it does not become a number.
 *
 * Vacancy is only ever set by the file saying so: tenant `VACANT` (any case) or
 * an explicit `vacant` flag column. A row with a rent of 0 and a tenant name is
 * a contradiction and is flagged, not silently treated as vacant — that is how
 * an occupied suite quietly leaves the income line.
 */

import type { Bp, Cents } from "./math";
import { assertInt, occupancyBp } from "./math";
import { missingColumns, parseCsvTable } from "./csv";

export interface RentRollRow {
  suite: string;
  tenant: string;
  sf: number;
  /** Contract base rent, cents per SF per year. 2800 = $28.00/SF/yr. */
  baseRentPerSfCents: Cents;
  /** Annual base rent for the suite, cents. 0 only when the suite is vacant. */
  annualRentCents: Cents;
  leaseStart: string | null;
  leaseEnd: string | null;
  leaseType: string;
  vacant: boolean;
}

export type RentRollIssueCode =
  | "duplicate_suite"
  | "zero_or_negative_sf"
  | "unreadable_sf"
  | "unreadable_rent"
  | "negative_rent"
  | "rented_without_lease_end"
  | "vacant_with_rent"
  | "vacant_with_lease"
  | "lease_end_before_start"
  | "unreadable_lease_date"
  | "csv_row_problem";

export interface RentRollIssue {
  suite: string;
  code: RentRollIssueCode;
  detail: string;
}

export interface ParsedRentRoll {
  rows: RentRollRow[];
  issues: RentRollIssue[];
}

const REQUIRED_COLUMNS = ["suite", "tenant", "sf", "base_rent_per_sf_yr"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isVacantTenant(tenant: string): boolean {
  return /^vacant\b/i.test(tenant.trim());
}

function parseNumber(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function parseRentRollCsv(text: string): ParsedRentRoll {
  const table = parseCsvTable(text);
  const missing = missingColumns(table.headers, REQUIRED_COLUMNS);
  if (missing) {
    throw new Error(`RENT_ROLL_HEADER missing ${missing.join(", ")}`);
  }

  const rows: RentRollRow[] = [];
  const issues: RentRollIssue[] = [];
  const seenSuites = new Set<string>();

  for (const raw of table.rows) {
    const suite = (raw.suite ?? "").trim();
    const tenant = (raw.tenant ?? "").trim();
    const vacant = isVacantTenant(tenant) || /^(true|yes|1)$/i.test((raw.vacant ?? "").trim());

    const sf = parseNumber(raw.sf ?? "");
    if (sf === null) {
      issues.push({ suite, code: "unreadable_sf", detail: `sf "${raw.sf ?? ""}" is not a number` });
      continue;
    }
    if (!Number.isInteger(sf) || sf <= 0) {
      issues.push({ suite, code: "zero_or_negative_sf", detail: `sf must be a whole number above zero, got ${raw.sf}` });
      continue;
    }
    if (seenSuites.has(suite)) {
      issues.push({ suite, code: "duplicate_suite", detail: "suite appears more than once" });
      continue;
    }
    seenSuites.add(suite);

    const rentRaw = raw.base_rent_per_sf_yr ?? "";
    const rentPerSf = parseNumber(rentRaw);
    if (rentPerSf === null && !vacant) {
      issues.push({ suite, code: "unreadable_rent", detail: `base rent "${rentRaw}" is not a number` });
      continue;
    }
    if (rentPerSf !== null && rentPerSf < 0) {
      issues.push({ suite, code: "negative_rent", detail: `base rent ${rentRaw} is negative` });
      continue;
    }
    const rentPerSfCents = Math.round((rentPerSf ?? 0) * 100);
    const annualRentCents = assertInt("annualRentCents", sf * rentPerSfCents);

    const leaseStart = (raw.lease_start ?? "").trim() || null;
    const leaseEnd = (raw.lease_end ?? "").trim() || null;
    for (const [label, value] of [["lease_start", leaseStart], ["lease_end", leaseEnd]] as const) {
      if (value && !ISO_DATE.test(value)) {
        issues.push({ suite, code: "unreadable_lease_date", detail: `${label} "${value}" is not YYYY-MM-DD` });
      }
    }
    if (leaseStart && leaseEnd && ISO_DATE.test(leaseStart) && ISO_DATE.test(leaseEnd) && leaseEnd < leaseStart) {
      issues.push({ suite, code: "lease_end_before_start", detail: `${leaseEnd} is before ${leaseStart}` });
    }
    if (vacant && annualRentCents > 0) {
      issues.push({ suite, code: "vacant_with_rent", detail: `marked VACANT but carries $${(annualRentCents / 100).toFixed(2)}/yr` });
    }
    if (vacant && (leaseStart || leaseEnd)) {
      issues.push({ suite, code: "vacant_with_lease", detail: "marked VACANT but has lease dates" });
    }
    if (!vacant && annualRentCents > 0 && !leaseEnd) {
      issues.push({ suite, code: "rented_without_lease_end", detail: "rented suite has no lease end date" });
    }

    rows.push({
      suite,
      tenant,
      sf,
      baseRentPerSfCents: rentPerSfCents,
      annualRentCents: vacant ? 0 : annualRentCents,
      leaseStart,
      leaseEnd,
      leaseType: (raw.lease_type ?? "").trim(),
      vacant,
    });
  }

  for (const p of table.problems) {
    issues.push({ suite: "", code: "csv_row_problem", detail: `line ${p.line}: ${p.reason}` });
  }

  return { rows, issues };
}

export interface RentRollSummaryInput {
  /** The date the analysis is as of (YYYY-MM-DD). Defaults to today, UTC. */
  asOf?: string;
  /** Loan term, years. Drives the rollover share inside the term. */
  termYears?: number;
  /** Issues found while parsing, echoed onto the summary for the Draft. */
  issues?: RentRollIssue[];
}

export interface LeaseExpiry {
  suite: string;
  tenant: string;
  leaseEnd: string;
  annualRentCents: Cents;
  sf: number;
}

export interface RentRollSummary {
  rowCount: number;
  totalSf: number;
  occupiedSf: number;
  vacantSf: number;
  occupancyBp: Bp;
  /** In-place annual base rent, cents. The income line's starting point. */
  annualBaseRentCents: Cents;
  vacantSuites: string[];
  /** Leases that end inside the loan term, soonest first. */
  rolloverInsideTerm: LeaseExpiry[];
  rolloverInsideTermCents: Cents;
  /** Share of in-place base rent that rolls inside the term, bp. 4286 = 42.86%. */
  rolloverInsideTermBp: Bp;
  /** Rent expiring by calendar year, cents. */
  expiriesByYear: Record<string, Cents>;
  /** Weighted average lease term from asOf, years x100. 261 = 2.61 years. */
  waltYearsX100: number;
  issues: RentRollIssue[];
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

function addYears(iso: string, years: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

function addMonths(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

export interface RolloverWindow {
  months: number;
  endDate: string;
  leases: LeaseExpiry[];
  cents: Cents;
  /** Share of in-place base rent, bp. */
  bp: Bp;
}

/**
 * Rent expiring inside the next `months` months. This is the concentration
 * figure a credit committee asks about ("what rolls in the first 24/36
 * months?"), and it is separate from rolloverInsideTerm on purpose: with a
 * 10-year loan term on a strip centre, *every* lease usually rolls inside the
 * term, so the term figure alone says nothing. The near-term window is the
 * number that finds the deal-killer.
 */
export function rolloverWithinMonths(
  rows: RentRollRow[],
  asOf: string,
  months: number,
): RolloverWindow {
  if (!ISO_DATE.test(asOf)) throw new RangeError(`asOf must be YYYY-MM-DD, got ${asOf}`);
  assertInt("months", months);
  const endDate = addMonths(asOf, months);
  const leases: LeaseExpiry[] = rows
    .filter((r) => !r.vacant && r.leaseEnd !== null && ISO_DATE.test(r.leaseEnd))
    .filter((r) => (r.leaseEnd as string) > asOf && (r.leaseEnd as string) <= endDate)
    .map((r) => ({
      suite: r.suite,
      tenant: r.tenant,
      leaseEnd: r.leaseEnd as string,
      annualRentCents: r.annualRentCents,
      sf: r.sf,
    }))
    .sort((a, b) => a.leaseEnd.localeCompare(b.leaseEnd) || a.suite.localeCompare(b.suite));
  const cents = leases.reduce((sum, l) => sum + l.annualRentCents, 0);
  const total = rows.reduce((sum, r) => sum + (r.vacant ? 0 : r.annualRentCents), 0);
  return {
    months,
    endDate,
    leases,
    cents: assertInt("cents", cents),
    bp: total > 0 ? Math.round((cents * 10000) / total) : 0,
  };
}

export function summariseRentRoll(rows: RentRollRow[], input: RentRollSummaryInput = {}): RentRollSummary {
  const asOf = input.asOf ?? new Date().toISOString().slice(0, 10);
  if (!ISO_DATE.test(asOf)) throw new RangeError(`asOf must be YYYY-MM-DD, got ${asOf}`);
  const termYears = input.termYears ?? 10;
  assertInt("termYears", termYears);
  const termEnd = addYears(asOf, termYears);

  let totalSf = 0;
  let occupiedSf = 0;
  let vacantSf = 0;
  let annualBaseRentCents = 0;
  const vacantSuites: string[] = [];
  const rolloverInsideTerm: LeaseExpiry[] = [];
  const expiriesByYear: Record<string, Cents> = {};
  let weightedDays = 0;

  for (const row of rows) {
    totalSf += row.sf;
    if (row.vacant) {
      vacantSf += row.sf;
      vacantSuites.push(row.suite);
      continue;
    }
    occupiedSf += row.sf;
    annualBaseRentCents += row.annualRentCents;
    if (!row.leaseEnd || !ISO_DATE.test(row.leaseEnd)) continue;
    const year = row.leaseEnd.slice(0, 4);
    expiriesByYear[year] = (expiriesByYear[year] ?? 0) + row.annualRentCents;
    weightedDays += row.annualRentCents * daysBetween(asOf, row.leaseEnd);
    if (row.leaseEnd <= termEnd) {
      rolloverInsideTerm.push({
        suite: row.suite,
        tenant: row.tenant,
        leaseEnd: row.leaseEnd,
        annualRentCents: row.annualRentCents,
        sf: row.sf,
      });
    }
  }

  rolloverInsideTerm.sort((a, b) => a.leaseEnd.localeCompare(b.leaseEnd) || a.suite.localeCompare(b.suite));
  const rolloverInsideTermCents = rolloverInsideTerm.reduce((sum, l) => sum + l.annualRentCents, 0);
  const rolloverInsideTermBp =
    annualBaseRentCents > 0 ? Math.round((rolloverInsideTermCents * 10000) / annualBaseRentCents) : 0;
  const waltYearsX100 =
    annualBaseRentCents > 0 ? Math.round((weightedDays / annualBaseRentCents / 365.25) * 100) : 0;

  return {
    rowCount: rows.length,
    totalSf,
    occupiedSf,
    vacantSf,
    occupancyBp: totalSf > 0 ? occupancyBp(occupiedSf, totalSf) : 0,
    annualBaseRentCents: assertInt("annualBaseRentCents", annualBaseRentCents),
    vacantSuites,
    rolloverInsideTerm,
    rolloverInsideTermCents: assertInt("rolloverInsideTermCents", rolloverInsideTermCents),
    rolloverInsideTermBp,
    expiriesByYear,
    waltYearsX100,
    issues: input.issues ?? [],
  };
}
