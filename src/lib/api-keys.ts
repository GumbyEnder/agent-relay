/**
 * Scoped agent API keys — issue, hash, verify (no plaintext storage).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

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
