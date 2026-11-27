/**
 * Facts a person asked BeeZilla to remember (CR-18).
 *
 * Hermetic: pure extraction + in-memory PGlite, no network, no built server.
 *
 *   npx tsx scripts/test-remember-fact.ts
 *
 * What it pins:
 *   - the four triggers ("remember (that)", "make a note (that)", "keep in
 *     mind (that)", "save this:") and the deliberate absence of bare "note that";
 *   - refusals: questions, reminiscence, reminders ("remember to…"), too short,
 *     too long, and secrets;
 *   - the store: account scope, a same-topic correction updates one row, two
 *     different facts both survive, a key collision gets a new key, a second
 *     user is untouched, PUT/DELETE only touch `remembered:` keys, and the 51st
 *     fact is refused.
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "../src/lib/db";
import {
  REMEMBERED_MAX_ROWS,
  deleteRememberedFact,
  deriveRememberedKey,
  extractRememberedFact,
  factShape,
  isRememberedKey,
  loadRememberedFacts,
  looksLikeSecret,
  rememberAccountFact,
  rememberedPromptSection,
  updateRememberedFact,
} from "../src/lib/buzzy/remember";

let pass = 0;
let fail = 0;
function ok(name: string, cond: unknown, detail = ""): void {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}
function eq<T>(name: string, got: T, want: T): void {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

// ── Extraction: save cases ────────────────────────────────────────────
const saves: Array<[string, string]> = [
  ["remember that my hourly rate is $85 an hour", "my hourly rate is $85 an hour"],
  ["Remember my dog's name is Rex", "my dog's name is Rex"],
  ["make a note that the office is in Sydney", "the office is in Sydney"],
  ["make a note the plumber comes Thursday", "the plumber comes Thursday"],
  ["keep in mind that the client prefers email", "the client prefers email"],
  ["keep in mind the budget is 5000", "the budget is 5000"],
  ["save this: my tax year ends in March", "my tax year ends in March"],
  ["please remember that I invoice on Fridays", "I invoice on Fridays"],
  ["remember this: the studio opens at 9", "the studio opens at 9"],
  ["remember my accountant is Priya", "my accountant is Priya"],
  ["Make a note that the van is a blue Transit", "the van is a blue Transit"],
  ["KEEP IN MIND that the landlord's number is on the invoice", "the landlord's number is on the invoice"],
];
for (const [message, want] of saves) {
  const got = extractRememberedFact(message);
  ok(`saves: ${message}`, got !== null && got.ok === true && got.kind === "save_request", JSON.stringify(got));
  if (got && got.ok) eq(`value: ${message}`, got.value, want);
}

// ── Extraction: refusals ──────────────────────────────────────────────
const notTriggers = [
  "note that the office is closed Friday", // too common in ordinary speech
  "my hourly rate is $85",                 // no trigger at all
  "good to know, thanks",                  // ordinary chat
];
for (const message of notTriggers) {
  eq(`no trigger: ${message}`, extractRememberedFact(message), null);
}

const refusals: Array<[string, "save_request" | "not_a_save"]> = [
  ["can you remember that my rate is $85?", "not_a_save"],
  ["do you remember my dog's name?", "not_a_save"],
  ["remember when we went to Paris", "not_a_save"],
  ["I remember when we went to Paris", "not_a_save"],
  ["I can't remember my password", "not_a_save"],
  ["remember to call Bob tomorrow", "save_request"],
  ["remember that", "save_request"],
  ["remember that ok", "save_request"],
  [`remember that ${"x".repeat(501)}`, "save_request"],
  ["remember that my password is hunter2", "save_request"],
  ["remember that my PIN is 4321", "save_request"],
  ["remember that my card number is 4111 1111 1111 1111", "save_request"],
  ["remember that the seed phrase is apple ball cat", "save_request"],
  ["remember that the key is sk-abcdef1234567890", "save_request"],
  ["remember that the AWS key is AKIAIOSFODNN7EXAMPLE", "save_request"],
  ["remember that the private key is -----BEGIN RSA PRIVATE KEY-----", "save_request"],
];
for (const [message, kind] of refusals) {
  const got = extractRememberedFact(message);
  ok(`refuses: ${message.slice(0, 60)}`, got !== null && got.ok === false, JSON.stringify(got));
  if (got && !got.ok) {
    eq(`refusal kind: ${message.slice(0, 40)}`, got.kind, kind);
    ok(`refusal says why: ${message.slice(0, 40)}`, got.reason.length > 20);
  }
}

// ── Keys and shapes ───────────────────────────────────────────────────
eq("key is stable", deriveRememberedKey("my hourly rate is $85 an hour"), "remembered:hourly-rate-85-hour");
eq("key drops stop words", deriveRememberedKey("the van is a blue Transit"), "remembered:van-blue-transit");
ok("key is bounded", deriveRememberedKey("alpha bravo charlie delta echo foxtrot golf").length <= 80);
eq("same fact, new number", factShape("my hourly rate is $85"), factShape("my hourly rate is $120"));
ok("different facts differ", factShape("my dog's name is Rex") !== factShape("my cat's name is Tom"));
ok("secret: password", looksLikeSecret("my password is hunter2"));
ok("secret: 16 digits", looksLikeSecret("4111111111111111"));
ok("not secret: rate", !looksLikeSecret("my hourly rate is $85"));
eq("only remembered keys are editable", [isRememberedKey("remembered:rate"), isRememberedKey("profile_name"), isRememberedKey("ask_first:low")], [true, false, false]);
eq("prompt section empty when nothing remembered", rememberedPromptSection([]), "");
const prompt = rememberedPromptSection([{ key: "remembered:x", value: "v".repeat(400) }]);
ok("prompt section names the facts", prompt.includes("Things they asked you to remember"));
ok("prompt section caps each fact", prompt.includes("v".repeat(200)) && !prompt.includes("v".repeat(201)));

// ── The store (PGlite, every column from 0016) ────────────────────────
(async () => {
  const db = new PGlite();
  await db.exec(readFileSync(join(process.cwd(), "migrations", "0016_buzzy_chat.sql"), "utf8"));
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = "";
    strings.forEach((s, i) => { text += s + (i < values.length ? "$" + (i + 1) : ""); });
    return db.query(text, values).then((r) => r.rows);
  }) as unknown as Sql;
  (sql as unknown as { query: unknown }).query = (text: string, params?: unknown[]) =>
    db.query(text, params ?? []).then((r) => r.rows);

  const userA = "user_a";
  const userB = "user_b";

  const first = await rememberAccountFact(sql, userA, "my hourly rate is $85");
  ok("first fact saves", first.ok === true);
  if (first.ok) {
    eq("key derived", first.key, "remembered:hourly-rate-85");
    eq("first save is an insert", first.updated, false);
  }
  const scopeRows = await db.query<{ job_id: string | null; key: string; value: string }>(
    "SELECT job_id, key, value FROM buzzy_user_memory WHERE user_id = $1 ORDER BY key", [userA],
  );
  eq("account scope (job_id null)", scopeRows.rows.map((r) => r.job_id), [null]);
  eq("value is their words", scopeRows.rows[0]?.value, "my hourly rate is $85");

  // Same-topic correction: one row, the new value.
  const corrected = await rememberAccountFact(sql, userA, "my hourly rate is $120");
  ok("correction saves", corrected.ok === true);
  if (corrected.ok) {
    eq("correction keeps the key", corrected.key, "remembered:hourly-rate-85");
    eq("correction reports an update", corrected.updated, true);
  }
  const rateRows = await db.query<{ key: string; value: string }>(
    "SELECT key, value FROM buzzy_user_memory WHERE user_id = $1 AND key LIKE 'remembered:%'", [userA],
  );
  eq("correction leaves one row", rateRows.rows.length, 1);
  eq("correction stores the new value", rateRows.rows[0]?.value, "my hourly rate is $120");
  // Two different facts both survive.
  const dog = await rememberAccountFact(sql, userA, "my dog's name is Rex");
  const cat = await rememberAccountFact(sql, userA, "my cat's name is Tom");
  ok("dog saves", dog.ok === true);
  ok("cat saves", cat.ok === true);
  const threeRows = await db.query<{ key: string; value: string }>(
    "SELECT key, value FROM buzzy_user_memory WHERE user_id = $1 ORDER BY key", [userA],
  );
  eq("three facts, none overwritten", threeRows.rows.map((r) => r.value), [
    "my cat's name is Tom", "my dog's name is Rex", "my hourly rate is $120",
  ]);

  // A key collision with a different fact gets its own key.
  const alpha = await rememberAccountFact(sql, userA, "alpha beta gamma delta");
  const extra = await rememberAccountFact(sql, userA, "alpha beta gamma delta extra");
  ok("base key saves", alpha.ok === true);
  ok("collision saves", extra.ok === true);
  if (alpha.ok && extra.ok) {
    eq("collision base key", alpha.key, "remembered:alpha-beta-gamma-delta");
    eq("collision suffixes instead of overwriting", extra.key, "remembered:alpha-beta-gamma-delta-2");
  }
  const fiveRows = await db.query<{ value: string }>(
    "SELECT value FROM buzzy_user_memory WHERE user_id = $1 AND key LIKE 'remembered:%' ORDER BY key", [userA],
  );
  eq("both colliding facts survive", fiveRows.rows.map((r) => r.value).sort(), [
    "alpha beta gamma delta", "alpha beta gamma delta extra", "my cat's name is Tom",
    "my dog's name is Rex", "my hourly rate is $120",
  ]);

  // A second user is untouched.
  await rememberAccountFact(sql, userB, "my hourly rate is $99");
  const aRate = await db.query<{ value: string }>(
    "SELECT value FROM buzzy_user_memory WHERE user_id = $1 AND key = $2", [userA, "remembered:hourly-rate-85"],
  );
  eq("second user does not touch the first", aRate.rows[0]?.value, "my hourly rate is $120");

  // Prompt recall: account rows, newest first, bounded.
  const loaded = await loadRememberedFacts(sql, userA, 10);
  eq("prompt recall is bounded", loaded.length, 5);
  ok("prompt recall has the corrected fact", loaded.some((f) => f.value === "my hourly rate is $120"));

  // Edit by key.
  const edited = await updateRememberedFact(sql, userA, "remembered:hourly-rate-85", "my hourly rate is $130");
  ok("edit succeeds", edited.ok === true && edited.updated === true);
  const afterEdit = await db.query<{ value: string }>(
    "SELECT value FROM buzzy_user_memory WHERE user_id = $1 AND key = $2", [userA, "remembered:hourly-rate-85"],
  );
  eq("edit changes the value", afterEdit.rows[0]?.value, "my hourly rate is $130");
  const ownerB = await db.query<{ value: string }>(
    "SELECT value FROM buzzy_user_memory WHERE user_id = $1 AND key = $2", [userB, "remembered:hourly-rate-85"],
  );
  eq("edit is owner-scoped", ownerB.rows.length, 0);

  const protectedEdit = await updateRememberedFact(sql, userA, "profile_name", "Hijacked");
  eq("edit refuses non-remembered keys", protectedEdit.ok === false && protectedEdit.code === "bad_key", true);
  const secretEdit = await updateRememberedFact(sql, userA, "remembered:hourly-rate-85", "my password is hunter2");
  eq("edit refuses secrets", secretEdit.ok === false && secretEdit.code === "secret", true);

  // Delete by key, owner-scoped.
  const removed = await deleteRememberedFact(sql, userA, "remembered:dog-name-rex");
  eq("delete removes exactly one", removed, 1);
  eq("delete is idempotent", await deleteRememberedFact(sql, userA, "remembered:dog-name-rex"), 0);
  eq("delete refuses non-remembered keys", await deleteRememberedFact(sql, userA, "profile_name"), 0);

  // The cap: 50 per account, the 51st refused with a sentence naming Memory.
  const userC = "user_c";
  let lastCap: Awaited<ReturnType<typeof rememberAccountFact>> | null = null;
  for (let i = 0; i < REMEMBERED_MAX_ROWS; i++) {
    lastCap = await rememberAccountFact(sql, userC, `fact${i} bravo charlie delta`);
    if (!lastCap.ok) break;
  }
  const capCount = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM buzzy_user_memory WHERE user_id = $1", [userC],
  );
  eq("cap fills to 50", capCount.rows[0]?.n, REMEMBERED_MAX_ROWS);
  const over = await rememberAccountFact(sql, userC, "different zulu yankee xray");
  ok("51st fact is refused", over.ok === false);
  if (!over.ok) ok("cap refusal names the Memory page", /Memory page/.test(over.reason), over.reason);

  await db.close();

  if (fail) {
    console.error(`remember-fact: ${fail} check(s) failed, ${pass} passed`);
    process.exit(1);
  }
  console.log(`remember-fact: all checks passed (${saves.length} saves, ${refusals.length + notTriggers.length} refusals/no-trigger, store + cap)`);
})();
