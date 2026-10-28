/**
 * Inference credentials for a local install.
 *
 * Two providers, one shape:
 *   - "beezilla" — our inference, via a device-scoped token minted against the
 *     owner's account (mint endpoint lands in s6b; the store is ready for it).
 *   - "byok" — the owner's own provider key, base URL and model.
 *
 * The key is written through an injected `encrypt`/`decrypt` pair. Electron
 * passes `safeStorage` (DPAPI on Windows); the CLI, which has no OS keychain
 * binding, stores 0600 and reports `encrypted: false` so `doctor` can say so out
 * loud instead of implying protection it does not have.
 *
 * Managed tokens are SHORT-LIVED by design (a mint-proxy issues scoped tokens,
 * never a shared key), so the store records `expiresAt`. An expired managed
 * token is a session problem, not a bad credential: it must say "reconnect",
 * not "invalid API key", and it must fail before spending a request.
 *
 * Precedence: explicit environment always wins. A desktop user who exported
 * BZ_CHAT_KEY for a test must not be silently overridden by a stale store file.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export const STORE_FILE = "inference.json";

const PROVIDERS = new Set(["beezilla", "byok"]);

/** Defaults for OUR inference, so a managed install never asks for a base URL. */
export const MANAGED_DEFAULTS = {
  baseUrl: "https://inference-api.nousresearch.com/v1",
};

export function storePath(dataDir) {
  return join(dataDir, STORE_FILE);
}

/**
 * @param {string} dataDir
 * @param {{ encrypt?: (s: string) => Buffer|string, decrypt?: (v: Buffer|string) => string }} cipher
 * @returns {{ provider: string, baseUrl: string, model: string, key: string, encrypted: boolean } | null}
 */
export function loadInference(dataDir, cipher = {}) {
  const file = storePath(dataDir);
  if (!existsSync(file)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!raw?.keyCipher) return null;

  let key;
  try {
    const stored = raw.encrypted
      ? Buffer.from(raw.keyCipher, "base64")
      : raw.keyCipher;
    key = raw.encrypted
      ? cipher.decrypt
        ? cipher.decrypt(stored)
        : ""
      : stored;
  } catch {
    return null;
  }
  // A store we cannot decrypt is not a key we may guess at.
  if (!key) return null;

  return {
    provider: PROVIDERS.has(raw.provider) ? raw.provider : "byok",
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : "",
    model: typeof raw.model === "string" ? raw.model : "",
    key,
    encrypted: Boolean(raw.encrypted),
    updatedAt: raw.updatedAt ?? null,
    expiresAt: typeof raw.expiresAt === "string" ? raw.expiresAt : null,
  };
}

/** True when a managed token carries an expiry that has passed. */
export function isExpired(cred, now = Date.now()) {
  if (!cred?.expiresAt) return false;
  const at = Date.parse(cred.expiresAt);
  return Number.isFinite(at) && at <= now;
}

/**
 * @param {string} dataDir
 * @param {{ provider: string, key: string, baseUrl?: string, model?: string }} cfg
 * @param {{ encrypt?: (s: string) => Buffer|string }} cipher
 */
export function saveInference(dataDir, cfg, cipher = {}) {
  if (!PROVIDERS.has(cfg.provider)) throw new Error(`unknown provider: ${cfg.provider}`);
  const key = (cfg.key ?? "").trim();
  if (!key) throw new Error("a key is required");

  const encrypted = Boolean(cipher.encrypt);
  const keyCipher = encrypted
    ? Buffer.from(cipher.encrypt(key)).toString("base64")
    : key;

  const baseUrl = (cfg.baseUrl ?? "").trim();
  const payload = {
    provider: cfg.provider,
    baseUrl: baseUrl || (cfg.provider === "beezilla" ? MANAGED_DEFAULTS.baseUrl : ""),
    expiresAt: (cfg.expiresAt ?? "").trim() || null,
    model: (cfg.model ?? "").trim(),
    encrypted,
    keyCipher,
    updatedAt: new Date().toISOString(),
  };
  const file = storePath(dataDir);
  writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows ignores POSIX modes; Electron encryption is the real control there */
  }
  return { ...payload, keyCipher: undefined };
}

export function clearInference(dataDir) {
  rmSync(storePath(dataDir), { force: true });
}

/** Never let a key reach a log line, an error message or a `--show` output. */
export function redactKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "****";
  return `${key.slice(0, 3)}…${key.slice(-4)} (${key.length} chars)`;
}

/**
 * Resolve what the runtime should use. Explicit env wins over the store, and the
 * store supplies only the fields env did not set.
 */
export function resolveInference(dataDir, cipher = {}) {
  const stored = loadInference(dataDir, cipher);
  const envKey = (process.env.BZ_CHAT_KEY ?? "").trim();
  const envBase = (process.env.BZ_CHAT_BASE_URL ?? "").trim();
  const envModel = (process.env.BZ_CHAT_MODEL ?? "").trim();

  if (envKey) {
    return {
      source: "env",
      provider: "env",
      key: envKey,
      baseUrl: envBase || stored?.baseUrl || "",
      model: envModel || stored?.model || "",
      encrypted: null,
    };
  }
  if (stored?.key) {
    return {
      source: "store",
      provider: stored.provider,
      key: stored.key,
      baseUrl: envBase || stored.baseUrl,
      model: envModel || stored.model,
      encrypted: stored.encrypted,
      expiresAt: stored.expiresAt ?? null,
      expired: isExpired(stored),
    };
  }
  return null;
}
