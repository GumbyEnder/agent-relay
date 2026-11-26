#!/usr/bin/env node
/**
 * E2E: local inference credentials (S6).
 *
 * The rule this test exists to enforce: a constraint that cannot be satisfied
 * refuses BY NAME, and a secret never appears in output, logs or a store file it
 * claims is encrypted.
 *
 * Run:
 *   BZ_TEST_KEY=<provider key> node scripts/test-inference-e2e.mjs
 * The live-turn check is skipped (not failed) without BZ_TEST_KEY.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadInference, saveInference, resolveInference, clearInference, redactKey } from "./lib/inference.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "bin", "beezilla.mjs");
const dataDir = mkdtempSync(join(tmpdir(), "bz-inference-e2e-"));

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// A stand-in for Electron's safeStorage: reversible, and definitely not plaintext.
const fakeCipher = {
  encrypt: (s) => Buffer.from([...Buffer.from(s, "utf8")].reverse()),
  decrypt: (b) => Buffer.from([...Buffer.from(b)].reverse()).toString("utf8"),
};

// 1. encrypted round trip
saveInference(dataDir, { provider: "byok", key: "sk-test-abcdefghijklmnop", baseUrl: "https://example.test/v1", model: "m1" }, fakeCipher);
const raw = readFileSync(join(dataDir, "inference.json"), "utf8");
check("encrypted store does not contain the plaintext key", !raw.includes("sk-test-abcdefghijklmnop"));
const round = loadInference(dataDir, fakeCipher);
check("encrypted store round-trips", round?.key === "sk-test-abcdefghijklmnop", round?.provider);
check("store records encrypted: true", JSON.parse(raw).encrypted === true);

// 2. a store that cannot be decrypted yields null, never a guess
const undecryptable = loadInference(dataDir, {});
check("undecryptable store yields no key", undecryptable === null);

// 3. unencrypted fallback is honest about itself
clearInference(dataDir);
saveInference(dataDir, { provider: "byok", key: "sk-plain-123456", baseUrl: "", model: "" });
const file = join(dataDir, "inference.json");
check("unencrypted store marked encrypted:false", JSON.parse(readFileSync(file, "utf8")).encrypted === false);
const mode = statSync(file).mode & 0o777;
check("unencrypted store is 0600", process.platform === "win32" || mode === 0o600, `mode ${mode.toString(8)}`);

// 4. explicit env always wins over the store
process.env.BZ_CHAT_KEY = "env-key-wins";
const precedence = resolveInference(dataDir);
check("env wins over the stored key", precedence?.source === "env" && precedence.key === "env-key-wins", precedence?.source);
delete process.env.BZ_CHAT_KEY;
check("store used when env is absent", resolveInference(dataDir)?.source === "store");

// 5. redaction never leaks the key
const red = redactKey("sk-test-abcdefghijklmnop");
// ── managed (our inference) token lifecycle ────────────────────────────────
// A managed token is short-lived by design: it must carry its expiry, default to
// OUR endpoint, and fail as a session problem — never as "invalid API key".
const managedDir = mkdtempSync(join(tmpdir(), "bz-managed-"));
const managed = saveInference(managedDir, {
  provider: "beezilla",
  key: "tok-managed-abcdef123456",
  expiresAt: "2020-01-01T00:00:00Z",
});
check("managed store defaults to our endpoint", managed.baseUrl === "https://inference-api.nousresearch.com/v1", managed.baseUrl);
check("managed store keeps its expiry", managed.expiresAt === "2020-01-01T00:00:00Z");
const managedResolved = resolveInference(managedDir);
check("expired managed token is flagged expired", managedResolved?.expired === true);
saveInference(managedDir, { provider: "beezilla", key: "tok-managed-abcdef123456", expiresAt: new Date(Date.now() + 3600_000).toISOString() });
check("a live managed token is not expired", resolveInference(managedDir)?.expired === false);

saveInference(managedDir, { provider: "beezilla", key: "tok-managed-abcdef123456", expiresAt: "2020-01-01T00:00:00Z" });
const expiredResult = await new Promise((res) =>
  execFile(process.execPath, [CLI, "run", "hello"], { cwd: ROOT, env: { ...process.env, BZ_DATA_DIR: managedDir, BZ_RUNTIME: "local" } },
    (err, stdout, stderr) => res({ code: Number(err?.code ?? 0), out: String(stdout) + String(stderr) })));
check("an expired managed token refuses before spending a request", expiredResult.code === 2, `exit ${expiredResult.code}`);
check("the refusal says reconnect, not invalid key", /session expired[\s\S]*reconnect/i.test(expiredResult.out), expiredResult.out.split("\n")[0]);
rmSync(managedDir, { recursive: true, force: true });

check("redaction hides the middle", !red.includes("abcdefghij") && red.length < 40, red);

// 6. CLI: set → show → doctor, with nothing secret in the output
clearInference(dataDir);
const env = { ...process.env, BZ_DATA_DIR: dataDir, BZ_RUNTIME: "local" };
delete env.BZ_CHAT_KEY;
const cli = (args, timeout = 180_000) =>
  new Promise((res) =>
    execFile(process.execPath, [CLI, ...args], { cwd: ROOT, env, timeout }, (err, stdout, stderr) =>
      res({ code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) }),
    ),
  );

const testKey = (process.env.BZ_TEST_KEY ?? "").trim();
const shownKey = testKey || "sk-cli-abcdefghijklmnop";
// When a real key is supplied, store the REAL provider endpoint — storing a
// placeholder URL and then "passing" a turn proves nothing but the error copy.
const liveBase = (process.env.BZ_TEST_BASE_URL ?? "https://inference-api.nousresearch.com/v1").trim();
const liveModel = (process.env.BZ_TEST_MODEL ?? "z-ai/glm-5.3-flash").trim();
const setArgs = testKey
  ? ["key", "set", "--key", shownKey, "--base-url", liveBase, "--model", liveModel]
  : ["key", "set", "--key", shownKey, "--base-url", "https://example.test/v1", "--model", "m1"];
const set = await cli(setArgs);
check("cli key set stores the key", set.code === 0, set.stdout.split("\n")[0]);
check("cli key set does not echo the key", !set.stdout.includes(shownKey));

const show = await cli(["key", "show"]);
check("cli key show reports the provider", /provider\s+byok \(store\)/.test(show.stdout), show.stdout.split("\n")[0]);
check("cli key show redacts the key", !show.stdout.includes(shownKey));

const doctor = await cli(["doctor"]);
check("doctor reports the configured provider", /byok via store/.test(doctor.stdout));
check("doctor does not print the key", !doctor.stdout.includes(shownKey));

// 7. the stored key actually reaches the model (no BZ_CHAT_KEY in env)
if (testKey) {
  await cli(["stop"]);
  const run = await cli(["run", "In one short sentence, what are you?"]);
  const reply = run.stdout.trim();
  // A non-empty reply is not an answer: the product's own failure copy is also
  // non-empty. Assert this is a real model response, not the "trouble
  // connecting" fallback.
  const realAnswer = run.code === 0 && reply.length > 10 && !/trouble connecting|could not reach|failed/i.test(reply);
  check("a stored key completes a real model turn", realAnswer, reply.slice(0, 90));
  await cli(["stop"]);
} else {
  check("a stored key completes a real model turn", true, "SKIP — BZ_TEST_KEY not set");
}

// 8. clearing refuses by name afterwards
const cleared = await cli(["key", "clear"]);
check("cli key clear removes credentials", cleared.code === 0 && !existsSync(file));
const after = await cli(["doctor"]);
check("doctor refuses by name with no key", /no key — chat will refuse by name/.test(after.stdout));

rmSync(dataDir, { recursive: true, force: true });
console.log(`\ninference E2E: ${failures === 0 ? "passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
