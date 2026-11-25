/**
 * /api/buzzy/art — the canvas's server half.
 *
 *   GET  /api/buzzy/art?job=<id>   → the saved board and the images on it
 *   POST /api/buzzy/art            → { action: "save", jobId, board }
 *                                  → { action: "render", prompt, jobId, refs[] }
 *                                  → { action: "edit", jobId, imageId, mask, instruction }
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

// A board is posted whole on every autosave (public/buzzy/sketch.html, 1.2s debounce),
// so one oversized board costs the user that whole upload on each pause in drawing.
// The page refuses over this same number first and says so out loud; this is the
// backstop for any other caller of the route.
const MAX_BOARD_BYTES = 8 * 1024 * 1024;

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
    // Backstop for the page's own cap. The board is re-posted whole on every
    // autosave, so its size is a cost the user pays on each pause in drawing:
    // measured 2026-11-23, without this check a 48 MB board was accepted and written
    // to jsonb (50,331,971 B in, 50,332,010 B back out) with nothing refusing it.
    const boardBytes = JSON.stringify(board).length;
    if (boardBytes > MAX_BOARD_BYTES) {
      return json(413, {
        error: "Board is too large to save (" + (boardBytes / (1024 * 1024)).toFixed(1) + " MB, limit 8 MB)",
        code: "payload_too_large",
        bytes: boardBytes,
      });
    }
    const owned = await sql`SELECT id FROM buzzy_jobs WHERE id = ${jobId} AND user_id = ${user.id} LIMIT 1`;
    if (!owned.length) return json(404, { error: "No such project", code: "not_found" });
    // The board is the project's source, so it lives beside its brief and survives
    // every reload — not in the browser's memory.
    const count = (k: string) => (Array.isArray((board as Record<string, unknown>)[k]) ? ((board as Record<string, unknown>)[k] as unknown[]).length : 0);
    // The board is the project's SOURCE, so it is listed as one: a project should show
    // what went in beside what came out. Kept as a single entry that is refreshed, not
    // one row per keystroke.
    const source = {
      kind: "board",
      label: `Sketch board — ${count("strokes")} marks, ${count("images")} images`,
      url: `/buzzy/sketch?job=${jobId}`,
      updatedAt: new Date().toISOString(),
    };
    await sql`
      UPDATE buzzy_jobs SET
        data = jsonb_set(
          jsonb_set(COALESCE(data, '{}'::jsonb), '{board}', ${JSON.stringify(board)}::jsonb, true),
          '{sources}',
          COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements(COALESCE(data->'sources', '[]'::jsonb)) x
                    WHERE x->>'kind' <> 'board'), '[]'::jsonb) || ${JSON.stringify([source])}::jsonb,
          true),
        updated_at = now()
      WHERE id = ${jobId} AND user_id = ${user.id}`;
    return json(200, { ok: true, saved: true });
  }

  // Saving the board itself as a Library file. The owner drew it, so there is no
  // model call and no quota: it is their own artwork being filed against the project
  // that produced it. Without the job_id the file would sit in the account with no
  // project to show it under, which is the orphan bug the render path just fixed.
  if (action === "file") {
    if (!jobId) return json(400, { error: "jobId is required to file a board", code: "bad_request" });
    const owned = await sql`SELECT id FROM buzzy_jobs WHERE id = ${jobId} AND user_id = ${user.id} LIMIT 1`;
    if (!owned.length) return json(404, { error: "No such project", code: "not_found" });
    const dataUrl = typeof body.dataUrl === "string" ? body.dataUrl : "";
    const parsed = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!parsed) return json(400, { error: "dataUrl must be a base64 PNG or JPEG", code: "bad_request" });
    const bytes = Buffer.from(parsed[2] as string, "base64");
    if (bytes.byteLength === 0) return json(400, { error: "That image is empty.", code: "bad_request" });
    if (bytes.byteLength > 16 * 1024 * 1024) return json(413, { error: "That image is over 16 MB.", code: "too_large" });
    const ext = parsed[1] === "image/jpeg" ? "jpg" : "png";
    const name = typeof body.name === "string" && body.name.trim()
      ? body.name.trim().replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80)
      : `sketch-${Date.now()}.${ext}`;
    const stored = await storeImage(user.id, bytes, name, parsed[1] as string);
    try {
      await sql`UPDATE buzzy_assets SET job_id = ${jobId} WHERE user_id = ${user.id} AND id = ${stored.id}`;
      await sql`
        UPDATE buzzy_jobs SET
          data = jsonb_set(COALESCE(data, '{}'::jsonb), '{artifacts}', COALESCE(data->'artifacts', '[]'::jsonb) || ${JSON.stringify([
            { kind: "image", id: String(stored.id), url: `/api/buzzy/assets/${stored.id}`, name, bytes: stored.bytes, type: parsed[1] },
          ])}::jsonb, true),
          updated_at = now()
        WHERE id = ${jobId} AND user_id = ${user.id}`;
    } catch { /* the file is stored either way */ }
    return json(200, { ok: true, image: { id: String(stored.id), url: `/api/buzzy/assets/${stored.id}`, name, bytes: stored.bytes, type: parsed[1] } });
  }

  // Region edit. "Make the coat red" on a finished picture used to mean re-rolling
  // the whole image and hoping the rest survived. A mask turns it into a change to
  // one part of the picture the owner actually chose, and the reference is the
  // existing render rather than the board — so nothing outside the mask is invented.
  if (action === "edit") {
    if (!jobId) return json(400, { error: "jobId is required to edit a picture", code: "bad_request" });
    const imageId = Number(body.imageId);
    const mask = typeof body.mask === "string" && body.mask.startsWith("data:image/") ? body.mask : "";
    const instruction = typeof body.instruction === "string" ? body.instruction.trim().slice(0, 1000) : "";
    if (!Number.isFinite(imageId) || imageId <= 0) return json(400, { error: "imageId is required", code: "bad_request" });
    if (!mask) return json(400, { error: "Draw the area to change first.", code: "bad_request" });
    if (!instruction) return json(400, { error: "Say what to change in that area.", code: "bad_request" });
    const rows = await sql`
      SELECT body, content_type FROM buzzy_assets
      WHERE id = ${imageId} AND user_id = ${user.id} AND job_id = ${jobId} LIMIT 1`;
    if (!rows.length) return json(404, { error: "No such picture on this project", code: "not_found" });
    const row = rows[0] as { body: Uint8Array | Buffer; content_type: string | null };
    const base = `data:${row.content_type || "image/png"};base64,${Buffer.from(row.body).toString("base64")}`;
    body.prompt =
      `${instruction}\n\nThe FIRST attached image is the current picture. The SECOND is a mask: ` +
      "white marks the ONLY area you may change. Change that area as instructed. Keep every pixel " +
      "outside the white area as it is — same colours, same shapes, same position.";
    body.refs = [base, mask];
  }

  // Repainting the painted part of a 3D model's texture (public/buzzy/model-paint.js;
  // testers, 2026-11-24: fixing the windshield "completely messed up all the treads").
  // The page sends the piece of the texture the paint covers and its mask; the answer is
  // the repainted piece, NOT kept in the Library (it is a working piece of a texture),
  // and the page puts back only the painted pixels, so nothing outside the paint changes.
  const repaint3d = action === "repaint3d";
  if (repaint3d) {
    const crop = typeof body.crop === "string" && /^data:image\/png;base64,/.test(body.crop) ? body.crop : "";
    const mask = typeof body.mask === "string" && /^data:image\/png;base64,/.test(body.mask) ? body.mask : "";
    const instruction = typeof body.instruction === "string" ? body.instruction.trim().slice(0, 600) : "";
    if (!crop || !mask) return json(400, { error: "Send the piece of the texture and its mask (PNG).", code: "bad_request" });
    if (crop.length > 12_000_000 || mask.length > 12_000_000) return json(413, { error: "That piece of the texture is too big.", code: "too_big" });
    if (!instruction) return json(400, { error: "Say how the painted area should change.", code: "bad_request" });
    body.prompt =
      `${instruction}\n\nThe FIRST attached image is part of a 3D model's texture map (flattened surface colours, not a photo). ` +
      "The SECOND is a mask: white marks the ONLY area you may change. Repaint that area as instructed, matching the " +
      "texture's style, scale, lighting and detail, and keep every pixel outside the white area exactly as it is. " +
      "Return an image of exactly the same size and framing as the first.";
    body.refs = [crop, mask];
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
  // The reference image the render was conditioned on is an INPUT of this project.
  // Storing it is what makes "source in, output out" auditable instead of folklore.
  let referenceSource: { kind: string; label: string; url: string; bytes: number } | null = null;
  // A texture piece sent for repainting is a working piece, not a picture of theirs: not kept.
  if (refs.length && !repaint3d) {
    try {
      const m = /^data:([^;,]+);base64,(.*)$/s.exec(refs[0]);
      if (m) {
        const bytes = Buffer.from(m[2]!, "base64");
        const stampRef = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        const refStored = await storeImage(user.id, bytes, `reference-${stampRef}.png`, m[1]!);
        if (jobId) await sql`UPDATE buzzy_assets SET job_id = ${jobId} WHERE user_id = ${user.id} AND id = ${refStored.id}`;
        referenceSource = {
          kind: "reference",
          label: `Reference image used for "${prompt.slice(0, 60)}${prompt.length > 60 ? "…" : ""}"`,
          url: `/api/buzzy/assets/${refStored.id}`,
          bytes: refStored.bytes,
        };
      }
    } catch { /* a reference that cannot be stored must not block the render */ }
  }
  const made = await generateImage(prompt, { referenceImages: refs });
  await recordUsage({
    userId: user.id, scope: "image", units: made.ok ? 1 : 0, ms: made.ms ?? 0,
    status: made.ok ? "ok" : "failed", code: made.ok ? null : made.code ?? "failed", model: imageModel(),
  }).catch(() => {});

  if (!made.ok || !made.bytes) {
    const status = made.code === "provider_plan_required" ? 402 : 502;
    return json(status, { error: made.error ?? "the provider did not return an image", code: made.code ?? "image_failed" });
  }
  if (repaint3d) {
    return json(200, { ok: true, image: `data:${made.contentType || "image/png"};base64,${made.bytes.toString("base64")}` });
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const name = `art-${stamp}.png`;
  const stored = await storeImage(user.id, made.bytes, name, made.contentType || "image/png");

  // Name the project the deliverable belongs to, and record the project if this
  // board was loose — a file that no work item claims is the bug we just fixed.
  if (jobId) {
    try {
      await sql`UPDATE buzzy_assets SET job_id = ${jobId} WHERE user_id = ${user.id} AND id = ${stored.id}`;
      const inputs = [
        { kind: "prompt", label: `Instruction: ${prompt.slice(0, 120)}`, url: `/buzzy/sketch?job=${jobId}`, updatedAt: new Date().toISOString() },
        ...(referenceSource ? [{ ...referenceSource, updatedAt: new Date().toISOString() }] : []),
      ];
      await sql`
        UPDATE buzzy_jobs SET status = 'Deliverable ready',
          data = jsonb_set(
            jsonb_set(COALESCE(data, '{}'::jsonb), '{artifacts}', COALESCE(data->'artifacts', '[]'::jsonb) || ${JSON.stringify([
              { kind: "image", id: String(stored.id), url: `/api/buzzy/assets/${stored.id}`, name, bytes: stored.bytes, type: made.contentType },
            ])}::jsonb, true),
            '{sources}',
            COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements(COALESCE(data->'sources', '[]'::jsonb)) x
                      WHERE x->>'kind' NOT IN ('prompt')), '[]'::jsonb) || ${JSON.stringify(inputs)}::jsonb,
            true),
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
