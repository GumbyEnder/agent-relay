/**
 * /api/buzzy/code — Code Monkey's workshop (src/lib/buzzy/codeMonkey.server.ts).
 *
 *   GET  /api/buzzy/code                → { projects: [...] } the person's coding projects
 *   GET  /api/buzzy/code?job=<id>       → one project: result card, slices, proof, questions
 *   POST /api/buzzy/code                → { action: "start", card, slices, words?, budgetDollars? }
 *                                       → { action: "answer", jobId, callId, text }
 *                                       → { action: "looks-right", jobId, slice }
 *                                       → { action: "not-yet", jobId, slice, text }
 *                                       → { action: "add-budget", jobId, dollars }
 *
 * Reading a project also moves it along (releases slices, opens reviews, accepts
 * what the policy allows), so the page only ever polls GET.
 */
import { defineEventHandler, getMethod } from "h3";
import { getSessionUserFromHeaders } from "@/lib/auth/verify.server";
import { getSql } from "@/lib/db";
import { startCodeProject, readCodeProject, ownerActs, listCodeProjects } from "./codeMonkey.server";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const MAX_BODY_BYTES = 64 * 1024;

// Matches art.nitro.ts: h3 hands us node headers, and the auth helper wants a Headers.
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
  const sql = await getSql();
  const fullPath = event.path ?? "";
  const params = new URLSearchParams(fullPath.includes("?") ? fullPath.slice(fullPath.indexOf("?") + 1) : "");

  if (method === "GET") {
    const jobId = params.get("job");
    if (!jobId) return json(200, { ok: true, projects: await listCodeProjects(sql, user.id) });
    const project = await readCodeProject(sql, user.id, jobId);
    if (!project) return json(404, { error: "No such coding project", code: "not_found" });
    return json(200, { ok: true, project });
  }
  if (method !== "POST") return json(405, { error: "method not allowed" });

  let body: Record<string, unknown>;
  try {
    const raw = await event.req.text();
    if (raw.length > MAX_BODY_BYTES) return json(413, { error: "Too big", code: "too_big" });
    body = JSON.parse(raw || "{}");
  } catch {
    return json(400, { error: "Bad JSON", code: "bad_request" });
  }
  const action = String(body.action || "");
  const jobId = String(body.jobId || "");

  if (action === "start") {
    const r = await startCodeProject(sql, user.id, {
      card: body.card,
      slices: body.slices,
      words: typeof body.words === "string" ? body.words.slice(0, 4000) : undefined,
      budgetDollars: body.budgetDollars,
      companyId: typeof body.companyId === "string" ? body.companyId : null,
    });
    return r.ok ? json(200, r) : json(422, r);
  }
  const owner = user.email || "owner";
  if (action === "add-budget") {
    // The owner's own tap is the only way a budget grows.
    const r = await ownerActs(sql, user.id, jobId, { kind: "add-budget", dollars: Number(body.dollars) }, owner);
    return json(r.ok ? 200 : r.error === "not_found" ? 404 : 400, r);
  }
  if (action === "answer") {
    const r = await ownerActs(sql, user.id, jobId, { kind: "answer", callId: String(body.callId || ""), text: String(body.text || "") }, owner);
    return json(r.ok ? 200 : r.error === "not_found" ? 404 : 400, r);
  }
  if (action === "looks-right" || action === "not-yet") {
    const sliceKey = String(body.slice || "");
    const r = await ownerActs(
      sql,
      user.id,
      jobId,
      action === "looks-right" ? { kind: "looks-right", sliceKey } : { kind: "not-yet", sliceKey, text: String(body.text || "") },
      owner,
    );
    return json(r.ok ? 200 : r.error === "not_found" ? 404 : 409, r);
  }
  return json(400, { error: "Unknown action", code: "bad_request" });
});
