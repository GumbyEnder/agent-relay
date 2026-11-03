import { BEEZILLA_HONCHO_WORKSPACE } from "./honcho.js";

export async function ensurePeer(
  userId: string,
  fetchImpl: typeof fetch,
  baseUrl: string,
): Promise<{ id: string; workspace: string }> {
  const id = userId.trim();
  if (!id) throw new Error("userId required");
  const url = `${baseUrl.replace(/\/$/, "")}/v3/workspaces/${BEEZILLA_HONCHO_WORKSPACE}/peers`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`ensurePeer ${res.status}`);
  }
  return { id, workspace: BEEZILLA_HONCHO_WORKSPACE };
}
