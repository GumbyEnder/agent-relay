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
  // The 3D models they asked for (0072): the words or picture each was made from — a
  // prompt sent straight to the 3D maker has no conversation of its own to export.
  let models3d: any[] = [];
  try {
    models3d = await sql`
      SELECT meshy_id, kind, purpose, prompt, texture_prompt, picture_id, parent_id, created_at
      FROM buzzy_model3d_jobs WHERE user_id = ${userId} ORDER BY created_at ASC`;
  } catch { /* an older schema: nothing to export */ }

  const zip = new JSZip();
  const stamp = new Date().toISOString().slice(0, 10);

  // Data as CSV
  zip.file("companies.csv", toCsv(companies.map((c: any) => ({ id: c.id, name: c.name, one_liner: c.one_liner, website: c.website }))));
  zip.file("company_facts.csv", toCsv(facts.map((f: any) => ({ company_id: f.company_id, key: f.fact_key, label: f.label, value: f.value, status: f.status, source: f.source_label }))));
  zip.file("remembered_decisions.csv", toCsv(memory.map((m: any) => ({ key: m.key, value: m.value, updated_at: m.updated_at }))));
  zip.file("templates.csv", toCsv(templates.map((t: any) => ({ id: t.id, name: t.name, kind: t.kind, headings: (t.structure?.headings ?? []).join(" | ") }))));
  // A step names its parent the way the parent's own row is named ("txt.…", "ref.…").
  const jobName = new Map<string, string>(models3d.map((m: any) => [String(m.meshy_id), `${m.kind}.${m.meshy_id}`]));
  zip.file("3d_models.csv", toCsv(models3d.map((m: any) => ({
    job: `${m.kind}.${m.meshy_id}`,
    step_of: m.parent_id ? (jobName.get(String(m.parent_id)) ?? String(m.parent_id)) : "",
    made_from: m.picture_id ? `picture ${m.picture_id}` : "words",
    purpose: m.purpose, prompt: m.prompt, look_asked_for: m.texture_prompt ?? "", created_at: m.created_at,
  }))));

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
    `3D model steps: ${models3d.length}`,
    "",
    "Data files are CSV (opens in any spreadsheet). Documents are Markdown",
    "(opens in any text editor or Word). Nothing here is a special format.",
  ].join("\n"));

  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return { filename: `beezilla-export-${stamp}.zip`, bytes };
}

/** Tables holding owner data, in deletion order (children first is unnecessary —
 *  no FKs between them — but listed for the audit trail). Statements are
 *  explicit (no dynamic identifiers) so they run identically on prod Postgres
 *  and the embedded PGLite dialect, where sql(table) parametrizes instead of
 *  quoting an identifier. buzzy_action_authority is a global constant table
 *  with no user data and is intentionally absent. */
