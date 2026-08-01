import { durableBoard, ensureBoardReady } from "../src/lib/board-store.server";
import { DEFAULT_PROJECT_ID } from "../src/lib/seed";

async function main() {
  console.log("ensuring...");
  await ensureBoardReady();
  console.log("reset...");
  await durableBoard.reset();
  console.log("create key...");
  const key = await durableBoard.createApiKey({
    projectId: DEFAULT_PROJECT_ID,
    name: "test-key",
    agentId: "agent_lens",
  });
  console.log("secret prefix", key.secret.slice(0, 12));
  const verified = await durableBoard.verifyPresentedApiKey(key.secret);
  if (!verified) throw new Error("verify failed");
  await durableBoard.revokeApiKey(key.id);
  if (await durableBoard.verifyPresentedApiKey(key.secret)) throw new Error("still valid");
  const key2 = await durableBoard.createApiKey({ projectId: DEFAULT_PROJECT_ID, name: "k2" });
  if (!(await durableBoard.verifyPresentedApiKey(key2.secret))) throw new Error("key2");
  await durableBoard.updateProjectSettings(DEFAULT_PROJECT_ID, {
    githubWebhookSecret: "sec123",
    replyWebhookUrl: "http://127.0.0.1:9/hook",
    githubRepo: "o/r",
  });
  const settings = await durableBoard.getProjectSettings(DEFAULT_PROJECT_ID);
  if (!settings.hasGithubSecret) throw new Error("no secret");
  const snap = await durableBoard.snapshot(DEFAULT_PROJECT_ID);
  const mid = snap.missions[0]!.id;
  const attached = await durableBoard.attachMissionArtifact(mid, "https://example.com/pr/1", "pr");
  if (!attached?.artifacts.includes("https://example.com/pr/1")) throw new Error("art");
  const exp = await durableBoard.exportHistory({ projectId: DEFAULT_PROJECT_ID, format: "csv" });
  if (exp.count < 1) throw new Error("export");
  console.log("✓ durable keys/settings/artifact/export");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
