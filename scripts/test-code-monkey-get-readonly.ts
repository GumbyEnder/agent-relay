/**
 * GET /api/buzzy/code is a read — the workshop's poll must never move the project.
 *
 * The bug this pins (review hold on PR #372, 2026-11-28): GET ?job= called
 * readCodeProject, which released slices, created independent review missions,
 * moved missions and counted spend. An open workshop tab polling that endpoint
 * advanced the project and every review mission it opened was money. `no-store`
 * does not make a read read-only.
 *
 * So this test drives the real route handler (not just the function behind it):
 *   1. a builder delivers on the board, which is exactly the state where the old
 *      GET would open a review;
 *   2. GET /api/buzzy/code?job=<id>, twice, must answer the current project and
 *      change nothing at all: no review mission, no new mission, no moved mission,
 *      no spend counted, the next step still parked;
 *   3. GET /api/buzzy/code (the list) changes nothing either;
 *   4. POST { action: "tick", jobId } — the door the page now polls — does open
 *      that review. Progression still works; it just never rides on a GET.
 *
 * Run: npx tsx scripts/test-code-monkey-get-readonly.ts
 */
import { durableBoard, ensureBoardReady } from "../src/lib/board-store.server";
import { getSql } from "../src/lib/db";
import { startCodeProject } from "../src/lib/buzzy/codeMonkey.server";
import codeRoute from "../src/lib/buzzy/codeMonkey.nitro";

process.env.BZ_CODE_HARNESS = "claude_code";
process.env.BZ_CODE_REVIEW_HARNESS = "codex";

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  }
}

type LinkedSlice = { key: string; missionId: string; reviewMissionId?: string };
type Link = {
  projectId: string;
  agentName: string;
  slices: LinkedSlice[];
  spend?: { usedCents: number };
};

