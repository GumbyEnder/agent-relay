/**
 * Deleting an orchestration graph — the wiring the store tests cannot see.
 *
 * The store test (test-orchestration-store.ts) proves the SQL: ownership, the
 * cascade, and the live-run refusal. This holds the two ends that connect a
 * person to it, because both had the same hole until now:
 *
 *   - the API block matched GET and POST only, so DELETE fell through to the
 *     405 at the bottom ("Use GET or POST") and a graph could never be removed;
 *   - the editor had Save but no Delete, so there was no path from the product.
 *
 * Hermetic: reads the two sources, no server, no database.
 *   npx tsx scripts/test-graph-delete.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let pass = 0, fail = 0;
const check = (cond: boolean, name: string, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const root = resolve(import.meta.dirname, "..");
const api = readFileSync(resolve(root, "src/lib/buzzy/chat.nitro.ts"), "utf8");
const page = readFileSync(resolve(root, "public/buzzy/orchestrate.html"), "utf8");

// ── The API: DELETE lives inside the graphs block, not somewhere else ──────
const start = api.indexOf('if (path === "/api/buzzy/graphs"');
const end = api.indexOf("// ── POST /api/buzzy/chat", start);
check(start > 0 && end > start, "the graphs block is still one contiguous branch");
const block = start > 0 && end > start ? api.slice(start, end) : "";

check(block.includes('if (method === "DELETE")'), "the graphs block answers DELETE");
check(block.includes("await deleteGraph(user.id, graphId)"), "DELETE goes through the owner-scoped store call");
check(block.includes('code: "not_found"'), "a graph that is not yours is not_found, not a silent success");
check(block.includes('code: "active_run"') && block.includes("setResponseStatus(event, 409)"), "a live run is refused with 409, not cascaded away");
check(block.includes("runsDeleted"), "the response says how much run history went with it");
check(block.includes('"Use GET, POST or DELETE."'), "the fall-through message names DELETE (it used to read 'Use GET or POST')");

// ── The page: a person can actually reach it ──────────────────────────────
check(page.includes('id="btnDelete"'), "the editor has a Delete control");
check(page.includes('method: "DELETE", credentials: "same-origin"'), "the control sends a same-origin DELETE");
check(page.includes('"/api/buzzy/graphs/" + encodeURIComponent(graphId), { method: "DELETE"'), "it deletes the graph that is open, by id");
check((page.match(/syncDeleteBtn\(\);/g) || []).length >= 3, "the button's enabled state follows save / open / new", `${(page.match(/syncDeleteBtn\(\);/g) || []).length} calls`);
check(page.includes("run history go with it"), "the confirm names what else is deleted before the person agrees");

const delStart = page.indexOf('$("#btnDelete").addEventListener');
const delEnd = page.indexOf('$("#btnSave").addEventListener', delStart);
const handler = delStart > 0 && delEnd > delStart ? page.slice(delStart, delEnd) : "";
check(handler.length > 0, "the delete handler is a contiguous block");
check(handler.includes('localStorage.removeItem("bz_orch_spec")'), "the deleted graph's browser draft is cleared, so it cannot come back on reload");
check(handler.includes("clearTimeout(saveTimer)"), "the draft timer cannot rewrite it after the delete");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
