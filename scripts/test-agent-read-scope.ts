/**
 * Board read routes show a caller only the boards it may see (2026-11-18).
 *
 * Found while writing docs/HARNESS_SKILLS.md: GET /api/agent/calls loaded every
 * board's human calls with no board check, so an agent key from one board could
 * read the questions agents on every other board were asking their people. GET
 * /stale, GET /events/stream and GET /lane-gate had the same gap, and on a server
 * that requires sign-in a signed-out browser could read all four. Each route now
 * goes through resolveCallerListScope, the gate GET /export already uses:
 *   agent key            → its key's board and the boards its agent was added to
 *   signed-in person     → the boards they can open
 *   server-wide key      → every board (an operator credential)
 *   signed out           → 401
 *
 * Drives handleAgentApiRequest directly with two private boards, one agent key
 * on each, the server-wide key and a signed-out same-origin browser.
 */
process.env.AGENT_RELAY_HUMAN_AUTH = "1"; // a server where sign-in is required
process.env.AGENT_RELAY_STALE_HEARTBEAT_MS = "1000";
const GLOBAL_KEY = `scope-global-${Date.now().toString(36)}`;
process.env.AGENT_RELAY_API_KEY = GLOBAL_KEY;

import { durableBoard, ensureBoardReady } from "../src/lib/board-store.server";
import { handleAgentApiRequest } from "../src/lib/agent-api.server";
import { getSql } from "../src/lib/db";

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

type Caller = { key?: string; browser?: boolean };
type Body = Record<string, unknown>;