async function main() {
  await ensureBoardReady();
  const sql = await getSql();
  const stamp = Date.now().toString(36);
  const owner = await durableBoard.adminCreateUser({
    email: `cm-get-${stamp}@example.test`,
    password: "testpass-99",
    name: "CM GET",
    role: "operator",
  });
  const token = `tok_cmget_${stamp}`;
  await sql`
    insert into "session" (id, token, "userId", "expiresAt", "createdAt", "updatedAt")
    values (${`ses_cmget_${stamp}`}, ${token}, ${owner.id}, now() + interval '1 day', now(), now())
  `;
  const headers = new Headers({
    cookie: `agent-relay.session_token=${token}`,
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    host: "localhost:8090",
    origin: "http://localhost:8090",
  });

  /** A minimal h3 event: the handler reads method, path, node.req.headers and req.text(). */
  function eventFor(method: string, path: string, body?: unknown) {
    return {
      method,
      path,
      node: { req: { method, headers, url: path } },
      req: { method, headers, text: async () => (body === undefined ? "" : JSON.stringify(body)) },
    } as any;
  }

  const made = await startCodeProject(sql, owner.id, {
    words: "a chore chart for our flat, budget $5",
    card: {
      making: "a chore chart",
      why: "nobody remembers whose turn it is",
      forWhom: "my flatmates",
      outcome: "we all see the rota",
      doneWhen: ["The chart shows this week's turns"],
      stakes: "play",
    },
    slices: [
      { key: "s1", title: "Show the rota", shows: "open the chart", doneWhen: ["The chart shows this week's turns"] },
      { key: "s2", title: "Tick a chore off", shows: "tick a box", doneWhen: ["Ticking a box marks it done for the week"], after: ["s1"] },
    ],
  });
  check("project started", made.ok, made.ok ? undefined : ("problems" in made ? made.problems : made.reason));
  if (!made.ok) return;
  const jobId = made.jobId;

  const linkOf = async (): Promise<Link> =>
    (await sql<{ data: { codeMonkey: Link } }>`SELECT data FROM buzzy_jobs WHERE id = ${jobId}`)[0].data.codeMonkey;
  const link = await linkOf();

  // The builder delivers. This is the exact moment the old GET would have opened a review.
  await durableBoard.claim(link.slices[0].missionId, link.agentName);
  await durableBoard.deliver(link.slices[0].missionId, link.agentName, "The rota renders. https://preview.example/rota", [
    "https://preview.example/rota.png",
  ]);

  const snapshot = async () => (await durableBoard.snapshot(link.projectId))!;
  const columns = (s: { missions: { id: string; column: string }[] }) =>
    JSON.stringify(s.missions.map((m) => [m.id, m.column]).sort());

  const before = await snapshot();
  const linkBefore = await linkOf();
  const parkedBefore = (await durableBoard.getMission(link.slices[1].missionId))?.column;

  console.log("1. GET ?job= answers the project and moves nothing:");
  const get1 = await codeRoute(eventFor("GET", `/api/buzzy/code?job=${jobId}`));
  const body1 = (await get1.json()) as { ok?: boolean; project?: { slices: { key: string; state: string }[] } };
  const get2 = await codeRoute(eventFor("GET", `/api/buzzy/code?job=${jobId}`));
  const body2 = (await get2.json()) as { ok?: boolean; project?: { slices: { key: string; state: string }[] } };

  check("GET answers 200 with the project", get1.status === 200 && body1.ok === true && Boolean(body1.project), get1.status);
  check("the delivered step reads as Checking", body1.project?.slices[0].state === "checking", body1.project?.slices[0]);
  check("a second GET answers the same, still 200", get2.status === 200 && body2.project?.slices[0].state === "checking");

  const after = await snapshot();
  const linkAfter = await linkOf();
  check("GET opened no review mission", !linkAfter.slices.find((s) => s.key === "s1")?.reviewMissionId, linkAfter.slices);
  check("GET created no mission at all", after.missions.length === before.missions.length, {
    before: before.missions.length,
    after: after.missions.length,
  });
  check("GET moved no mission", columns(after) === columns(before));
  check(
    "GET counted no spend",
    (linkAfter.spend?.usedCents ?? 0) === (linkBefore.spend?.usedCents ?? 0),
    { before: linkBefore.spend, after: linkAfter.spend },
  );
  check(
    "the next step is still parked",
    (await durableBoard.getMission(link.slices[1].missionId))?.column === parkedBefore,
  );

  console.log("2. GET the list moves nothing either:");
  const listRes = await codeRoute(eventFor("GET", "/api/buzzy/code"));
  const listBody = (await listRes.json()) as { ok?: boolean; projects?: { jobId: string }[] };
  const afterList = await snapshot();
  check("the list answers 200 with this project in it", listRes.status === 200 && (listBody.projects ?? []).some((p) => p.jobId === jobId), listRes.status);
  check("the list changed nothing", columns(afterList) === columns(before) && afterList.missions.length === before.missions.length);
  check("…and opened no review", !(await linkOf()).slices.find((s) => s.key === "s1")?.reviewMissionId);

  console.log("3. POST { action: \"tick\" } is the door that moves it:");
  const tickRes = await codeRoute(eventFor("POST", "/api/buzzy/code", { action: "tick", jobId }));
  const tickBody = (await tickRes.json()) as { ok?: boolean; project?: { slices: { key: string; state: string }[] } };
  const ticked = await linkOf();
  check("the tick answers 200", tickRes.status === 200 && tickBody.ok === true, tickRes.status);
  check("the tick opens the review mission the GET refused to open", Boolean(ticked.slices.find((s) => s.key === "s1")?.reviewMissionId), ticked.slices);
  check("the step is Checking on the board", (await durableBoard.getMission(link.slices[0].missionId))?.column === "review");
  check("the tick's answer still reads Checking", tickBody.project?.slices[0].state === "checking", tickBody.project?.slices[0]);

  console.log("4. a tick for a stranger's project is a 404, not a leak:");
  const nobody = await durableBoard.adminCreateUser({
    email: `cm-get-other-${stamp}@example.test`,
    password: "testpass-99",
    name: "Other",
    role: "operator",
  });
  const otherToken = `tok_cmget_other_${stamp}`;
  await sql`
    insert into "session" (id, token, "userId", "expiresAt", "createdAt", "updatedAt")
    values (${`ses_cmget_other_${stamp}`}, ${otherToken}, ${nobody.id}, now() + interval '1 day', now(), now())
  `;
  const otherHeaders = new Headers({ cookie: `agent-relay.session_token=${otherToken}`, authorization: `Bearer ${otherToken}` });
  const otherEvent = (method: string, path: string, body?: unknown) => ({
    method,
    path,
    node: { req: { method, headers: otherHeaders, url: path } },
    req: { method, headers: otherHeaders, text: async () => (body === undefined ? "" : JSON.stringify(body)) },
  }) as any;
  const strangerGet = await codeRoute(otherEvent("GET", `/api/buzzy/code?job=${jobId}`));
  const strangerTick = await codeRoute(otherEvent("POST", "/api/buzzy/code", { action: "tick", jobId }));
  check("a stranger's GET is 404", strangerGet.status === 404, strangerGet.status);
  check("a stranger's tick is 404", strangerTick.status === 404, strangerTick.status);
}

main()
  .then(() => {
    if (failures) {
      console.error(`\n${failures} check(s) failed`);
      process.exit(1);
    }
    console.log("\nall code-monkey read-only checks passed");
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