export const DELETION_STATEMENTS: Record<string, string> = {
  buzzy_chat_messages: "DELETE FROM buzzy_chat_messages WHERE user_id = $1 RETURNING 1",
  buzzy_user_memory: "DELETE FROM buzzy_user_memory WHERE user_id = $1 RETURNING 1",
  buzzy_jobs: "DELETE FROM buzzy_jobs WHERE user_id = $1 RETURNING 1",
  // BZ-F015: versions go first (FK child of documents; cascade also covers it,
  // but the explicit pass keeps the receipt truthful).
  buzzy_document_versions:
    "DELETE FROM buzzy_document_versions WHERE doc_id IN (SELECT id FROM buzzy_documents WHERE user_id = $1) RETURNING 1",
  buzzy_share_links: "DELETE FROM buzzy_share_links WHERE user_id = $1 RETURNING 1",
  // Pages the person shared by link (0064): the copies go with the account.
  buzzy_page_shares: "DELETE FROM buzzy_page_shares WHERE user_id = $1 RETURNING 1",
  buzzy_outbound_actions: "DELETE FROM buzzy_outbound_actions WHERE user_id = $1 RETURNING 1",
  buzzy_telemetry: "DELETE FROM buzzy_telemetry WHERE user_id = $1 RETURNING 1",
  buzzy_documents: "DELETE FROM buzzy_documents WHERE user_id = $1 RETURNING 1",
  buzzy_document_decisions: "DELETE FROM buzzy_document_decisions WHERE user_id = $1 RETURNING 1",
  buzzy_templates: "DELETE FROM buzzy_templates WHERE user_id = $1 RETURNING 1",
  buzzy_paper_facts: "DELETE FROM buzzy_paper_facts WHERE user_id = $1 RETURNING 1",
  buzzy_papers: "DELETE FROM buzzy_papers WHERE user_id = $1 RETURNING 1",
  buzzy_company_facts: "DELETE FROM buzzy_company_facts WHERE user_id = $1 RETURNING 1",
  buzzy_companies: "DELETE FROM buzzy_companies WHERE user_id = $1 RETURNING 1",
  buzzy_contacts: "DELETE FROM buzzy_contacts WHERE user_id = $1 RETURNING 1",
  buzzy_sessions: "DELETE FROM buzzy_sessions WHERE user_id = $1 RETURNING 1",
  buzzy_job_events: "DELETE FROM buzzy_job_events WHERE user_id = $1 RETURNING 1",
  buzzy_scheduled_jobs: "DELETE FROM buzzy_scheduled_jobs WHERE user_id = $1 RETURNING 1",
  buzzy_connections: "DELETE FROM buzzy_connections WHERE user_id = $1 RETURNING 1",
  // CR-6: a feedback row belongs to the account that wrote it. No second nulling
  // pass, and no "snapshot" that outlives the user — closing an account is not
  // consent to a 24-month archive. The receipt counts the rows it removed.
  buzzy_feedback: "DELETE FROM buzzy_feedback WHERE user_id = $1 RETURNING 1",
  // The one board (0060_buzzy_one_board): the person's own AI key (sealed), the
  // recipes they made from the Idea Board and the search words on their files.
  buzzy_user_ai_keys: "DELETE FROM buzzy_user_ai_keys WHERE user_id = $1 RETURNING 1",
  buzzy_board_recipes: "DELETE FROM buzzy_board_recipes WHERE user_id = $1 RETURNING 1",
  buzzy_asset_tags: "DELETE FROM buzzy_asset_tags WHERE user_id = $1 RETURNING 1",
  // What BeeZilla saw in each picture (0071): it goes with the account, not only the picture.
  buzzy_picture_looks: "DELETE FROM buzzy_picture_looks WHERE user_id = $1 RETURNING 1",
  // 3D model jobs (0072): who started each and which step continues it.
  buzzy_model3d_jobs: "DELETE FROM buzzy_model3d_jobs WHERE user_id = $1 RETURNING 1",
  // The pictures added to each conversation (0073): ids only, gone with the account.
  buzzy_chat_pictures: "DELETE FROM buzzy_chat_pictures WHERE user_id = $1 RETURNING 1",
  // The Talk whiteboards (0060): the history first (FK child; cascade covers it too,
  // but the explicit pass keeps the receipt truthful), then the boards.
  buzzy_whiteboard_versions: "DELETE FROM buzzy_whiteboard_versions WHERE user_id = $1 RETURNING 1",
  buzzy_whiteboards: "DELETE FROM buzzy_whiteboards WHERE user_id = $1 RETURNING 1",
};

/** One-action account deletion. Returns per-table row counts for the receipt. */
export async function deleteAccountData(sql: any, userId: string): Promise<Record<string, number>> {
  const receipt: Record<string, number> = {};
  for (const [table, statement] of Object.entries(DELETION_STATEMENTS)) {
    const rows = await sql.query(statement, [userId]);
    receipt[table] = rows.length;
  }
  return receipt;
}
