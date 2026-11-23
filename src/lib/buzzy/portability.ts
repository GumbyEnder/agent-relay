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
  // The Zilla agents the person made and the job they gave each one (0065). Their own
  // words, so they leave with them. An older database without the table exports none.
  let agents: any[] = [];
  try {
    agents = await sql`
      SELECT id, name, creature, look, role, instructions, face, created_at
      FROM buzzy_agents WHERE user_id = ${userId} ORDER BY pos ASC, created_at ASC`;
  } catch { agents = []; }
  // The colonies those agents are grouped into (0066), each with the person's own words for
  // its purpose. Read apart from the agents so a database that has not had 0066 yet still
  // exports every agent, just with no colony named.
  let seats: any[] = [];
  try {
    seats = await sql`
      SELECT a.id AS agent_id, c.id AS colony_id, c.name, c.purpose
      FROM buzzy_agents a
      JOIN buzzy_agent_colonies c ON c.id = a.colony_id AND c.user_id = a.user_id
      WHERE a.user_id = ${userId}
      ORDER BY c.pos ASC, c.created_at ASC, a.pos ASC, a.created_at ASC`;
  } catch { seats = []; }
  const colonyOf = new Map<string, string>(seats.map((s: any) => [s.agent_id, s.name]));
  const colonies = new Map<string, { name: string; purpose: string; agents: string[] }>();
  for (const s of seats) {
    const c: { name: string; purpose: string; agents: string[] } = colonies.get(s.colony_id) ?? { name: s.name, purpose: s.purpose, agents: [] };
    c.agents.push(agents.find((a: any) => a.id === s.agent_id)?.name ?? "");
    colonies.set(s.colony_id, c);
  }

  const zip = new JSZip();
  const stamp = new Date().toISOString().slice(0, 10);

  // Data as CSV
  zip.file("companies.csv", toCsv(companies.map((c: any) => ({ id: c.id, name: c.name, one_liner: c.one_liner, website: c.website }))));
  zip.file("company_facts.csv", toCsv(facts.map((f: any) => ({ company_id: f.company_id, key: f.fact_key, label: f.label, value: f.value, status: f.status, source: f.source_label }))));
  zip.file("remembered_decisions.csv", toCsv(memory.map((m: any) => ({ key: m.key, value: m.value, updated_at: m.updated_at }))));
  zip.file("templates.csv", toCsv(templates.map((t: any) => ({ id: t.id, name: t.name, kind: t.kind, headings: (t.structure?.headings ?? []).join(" | ") }))));
  if (agents.length) {
    zip.file("zilla_agents.csv", toCsv(agents.map((a: any) => ({
      name: a.name, zilla: a.look ? `${a.look} ${a.creature}` : a.creature, helps_with: a.role, in_your_words: a.instructions, face: a.face,
      colony: colonyOf.get(a.id) ?? "",
    }))));
  }
  if (colonies.size) {
    zip.file("zilla_colonies.csv", toCsv([...colonies.values()].map((c) => ({ name: c.name, purpose: c.purpose, agents: c.agents.join(" | ") }))));
  }

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
  // The Talk whiteboards (0060): the history first (FK child; cascade covers it too,
  // but the explicit pass keeps the receipt truthful), then the boards.
  buzzy_whiteboard_versions: "DELETE FROM buzzy_whiteboard_versions WHERE user_id = $1 RETURNING 1",
  buzzy_whiteboards: "DELETE FROM buzzy_whiteboards WHERE user_id = $1 RETURNING 1",
  // The Zilla agents (0065): the person's helpers, with the words they used to give each
  // one its job, and the marker that they were handed their starter agent.
  buzzy_agents: "DELETE FROM buzzy_agents WHERE user_id = $1 RETURNING 1",
  buzzy_agent_seed: "DELETE FROM buzzy_agent_seed WHERE user_id = $1 RETURNING 1",
  // The colonies those agents are grouped into (0066), with the purpose the person wrote for each.
  buzzy_agent_colonies: "DELETE FROM buzzy_agent_colonies WHERE user_id = $1 RETURNING 1",
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
