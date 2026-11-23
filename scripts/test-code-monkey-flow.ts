/**
 * Code Monkey's workshop, end to end on the real board store (PGlite, no network).
 *
 * Drives projects the way agents would — claim, deliver with proof, escalate,
 * review — and checks what the owner sees and when the workshop moves work on
 * its own, under the owner's decisions of 2026-11-23 (docs/beezilla/CODE-MONKEY.md):
 *   1. play: steps release in order; EVERY step gets a review by another company;
 *      a question reaches the owner; no proof → sent back; the owner's words kept
 *   2. product: a failed review sends the step back; a fresh review follows
 *   3. one-way door (email): reviewed first, then the owner says go, then it runs
 *   4. launch authorized in the owner's own words: no stop, but only after review
 *   5. go-ahead on the first launch becomes this project's launch policy
 *   6. no reviewer from another company: "not independently reviewed", never "passed"
 * Run: npx tsx scripts/test-code-monkey-flow.ts
 */
import { durableBoard as board, ensureBoardReady } from "../src/lib/board-store.server";
import { getSql } from "../src/lib/db";
import { startCodeProject, readCodeProject, ownerActs, listCodeProjects } from "../src/lib/buzzy/codeMonkey.server";

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

async function main() {
  await ensureBoardReady();
  const sql = await getSql();
  const user = `user_cm_${Date.now().toString(36)}`;
  const stranger = `${user}_other`;

  type Link = { slices: { key: string; missionId: string; reviewMissionId?: string }[]; agentName: string; reviewerName: string };
  async function ids(jobId: string, key: string) {
    const rows = await sql<{ data: { codeMonkey: Link } }>`SELECT data FROM buzzy_jobs WHERE id = ${jobId}`;
    const link = rows[0].data.codeMonkey;
    const s = link.slices.find((x) => x.key === key)!;
    return { missionId: s.missionId, reviewMissionId: s.reviewMissionId, agent: link.agentName, reviewer: link.reviewerName };
  }
  const states = async (jobId: string) => {
    const v = await readCodeProject(sql, user, jobId);
    return Object.fromEntries((v?.slices ?? []).map((s) => [s.key, s.state]));
  };
  const column = async (id: string | undefined) => (id ? (await board.getMission(id))?.column : undefined);
  /** Builder delivers; the workshop opens the review; the reviewer delivers a verdict. */
  async function buildAndReview(jobId: string, key: string, proof: string[], verdict: "PASS" | "FAIL" = "PASS") {
    const a = await ids(jobId, key);
    await board.claim(a.missionId, a.agent);
    await board.deliver(a.missionId, a.agent, `Built ${key}`, proof);
    await readCodeProject(sql, user, jobId);
    const b = await ids(jobId, key);
    if (!b.reviewMissionId) return null;
    await board.claim(b.reviewMissionId, b.reviewer);
    await board.deliver(b.reviewMissionId, b.reviewer, `- ${verdict} every check, tried in the running app\nVERDICT ${verdict}`);
    return b.reviewMissionId;
  }

  console.log("refuses a vague project before anything is created:");
  const vague = await startCodeProject(sql, user, {
    card: { making: "an app", forWhom: "people", outcome: "it is useful", doneWhen: ["It looks professional"], stakes: "product" },
    slices: [{ key: "s1", title: "Set up the database", shows: "", doneWhen: ["Tables exist"] }],
  });
  check("refused with reasons", !vague.ok && vague.problems.length >= 2, vague.ok ? "started" : vague.problems);

  console.log("1. a bedtime game (play):");
  const words = "Can you build a bedtime adventure game for my kids? They're 8 and 10.";
  const game = await startCodeProject(sql, user, {
    words,
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
  check("the owner's words are kept exactly as typed", game.project.source.words === words);
  check("reviews are independent (Anthropic builds, OpenAI reviews)", game.project.reviewIndependent && game.project.builderProvider === "anthropic" && game.project.reviewerProvider === "openai");
  check("both steps start waiting", JSON.stringify(await states(g)) === JSON.stringify({ s1: "waiting", s2: "waiting" }));
  const g1 = await ids(g, "s1");
  check("first step is claimable, second parked", (await column(g1.missionId)) === "ready" && (await column((await ids(g, "s2")).missionId)) === "blocked");
  check("the brief asks for the running app to be tested", /run the real app/.test((await board.getMission(g1.missionId))?.constraints ?? ""));

  await board.claim(g1.missionId, g1.agent);
  check("owner sees Working", (await states(g)).s1 === "working");
  await board.escalate(g1.missionId, g1.agent, "Should the hero be an animal or a kid?");
  const withQ = await readCodeProject(sql, user, g);
  const q = withQ?.slices.find((s) => s.key === "s1")?.question;
  check("an agent's question reaches the owner as Needs you", withQ?.slices[0].state === "needs-you" && /animal/.test(q?.text ?? ""));
  check("a stranger cannot answer it", !(await ownerActs(sql, stranger, g, { kind: "answer", callId: q?.callId ?? "", text: "x" })).ok);
  check("the owner answers", (await ownerActs(sql, user, g, { kind: "answer", callId: q?.callId ?? "", text: "An animal — a fox" })).ok);
  check("the question is gone", !(await readCodeProject(sql, user, g))?.slices[0].question);

  await board.claim(g1.missionId, g1.agent);
  await board.deliver(g1.missionId, g1.agent, "Fox hero and the forest scene. Try it: https://preview.example/game", ["https://preview.example/shot-1.png"]);
  check("delivered play work waits for its review (Checking, not Done)", (await states(g)).s1 === "checking");
  const g1r = await ids(g, "s1");
  check("…a review mission for the other company's reviewer exists", Boolean(g1r.reviewMissionId));
  check("the review asks for PASS/FAIL per check from the running app", /PASS or FAIL/.test((await board.getMission(g1r.reviewMissionId!))?.acceptance ?? "") && /real app/.test((await board.getMission(g1r.reviewMissionId!))?.constraints ?? ""));
  await board.claim(g1r.reviewMissionId!, g1r.reviewer);
  await board.deliver(g1r.reviewMissionId!, g1r.reviewer, "- PASS Tapping a hero shows the forest scene (iPad Safari)\nVERDICT PASS");
  const afterReview = await readCodeProject(sql, user, g);
  check("reviewed play work with proof is Done", afterReview?.slices[0].state === "done" && afterReview.slices[0].reviewed === "pass", afterReview?.slices[0]);
  check("the next step is released once its 'after' is done", (await column((await ids(g, "s2")).missionId)) === "ready");
  check("proof links reach the owner", (afterReview?.slices[0].proof.links ?? []).includes("https://preview.example/game"));

  const g2 = await ids(g, "s2");
  await board.claim(g2.missionId, g2.agent);
  await board.deliver(g2.missionId, g2.agent, "Choices wired up", []);
  const g2r = await ids(g, "s2");
  await readCodeProject(sql, user, g);
  const g2r2 = await ids(g, "s2");
  await board.claim(g2r2.reviewMissionId!, g2r2.reviewer);
  await board.deliver(g2r2.reviewMissionId!, g2r2.reviewer, "- PASS choices branch\nVERDICT PASS");
  await readCodeProject(sql, user, g);
  const gameBoard = (await sql<{ data: { codeMonkey: { projectId: string } } }>`SELECT data FROM buzzy_jobs WHERE id = ${g}`)[0].data.codeMonkey.projectId;
  const notes = ((await board.snapshot(gameBoard))?.events ?? []).filter((e) => e.missionId === g2.missionId);
  check("no proof attached → sent back to the builder, never Done", (await column(g2.missionId)) === "ready" && /without proof/i.test(JSON.stringify(notes)), { column: await column(g2.missionId), g2r });

  console.log("2. a game for kids everywhere (product, failed then passed review):");
  const pub = await startCodeProject(sql, user, {
    words: "make a puzzle game kids everywhere will enjoy",
    card: { making: "a puzzle game", forWhom: "kids everywhere", outcome: "kids solve a puzzle a day", doneWhen: ["A new puzzle appears every day at midnight"], stakes: "play" },
    slices: [{ key: "s1", title: "Solve today's puzzle", shows: "open the link and drag the pieces", doneWhen: ["Placing every piece shows 'Solved!'"] }],
  });
  check("started", pub.ok);
  if (!pub.ok) return;
  check("stakes raised to product by the words, not the model", pub.project.card.stakes === "product" && pub.project.stakesRaisedFrom === "play");
  await buildAndReview(pub.jobId, "s1", ["https://preview.example/puzzle"], "FAIL");
  const p1 = await ids(pub.jobId, "s1");
  const back = await states(pub.jobId);
  check("a failed review sends the step back to the builder", back.s1 === "waiting" && (await column(p1.missionId)) === "ready", back);
  const firstReview = p1.reviewMissionId;
  await buildAndReview(pub.jobId, "s1", ["https://preview.example/puzzle-2"], "PASS");
  const p1b = await ids(pub.jobId, "s1");
  check("a fresh review followed the fix", Boolean(p1b.reviewMissionId) && p1b.reviewMissionId !== firstReview);
  check("a passing review lets undoable product work through", (await states(pub.jobId)).s1 === "done");

  console.log("3. a one-way door, not authorized (email):");
  const mail = await startCodeProject(sql, user, {
    words: "write a launch announcement for the game",
    card: { making: "a launch announcement", forWhom: "my newsletter subscribers", outcome: "they hear about the game", doneWhen: ["Each subscriber gets one email with the link"], stakes: "product" },
    slices: [{ key: "s1", title: "Email every subscriber the launch news", shows: "check your own inbox first", doneWhen: ["The email arrives with a working link"] }],
  });
  check("started", mail.ok);
  if (!mail.ok) return;
  check("the step is a one-way door with no authorization", mail.project.slices[0].door === "one-way" && !mail.project.slices[0].authorizedBy);
  const m1 = await ids(mail.jobId, "s1");
  check("the brief holds the irreversible step", /do not run the irreversible step/.test((await board.getMission(m1.missionId))?.constraints ?? ""));
  await buildAndReview(mail.jobId, "s1", ["https://preview.example/email.png"]);
  const ready = await readCodeProject(sql, user, mail.jobId);
  check("after review, the owner is asked (never auto-sent)", ready?.slices[0].state === "needs-you" && ready.slices[0].ownerLooks === true, ready?.slices[0]);
  check("'go' from a stranger is refused", !(await ownerActs(sql, stranger, mail.jobId, { kind: "looks-right", sliceKey: "s1" })).ok);
  check("the owner says go ahead", (await ownerActs(sql, user, mail.jobId, { kind: "looks-right", sliceKey: "s1" })).ok);
  check("go ahead returns it to the builder to run the held-back step", (await column(m1.missionId)) === "ready");
  await board.claim(m1.missionId, m1.agent);
  await board.deliver(m1.missionId, m1.agent, "Sent to 312 subscribers", ["https://preview.example/sent-log"]);
  check("that delivery completes it", (await states(mail.jobId)).s1 === "done");

  console.log("4. a launch the owner asked for in their own words:");
  const launch = await startCodeProject(sql, user, {
    words: "Make a colouring page for my niece. When it works, publish it on itch.io so the family can find it.",
    card: { making: "a colouring page", forWhom: "my niece", outcome: "she colours animals on a tablet", doneWhen: ["Tapping a colour then an area fills it"], stakes: "play" },
    slices: [
      { key: "s1", title: "Colour in the first picture", shows: "open the link and tap", doneWhen: ["Tapping a colour then an area fills it"] },
      { key: "s2", title: "Publish it on itch.io", shows: "open the itch.io page", doneWhen: ["The itch.io page loads the game"], after: ["s1"] },
    ],
  });
  check("started", launch.ok);
  if (!launch.ok) return;
  const pubStep = launch.project.slices.find((s) => s.key === "s2")!;
  check("the publish step carries the owner's sentence", pubStep.door === "one-way" && /publish it on itch\.io/.test(pubStep.authorizedBy ?? ""), pubStep);
  check("the project's launch policy says it came from their words", launch.project.launch?.authorized === true && launch.project.launch.source === "your words");
  const l2brief = (await board.getMission((await ids(launch.jobId, "s2")).missionId))?.constraints ?? "";
  check("even authorized, the brief holds the step until the review passes", /do not run the irreversible step/.test(l2brief) && /once the independent review passes/.test(l2brief));
  await buildAndReview(launch.jobId, "s1", ["https://preview.example/colour"]);
  await readCodeProject(sql, user, launch.jobId);
  await buildAndReview(launch.jobId, "s2", ["https://preview.example/itch-ready"]);
  const l2 = await ids(launch.jobId, "s2");
  const lview = await readCodeProject(sql, user, launch.jobId);
  check("after its review it goes ahead by itself — the owner is not asked", (await column(l2.missionId)) === "ready" && lview?.slices[1].state !== "needs-you", lview?.slices[1]);
  await board.claim(l2.missionId, l2.agent);
  await board.deliver(l2.missionId, l2.agent, "Live at https://example.itch.io/colouring", ["https://example.itch.io/colouring"]);
  check("its delivery completes the launch", (await states(launch.jobId)).s2 === "done");

  console.log("5. the first launch's go-ahead becomes this project's launch policy:");
  const two = await startCodeProject(sql, user, {
    words: "Make a tiny recipe site for my cooking club.",
    card: { making: "a recipe site", forWhom: "my cooking club", outcome: "members find this week's recipe", doneWhen: ["The home page shows this week's recipe"], stakes: "play" },
    slices: [
      { key: "s1", title: "Publish the first version", shows: "open the site", doneWhen: ["The site loads this week's recipe"] },
      { key: "s2", title: "Publish the update with the archive", shows: "open the archive", doneWhen: ["The archive lists past recipes"], after: ["s1"] },
    ],
  });
  check("started without any launch authorization", two.ok && !two.project.launch);
  if (!two.ok) return;
  await buildAndReview(two.jobId, "s1", ["https://preview.example/site"]);
  check("the first launch waits for the owner", (await readCodeProject(sql, user, two.jobId))?.slices[0].state === "needs-you");
  await ownerActs(sql, user, two.jobId, { kind: "looks-right", sliceKey: "s1" });
  const t1 = await ids(two.jobId, "s1");
  await board.claim(t1.missionId, t1.agent);
  await board.deliver(t1.missionId, t1.agent, "Live", ["https://preview.example/live"]);
  const policyView = await readCodeProject(sql, user, two.jobId);
  check("the project now has a launch policy from the owner's go-ahead", policyView?.launch?.authorized === true && policyView.launch.source === "your go-ahead");
  await buildAndReview(two.jobId, "s2", ["https://preview.example/archive"]);
  const t2 = await ids(two.jobId, "s2");
  await readCodeProject(sql, user, two.jobId);
  check("the later launch goes ahead after review without asking again", (await column(t2.missionId)) === "ready" && (await readCodeProject(sql, user, two.jobId))?.slices[1].state !== "needs-you");

  console.log("6. no reviewer from another company:");
  process.env.BZ_CODE_REVIEW_HARNESS = "claude_code";
  const solo = await startCodeProject(sql, user, {
    words: "a dice roller for our board-game night",
    card: { making: "a dice roller", forWhom: "our board-game night", outcome: "we roll dice on a phone", doneWhen: ["Tapping Roll shows a number from 1 to 6"], stakes: "play" },
    slices: [{ key: "s1", title: "Roll a die", shows: "tap Roll", doneWhen: ["Tapping Roll shows a number from 1 to 6"] }],
  });
  process.env.BZ_CODE_REVIEW_HARNESS = "codex";
  check("started, marked as not independent", solo.ok && solo.project.reviewIndependent === false);
  if (!solo.ok) return;
  const reviewed = await buildAndReview(solo.jobId, "s1", ["https://preview.example/dice"]);
  check("no same-company review is created", reviewed === null);
  const sv = await readCodeProject(sql, user, solo.jobId);
  check("it finishes, reported 'not independently reviewed' — never 'passed'", sv?.slices[0].state === "done" && sv.slices[0].reviewed === "not-available", sv?.slices[0]);

  console.log("listing and privacy:");
  const mine = await listCodeProjects(sql, user);
  check("the owner's list has the six projects", mine.length === 6, mine.length);
  check("a stranger sees none of them", (await listCodeProjects(sql, stranger)).length === 0);
  check("a stranger can't read one", (await readCodeProject(sql, stranger, g)) === null);
  check("reading twice changes nothing more", JSON.stringify(await states(g)) === JSON.stringify(await states(g)));
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
