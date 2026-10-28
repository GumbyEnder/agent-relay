/**
 * Company context for the chat turn.
 *
 * Extracted from `chat.nitro.ts` so the orchestrator can be lifted out of the
 * Nitro handler without importing it (that would be a cycle). Pure data access
 * over `buzzy_companies` / `buzzy_company_facts` — no transport, no auth.
 */
import type { Sql } from "../db";
import type { MoneyBriefLine } from "./money";

export function isCompanyId(id: string): boolean {
  return /^co_[a-z0-9]{8,32}$/.test(id);
}

export function asMoneyBrief(raw: unknown): MoneyBriefLine[] {
  if (!Array.isArray(raw)) return [];
  const out: MoneyBriefLine[] = [];
  for (const row of raw.slice(0, 12)) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const status = rec.status === "confirmed" || rec.status === "skipped" || rec.status === "open" || rec.status === "proposed"
      ? rec.status
      : "open";
    out.push({
      label: typeof rec.label === "string" ? rec.label.slice(0, 80) : "",
      value: typeof rec.value === "string" ? rec.value.slice(0, 500) : "",
      status,
    });
  }
  return out;
}

export function companyName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().replace(/\s+/g, " ").slice(0, 80);
  return name || null;
}

export type CompanyRow = {
  id: string;
  name: string;
  one_liner: string;
  website: string;
  created_at: string;
  updated_at: string;
};

export type FactRow = {
  id: string;
  company_id: string;
  fact_key: string;
  label: string;
  value: string;
  status: string;
  source_label: string;
  source_page: string;
  original_value: string;
};

export const FACT_ORDER = ["name", "does", "serves", "locations", "voice"];

export function linePayload(row: FactRow) {
  return {
    id: row.id,
    key: row.fact_key,
    label: row.label,
    value: row.value,
    status: row.status,
    source: row.source_label,
    page: row.source_page,
    edited: row.original_value !== "" && row.value !== row.original_value,
  };
}

export function companyPayload(row: CompanyRow, facts: FactRow[] = []) {
  const lines = facts
    .filter((f) => f.company_id === row.id && f.status !== "dropped")
    .sort((a, b) => FACT_ORDER.indexOf(a.fact_key) - FACT_ORDER.indexOf(b.fact_key))
    .map(linePayload);
  return {
    id: row.id,
    name: row.name,
    oneLiner: row.one_liner || "",
    website: row.website || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines,
    facts: lines.filter((l) => l.status === "confirmed"),
  };
}

export function factValue(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 280);
  return v || null;
}

export async function confirmedCompanyContext(
  sql: Sql,
  userId: string,
  companyId: string,
): Promise<{ name: string; facts: Array<{ label: string; value: string }> } | null> {
  if (!isCompanyId(companyId)) return null;
  const rows = await sql<CompanyRow>`
    SELECT id, name, one_liner, website, created_at, updated_at
    FROM buzzy_companies
    WHERE id = ${companyId} AND user_id = ${userId}
    LIMIT 1
  `;
  if (!rows.length) return null;
  const facts = await sql<FactRow>`
    SELECT id, company_id, fact_key, label, value, status, source_label, source_page, original_value
    FROM buzzy_company_facts
    WHERE user_id = ${userId} AND company_id = ${companyId} AND status = 'confirmed'
    ORDER BY created_at ASC
    LIMIT 20
  `;
  return {
    name: rows[0].name,
    facts: facts
      .filter((f) => typeof f.value === "string" && f.value.trim())
      .map((f) => ({ label: f.label || f.fact_key, value: f.value })),
  };
}

export async function companyFacts(sql: Sql, userId: string, companyId?: string): Promise<FactRow[]> {
  return companyId
    ? await sql<FactRow>`
        SELECT id, company_id, fact_key, label, value, status, source_label, source_page, original_value
        FROM buzzy_company_facts
        WHERE user_id = ${userId} AND company_id = ${companyId} AND status <> 'dropped'
        ORDER BY created_at ASC
        LIMIT 20
      `
    : await sql<FactRow>`
        SELECT id, company_id, fact_key, label, value, status, source_label, source_page, original_value
        FROM buzzy_company_facts
        WHERE user_id = ${userId} AND status <> 'dropped'
        ORDER BY created_at ASC
        LIMIT 250
      `;
}