async function send(path: string, who: Caller, method = "GET", body?: Body): Promise<Response> {
  const headers: Record<string, string> = {};
  if (who.key) headers.authorization = `Bearer ${who.key}`;
  if (who.browser) headers["sec-fetch-site"] = "same-origin";
  if (body) headers["content-type"] = "application/json";
  return handleAgentApiRequest(
    new Request(`http://local/api/agent${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
}

async function read(path: string, who: Caller): Promise<{ status: number; body: Body }> {
  const res = await send(path, who);
  const text = await res.text();
  let body: Body = {};
  try {
    body = JSON.parse(text) as Body;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

/** The first `board` event of GET /events/stream, or the error status. */
async function firstStreamBoard(who: Caller): Promise<{ status: number; board?: Body }> {
  const res = await send("/events/stream", who);
  if (res.status !== 200 || !res.body) {
    await res.text().catch(() => "");
    return { status: res.status };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 5000;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const m = buf.match(/event: board\ndata: (.*)\n\n/);
      if (m) return { status: 200, board: JSON.parse(m[1]!) as Body };
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return { status: 200 };
}

async function main() {
  await ensureBoardReady();
  const stamp = Date.now().toString(36);

  async function boardWithAgent(label: string) {
    const board = await durableBoard.createProject({
      name: `Read scope ${label} ${stamp}`,
      slug: `read-scope-${label}-${stamp}`,
      ownerUserId: `owner_${label}_${stamp}`,
    });
    const registered = await durableBoard.registerAgent({
      name: `scope-${label}-${stamp}`,
      harness: "custom",
      role: "client",
      projectId: board.id,
    });
    assert(registered.ok, `register agent on ${label}`);
    const key = await durableBoard.createApiKey({
      projectId: board.id,
      agentId: registered.data.agent.id,
      name: `read-scope-${label}`,
    });
    const caller: Caller = { key: key.secret };

    // One mission whose agent asks its person a question (an open human call)…
    const asked = await durableBoard.createMission({
      title: `Asks a person ${label}`,
      objective: `private to board ${label}`,
      projectId: board.id,
      column: "ready",
    });
    assert(asked.ok, `mission on ${label}`);
    const askedId = asked.data.mission.id;
    const claim1 = await send(`/missions/${askedId}/claim`, caller, "POST", {});
    assert(claim1.status === 200, `claim on ${label}: ${claim1.status} ${await claim1.text()}`);
    const question = `Private question from board ${label} ${stamp}`;
    const esc = await send(`/missions/${askedId}/escalate`, caller, "POST", { question });
    assert(esc.status === 200, `escalate on ${label}: ${esc.status} ${await esc.text()}`);

    // …and one that stays running with no heartbeat, so it goes stale.
    const quiet = await durableBoard.createMission({
      title: `Goes quiet ${label}`,
      objective: `private to board ${label}`,
      projectId: board.id,
      column: "ready",
    });
    assert(quiet.ok, `second mission on ${label}`);
    const quietId = quiet.data.mission.id;
    const claim2 = await send(`/missions/${quietId}/claim`, caller, "POST", {});
    assert(claim2.status === 200, `claim 2 on ${label}: ${claim2.status} ${await claim2.text()}`);

    // A lane moved with no lane history: a problem the lane report lists.
    const sql = await getSql();
    await sql.query(`UPDATE ar_missions SET lane = 'evidence' WHERE id = $1`, [askedId]);

    return { board, caller, question, askedId, quietId };
  }

  const A = await boardWithAgent("a");
  const B = await boardWithAgent("b");
  const server: Caller = { key: GLOBAL_KEY };
  const signedOut: Caller = { browser: true };
  await new Promise((r) => setTimeout(r, 1300)); // past the 1s stale threshold

  const questions = (body: Body) =>
    ((body.calls as Array<{ question: string }> | undefined) ?? []).map((c) => c.question);
  const missionIds = (body: Body) =>
    ((body.missions as Array<{ id: string }> | undefined) ?? []).map((m) => m.id);

  // ── GET /calls ──
  {
    const a = await read("/calls", A.caller);
    assert(a.status === 200, `A key lists calls: ${a.status}`);
    assert(questions(a.body).includes(A.question), "A key sees its own board's question");
    assert(!questions(a.body).includes(B.question), "A key must not see board B's question");

    const b = await read("/calls", B.caller);
    assert(questions(b.body).includes(B.question), "B key sees its own board's question");
    assert(!questions(b.body).includes(A.question), "B key must not see board A's question");

    const all = await read("/calls", server);
    assert(
      questions(all.body).includes(A.question) && questions(all.body).includes(B.question),
      "the server-wide key sees every board",
    );

    const narrowed = await read(`/calls?project=${A.board.id}`, server);
    assert(
      questions(narrowed.body).includes(A.question) && !questions(narrowed.body).includes(B.question),
      "?project= narrows to one board",
    );

    const other = await read(`/calls?project=${B.board.id}`, A.caller);
    assert(other.status === 404, `A key asking for board B gets 404, got ${other.status}`);

    const out = await read("/calls", signedOut);
    assert(out.status === 401, `signed-out browser gets 401 on /calls, got ${out.status}`);
    console.log("✓ GET /calls is limited to the caller's boards");
  }

  // ── GET /stale ──
  {
    const all = await read("/stale", server);
    assert(all.status === 200, `server key reads stale: ${all.status}`);
    assert(
      missionIds(all.body).includes(A.quietId) && missionIds(all.body).includes(B.quietId),
      `both quiet missions are stale for the server key (got ${JSON.stringify(missionIds(all.body))})`,
    );

    const a = await read("/stale", A.caller);
    assert(a.status === 200, `A key reads stale: ${a.status}`);
    assert(missionIds(a.body).includes(A.quietId), "A key sees its own stale mission");
    assert(!missionIds(a.body).includes(B.quietId), "A key must not see board B's stale mission");
    assert(
      !((a.body.staleIds as string[] | undefined) ?? []).includes(B.quietId),
      "A key must not see board B's stale mission id",
    );

    const other = await read(`/stale?project=${B.board.id}`, A.caller);
    assert(other.status === 404, `A key asking for board B's stale missions gets 404, got ${other.status}`);

    const out = await read("/stale", signedOut);
    assert(out.status === 401, `signed-out browser gets 401 on /stale, got ${out.status}`);
    console.log("✓ GET /stale is limited to the caller's boards");
  }

  // ── GET /events/stream ──
  {
    const a = await firstStreamBoard(A.caller);
    assert(a.status === 200 && a.board, `A key opens the stream: ${a.status}`);
    assert(a.board.missionCount === 2, `A key's stream counts only board A's 2 missions, got ${a.board.missionCount}`);
    const latest = a.board.latestEvent as { missionId?: string | null; projectId?: string | null } | null;
    assert(
      !latest || latest.projectId === A.board.id || latest.missionId === A.askedId || latest.missionId === A.quietId,
      `A key's stream must not show board B's latest event (got ${JSON.stringify(latest)})`,
    );

    const all = await firstStreamBoard(server);
    assert(all.status === 200 && all.board, "server key opens the stream");
    assert(Number(all.board.missionCount) >= 4, "server key's stream counts every board");

    const out = await firstStreamBoard(signedOut);
    assert(out.status === 401, `signed-out browser gets 401 on the stream, got ${out.status}`);
    console.log("✓ GET /events/stream is limited to the caller's boards");
  }

  // ── GET /lane-gate ──
  {
    const onBoard = (body: Body, boardId: string) =>
      ((body.violations as Array<{ project_id: string | null }> | undefined) ?? []).some(
        (v) => v.project_id === boardId,
      );
    const all = await read("/lane-gate", server);
    assert(all.status === 200, `server key reads the lane report: ${all.status}`);
    assert(
      onBoard(all.body, A.board.id) && onBoard(all.body, B.board.id),
      "the server-wide key's lane report covers both boards",
    );

    const a = await read("/lane-gate", A.caller);
    assert(a.status === 200, `A key reads the lane report: ${a.status}`);
    assert(!onBoard(a.body, B.board.id), "A key must not see board B's lane problems");
    const everyBoard = ((a.body.violations as Array<{ project_id: string | null }> | undefined) ?? []).every(
      (v) => v.project_id === A.board.id,
    );
    assert(everyBoard, "A key's lane report lists board A only");
    assert(onBoard(a.body, A.board.id), "A key still sees board A's lane problems");
    assert(
      (a.body.counts as { global?: number } | undefined)?.global ===
        ((a.body.violations as unknown[] | undefined) ?? []).length,
      "A key's counts describe board A only",
    );

    const own = await read(`/lane-gate?project_id=${A.board.id}`, A.caller);
    assert(own.status === 200 && onBoard(own.body, A.board.id), "A key reads its own board's lane report");
    assert(
      (own.body.counts as { global?: number } | undefined)?.global ===
        ((a.body.violations as unknown[] | undefined) ?? []).length,
      "A key's one-board report counts board A only, not every board",
    );

    const other = await read(`/lane-gate?project_id=${B.board.id}`, A.caller);
    assert(other.status === 404, `A key asking for board B's lane report gets 404, got ${other.status}`);

    const out = await read("/lane-gate", signedOut);
    assert(out.status === 401, `signed-out browser gets 401 on /lane-gate, got ${out.status}`);
    console.log("✓ GET /lane-gate is limited to the caller's boards");
  }

  console.log("test-agent-read-scope: all checks passed");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
