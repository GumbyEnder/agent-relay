/**
 * Web-search credentials for a local install.
 *
 * The product offers OUR Brave key so search works out of the box, and BYOK so
 * an owner can point it at their own Brave subscription (or, later, another
 * provider). Resolution is env-first: `BZ_BRAVE_KEY` (what the launcher injects
 * for our key, or what the user exported) beats the stored key.
 *
 * The store mirrors the inference store: `encrypt` is injected (Electron passes
 * safeStorage), the CLI writes 0600 and says "unencrypted" out loud rather than
 * implying protection it does not have.
 */
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SEARCH_STORE_FILE = "search.json";

export function searchStorePath(dataDir) {
  return join(dataDir, SEARCH_STORE_FILE);
}

export function loadSearchKey(dataDir, cipher = {}) {
  const file = searchStorePath(dataDir);
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
    if (raw.encrypted) {
      if (!cipher.decrypt) return null;
      key = cipher.decrypt(Buffer.from(raw.keyCipher, "base64"));
    } else {
      key = raw.keyCipher;
    }
  } catch {
    return null;
  }
  if (!key) return null;
  return {
    provider: raw.provider === "brave" ? "brave" : "brave",
    key,
    encrypted: Boolean(raw.encrypted),
    updatedAt: raw.updatedAt ?? null,
  };
}

export function saveSearchKey(dataDir, cfg, cipher = {}) {
  const key = (cfg.key ?? "").trim();
  if (!key) throw new Error("a search key is required");
  const encrypted = Boolean(cipher.encrypt);
  const payload = {
    provider: "brave",
    encrypted,
    keyCipher: encrypted ? Buffer.from(cipher.encrypt(key)).toString("base64") : key,
    updatedAt: new Date().toISOString(),
  };
  const file = searchStorePath(dataDir);
  writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows ignores POSIX modes; Electron encryption is the real control there */
  }
  return payload;
}

export function clearSearchKey(dataDir) {
  rmSync(searchStorePath(dataDir), { force: true });
}

/**
 * BeeZilla search: a short-lived, search-scoped token pointed at OUR gateway.
 * Stored beside the BYOK key (never instead of it — BYOK wins at resolve time) so a
 * user who later adds their own Brave key is not fighting a hidden credential.
 */
export function saveManagedSearch(dataDir, { token, gateway, expiresAt }, cipher = {}) {
  const value = (token ?? "").trim();
  if (!value) throw new Error("a search token is required");
  const encrypted = Boolean(cipher.encrypt);
  const payload = {
    managedTokenCipher: encrypted ? Buffer.from(cipher.encrypt(value)).toString("base64") : value,
    managedEncrypted: encrypted,
    gateway: (gateway ?? "").trim().replace(/\/+$/, ""),
    expiresAt: expiresAt ?? null,
    updatedAt: new Date().toISOString(),
  };
  const file = searchStorePath(dataDir);
  // Merge rather than overwrite: a BYOK key already in the file must survive.
  let existing = {};
  try {
    existing = JSON.parse(readFileSync(file, "utf8")) ?? {};
  } catch {}
  writeFileSync(file, JSON.stringify({ ...existing, ...payload }, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows ignores POSIX modes; Electron encryption is the real control there */
  }
  return payload;
}

export function loadManagedSearch(dataDir, cipher = {}) {
  const file = searchStorePath(dataDir);
  if (!existsSync(file)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!raw?.managedTokenCipher || !raw?.gateway) return null;
  let token;
  try {
    token = raw.managedEncrypted
      ? cipher.decrypt
        ? cipher.decrypt(Buffer.from(raw.managedTokenCipher, "base64"))
        : null
      : raw.managedTokenCipher;
  } catch {
    return null;
  }
  if (!token) return null;
  const expiresAt = raw.expiresAt ?? null;
  const expired = expiresAt ? Date.parse(expiresAt) <= Date.now() : false;
  return { token, gateway: raw.gateway, expiresAt, expired, updatedAt: raw.updatedAt ?? null };
}

export function resolveSearch(dataDir, cipher = {}) {
  const envKey = (process.env.BZ_BRAVE_KEY ?? "").trim();
  if (envKey) {
    return { source: "env", provider: "brave", key: envKey, encrypted: null };
  }
  const stored = loadSearchKey(dataDir, cipher);
  if (stored) {
    return { source: "store", provider: stored.provider, key: stored.key, encrypted: stored.encrypted };
  }
  // Nothing of the user's own: fall back to OUR gateway with a scoped token, which
  // is how search works out of the box. An expired managed token is simply not
  // offered — search degrades to "unavailable" rather than failing a chat turn.
  const managed = loadManagedSearch(dataDir, cipher);
  if (managed && !managed.expired) {
    return {
      source: "managed",
      provider: "beezilla",
      token: managed.token,
      gateway: managed.gateway,
      expiresAt: managed.expiresAt,
      encrypted: true,
    };
  }
  return null;
}
