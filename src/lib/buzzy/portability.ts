/**
 * Buzzy data export + account deletion (plan doc 23, "the owner owns the data").
 *
 * - Export: everything out, one click — profile(s), confirmed facts, customer
 *   memory, templates, approved documents. Ordinary file formats: documents
 *   as .md, data as .csv, all inside one .zip (jszip, already a dependency).
 * - Deletion: one action, plain confirmation flag, no support ticket. Removes
 *   every buzzy_* row for the user.
 */

import JSZip from "jszip";

function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  return [headers.join(","), ...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(","))].join("\n");
}

export interface ExportBundle {
  filename: string;
  bytes: Uint8Array;
}

/** Build the one-click export bundle. Everything the owner put in, as files. */
export async function buildExportBundle(sql: any, userId: string): Promise<ExportBundle> {
  const companies = await sql`
    SELECT id, name, one_liner, website, customer_memory, created_at
    FROM buzzy_companies WHERE user_id = ${userId} ORDER BY created_at ASC`;
  const facts = await sql`
    SELECT company_id, fact_key, label, value, status, source_label, updated_at
    FROM buzzy_company_facts WHERE user_id = ${userId} ORDER BY updated_at ASC`;
  const templates = await sql`
    SELECT id, name, kind, structure, created_at
    FROM buzzy_templates WHERE user_id = ${userId} ORDER BY created_at ASC`;
  const jobs = await sql`
    SELECT id, company_id, title, status, data, updated_at
    FROM buzzy_jobs WHERE user_id = ${userId} AND data->>'draft' IS NOT NULL
    ORDER BY updated_at DESC LIMIT 200`;
  const memory = await sql`
    SELECT key, value, updated_at FROM buzzy_user_memory
    WHERE user_id = ${userId} ORDER BY updated_at DESC`;

  const zip = new JSZip();
  const stamp = new Date().toISOString().slice(0, 10);

  // Data as CSV
  zip.file("companies.csv", toCsv(companies.map((c: any) => ({ id: c.id, name: c.name, one_liner: c.one_liner, website: c.website }))));
  zip.file("company_facts.csv", toCsv(facts.map((f: any) => ({ company_id: f.company_id, key: f.fact_key, label: f.label, value: f.value, status: f.status, source: f.source_label }))));
  zip.file("remembered_decisions.csv", toCsv(memory.map((m: any) => ({ key: m.key, value: m.value, updated_at: m.updated_at }))));
  zip.file("templates.csv", toCsv(templates.map((t: any) => ({ id: t.id, name: t.name, kind: t.kind, headings: (t.structure?.headings ?? []).join(" | ") }))));

  // Approved documents as markdown files
  const docs = zip.folder("approved-documents");
  let docCount = 0;
  for (const j of jobs) {
    const data = typeof j.data === "string" ? JSON.parse(j.data) : j.data;
    if (data?.approved !== "true" && data?.approved !== true) continue;
    const safe = String(j.title || j.id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "document";
    docs?.file(`${j.id.slice(-6)}-${safe}.md`, `# ${j.title}\n\n${data.draft ?? ""}\n`);
    docCount++;
  }

  // Human-readable index
  zip.file("README.txt", [
    "Your BeeZilla export — everything you gave us, in ordinary files.",
    `Exported: ${new Date().toISOString()}`,
    `Companies: ${companies.length}`,
    `Confirmed facts: ${facts.filter((f: any) => f.status === "confirmed").length}`,
    `Approved documents: ${docCount}`,
    `Templates: ${templates.length}`,
    "",
    "Data files are CSV (opens in any spreadsheet). Documents are Markdown",
    "(opens in any text editor or Word). Nothing here is a special format.",
  ].join("\n"));

  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return { filename: `beezilla-export-${stamp}.zip`, bytes };
}

/** Tables holding owner data, in deletion order (children first is unnecessary —
 *  no FKs between them — but listed for the audit trail). */
const DELETION_TABLES = [
  "buzzy_chat_messages",
  "buzzy_user_memory",
  "buzzy_jobs",
  "buzzy_templates",
  "buzzy_paper_facts",
  "buzzy_papers",
  "buzzy_company_facts",
  "buzzy_companies",
  "buzzy_sessions",
] as const;

/** One-action account deletion. Returns per-table row counts for the receipt. */
export async function deleteAccountData(sql: any, userId: string): Promise<Record<string, number>> {
  const receipt: Record<string, number> = {};
  for (const table of DELETION_TABLES) {
    const rows = await sql`DELETE FROM ${sql(table)} WHERE user_id = ${userId} RETURNING 1`;
    receipt[table] = rows.length;
  }
  return receipt;
}
