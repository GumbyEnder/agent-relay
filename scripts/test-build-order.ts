/**
 * Drives shipped paths for Live/admin snapshot, project isolation,
 * GitHub ingest idempotency, journal markdown, and theme helpers.
 */
import { durableBoard, ensureBoardReady } from "../src/lib/board-store.server";
import { mapGitHubIssueToMission, githubExternalId } from "../src/lib/github-ingest";
import { renderMissionJournalMarkdown } from "../src/lib/journal";
import { applyTheme, isThemeId, THEME_IDS } from "../src/lib/theme";
import { DEFAULT_PROJECT_ID } from "../src/lib/seed";

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

async function main() {
  await ensureBoardReady();
  await durableBoard.reset();

  // --- projects ---
  const projects = await durableBoard.listProjects();
  assert(projects.length >= 2, "need ≥2 seed projects");
  const def = projects.find((p) => p.id === DEFAULT_PROJECT_ID || p.slug === "default");
  const plat = projects.find((p) => p.slug === "platform");
  assert(def && plat, "default + platform projects");

  // mission only on default
  const created = await durableBoard.createMission({
    title: "Only on default",
    objective: "isolation probe",
    projectId: def!.id,
    column: "ready",
  });
  assert(created.ok, "create on default");
  const idA = created.data.mission.id;

  const boardA = await durableBoard.snapshot(def!.id);
  const boardB = await durableBoard.snapshot(plat!.id);
  assert(
    boardA.missions.some((m) => m.id === idA),
    "mission on A",
  );
  assert(
    !boardB.missions.some((m) => m.id === idA),
    "mission NOT on B",
  );
  console.log("✓ project isolation");

  // --- live/admin snapshot after claim ---
  // Unique agent name per run — ar_agents.name is globally unique; "lens" collides
  // when durable store survives across test files or repeated invocations.
  const claimAgent = `lens-bo-${Date.now().toString(36)}`;
  const claim = await durableBoard.claim(idA, claimAgent);
  assert(claim.ok, "claim");
  const admin = await durableBoard.adminSnapshot(def!.id);
  assert(admin.events.length >= 1, "events present");
  assert(admin.history.some((h) => h.missionId === idA && h.toColumn === "running"), "history claim row");
  const histRow = admin.history.find((h) => h.missionId === idA && h.toColumn === "running")!;
  assert(
    histRow.actorName === claimAgent || histRow.actorId,
    "actor on history",
  );
  assert(histRow.fromColumn === "ready", "from ready");
  console.log("✓ live/admin snapshot after claim");

  // --- github ingest idempotent ---
  const payload = {
    action: "opened",
    repository: { full_name: "Acme/Widget" },
    issue: {
      number: 42,
      title: "Fix flaky deploy",
      body: "Pipeline fails on migrate.\n\n## Steps\n1. repro",
      html_url: "https://github.com/Acme/Widget/issues/42",
      state: "open",
      labels: ["agent", "p1", "ready-for-agent"],
    },
    projectId: def!.id,
  };
  const mapped = mapGitHubIssueToMission(payload);
  assert(mapped.externalId === githubExternalId("Acme/Widget", 42), "external id");
  assert(mapped.column === "ready", "ready column from labels");
  const g1 = await durableBoard.ingestGitHubIssue(payload);
  assert(g1.created === true, "first ingest creates");
  const g2 = await durableBoard.ingestGitHubIssue(payload);
  assert(g2.created === false, "second ingest updates not creates");
  assert(g1.mission.id === g2.mission.id, "same mission id");
  const boardAfter = await durableBoard.snapshot(def!.id);
  const ghMissions = boardAfter.missions.filter((m) => m.externalId === mapped.externalId);
  assert(ghMissions.length === 1, "exactly one github mission");
  console.log("✓ github ingest idempotent", g1.mission.id);

  // --- journal ---
  await durableBoard.escalate(idA, claimAgent, "Ship isolation fix?");
  const md = await durableBoard.journalMarkdown(idA);
  assert(md && md.includes(idA), "journal has mission id");
  assert(md!.includes("ready") && md!.includes("running"), "timeline columns");
  assert((md!.match(/\|/g) || []).length >= 10, "table rows");
  // pure renderer also
  const mission = boardAfter.missions.find((m) => m.id === idA)!;
  const hist = await durableBoard.history(idA);
  const md2 = renderMissionJournalMarkdown(mission, hist);
  assert(md2.includes("Timeline"), "renderer timeline");
  assert(hist.length >= 2, "≥2 history for journal");
  console.log("✓ journal markdown");

  // --- themes ---
  for (const id of THEME_IDS) {
    assert(isThemeId(id), `theme id ${id}`);
  }
  // applyTheme needs document — in node just verify function returns id when no document
  const applied = applyTheme("cyberpunk");
  assert(applied === "cyberpunk", "applyTheme returns id");
  applyTheme("dark");
  console.log("✓ themes");

  console.log("\nAll build-order checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
