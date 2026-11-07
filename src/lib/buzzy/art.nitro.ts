/**
 * /api/buzzy/art — the canvas's server half.
 *
 *   GET  /api/buzzy/art?job=<id>   → the saved board and the images on it
 *   POST /api/buzzy/art            → { action: "save", jobId, board }
 *                                  → { action: "render", prompt, jobId, refs[] }
 *
 * A rendered image is a deliverable of the project, exactly like a track: it lands
 * in buzzy_assets with job_id set, so the project page and the Library show the same
 * file and nothing is orphaned.
 */
import { defineEventHandler, getMethod, setResponseStatus } from "h3";
import { getSessionUserFromHeaders } from "@/lib/auth/verify.server";
import { getSql } from "@/lib/db";
import { checkQuota, recordUsage } from "./entitlements";
import { artConfigured, generateImage, storeImage, imageModel } from "./art";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Matches chat.nitro.ts: h3 hands us node headers, and the auth helper wants a Headers.
function headersFromEvent(event: any): Headers {
  const rawHeaders = event.node?.req?.headers ?? event.req?.headers;
  if (rawHeaders instanceof Headers) return rawHeaders;
  const init: [string, string][] = Object.entries(
    (rawHeaders ?? {}) as Record<string, string | string[] | undefined>,
  ).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : (v ?? "")]);
  return new Headers(init);
}

export default defineEventHandler(async (event) => {
  const method = getMethod(event);
  const user = await getSessionUserFromHeaders(headersFromEvent(event));
  if (!user) return json(401, { error: "Sign in required", code: "signed_out" });

  const fullPath = event.path ?? "";
  const qs = fullPath.includes("?") ? fullPath.slice(fullPath.indexOf("?") + 1) : "";
  const params = new URLSearchParams(qs);
  const sql = await getSql();

  if (method === "GET") {
    const jobId = params.get("job");
    if (!jobId) return json(400, { error: "job is required", code: "bad_request" });
    const rows = await sql`
      SELECT id, title, status, data FROM buzzy_jobs
      WHERE id = ${jobId} AND user_id = ${user.id} LIMIT 1`;
    if (!rows.length) return json(404, { error: "No such project", code: "not_found" });
    const data = (rows[0] as { data: Record<string, unknown> }).data ?? {};
    const images = await sql`
      SELECT id, filename, content_type, bytes, created_at FROM buzzy_assets
      WHERE user_id = ${user.id} AND job_id = ${jobId} AND content_type LIKE 'image/%'
      ORDER BY created_at ASC`;
    return json(200, {
      ok: true,
      configured: artConfigured(),
      model: imageModel(),
      board: data.board ?? null,
      images: images.map((a: Record<string, unknown>) => ({
        id: String(a.id),
        url: `/api/buzzy/assets/${a.id}`,
        name: a.filename,
        bytes: a.bytes,
        type: a.content_type,
      })),
    });
  }

  if (method !== "POST") return json(405, { error: "method not allowed" });

  let body: Record<string, unknown> = {};
  try {
    const parsed = await event.req.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch { /* empty body */ }

  const action = typeof body.action === "string" ? body.action : "render";
  const jobId = typeof body.jobId === "string" && body.jobId ? body.jobId : null;

  if (action === "save") {
    if (!jobId) return json(400, { error: "jobId is required to save a board", code: "bad_request" });
    const board = body.board && typeof body.board === "object" ? body.board : null;
    if (!board) return json(400, { error: "board is required", code: "bad_request" });
    const owned = await sql`SELECT id FROM buzzy_jobs WHERE id = ${jobId} AND user_id = ${user.id} LIMIT 1`;
    if (!owned.length) return json(404, { error: "No such project", code: "not_found" });
    // The board is the project's source, so it lives beside its brief and survives
    // every reload — not in the browser's memory.
    await sql`
      UPDATE buzzy_jobs SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{board}', ${JSON.stringify(board)}::jsonb, true),
        updated_at = now()
      WHERE id = ${jobId} AND user_id = ${user.id}`;
    return json(200, { ok: true, saved: true });
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 4000) : "";
  if (!prompt) return json(400, { error: "Describe what to create.", code: "bad_request" });
  if (!artConfigured()) return json(503, { error: "Art is not configured on this deployment.", code: "not_configured" });

  const verdict = await checkQuota({ userId: user.id, scope: "image", units: 1 });
  if (!verdict.ok) {
    // 402 is "pay for it", 429 is "you've had your share today" — never a 5xx.
    const status = verdict.code === "plan_required" ? 402 : 429;
    await recordUsage({
      userId: user.id, scope: "image", units: 0, ms: 0,
      status: "refused", code: verdict.code ?? "refused", model: imageModel(),
    }).catch(() => {});
    return json(status, { error: verdict.error, code: verdict.code, plan: verdict.plan, limit: verdict.limit, used: verdict.used });
  }

  const refs = Array.isArray(body.refs) ? (body.refs as unknown[]).filter((r): r is string => typeof r === "string") : [];
  const made = await generateImage(prompt, { referenceImages: refs });
  await recordUsage({
    userId: user.id, scope: "image", units: made.ok ? 1 : 0, ms: made.ms ?? 0,
    status: made.ok ? "ok" : "failed", code: made.ok ? null : made.code ?? "failed", model: imageModel(),
  }).catch(() => {});

  if (!made.ok || !made.bytes) {
    const status = made.code === "provider_plan_required" ? 402 : 502;
    return json(status, { error: made.error ?? "the provider did not return an image", code: made.code ?? "image_failed" });
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const name = `art-${stamp}.png`;
  const stored = await storeImage(user.id, made.bytes, name, made.contentType || "image/png");

  // Name the project the deliverable belongs to, and record the project if this
  // board was loose — a file that no work item claims is the bug we just fixed.
  if (jobId) {
    try {
      await sql`UPDATE buzzy_assets SET job_id = ${jobId} WHERE user_id = ${user.id} AND id = ${stored.id}`;
      await sql`
        UPDATE buzzy_jobs SET status = 'Deliverable ready',
          data = jsonb_set(COALESCE(data, '{}'::jsonb), '{artifacts}', COALESCE(data->'artifacts', '[]'::jsonb) || ${JSON.stringify([
            { kind: "image", id: String(stored.id), url: `/api/buzzy/assets/${stored.id}`, name, bytes: stored.bytes, type: made.contentType },
          ])}::jsonb, true),
          updated_at = now()
        WHERE id = ${jobId} AND user_id = ${user.id}`;
    } catch { /* link is an improvement, not a gate */ }
  }

  return json(200, {
    ok: true,
    image: {
      url: `/api/buzzy/assets/${stored.id}`,
      name,
      bytes: stored.bytes,
      type: made.contentType || "image/png",
      id: String(stored.id),
    },
    model: made.model,
    ms: made.ms,
  });
});
