/**
 * /api/buzzy/studio — the music studio's endpoints.
 *
 *   GET  /api/buzzy/studio?job=<id>      → plan, current render, versions, edit log
 *   POST /api/buzzy/studio               → { action: "save", jobId, plan }
 *                                        → { action: "render", jobId, plan }
 *                                        → { action: "edit", jobId, instruction, fromMs, toMs, actor }
 *
 * The edit endpoint is the one the owner uses by selecting a region on the waveform,
 * and the one the agent uses when told "make the second verse darker". Both write the
 * same `buzzy_music_edits` row, so the studio's change list and what the agent is told
 * about the track cannot drift apart.
 */
import { defineEventHandler, getMethod, readBody } from "h3";
import { getSessionUserFromHeaders } from "@/lib/auth/verify.server";
import { getStudio, renderTrack, savePlan, type MusicPlan } from "./studio";
import { musicConfigured } from "./music";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function headersFromEvent(event: any): Headers {
  const rawHeaders = event.node?.req?.headers ?? event.req?.headers;
  if (rawHeaders instanceof Headers) return rawHeaders;
  const init: [string, string][] = Object.entries(
    (rawHeaders ?? {}) as Record<string, string | string[] | undefined>,
  ).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : (v ?? "")]);
  return new Headers(init);
}

function planFromBody(raw: unknown): Partial<MusicPlan> {
  const b = (raw ?? {}) as Record<string, unknown>;
  const out: Partial<MusicPlan> = {};
  if (typeof b.prompt === "string") out.prompt = b.prompt.slice(0, 1200);
  if (typeof b.lyrics === "string") out.lyrics = b.lyrics.slice(0, 4000);
  if (Array.isArray(b.instruments)) out.instruments = b.instruments.map(String).slice(0, 24);
  if (Array.isArray(b.sections)) {
    out.sections = b.sections.slice(0, 24).map((s) => {
      const o = (s ?? {}) as Record<string, unknown>;
      return {
        label: String(o.label ?? "section"),
        fromSec: Number(o.fromSec ?? 0),
        toSec: Number(o.toSec ?? 0),
        note: o.note ? String(o.note) : undefined,
      };
    });
  }
  if (typeof b.tempo === "string") out.tempo = b.tempo.slice(0, 40);
  if (typeof b.key === "string") out.key = b.key.slice(0, 40);
  if (b.seconds != null) out.seconds = Number(b.seconds);
  return out;
}

export default defineEventHandler(async (event: any) => {
  const method = getMethod(event);
  const user = await getSessionUserFromHeaders(headersFromEvent(event));
  if (!user) return json(401, { error: "Sign in required", code: "signed_out" });

  const fullPath = event.path ?? "";
  const qs = fullPath.includes("?") ? fullPath.slice(fullPath.indexOf("?") + 1) : "";
  const params = new URLSearchParams(qs);

  if (method === "GET") {
    const jobId = params.get("job");
    if (!jobId) return json(400, { error: "job is required", code: "bad_request" });
    const state = await getStudio(user.id, jobId);
    if (!state) return json(404, { error: "No such project", code: "not_found" });
    return json(200, { ok: true, musicConfigured: musicConfigured(), ...state });
  }
  if (method !== "POST") return json(405, { error: "method not allowed" });

  const body = (await readBody(event).catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action ?? "");
  const jobId = String(body.jobId ?? "");
  if (!jobId) return json(400, { error: "jobId is required", code: "bad_request" });

  const state = await getStudio(user.id, jobId);
  if (!state) return json(404, { error: "No such project", code: "not_found" });

  if (action === "save") {
    const merged = await savePlan(user.id, jobId, planFromBody(body.plan ?? body));
    return json(200, { ok: true, plan: merged });
  }

  if (action === "render" || action === "edit") {
    const plan: MusicPlan = { ...state.plan, ...planFromBody(body.plan ?? body) };
    if (!plan.prompt && !plan.lyrics && !plan.instruments.length) {
      return json(400, { error: "Describe the music first — a prompt, lyrics or instruments.", code: "empty_plan" });
    }
    const isEdit = action === "edit";
    const fromMs = isEdit && body.fromMs != null ? Math.max(0, Math.round(Number(body.fromMs))) : null;
    const toMs = isEdit && body.toMs != null ? Math.max(0, Math.round(Number(body.toMs))) : null;
    const instruction = isEdit ? String(body.instruction ?? "").trim().slice(0, 400) : undefined;
    if (isEdit && !instruction) return json(400, { error: "Tell the studio what to change.", code: "no_instruction" });

    const actor = body.actor === "agent" ? "agent" : "user";
    const out = await renderTrack(user.id, jobId, { plan, actor, instruction, fromMs, toMs });
    if (!out.ok) {
      const status = out.code === "plan_required" || out.code === "paid_plan_required" ? 402
        : out.code === "quota_exhausted" ? 429
        : 502;
      return json(status, { ok: false, code: out.code, error: out.error });
    }
    const after = await getStudio(user.id, jobId);
    return json(200, { ...out, state: after });
  }

  return json(400, { error: `unknown action: ${action}`, code: "bad_action" });
});
