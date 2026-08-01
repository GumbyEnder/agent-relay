/**
 * Outbound payload when a human resolves a Call.
 */
export interface ReplyWebhookPayload {
  type: "call.resolved";
  callId: string;
  missionId: string;
  projectId: string | null;
  reply: string;
  resolvedAt: number;
  agentId: string | null;
}

export function buildReplyWebhookPayload(input: {
  callId: string;
  missionId: string;
  projectId?: string | null;
  reply: string;
  resolvedAt?: number;
  agentId?: string | null;
}): ReplyWebhookPayload {
  return {
    type: "call.resolved",
    callId: input.callId,
    missionId: input.missionId,
    projectId: input.projectId ?? null,
    reply: input.reply,
    resolvedAt: input.resolvedAt ?? Date.now(),
    agentId: input.agentId ?? null,
  };
}

export async function dispatchReplyWebhook(
  url: string,
  payload: ReplyWebhookPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (!url?.trim()) return { ok: false, error: "no_url" };
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
