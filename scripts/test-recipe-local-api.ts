/**
 * S7b acceptance: the local recipe API, end to end through a real runtime.
 *
 * Boots the launcher with pinned publisher keys, then exercises what a desktop
 * user's app and CLI actually call: list / import / verify — plus the two
 * failures that matter (unpinned bundle, no token).
 *
 * Run: npx tsx scripts/test-recipe-local-api.ts
 */
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { RECIPES } from "../src/lib/buzzy/recipes";
import { compileRecipeChecks } from "../src/lib/recipe-checks";
import { generateAuthorKey, sealBundle, type Capability, type SealInput } from "../src/lib/recipe-seal/bundle";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "bin", "beezilla.mjs");

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const recipe = RECIPES[0];
const compiled = compileRecipeChecks(recipe.id, { salt: new Uint8Array(8) });
const capability: Capability = {
  inputs: [{ name: "quotes", type: "file[]", required: true }],
  outputs: ["comparison-table", "recommendation"],
  tools: recipe.tools,
  forbidden_tools: ["send", "email", "submit", "publish", "pay", "sign"],
  boundary_summary: "read-only; nothing is sent",
};
const SEMANTIC = {
  discovery: recipe.discovery,
  checklist: recipe.checklist,
  firstQuestion: recipe.firstQuestion,
  outputContract: recipe.outputContract,
  boundary: recipe.boundary,
};

const seal = (key: ReturnType<typeof generateAuthorKey>) =>
  sealBundle({
    recipeId: recipe.id, version: "1.0.0", semantic: SEMANTIC,
    checksWasm: compiled.wasm, checks: compiled.manifest, capability,
    author: { id: "acct_beezilla", name: "BeeZilla", keyId: key.keyId, privateKey: key.privateKey },
    kek: new Uint8Array(32).fill(7), createdAt: "2026-10-20T12:00:00.000Z",
    dek: new Uint8Array(32).fill(3), nonce: new Uint8Array(12).fill(5), dekNonce: new Uint8Array(12).fill(9),
  } satisfies SealInput);

const ours = generateAuthorKey();
const theirs = generateAuthorKey();
const good = seal(ours);
const foreign = seal(theirs);

const dataDir = mkdtempSync(join(tmpdir(), "bz-recipe-api-"));
const goodFile = join(dataDir, "good.bezz");
const foreignFile = join(dataDir, "foreign.bezz");
writeFileSync(goodFile, good.bytes);
writeFileSync(foreignFile, foreign.bytes);

const env = {
  ...process.env,
  BZ_DATA_DIR: dataDir,
  BZ_RUNTIME: "local",
  BZ_RECIPE_PUBLISHER_KEYS: `${ours.keyId}:${ours.publicKeyRaw}`,
  BZ_CHAT_KEY: "sk-not-used-here",
};

const launcher = spawn(process.execPath, [join(ROOT, "scripts", "beezilla-local.mjs")], {
  cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"],
});
const logs: string[] = [];
launcher.stdout.on("data", (b) => logs.push(String(b)));
launcher.stderr.on("data", (b) => logs.push(String(b)));

const runtimeFile = join(dataDir, "runtime.json");
const deadline = Date.now() + 120_000;
let rt: any = null;
while (Date.now() < deadline) {
  if (existsSync(runtimeFile)) {
    try {
      const candidate = JSON.parse(readFileSync(runtimeFile, "utf8"));
      const healthy = await fetch(`http://${candidate.host}:${candidate.port}/api/agent/health`).then((r) => r.ok).catch(() => false);
      if (healthy) { rt = candidate; break; }
    } catch { /* handshake being written */ }
  }
  await new Promise((r) => setTimeout(r, 400));
}
check("runtime booted under the pinned-key env", !!rt);

const call = async (path: string, init: RequestInit = {}, token = rt?.token) => {
  const res = await fetch(`http://${rt.host}:${rt.port}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

if (rt) {
  const empty = await call("/api/recipes/local");
  check("list starts empty with pins loaded", empty.status === 200 && empty.body?.valid?.length === 0 && empty.body?.pins === 1, `pins ${empty.body?.pins}`);

  const anon = await call("/api/recipes/local", {}, null);
  check("recipe API requires the local token", anon.status === 401, `status ${anon.status}`);

  const verify = await call("/api/recipes/local/verify", {
    method: "POST", body: JSON.stringify({ bundle: Buffer.from(good.bytes).toString("base64") }),
  });
  check("verify accepts a pinned bundle", verify.status === 200 && verify.body?.trusted === true, verify.body?.anchor);

  const importGood = await call("/api/recipes/local", {
    method: "POST", body: JSON.stringify({ bundle: Buffer.from(good.bytes).toString("base64") }),
  });
  check("import stores a pinned bundle", importGood.status === 201 && importGood.body?.ok === true, importGood.body?.cached?.id);

  const importForeign = await call("/api/recipes/local", {
    method: "POST", body: JSON.stringify({ bundle: Buffer.from(foreign.bytes).toString("base64") }),
  });
  check("import refuses an unpinned bundle", importForeign.status === 422 && importForeign.body?.reason === "UNPINNED_PUBLISHER", importForeign.body?.detail);

  const listed = await call("/api/recipes/local");
  check("list returns the imported recipe only", listed.body?.valid?.length === 1 && listed.body?.rejected?.length === 0, listed.body?.valid?.[0]?.id);

  const noBody = await call("/api/recipes/local", { method: "POST", body: JSON.stringify({}) });
  check("import without a bundle is a 400", noBody.status === 400, noBody.body?.code);

  // ── CLI on the same runtime ────────────────────────────────────────────────
  const cli = (args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((res) =>
      execFile(process.execPath, [CLI, ...args], { cwd: ROOT, env, timeout: 180_000 },
        (err, stdout, stderr) => res({ code: Number(err?.code ?? 0), stdout: String(stdout), stderr: String(stderr) })));

  const addAgain = await cli(["recipe", "add", foreignFile]);
  check("cli recipe add refuses an unpinned file", addAgain.code === 1 && /refused: UNPINNED_PUBLISHER/.test(addAgain.stderr + addAgain.stdout), (addAgain.stderr || addAgain.stdout).trim().slice(0, 80));

  const listCli = await cli(["recipe", "list"]);
  check("cli recipe list shows the cached recipe", /ok\s+quote-comparison@1\.0\.0/.test(listCli.stdout), listCli.stdout.trim().split("\n")[0]);

  const verifyCli = await cli(["recipe", "verify", goodFile]);
  check("cli recipe verify trusts the pinned bundle", verifyCli.code === 0 && /trusted \(/.test(verifyCli.stdout), verifyCli.stdout.trim());

  const verifyBad = await cli(["recipe", "verify", foreignFile]);
  check("cli recipe verify reports the unpinned key", verifyBad.code === 1 && /UNPINNED_PUBLISHER/.test(verifyBad.stdout), verifyBad.stdout.trim());
}

try {
  const pid = rt?.pid ?? JSON.parse(readFileSync(runtimeFile, "utf8")).pid;
  process.kill(pid, "SIGTERM");
} catch { /* already gone */ }
await new Promise((r) => setTimeout(r, 1500));
try { process.kill(launcher.pid!, "SIGTERM"); } catch { /* gone */ }
rmSync(dataDir, { recursive: true, force: true });

console.log(`\nlocal recipe API E2E: ${failures === 0 ? "passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
