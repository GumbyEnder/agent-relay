/**
 * Buzzy → Honcho v3 API client.
 *
 * Wraps the Honcho REST API (peer/session/message lifecycle) so the
 * chat loop can sync every turn to the deployed Honcho service.
 *
 * Env vars:
 *   BZ_HONCHO_URL   — base URL (e.g. https://honcho-api-production-5869.up.railway.app)
 *   BZ_HONCHO_KEY   — JWT bearer token
 *   BZ_HONCHO_WORKSPACE — workspace id (e.g. beezilla-clients)
 */

const env = (key: string): string => process.env[key]?.trim() ?? "";

const HONCHO_URL = env("BZ_HONCHO_URL");
const HONCHO_KEY = env("BZ_HONCHO_KEY");
const HONCHO_WORKSPACE = env("BZ_HONCHO_WORKSPACE") || "beezilla-clients";

/** Check whether Honcho is configured. */
export function honchoAvailable(): boolean {
  return !!(HONCHO_URL && HONCHO_KEY);
}

/**
 * Ensure the peer exists in Honcho.
 * Called once per user session.
 */
export async function ensurePeer(userId: string): Promise<void> {
  if (!honchoAvailable()) return;

  await fetch(`${HONCHO_URL}/v3/workspaces/${HONCHO_WORKSPACE}/peers`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${HONCHO_KEY}`,
    },
    body: JSON.stringify({ id: userId }),
  }).catch(() => { /* peer may already exist, or Honcho is down — non-fatal */ });
}

/**
 * Create or retrieve a session for this job.
 * Returns the session id (same as the input id on creation).
 */
export async function ensureSession(jobId: string, peerId: string): Promise<string> {
  if (!honchoAvailable()) return jobId;

  const sid = jobId.slice(0, 128);

  // Try to retrieve first
  try {
    await fetch(
      `${HONCHO_URL}/v3/workspaces/${HONCHO_WORKSPACE}/sessions/${encodeURIComponent(sid)}`,
      {
        headers: { authorization: `Bearer ${HONCHO_KEY}` },
      },
    );
    return sid;
  } catch {
    // Session doesn't exist — create it
    await fetch(
      `${HONCHO_URL}/v3/workspaces/${HONCHO_WORKSPACE}/sessions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${HONCHO_KEY}`,
        },
        body: JSON.stringify({
          id: sid,
          peers: { [peerId]: {}, beezilla: {} },
        }),
      },
    ).catch(() => { /* non-fatal */ });
    return sid;
  }
}

/**
 * Push messages to a Honcho session.
 * @param messages — array of { content, peer_id } to send.
 */
export async function syncMessages(
  sessionId: string,
  peerId: string,
  messages: Array<{ content: string; peer_id: string }>,
): Promise<void> {
  if (!honchoAvailable() || !messages.length) return;

  await fetch(
    `${HONCHO_URL}/v3/workspaces/${HONCHO_WORKSPACE}/sessions/${encodeURIComponent(sessionId)}/messages`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${HONCHO_KEY}`,
      },
      body: JSON.stringify({ messages }),
    },
  ).catch(() => { /* non-fatal */ });
}
