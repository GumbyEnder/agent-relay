/**
 * GitHub webhook signature verification (HMAC SHA-256).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Verify X-Hub-Signature-256: sha256=<hex> */
export function verifyGitHubSignature(
  rawBody: string | Buffer,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!secret?.trim()) return false;
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = signatureHeader.slice("sha256=".length).trim();
  try {
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(provided, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function signGitHubBody(rawBody: string | Buffer, secret: string): string {
  const hex = createHmac("sha256", secret).update(rawBody).digest("hex");
  return `sha256=${hex}`;
}
