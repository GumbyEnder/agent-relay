/**
 * Buzzy memory interface — narrow surface for per-user facts.
 *
 * DB-first today (buzzy_user_memory table). A future Honcho client
 * (Railway peer, workspace=beezilla-clients, peer=userId) will swap in
 * here behind this interface without touching callers.
 *
 * Methods:
 *   - remember(key, value)  — persist a single fact
 *   - get_facts()           — all facts as { key, value }[]
 *   - summarize()           — natural-language summary of all facts
 */

import type { Sql } from "@/lib/db";

export interface MemoryFact {
  key: string;
  value: string;
}

export interface MemoryInterface {
  /** Store or update a single fact for this user/job. */
  remember(key: string, value: string): Promise<void>;

  /** Return all facts as an array of { key, value }. */
  get_facts(): Promise<MemoryFact[]>;

  /** Return a natural-language summary of all facts. */
  summarize(): Promise<string>;
}

/**
 * DB-backed implementation. Works with both Neon and PGLite via the
 * shared `Sql` surface. Uses .query() to avoid tagged-template `this` binding issues.
 */
export class DbMemory implements MemoryInterface {
  constructor(
    private sql: Sql,
    private userId: string,
    private jobId: string | null,
  ) {}

  async remember(key: string, value: string): Promise<void> {
    await this.sql.query(
      `INSERT INTO buzzy_user_memory (user_id, job_id, key, value)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, job_id, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [this.userId, this.jobId, key, value],
    );
  }

  async get_facts(): Promise<MemoryFact[]> {
    const rows = await this.sql.query<{ key: string; value: string }>(
      `SELECT key, value FROM buzzy_user_memory
       WHERE user_id = $1 AND job_id = $2
       ORDER BY key`,
      [this.userId, this.jobId],
    );
    return rows as MemoryFact[];
  }

  async summarize(): Promise<string> {
    const facts = await this.get_facts();
    if (facts.length === 0) return "(no facts yet)";
    return facts
      .map((f) => `${f.key}: ${f.value}`)
      .join("\n");
  }
}
