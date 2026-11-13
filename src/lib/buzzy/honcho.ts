/**
 * External Honcho memory is disabled pending authenticated, scoped owner consent.
 *
 * The former automatic peer/session/message sync treated deployment credentials
 * as permission to share every owner's conversation. No such consent mechanism
 * exists yet. BZ_HONCHO_* values, a signed-in session, and a local model preference
 * must not enable that sharing, in either hosted or local runtimes.
 *
 * Keep the existing async API so chat and local DB-backed memory still work, but
 * fail closed at this boundary, including direct callers and inherited env vars.
 * Re-enabling this service requires a real consent/payload/recipient policy, not
 * a new environment switch or an unverified client boolean. This disables only
 * Honcho transmission; it does not make other app traffic offline/Lockdown-safe.
 */

/** Unavailable by policy, even when deployment credentials are configured. */
export function honchoAvailable(): boolean {
  return false;
}

/** Compatibility no-op: creating a remote peer also discloses an owner ID. */
export async function ensurePeer(_userId: string): Promise<void> {}

/** No remote lookup or creation; preserve the existing unavailable result. */
export async function ensureSession(jobId: string, _peerId: string): Promise<string> {
  return jobId;
}

/** Compatibility no-op: no conversation is copied to external memory. */
export async function syncMessages(
  _sessionId: string,
  _peerId: string,
  _messages: Array<{ content: string; peer_id: string }>,
): Promise<void> {}
