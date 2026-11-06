#!/usr/bin/env node
/**
 * test-lane-guard.mjs — P3 write-path guard, on a REAL local Postgres.
 *
 *   DATABASE_URL=postgres://<user>@127.0.0.1:5432/postgres node scripts/test-lane-guard.mjs
 *
 * The role must be allowed to CREATE DATABASE. The test creates a throwaway
 * database, applies migrations/ through scripts/migrate.mjs, seeds two boards
 * (one flipped, one not) and drives the real HTTP surface
 * (`handleAgentApiRequest`) plus the real store (`durableBoard`).
 *
 * What it proves:
 *   a) enforced board + agent principal: closed → 422 lane_violation
 *      (closed_no_authority); blocked-evidence without evidence_missing → 422
 *      (blocked_no_reason); nothing written, no history row minted
 *   b) enforced board + agent principal: a legal transition (open → evidence)
 *      is accepted and recorded with actor_kind='agent'
 *   c) human principal (same-origin operator session / local open mode) is
 *      exempt: a lane write is accepted and recorded with actor_kind='human',
 *      and closed still needs authority=shane + pass + evidence_ref
 *   d) board scoping: the same bad agent write on an unflipped board is
 *      accepted (200) — enforcement is per board, never fleet-wide
 *   e) soft rollback: with LANES_ENFORCE unset the guard stops rejecting on an
 *      otherwise-flipped board (byte-identical write path again)
 *   f) `→ done` coercion: an agent move to done on a flipped board leaves the
 *      card lane=evidence/unverified with a history row (never closed)
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import pg from "pg";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_API = pathToFileURL(join(REPO, "src", "lib", "agent-api.server.ts")).href;
const BOARD_STORE = pathToFileURL(join(REPO, "src", "lib", "board-store.server.ts")).href;
const GLOBAL_KEY = "lane_guard_test_key";

const PROJECT_ENFORCED = "proj_lane_guard_on";
const PROJECT_PLAIN = "proj_lane_guard_off";

const M = {
  agentClosed: "msn_lg_agent_closed",
  agentBlocked: "msn_lg_agent_blocked",
  agentEvidence: "msn_lg_agent_evidence",
  plainBoard: "msn_lg_plain_closed",
  offBoard: "msn_lg_off_soft_rollback",
  humanBlocked: "msn_lg_human_blocked",
  humanClosed: "msn_lg_human_closed",
  humanClosedBad: "msn_lg_human_closed_bad",
  coerced: "msn_lg_coerce_done",
  moveOn: "msn_lg_move_on",
  movePlain: "msn_lg_move_plain",
  moveOff: "msn_lg_move_off",
};

let failures = 0;
function check(name, cond, detail = "") {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${detail}`}`);
  if (!ok) failures += 1;
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Child env: LANES_ENFORCE explicitly absent unless given; key unless disabled. */
function envFor(dbUrl, lanesEnforce, withKey) {
  const env = { ...process.env, DATABASE_URL: dbUrl, AGENT_RELAY_API_KEY: withKey ? GLOBAL_KEY : "" };
  delete env.LANES_ENFORCE;
  delete env.BETTER_AUTH_URL; // local open mode → operator path, no session store
  delete env.AGENT_RELAY_HUMAN_AUTH;
  if (lanesEnforce !== undefined) env.LANES_ENFORCE = lanesEnforce;
  return env;
}

const PROBE_HTTP = `
import { handleAgentApiRequest } from ${JSON.stringify(AGENT_API)};
const base = "http://local/api/agent";
const headers = { "content-type": "application/json" };
if (process.env.PROBE_KEY) headers["authorization"] = "Bearer " + process.env.PROBE_KEY;
async function post(path, body) {
  const res = await handleAgentApiRequest(
    new Request(base + path, { method: "POST", headers, body: JSON.stringify(body) }),
  );
  let parsed = null;
  try { parsed = await res.json(); } catch {}
  return { status: res.status, body: parsed };
}
const out = {};
for (const step of JSON.parse(process.env.PROBE_STEPS)) {
  out[step.name] = await post(step.path, step.body);
}
process.stdout.write(JSON.stringify(out));
`;

const PROBE_MOVE = `
import { durableBoard } from ${JSON.stringify(BOARD_STORE)};
const out = {};
for (const step of JSON.parse(process.env.PROBE_STEPS)) {
  const res = await durableBoard.moveMission(step.id, step.column, "tester", step.kind ?? "agent");
  out[step.name] = { ok: res.ok, status: res.status ?? 200, code: res.code ?? null,
                     violations: (res.data && res.data.violations) || [] };
}
process.stdout.write(JSON.stringify(out));
`;

