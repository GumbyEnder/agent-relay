/**
 * CR-9 phase C — where the memo's files live.
 *
 * The four files go into `buzzy_assets`, the same table the Library, the asset
 * download route (`GET /api/buzzy/assets/:id`) and the document export already
 * read. That is deliberate: a deal memo is not a special case for the operator
 * to learn, and a file the person downloaded from the chat card must be the
 * same row they see in the Library.
 *
 * The stored label is the format's own type, not a guess. `rel_path` is scoped
 * by job so a job's four files sit together, and the write is idempotent on
 * (user_id, sha256) — re-running a step that produces the same bytes must not
 * create a second asset with a second URL.
 */

import { createHash } from "node:crypto";

import type { MemoFiles } from "./outputs";

/** The two query shapes this module needs (PGlite in tests, pg in production). */
export type MemoQuery = <T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
) => Promise<T[]>;

export interface StoredMemoAsset {
  format: "md" | "pdf" | "docx" | "csv";
  id: number;
  filename: string;
  contentType: string;
  bytes: number;
  relPath: string;
  duplicate: boolean;
  /** The existing download route. Nothing new to learn or to secure. */
  url: string;
}

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function safeStem(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "deal-memo"
  );
}

export async function storeMemoFiles(
  q: MemoQuery,
  input: {
    userId: string;
    files: MemoFiles;
    /** Job the files belong to; the Library groups on it. */
    jobId?: string;
    sessionId?: string;
    /** Title-derived filename stem; defaults to "deal-memo". */
    title?: string;
  },
): Promise<{ assets: StoredMemoAsset[] }> {
  const stem = safeStem(input.title ?? "deal memo");
  const folder = `deal-memo/${(input.jobId ?? "draft").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 100) || "draft"}`;
  const entries: Array<{ format: StoredMemoAsset["format"]; filename: string; contentType: string; bytes: Uint8Array }> = [
    { format: "md", filename: `${stem}.md`, contentType: "text/markdown; charset=utf-8", bytes: new Uint8Array(Buffer.from(input.files.markdown, "utf8")) },
    { format: "pdf", filename: `${stem}.pdf`, contentType: "application/pdf", bytes: input.files.pdf.bytes },
    { format: "docx", filename: input.files.docx.filename, contentType: input.files.docx.contentType || DOCX_TYPE, bytes: input.files.docx.bytes },
  ];
  if (input.files.csv) {
    entries.push({ format: "csv", filename: `${stem}.csv`, contentType: "text/csv; charset=utf-8", bytes: new Uint8Array(Buffer.from(input.files.csv, "utf8")) });
  }

  const assets: StoredMemoAsset[] = [];
  for (const entry of entries) {
    const sha256 = createHash("sha256").update(Buffer.from(entry.bytes)).digest("hex");
    const relPath = `${folder}/${entry.filename}`;
    const inserted = await q<{ id: number }>(
      `INSERT INTO buzzy_assets (user_id, sha256, filename, rel_path, content_type, bytes, body)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, sha256) DO NOTHING
       RETURNING id`,
      [input.userId, sha256, entry.filename, relPath, entry.contentType, entry.bytes.byteLength, Buffer.from(entry.bytes)],
    );
    let id = Number(inserted[0]?.id ?? 0);
    let duplicate = false;
    if (!id) {
      const prior = await q<{ id: number }>(
        `SELECT id FROM buzzy_assets WHERE user_id = $1 AND sha256 = $2 LIMIT 1`,
        [input.userId, sha256],
      );
      id = Number(prior[0]?.id ?? 0);
      duplicate = true;
    }
    if (!id) throw new Error(`MEMO_STORE the ${entry.format} file was neither inserted nor found`);
    if (input.jobId || input.sessionId) {
      await q(
        `UPDATE buzzy_assets SET job_id = COALESCE($1, job_id), session_id = COALESCE($2, session_id)
         WHERE user_id = $3 AND id = $4`,
        [input.jobId ?? null, input.sessionId ?? null, input.userId, id],
      );
    }
    assets.push({
      format: entry.format,
      id,
      filename: entry.filename,
      contentType: entry.contentType,
      bytes: entry.bytes.byteLength,
      relPath,
      duplicate,
      url: `/api/buzzy/assets/${id}`,
    });
  }
  return { assets };
}
