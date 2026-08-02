/**
 * Scoped agent API keys — issue, hash, verify.
 * Full secrets may be sealed (AES-GCM) for operator "reveal" in the UI.
 * Verification still uses the hash only.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export interface ApiKeyRecord {
  id: string;
  projectId: string;
  agentId: string | null;
  name: string;
  keyPrefix: string;
  keyHash: string;
  createdAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

export interface IssuedApiKey {
  record: Omit<ApiKeyRecord, "keyHash">;
  /** Full secret shown once at creation */
  secret: string;
}

const PREFIX = "ark_";

export function hashApiKey(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function issueApiKeySecret(): {
  secret: string;
  prefix: string;
  /** Last 6 chars of the secret — safe to show in operator UI */
  suffix: string;
  hash: string;
} {
  const raw = randomBytes(24).toString("base64url");
  const secret = `${PREFIX}${raw}`;
  const prefix = secret.slice(0, 12);
  const suffix = secret.slice(-6);
  return { secret, prefix, suffix, hash: hashApiKey(secret) };
}

export function buildIssuedKey(input: {
  id: string;
  projectId: string;
  agentId?: string | null;
  name?: string;
  createdAt?: number;
}): IssuedApiKey {
  const { secret, prefix, hash } = issueApiKeySecret();
  const createdAt = input.createdAt ?? Date.now();
  return {
    secret,
    record: {
      id: input.id,
      projectId: input.projectId,
      agentId: input.agentId ?? null,
      name: (input.name ?? "").trim() || "agent-key",
      keyPrefix: prefix,
      createdAt,
      revokedAt: null,
      lastUsedAt: null,
    },
    // hash attached for persistence by caller
    ...({} as object),
  } as IssuedApiKey & { hash?: string };
}

/** Returns { secret, prefix, suffix, hash, meta } for persistence */
export function createApiKeyMaterial(input: {
  id: string;
  projectId: string;
  agentId?: string | null;
  name?: string;
}): {
  secret: string;
  prefix: string;
  suffix: string;
  hash: string;
  id: string;
  projectId: string;
  agentId: string | null;
  name: string;
  createdAt: number;
} {
  const { secret, prefix, suffix, hash } = issueApiKeySecret();
  return {
    id: input.id,
    projectId: input.projectId,
    agentId: input.agentId ?? null,
    name: (input.name ?? "").trim() || "agent-key",
    secret,
    prefix,
    suffix,
    hash,
    createdAt: Date.now(),
  };
}

export function verifyApiKeyAgainstHashes(
  presented: string,
  candidates: Array<{ id: string; keyHash: string; revokedAt: number | null; projectId: string; agentId: string | null }>,
): { id: string; projectId: string; agentId: string | null } | null {
  if (!presented || !presented.startsWith(PREFIX)) return null;
  const presentedHash = hashApiKey(presented);
  const presentedBuf = Buffer.from(presentedHash, "hex");
  for (const c of candidates) {
    if (c.revokedAt) continue;
    const candBuf = Buffer.from(c.keyHash, "hex");
    if (candBuf.length !== presentedBuf.length) continue;
    if (timingSafeEqual(presentedBuf, candBuf)) {
      return { id: c.id, projectId: c.projectId, agentId: c.agentId };
    }
  }
  return null;
}

/** 32-byte key from app secret (BETTER_AUTH_SECRET / AGENT_KEY_SEAL_SECRET). */
function sealKeyMaterial(): Buffer {
  const raw =
    process.env.AGENT_KEY_SEAL_SECRET?.trim() ||
    process.env.BETTER_AUTH_SECRET?.trim() ||
    process.env.AUTH_SECRET?.trim() ||
    "devboards-dev-key-seal-not-for-prod";
  return createHash("sha256").update(raw, "utf8").digest();
}

/**
 * Seal a secret for operator reveal. Format: v1.<iv_b64url>.<tag_b64url>.<ct_b64url>
 */
export function sealApiKeySecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealKeyMaterial(), iv);
  const ct = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const b64 = (b: Buffer) => b.toString("base64url");
  return `v1.${b64(iv)}.${b64(tag)}.${b64(ct)}`;
}

/** Unseal a previously sealed secret, or null if missing/invalid. */
export function unsealApiKeySecret(sealed: string | null | undefined): string | null {
  if (!sealed?.startsWith("v1.")) return null;
  try {
    const parts = sealed.split(".");
    if (parts.length !== 4) return null;
    const iv = Buffer.from(parts[1]!, "base64url");
    const tag = Buffer.from(parts[2]!, "base64url");
    const ct = Buffer.from(parts[3]!, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", sealKeyMaterial(), iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf8");
  } catch {
    return null;
  }
}
