/**
 * Recipe Seal — bundle storage.
 *
 * Content-addressed only: a key is `bundles/<hash>.srb`, `semantic/<hash>.enc`,
 * `checks/<hash>.wasm`. Nothing is ever overwritten because the key IS the
 * content hash. A memory implementation exists for tests and dry runs.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface BundleStorage {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}

export const bundleKey = (hash: string): string => `bundles/${hash}.srb`;
export const semanticKey = (hash: string): string => `semantic/${hash}.enc`;
export const checksKey = (hash: string): string => `checks/${hash}.wasm`;

export class MemoryStorage implements BundleStorage {
  private map = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.map.set(key, bytes);
  }
  async get(key: string): Promise<Uint8Array | null> {
    return this.map.get(key) ?? null;
  }
}

export class FsStorage implements BundleStorage {
  constructor(private readonly root: string) {}

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const path = join(this.root, key);
    mkdirSync(dirname(path), { recursive: true });
    // Refuse to overwrite: content-addressed keys must be immutable.
    if (existsSync(path)) {
      const existing = readFileSync(path);
      if (existing.length !== bytes.length) {
        throw new Error(`content-addressed key collision: ${key}`);
      }
      return;
    }
    writeFileSync(path, bytes, { mode: 0o600 });
  }

  async get(key: string): Promise<Uint8Array | null> {
    const path = join(this.root, key);
    if (!existsSync(path)) return null;
    return new Uint8Array(readFileSync(path));
  }
}

/**
 * Postgres-backed storage.
 *
 * The filesystem adapter is fine for a laptop and wrong for a container: Railway
 * rebuilds the image on every deploy, so a bundle written to disk exists until the
 * next deploy and then does not. That is not a hypothetical — recipes published on
 * the demo became unopenable the moment the service restarted, while their rows
 * still claimed to be published.
 *
 * The bytes are small (a bundle plus its sealed half and checks module, tens of KB),
 * content-addressed, immutable, and already committed in the same transaction-
 * adjacent flow as the row. Postgres is the durable store we actually have.
 */
export class PgStorage implements BundleStorage {
  constructor(
    private readonly q: <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>,
  ) {}

  async put(key: string, bytes: Uint8Array): Promise<void> {
    // Immutable by construction: a second write for the same key is a no-op. A
    // different payload under the same hash is a collision and must be surfaced.
    const rows = await this.q<{ n: string }>(
      `INSERT INTO ar_recipe_blob (key, bytes) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key
       WHERE ar_recipe_blob.bytes = EXCLUDED.bytes
       RETURNING length(bytes)::text AS n`,
      [key, Buffer.from(bytes)],
    );
    if (!rows[0]) throw new Error(`content-addressed key collision: ${key}`);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const rows = await this.q<{ bytes: Buffer }>(`SELECT bytes FROM ar_recipe_blob WHERE key = $1`, [key]);
    if (!rows[0]) return null;
    const b = rows[0].bytes;
    return new Uint8Array(b);
  }
}
