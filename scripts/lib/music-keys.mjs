/**
 * Music credentials for a local install (ElevenLabs).
 *
 * Why this file exists: the desktop shell had no way to give the local runtime an
 * ElevenLabs key at all, so the Music button in the app answered `not_configured`
 * on every machine, forever — even with a paid plan. The cloud service reads
 * BZ_ELEVEN_KEY from its environment; a desktop install has no environment to put
 * it in, so it needs a store plus an injector at spawn time (main.mjs).
 *
 * Same rules as the inference and search stores: `encrypt` is injected (Electron
 * passes safeStorage), the CLI writes 0600 and says "unencrypted" out loud.
 */
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MUSIC_STORE_FILE = "music.json";

export function musicStorePath(dataDir) {
  return join(dataDir, MUSIC_STORE_FILE);
}

/**
 * ElevenLabs has two things that look pasteable in the dashboard: the key ID
 * (64 hex characters) and the key itself (`sk_...`, shown once). Pasting the ID
 * produces `invalid_api_key: API key ID used as API key`, which reads like a bad
 * key and sends the owner hunting. Refuse it by name instead.
 */
export function describeElevenKeyProblem(raw) {
  const key = (raw ?? "").trim();
  if (!key) return "Paste your ElevenLabs API key (it starts with sk_).";
  if (/^[0-9a-f]{64}$/i.test(key)) {
    return "That is the API key ID, not the key. ElevenLabs shows the key itself only when it is created — copy the value that starts with sk_ (or rotate the key and copy the new one).";
  }
  if (!key.startsWith("sk_")) {
    return "An ElevenLabs API key starts with sk_. Check you copied the whole value.";
  }
  return null;
}

export function loadMusicKey(dataDir, cipher = {}) {
  const file = musicStorePath(dataDir);
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
    provider: "elevenlabs",
    key,
    encrypted: Boolean(raw.encrypted),
    updatedAt: raw.updatedAt ?? null,
  };
}

export function saveMusicKey(dataDir, cfg, cipher = {}) {
  const problem = describeElevenKeyProblem(cfg?.key);
  if (problem) throw new Error(problem);
  const key = cfg.key.trim();
  const encrypted = Boolean(cipher.encrypt);
  const payload = {
    provider: "elevenlabs",
    encrypted,
    keyCipher: encrypted ? Buffer.from(cipher.encrypt(key)).toString("base64") : key,
    updatedAt: new Date().toISOString(),
  };
  const file = musicStorePath(dataDir);
  writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows ignores POSIX modes; Electron encryption is the real control there */
  }
  return payload;
}

export function clearMusicKey(dataDir) {
  rmSync(musicStorePath(dataDir), { force: true });
}

/** Env first: an exported BZ_ELEVEN_KEY (our launcher, or the owner's shell) wins. */
export function resolveMusicKey(dataDir, cipher = {}) {
  const envKey = (process.env.BZ_ELEVEN_KEY ?? "").trim();
  if (envKey) return { source: "env", provider: "elevenlabs", key: envKey, encrypted: null };
  const stored = loadMusicKey(dataDir, cipher);
  if (stored) return { source: "store", provider: stored.provider, key: stored.key, encrypted: stored.encrypted };
  return null;
}
