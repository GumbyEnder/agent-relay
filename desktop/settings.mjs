/**
 * Settings bridge — the non-technical path.
 *
 * A BeeZilla user is not going to run `beezilla key set`. They open the window,
 * pick "our inference" or "my own key", paste it, and it works. This module is
 * that operation, kept Electron-free so it can be tested without a display:
 * `cipher` is injected (safeStorage in the app, nothing in tests).
 *
 * Saving a credential requires restarting the runtime, because the key is
 * injected into the child's environment at spawn. Doing that here — rather than
 * telling the user to "restart the app" — is the difference between a product
 * and a wrapper around a CLI.
 */
import {
  loadInference,
  saveInference,
  clearInference,
  resolveInference,
  isExpired,
  redactKey,
} from "../scripts/lib/inference.mjs";
import { resolveSearch, saveSearchKey, clearSearchKey } from "../scripts/lib/search-keys.mjs";

/**
 * @param {{ dataDir: () => string, supervisor?: any, cipher?: {encrypt?:Function, decrypt?:Function} }} deps
 */
export function createSettingsHandlers({ dataDir, supervisor, cipher = {}, beforeRestart }) {
  const describe = () => {
    const dir = dataDir();
    const inf = resolveInference(dir, cipher);
    const search = resolveSearch(dir, cipher);
    return {
      inference: inf
        ? {
            provider: inf.provider,
            source: inf.source,
            key: redactKey(inf.key),
            baseUrl: inf.baseUrl || null,
            model: inf.model || null,
            encrypted: inf.encrypted,
            expiresAt: inf.expiresAt ?? null,
            expired: Boolean(inf.expired),
          }
        : null,
      search: search
        ? { provider: search.provider, source: search.source, key: redactKey(search.key) }
        : null,
    };
  };

  const restart = async () => {
    if (!supervisor) return { restarted: false, reason: "no supervisor" };
    try {
      // The runtime inherits credentials from the parent environment, so the new
      // key must be decrypted into process.env BEFORE the child is spawned.
      if (beforeRestart) await beforeRestart();
      const wasRunning = await supervisor.isHealthy();
      await supervisor.stop();
      if (!wasRunning) return { restarted: false, reason: "was not running" };
      const rt = await supervisor.start();
      return { restarted: true, port: rt?.port ?? null };
    } catch (err) {
      return { restarted: false, reason: err instanceof Error ? err.message : String(err) };
    }
  };

  return {
    status: () => describe(),

    /** @param {{provider?: "beezilla"|"byok", key: string, baseUrl?: string, model?: string, expiresAt?: string}} cfg */
    async saveInference(cfg) {
      const key = (cfg?.key ?? "").trim();
      if (!key) throw new Error("a key is required");
      const provider = cfg.provider === "beezilla" ? "beezilla" : "byok";
      const saved = saveInference(dataDir(), {
        provider,
        key,
        baseUrl: cfg.baseUrl ?? "",
        model: cfg.model ?? "",
        expiresAt: cfg.expiresAt ?? "",
      }, cipher);
      const restartInfo = await restart();
      return { saved: { provider: saved.provider, encrypted: saved.encrypted, key: redactKey(key) }, ...restartInfo, status: describe() };
    },

    async saveSearch(cfg) {
      const key = (cfg?.key ?? "").trim();
      if (!key) throw new Error("a search key is required");
      const saved = saveSearchKey(dataDir(), { key }, cipher);
      const restartInfo = await restart();
      return { saved: { provider: saved.provider, encrypted: saved.encrypted }, ...restartInfo, status: describe() };
    },

    async clear(kind) {
      if (kind === "search") clearSearchKey(dataDir());
      else if (kind === "inference") clearInference(dataDir());
      else throw new Error(`unknown credential kind: ${String(kind)}`);
      const restartInfo = await restart();
      return { cleared: kind, ...restartInfo, status: describe() };
    },

    /** Exposed for doctor-style surfaces that need the raw state. */
    raw: () => loadInference(dataDir(), cipher),
    expired: () => isExpired(loadInference(dataDir(), cipher)),
  };
}