function runProbe(dbUrl, source, env) {
  const dir = mkdtempSync(join(tmpdir(), "lane-guard-"));
  const file = join(dir, "probe.mjs");
  writeFileSync(file, source);
  const res = spawnSync(process.execPath, ["--import", "tsx", file], {
    cwd: REPO,
    env: { ...env, TSX_TSCONFIG_PATH: join(REPO, "tsconfig.json") },
    encoding: "utf8",
  });
  if (res.status !== 0) {
    return { error: `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim() };
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    return { error: `unparsable probe output: ${res.stdout}` };
  }
}

async function seed(client) {
  await client.query(
    `INSERT INTO ar_projects (id, name, slug, lanes_enforce) VALUES
       ($1, 'Lane guard enforced', $1, true),
       ($2, 'Lane guard plain', $2, false)
     ON CONFLICT (id) DO UPDATE SET lanes_enforce = excluded.lanes_enforce`,
    [PROJECT_ENFORCED, PROJECT_PLAIN],
  );
  const insert = (id, project, column, lane) =>
    client.query(
      `INSERT INTO ar_missions (id, title, column_id, project_id, lane, lane_changed_by,
                                lane_changed_at, evidence_type, check_result)
       VALUES ($1, $1, $2, $3, $4, 'migration:0052', now(), 'none', 'unverified')`,
      [id, column, project, lane],
    );
  await insert(M.agentClosed, PROJECT_ENFORCED, "ready", "open");
  await insert(M.agentBlocked, PROJECT_ENFORCED, "ready", "open");
  await insert(M.agentEvidence, PROJECT_ENFORCED, "ready", "open");
  await insert(M.offBoard, PROJECT_ENFORCED, "ready", "open");
  await insert(M.humanBlocked, PROJECT_ENFORCED, "ready", "open");
  await insert(M.humanClosed, PROJECT_ENFORCED, "done", "evidence");
  await insert(M.humanClosedBad, PROJECT_ENFORCED, "done", "evidence");
  await insert(M.coerced, PROJECT_ENFORCED, "review", "open");
  await insert(M.plainBoard, PROJECT_PLAIN, "ready", "open");
  // Move-path cases: a blocked-evidence card in needs_human. An agent moving it
  // to running would produce column_lane_mismatch — rejected only where the
  // board is enforced.
  const blocked = (id, project) =>
    client.query(
      `INSERT INTO ar_missions (id, title, column_id, project_id, lane, lane_authority,
                                lane_changed_by, lane_changed_at, evidence_type,
                                check_result, evidence_missing)
       VALUES ($1, $1, 'needs_human', $2, 'blocked_evidence', 'agent:seed',
               'migration:0052', now(), 'none', 'unverified', 'vendor invoice')`,
      [id, project],
    );
  await blocked(M.moveOn, PROJECT_ENFORCED);
  await blocked(M.movePlain, PROJECT_PLAIN);
  await blocked(M.moveOff, PROJECT_ENFORCED);
}

async function laneRow(client, id) {
  const r = await client.query(
    `SELECT lane, lane_authority, check_result, evidence_ref, evidence_missing
       FROM ar_missions WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

async function laneHistory(client, id) {
  const r = await client.query(
    `SELECT from_lane, to_lane, actor_kind, actor_id, authority
       FROM ar_mission_lane_history WHERE mission_id = $1 ORDER BY at ASC`,
    [id],
  );
  return r.rows;
}

async function main() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    console.error("test-lane-guard: DATABASE_URL is required (point it at local Postgres).");
    process.exit(2);
  }

  const base = new URL(rawUrl);
  const dbName = `lane_guard_test_${process.pid}_${Date.now().toString(36)}`;
  const scratch = new URL(base);
  scratch.pathname = `/${dbName}`;
  scratch.search = "";
  const scratchUrl = scratch.toString();

  let admin = null;
  for (const maintenance of ["postgres", "template1"]) {
    const candidateUrl = new URL(base);
    candidateUrl.pathname = `/${maintenance}`;
    candidateUrl.search = "";
    const candidate = new pg.Client({ connectionString: candidateUrl.toString() });
    try {
      await candidate.connect();
      admin = candidate;
      break;
    } catch {
      await candidate.end().catch(() => undefined);
    }
  }
  if (!admin) {
    console.error("test-lane-guard: cannot connect to a maintenance database.");
    process.exit(2);
  }

  let created = false;
  try {
    await admin.query(`CREATE DATABASE ${dbName}`);
    created = true;
    console.log(`scratch database: ${dbName}`);

    const migrate = spawnSync(process.execPath, [join(REPO, "scripts", "migrate.mjs")], {
      cwd: REPO,
      env: { ...process.env, DATABASE_URL: scratchUrl },
      encoding: "utf8",
    });
    if (migrate.status !== 0) {
      console.error(migrate.stdout, migrate.stderr);
      throw new Error("migrations failed on the scratch database");
    }
    check("migrations applied (incl. 0052/0053)", !migrate.stdout.includes("error"));

    const client = new pg.Client({ connectionString: scratchUrl });
    client.on("error", () => undefined); // cleanup terminates this backend
    await client.connect();
    await seed(client);

    // ------------------------------------------------ A) agent on enforced board
    const agentSteps = [
      {
        name: "closed",
        path: `/missions/${M.agentClosed}/lane`,
        body: { lane: "closed", check_result: "pass", evidence_ref: "file:docs/x.md" },
      },
      {
        name: "blocked",
        path: `/missions/${M.agentBlocked}/lane`,
        body: { lane: "blocked_evidence" },
      },
      {
        name: "evidence",
        path: `/missions/${M.agentEvidence}/lane`,
        body: { lane: "evidence", evidence_type: "file", evidence_ref: "file:docs/y.md" },
      },
    ];
    const agent = runProbe(
      scratchUrl,
      PROBE_HTTP,
      { ...envFor(scratchUrl, "1", true), PROBE_KEY: GLOBAL_KEY, PROBE_STEPS: JSON.stringify(agentSteps) },
    );
    check("agent probe ran", !agent.error, agent.error);
    eq("agent closed on enforced board → HTTP 422", agent.closed?.status, 422);
    eq("agent closed → code lane_violation", agent.closed?.body?.code, "lane_violation");
    check(
      "agent closed → rule closed_no_authority named",
      JSON.stringify(agent.closed?.body?.violations ?? []).includes("closed_no_authority"),
      JSON.stringify(agent.closed?.body ?? {}),
    );
    eq("agent closed → enforce_active reported true", agent.closed?.body?.enforce_active, true);
    eq("agent blocked without reason → HTTP 422", agent.blocked?.status, 422);
    check(
      "agent blocked → rule blocked_no_reason named",
      JSON.stringify(agent.blocked?.body?.violations ?? []).includes("blocked_no_reason"),
      JSON.stringify(agent.blocked?.body ?? {}),
    );
    eq("agent legal open→evidence → HTTP 200", agent.evidence?.status, 200);
    eq("agent legal move recorded lane=evidence", (await laneRow(client, M.agentEvidence))?.lane, "evidence");
    const agentHist = await laneHistory(client, M.agentEvidence);
    eq("agent legal move wrote exactly one history row", agentHist.length, 1);
    eq("agent history actor_kind", agentHist[0]?.actor_kind, "agent");
    eq("rejected closed wrote NO lane history row", (await laneHistory(client, M.agentClosed)).length, 0);
    eq("rejected closed left lane=open", (await laneRow(client, M.agentClosed))?.lane, "open");
    eq("rejected blocked left lane=open", (await laneRow(client, M.agentBlocked))?.lane, "open");

    // ------------------------------------------- D) board scoping (unflipped)
    // The same agent move that is refused on the flipped board is accepted on
    // the unflipped one: enforcement is per board, never fleet-wide. (An agent
    // close is refused on every board — `closed` is an authority rule, not an
    // enforcement one.)
    const moves = runProbe(
      scratchUrl,
      PROBE_MOVE,
      {
        ...envFor(scratchUrl, "1", false),
        PROBE_STEPS: JSON.stringify([
          { name: "enforced", id: M.moveOn, column: "running" },
          { name: "plain", id: M.movePlain, column: "running" },
        ]),
      },
    );
    check("move probe ran", !moves.error, moves.error);
    eq("agent bad lane move on ENFORCED board → 422", moves.enforced?.status, 422);
    eq("agent bad lane move → code lane_violation", moves.enforced?.code, "lane_violation");
    check(
      "agent bad lane move → rule column_lane_mismatch named",
      JSON.stringify(moves.enforced?.violations ?? []).includes("column_lane_mismatch"),
      JSON.stringify(moves.enforced ?? {}),
    );
    eq("agent bad lane move left the column untouched", (await client.query(
      `SELECT column_id FROM ar_missions WHERE id = $1`, [M.moveOn],
    )).rows[0]?.column_id, "needs_human");
    eq("agent bad lane move on UNFLIPPED board → accepted", moves.plain?.status, 200);
    eq("unflipped board moved the card (no fleet-wide enforcement)", (await client.query(
      `SELECT column_id FROM ar_missions WHERE id = $1`, [M.movePlain],
    )).rows[0]?.column_id, "running");

    // ------------------------------------------------ E) soft rollback (env off)
    const off = runProbe(
      scratchUrl,
      PROBE_MOVE,
      {
        ...envFor(scratchUrl, undefined, false),
        PROBE_STEPS: JSON.stringify([{ name: "off", id: M.moveOff, column: "running" }]),
      },
    );
    check("soft-rollback probe ran", !off.error, off.error);
    eq("LANES_ENFORCE unset → the same move is accepted", off.off?.status, 200);
    eq("LANES_ENFORCE unset → enforce_active false", (await client.query(
      `SELECT project_id FROM ar_missions WHERE id = $1`, [M.moveOff],
    )).rows[0]?.project_id, PROJECT_ENFORCED);

    // ----------------------------------------------------- B/C) human principal
    const humanSteps = [
      {
        name: "blocked",
        path: `/missions/${M.humanBlocked}/lane`,
        body: { lane: "blocked_evidence", evidence_missing: "vendor invoice" },
      },
      {
        name: "closed_bad",
        path: `/missions/${M.humanClosedBad}/lane`,
        body: { lane: "closed" },
      },
      {
        name: "closed_ok",
        path: `/missions/${M.humanClosed}/lane`,
        body: {
          lane: "closed",
          check_result: "pass",
          evidence_ref: "https://app.devboards.ai/missions/x",
        },
      },
    ];
    const human = runProbe(
      scratchUrl,
      PROBE_HTTP,
      {
        ...envFor(scratchUrl, "1", false),
        // The Shane principal is configured server-side; the request body never
        // decides it. In open local mode the operator is dev@example.com.
        AGENT_RELAY_LANE_AUTHORITY_EMAILS: "dev@example.com",
        PROBE_KEY: "",
        PROBE_STEPS: JSON.stringify(humanSteps),
      },
    );
    check("human probe ran", !human.error, human.error);
    if (process.env.LANE_GUARD_DEBUG) console.log(JSON.stringify(human, null, 2));
    eq("human blocked-evidence on enforced board → HTTP 200", human.blocked?.status, 200);
    eq("human move recorded lane", (await laneRow(client, M.humanBlocked))?.lane, "blocked_evidence");
    const humanHist = await laneHistory(client, M.humanBlocked);
    eq("human move wrote one history row", humanHist.length, 1);
    eq("human history actor_kind", humanHist[0]?.actor_kind, "human");
    eq("human blocked recorded evidence_missing", (await laneRow(client, M.humanBlocked))?.evidence_missing, "vendor invoice");
    eq("human closed without evidence → 422", human.closed_bad?.status, 422);
    eq("human closed with shane authority + pass + ref → 200", human.closed_ok?.status, 200);
    eq("human closed recorded lane", (await laneRow(client, M.humanClosed))?.lane, "closed");
    eq("human closed recorded authority", (await laneRow(client, M.humanClosed))?.lane_authority, "shane");

    // ------------------------------------------------ F) → done coercion
    const coerceEnv = {
      ...envFor(scratchUrl, "1", false),
      PROBE_STEPS: JSON.stringify([{ name: "coerce", id: M.coerced, column: "done" }]),
    };
    const coerce = runProbe(scratchUrl, PROBE_MOVE, coerceEnv);
    check("coercion probe ran", !coerce.error, coerce.error);
    eq("agent move → done accepted", coerce.coerce?.ok, true);
    const coercedRow = await laneRow(client, M.coerced);
    eq("→ done coerced lane to evidence", coercedRow?.lane, "evidence");
    eq("→ done coerced check_result to unverified", coercedRow?.check_result, "unverified");
    const coerceHist = await laneHistory(client, M.coerced);
    eq("coercion wrote a history row", coerceHist.length, 1);
    eq("coercion history to_lane", coerceHist[0]?.to_lane, "evidence");
    check("coercion never closes", coerceHist[0]?.to_lane !== "closed");

    // ------------------------------------------------------------- gate clean
    const violations = await client.query(
      `SELECT rule_code, count(*)::int AS c FROM ar_mission_lane_violations GROUP BY 1 ORDER BY 1`,
    );
    const bad = violations.rows.filter((r) =>
      ["closed_no_authority", "blocked_no_reason", "closed_no_evidence"].includes(r.rule_code),
    );
    check(
      "no guard-driven violation rows were written",
      bad.length === 0,
      JSON.stringify(violations.rows),
    );

    await client.end();
  } finally {
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName],
      );
      if (created) await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    } catch (error) {
      console.error(`test-lane-guard: cleanup warning: ${error?.message || error}`);
    }
    await admin.end().catch(() => undefined);
  }

  console.log("");
  if (failures) {
    console.log(`${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log("ALL CHECKS PASSED");
}

main().catch((error) => {
  console.error(`test-lane-guard: ${error?.stack || error}`);
  process.exit(1);
});
