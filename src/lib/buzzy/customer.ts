/**
 * Buzzy customer memory + template library (plan doc 23, components #2 & #3).
 *
 * Customer memory: a per-company rollup of APPROVED jobs (amounts, dates,
 * deliverables) — built only from approved work, never raw chats, and rebuilt
 * on each approval so corrections always win.
 *
 * Template library: the owner's uploaded documents become reusable structures.
 * Private by default (negative scope: no marketplace). Extraction reads the
 * document's headings/blanks; drafts then render in THEIR format.
 */

import JSZip from "jszip";

export interface CustomerMemoryEntry {
  jobId: string;
  title: string;
  kind: string;
  amount: number | null;
  approvedAt: string;
  summary: string;
}

export interface TemplateStructure {
  /** Ordered headings from the uploaded document. */
  headings: string[];
  /** Bracket-style blanks found in the text, e.g. [Client Name]. */
  blanks: string[];
  /** Word count — a cheap size signal for the "is this the right structure?" preview. */
  wordCount: number;
}

/**
 * Rebuild the customer memory rollup for a company from APPROVED jobs.
 * Called on every approval — the most recent correction wins because the
 * rollup is recomputed, never patched.
 */
export async function rebuildCustomerMemory(
  sql: any,
  userId: string,
  companyId: string,
): Promise<CustomerMemoryEntry[]> {
  const rows = (await sql`
    SELECT id, title, status, updated_at,
      data->>'draft' AS draft,
      data->'slots' AS slots
    FROM buzzy_jobs
    WHERE user_id = ${userId} AND company_id = ${companyId}
      AND data->>'approved' = 'true'
    ORDER BY updated_at DESC
    LIMIT 50
  `) as Array<{ id: string; title: string; status: string; updated_at: string; draft: string | null; slots: unknown }>;

  const entries: CustomerMemoryEntry[] = rows.map((r) => {
    const draft = r.draft ?? "";
    const money = draft.match(/\$\s?[0-9][0-9,]*(?:\.[0-9]{2})?/);
    const slots = (r.slots && typeof r.slots === "object" ? r.slots : {}) as Record<string, string>;
    return {
      jobId: r.id,
      title: (r.title || "Untitled job").slice(0, 120),
      kind: guessKind(draft, r.title),
      amount: money ? Number(money[0].replace(/[$,\s]/g, "")) : null,
      approvedAt: r.updated_at,
      summary: (slots.end_goal || draft.slice(0, 160)).slice(0, 200),
    };
  });

  await sql`
    UPDATE buzzy_companies
    SET customer_memory = ${JSON.stringify(entries)}::jsonb,
        memory_updated_at = now()
    WHERE id = ${companyId} AND user_id = ${userId}
  `;
  return entries;
}

function guessKind(draft: string, title: string): string {
  const t = (draft + " " + title).toLowerCase();
  if (/invoice|amount due|total due/.test(t)) return "invoice";
  if (/quote|estimate/.test(t)) return "quote";
  if (/agreement|contract|terms/.test(t)) return "agreement";
  if (/dear|sincerely|regards/.test(t)) return "letter";
  return "document";
}

/** Civilian context block for the chat loop: what we know about this customer. */
export function memoryContextBlock(entries: CustomerMemoryEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries.slice(0, 8).map((e) => {
    const money = e.amount != null ? ` ($${e.amount.toFixed(2)})` : "";
    return `- ${e.kind}: ${e.title}${money} — approved ${e.approvedAt.slice(0, 10)}`;
  });
  return (
    "\n\nPAST WORK FOR THIS CUSTOMER (approved jobs on file — use, don't re-ask):\n" +
    lines.join("\n")
  );
}

/**
 * Extract template structure from an uploaded .docx: headings + bracket
 * blanks + size. The owner confirms the structure on the preview card.
 */
export async function extractTemplateStructure(docxBytes: Uint8Array): Promise<TemplateStructure> {
  const zip = await JSZip.loadAsync(docxBytes);
  const docXml = await zip.file("word/document.xml")?.async("string");
  if (!docXml) throw new Error("not a readable .docx file");
  // Paragraphs carry a heading style or are plain runs. Extract in document order.
  const paragraphs = [...docXml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((m) => m[0]);
  const headings: string[] = [];
  let plainText = "";
  for (const p of paragraphs) {
    const runs = [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");
    if (!runs.trim()) continue;
    plainText += runs + "\n";
    if (/w:val="Heading[12]"/.test(p) || /<w:pStyle w:val="Title"/.test(p)) {
      headings.push(runs.trim().slice(0, 150));
    }
  }
  const value = plainText;
  const blanks = [...new Set([...value.matchAll(/\[[^\]\n]{1,60}\]/g)].map((m) => m[0]))].slice(0, 30);
  const wordCount = value.split(/\s+/).filter(Boolean).length;
  return { headings: headings.slice(0, 40), blanks, wordCount };
}

// NOTE (2026-10-25): the `fill_template` declaration lived here and was never
// wired into the chat loop — a dead schema that read as a shipped capability.
// It was removed under `docs/TOOL-AND-BROWSER-PLAN.md` (A3): a tool declaration
// is a promise, and an unreachable promise is worse than none. Re-adding it
// means a real template store, a registry entry, a gate, and a test (wave 3).
