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
