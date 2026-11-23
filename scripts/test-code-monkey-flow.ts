/**
 * Code Monkey's workshop, end to end on the real board store (PGlite, no network).
 *
 * Drives three projects the way agents would — claim, deliver with proof,
 * escalate, review — and checks what the owner sees and when the workshop
 * moves work on its own:
 *   1. play: slices release in order, proof auto-accepts, a question reaches the owner
 *   2. product: delivered work waits for an independent reviewer; FAIL sends it back
 *   3. one-way door: the owner says go ahead, then the held-back step completes it
 * Run: npx tsx scripts/test-code-monkey-flow.ts
 */
import { durableBoard as board, ensureBoardReady } from "../src/lib/board-store.server";
import { getSql } from "../src/lib/db";
import { startCodeProject, readCodeProject, ownerActs, listCodeProjects } from "../src/lib/buzzy/codeMonkey.server";

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  }
}

async function main() {
  await ensureBoardReady();
  const sql = await getSql();
  const user = `user_cm_${Date.now().toString(36)}`;
  const stranger = `${user}_other`;

  async function missionOf(jobId: string, key: string) {
    const rows = await sql<{ data: { codeMonkey: { slices: { key: string; missionId: string; reviewMissionId?: string }[]; agentName: string; reviewerName: string } } }>`
      SELECT data FROM buzzy_jobs WHERE id = ${jobId}`;
    const link = rows[0].data.codeMonkey;
    const s = link.slices.find((x) => x.key === key)!;
    return { missionId: s.missionId, reviewMissionId: s.reviewMissionId, agent: link.agentName, reviewer: link.reviewerName };
  }
  const stateOf = async (jobId: string) => {
    const v = await readCodeProject(sql, user, jobId);
    return Object.fromEntries((v?.slices ?? []).map((s) => [s.key, s.state]));
  };

  console.log("refuses a vague project before anything is created:");
  const vague = await startCodeProject(sql, user, {
    card: { making: "an app", forWhom: "people", outcome: "it is useful", doneWhen: ["It looks professional"], stakes: "product" },
    slices: [{ key: "s1", title: "Set up the database", shows: "", doneWhen: ["Tables exist"] }],
  });
  check("refused with reasons", !vague.ok && vague.problems.length >= 2, vague.ok ? "started" : vague.problems);

  console.log("1. a bedtime game (play):");
  const game = await startCodeProject(sql, user, {
    words: "a bedtime adventure game for my kids, 8 and 10",
    card: {
      making: "a bedtime adventure game",
      forWhom: "me and my two kids (8 and 10)",
      outcome: "we play a ten-minute story together before lights out",
      doneWhen: ["The kids can pick a hero and start a story on the iPad", "Every story ends within ten minutes"],
      stakes: "play",
      assumptions: ["Runs in the iPad's browser, no install"],
    },
    slices: [
      { key: "s1", title: "Pick a hero and see the first scene", shows: "open the link and tap a hero", doneWhen: ["Tapping a hero shows the forest scene"] },
      { key: "s2", title: "Choices change the story", shows: "tap a choice", doneWhen: ["Each choice leads to a different next scene"], after: ["s1"] },
    ],
  });
  check("started", game.ok, game.ok ? undefined : game.problems);
  if (!game.ok) return;
  const g = game.jobId;
  check("stakes stayed play", game.project.card.stakes === "play");
  check("first slice waits for an agent, second waits on the first", JSON.stringify(await stateOf(g)) === JSON.stringify({ s1: "waiting", s2: "waiting" }));
  const g1 = await missionOf(g, "s1");
  const g1m = await board.getMission(g1.missionId);
  check("first slice is claimable (Ready)", g1m?.column === "ready", g1m?.column);
  const g2m = await board.getMission((await missionOf(g, "s2")).missionId);
  check("second slice is parked until the first is done", g2m?.column === "blocked", g2m?.column);
  check("the brief carries the done checks and the proof wanted", /forest scene/.test(g1m?.acceptance ?? "") && /screenshot/.test(g1m?.acceptance ?? ""));

  const claimed = await board.claim(g1.missionId, g1.agent);
  check("an agent can claim it", claimed.ok, claimed);
  check("owner sees Working", (await stateOf(g)).s1 === "working");
  const asked = await board.escalate(g1.missionId, g1.agent, "Should the hero be an animal or a kid?");
  check("an agent question escalates", asked.ok, asked);
  const withQ = await readCodeProject(sql, user, g);
  const q = withQ?.slices.find((s) => s.key === "s1")?.question;
  check("owner sees Needs you with the question", withQ?.slices[0].state === "needs-you" && /animal/.test(q?.text ?? ""));
  check("a stranger cannot answer it", !(await ownerActs(sql, stranger, g, { kind: "answer", callId: q?.callId ?? "", text: "x" })).ok);
  const answered = await ownerActs(sql, user, g, { kind: "answer", callId: q?.callId ?? "", text: "An animal — a fox" });
  check("the owner answers", answered.ok, answered);
  check("the question is gone", !(await readCodeProject(sql, user, g))?.slices[0].question);

  await board.claim(g1.missionId, g1.agent);
  const delivered = await board.deliver(g1.missionId, g1.agent, "Fox hero and forest scene done. Try it: https://preview.example/game", ["https://preview.example/shot-1.png"]);
  check("the agent delivers with proof", delivered.ok, delivered);
  const afterDeliver = await stateOf(g);
  check("play + undoable work auto-accepts on proof", afterDeliver.s1 === "done", afterDeliver);
  const again = await stateOf(g);
  check("the next slice is released once its 'after' is done", again.s2 === "waiting" && (await board.getMission((await missionOf(g, "s2")).missionId))?.column === "ready");
  const view = await readCodeProject(sql, user, g);
  check("proof links reach the owner", (view?.slices[0].proof.links ?? []).includes("https://preview.example/shot-1.png") && (view?.slices[0].proof.links ?? []).includes("https://preview.example/game"));

  console.log("2. a game for kids everywhere (product, independent review):");
  const pub = await startCodeProject(sql, user, {
    words: "publish a game kids everywhere will enjoy on Steam",
    card: {
      making: "a puzzle game", forWhom: "kids everywhere", outcome: "kids solve a puzzle a day",
      doneWhen: ["A new puzzle appears every day at midnight"], stakes: "play",
    },
    slices: [{ key: "s1", title: "Solve today's puzzle", shows: "open the link and drag the pieces", doneWhen: ["Placing every piece shows 'Solved!'"] }],
  });
  check("started", pub.ok);
  if (!pub.ok) return;
  check("stakes raised to product by the words, not the model", pub.project.card.stakes === "product" && pub.project.stakesRaisedFrom === "play");
  const p1 = await missionOf(pub.jobId, "s1");
  await board.claim(p1.missionId, p1.agent);
  await board.deliver(p1.missionId, p1.agent, "Done", ["https://preview.example/puzzle"]);
  const pv = await stateOf(pub.jobId);
  check("delivered product work is Checking, not Done", pv.s1 === "checking", pv);
  const p1r = await missionOf(pub.jobId, "s1");
  check("an independent review mission exists", Boolean(p1r.reviewMissionId));
  const rm = await board.getMission(p1r.reviewMissionId!);
  check("the review asks for PASS/FAIL per check", /PASS or FAIL/.test(rm?.acceptance ?? "") && /Solved/.test(rm?.acceptance ?? ""));
  await board.claim(p1r.reviewMissionId!, p1r.reviewer);
  await board.deliver(p1r.reviewMissionId!, p1r.reviewer, "- FAIL Placing every piece shows 'Solved!' — the last piece does nothing\nVERDICT FAIL");
  const back = await stateOf(pub.jobId);
  check("a failed review sends the slice back to the builder", back.s1 === "waiting" && (await board.getMission(p1.missionId))?.column === "ready", back);
  await board.claim(p1.missionId, p1.agent);
  await board.deliver(p1.missionId, p1.agent, "Fixed the last piece", ["https://preview.example/puzzle-2"]);
  await readCodeProject(sql, user, pub.jobId);
  const p1r2 = await missionOf(pub.jobId, "s1");
  check("a fresh review follows the fix", Boolean(p1r2.reviewMissionId) && p1r2.reviewMissionId !== p1r.reviewMissionId);
  await board.claim(p1r2.reviewMissionId!, p1r2.reviewer);
  await board.deliver(p1r2.reviewMissionId!, p1r2.reviewer, "- PASS Placing every piece shows 'Solved!' (tried in Chrome)\nVERDICT PASS");
  check("a passing review lets undoable product work through", (await stateOf(pub.jobId)).s1 === "done");

  console.log("3. a one-way door (sending email):");
  const mail = await startCodeProject(sql, user, {
    card: { making: "a launch announcement", forWhom: "my newsletter subscribers", outcome: "they hear about the game", doneWhen: ["Each subscriber gets one email with the link"], stakes: "product" },
    slices: [{ key: "s1", title: "Email every subscriber the launch news", shows: "check your own inbox first", doneWhen: ["The email arrives with a working link"] }],
  });
  check("started", mail.ok);
  if (!mail.ok) return;
  check("the slice is a one-way door", mail.project.slices[0].door === "one-way");
  const m1 = await missionOf(mail.jobId, "s1");
  const mm = await board.getMission(m1.missionId);
  check("the brief tells the builder to hold the irreversible step", /do not run the irreversible step/.test(mm?.constraints ?? ""));
  await board.claim(m1.missionId, m1.agent);
  await board.deliver(m1.missionId, m1.agent, "Email built and test-sent to the owner only", ["https://preview.example/email.png"]);
  await readCodeProject(sql, user, mail.jobId);
  const m1r = await missionOf(mail.jobId, "s1");
  await board.claim(m1r.reviewMissionId!, m1r.reviewer);
  await board.deliver(m1r.reviewMissionId!, m1r.reviewer, "- PASS The email arrives with a working link\nVERDICT PASS");
  const ready = await readCodeProject(sql, user, mail.jobId);
  check("after review, the owner is asked (never auto-sent)", ready?.slices[0].state === "needs-you" && ready.slices[0].ownerLooks === true, ready?.slices[0]);
  check("'looks right' from a stranger is refused", !(await ownerActs(sql, stranger, mail.jobId, { kind: "looks-right", sliceKey: "s1" })).ok);
  const go = await ownerActs(sql, user, mail.jobId, { kind: "looks-right", sliceKey: "s1" });
  check("the owner says go ahead", go.ok, go);
  check("go ahead returns it to the builder to run the held-back step", (await board.getMission(m1.missionId))?.column === "ready");
  await board.claim(m1.missionId, m1.agent);
  await board.deliver(m1.missionId, m1.agent, "Sent to 312 subscribers", ["https://preview.example/sent-log"]);
  check("its delivery after go-ahead completes it", (await stateOf(mail.jobId)).s1 === "done");

  console.log("listing and privacy:");
  const mine = await listCodeProjects(sql, user);
  check("the owner's list has the three projects", mine.length === 3, mine.length);
  check("a stranger sees none of them", (await listCodeProjects(sql, stranger)).length === 0);
  check("a stranger can't read one", (await readCodeProject(sql, stranger, g)) === null);
  check("reading twice changes nothing more", JSON.stringify(await stateOf(g)) === JSON.stringify(await stateOf(g)));
}

main()
  .then(() => {
    if (failures) {
      console.error(`\n${failures} check(s) failed`);
      process.exit(1);
    }
    console.log("\nall code-monkey flow checks passed");
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
