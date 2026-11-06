#!/usr/bin/env node
/**
 * test-lane-gate.mjs — P2 gate read surface, on a REAL local Postgres.
 *
 *   node scripts/test-lane-gate.mjs
 *
 * DATABASE_URL must point at a Postgres role allowed to CREATE DATABASE (the
 * local containers on this host use trust auth; see docker-compose.yml for the
 * repo's own DB URL shape). The test creates a throwaway database, applies
 * migrations/ through scripts/migrate.mjs, seeds legacy lane violations the
 * 0052 CHECK constraints would otherwise block, and drops the database again.
 *
 * What it proves:
 *   a) scoped / null_project_id / global counts match seeded rows covering
 *      closed_no_authority and pass_no_ref (plus a project_id IS NULL row)
 *   b) exit codes: 1 for violations, 0 only when scoped==0 && null==0 (or
 *      global==0 for --all), 2 for usage errors
 *   c) GET /api/agent/lane-gate (invoked through handleAgentApiRequest with a
 *      synthetic Request) returns byte-identical counts and rows to the CLI for
 *      the same snapshot
 *   d) enforce_active is false with LANES_ENFORCE unset, and false with
 *      lanes_enforce=false even when LANES_ENFORCE=1
 *
 * The scratch DB deliberately:
 *   - drops the five lane CHECK constraints, because offending rows predate the
 *     constraints (0052 added them NOT VALID then validated; any surviving
 *     violation came from a writer that bypassed them). The view must still see
 *     such rows.
 *   - drops NOT NULL on ar_missions.project_id, because the gate contract
 *     treats project_id IS NULL as possible (docs/MISSION-LANES-ENFORCEMENT.md)
 *     and must disclose it rather than assume it away.
 * Both mutations are confined to the throwaway database.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "scripts", "lane-gate.mjs");
const AGENT_API = pathToFileURL(join(REPO, "src", "lib", "agent-api.server.ts")).href;

let failures = 0;
function check(name, cond, detail = "") {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${detail}`}`);
  if (!ok) failures += 1;
}

function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Child env with LANES_ENFORCE explicitly absent (not just empty). */
function envWith(dbUrl, lanesEnforce) {
  const env = { ...process.env, DATABASE_URL: dbUrl, AGENT_RELAY_API_KEY: "" };
  delete env.LANES_ENFORCE;
  if (lanesEnforce !== undefined) env.LANES_ENFORCE = lanesEnforce;
  return env;
}

function runCli(dbUrl, args, lanesEnforce) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO,
    env: envWith(dbUrl, lanesEnforce),
    encoding: "utf8",
  });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    /* human output or error */
  }
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", json };
}

function runEndpoint(dbUrl, query, lanesEnforce) {
  const url = `http://local/api/agent/lane-gate${query}`;
  const probe = `
import { handleAgentApiRequest } from ${JSON.stringify(AGENT_API)};
const res = await handleAgentApiRequest(new Request(process.env.LANE_GATE_PROBE_URL));
const body = await res.json();
process.stdout.write(JSON.stringify({ status: res.status, body }));
`;
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", probe],
    {
      cwd: REPO,
      env: { ...envWith(dbUrl, lanesEnforce), LANE_GATE_PROBE_URL: url },
      encoding: "utf8",
    },
  );
  if (res.status !== 0) {
    return { status: res.status, stderr: res.stderr ?? "", body: null };
  }
  return { status: res.status, stderr: res.stderr ?? "", ...JSON.parse(res.stdout) };
}

const PROJECT_A = "proj_lane_gate_a";
const PROJECT_B = "proj_lane_gate_b";
const PROJECT_C = "proj_lane_gate_c";

async function seed(client) {
  await client.query(
    `ALTER TABLE ar_missions
       DROP CONSTRAINT IF EXISTS ar_missions_lane_authority_chk,
       DROP CONSTRAINT IF EXISTS ar_missions_authority_required_chk,
       DROP CONSTRAINT IF EXISTS ar_missions_closed_evidence_chk,
       DROP CONSTRAINT IF EXISTS ar_missions_pass_ref_chk,
       DROP CONSTRAINT IF EXISTS ar_missions_blocked_missing_chk`,
  );
  await client.query(`ALTER TABLE ar_missions ALTER COLUMN project_id DROP NOT NULL`);

  for (const [id, name] of [
    [PROJECT_A, "Lane gate A"],
    [PROJECT_B, "Lane gate B"],
    [PROJECT_C, "Lane gate C"],
  ]) {
    await client.query(
      `INSERT INTO ar_projects (id, name, slug) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [id, name, id],
    );
  }

  // closed_no_authority: lane=closed, no shane authority. pass + ref present so
  // closed_no_evidence does NOT also fire; column=done keeps column_lane_mismatch
  // quiet; the 0052 marker exempts no_lane_history.
  await client.query(
    `INSERT INTO ar_missions
       (id, title, column_id, project_id, lane, lane_authority, check_result,
        evidence_ref, lane_changed_by, lane_changed_at)
     VALUES ('msn_gate_closed_bad', 'closed without authority', 'done', $1,
             'closed', NULL, 'pass', 'file:docs/evidence.md', 'migration:0052', now())`,
    [PROJECT_A],
  );

  // pass_no_ref: check_result=pass with no openable evidence_ref.
  await client.query(
    `INSERT INTO ar_missions
       (id, title, column_id, project_id, lane, check_result, evidence_ref,
        lane_changed_by, lane_changed_at)
     VALUES ('msn_gate_pass_noref', 'pass without ref', 'done', $1,
             'evidence', 'pass', NULL, 'migration:0052', now())`,
    [PROJECT_A],
  );

  // Orphan: project_id IS NULL. The gate must disclose it, never hide it.
  await client.query(
    `INSERT INTO ar_missions
       (id, title, column_id, project_id, lane, check_result, evidence_ref,
        lane_changed_by, lane_changed_at)
     VALUES ('msn_gate_orphan', 'orphan pass without ref', 'done', NULL,
             'evidence', 'pass', NULL, 'migration:0052', now())`,
  );

  // Clean board: nothing wrong here.
  await client.query(
    `INSERT INTO ar_missions (id, title, column_id, project_id, lane)
     VALUES ('msn_gate_clean', 'clean open card', 'ready', $1, 'open')`,
    [PROJECT_B],
  );
}

async function main() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    console.error("test-lane-gate: DATABASE_URL is required (point it at local Postgres).");
    process.exit(2);
  }

  const base = new URL(rawUrl);
  const dbName = `lane_gate_test_${process.pid}_${Date.now().toString(36)}`;
  const scratch = new URL(base);
  scratch.pathname = `/${dbName}`;
  scratch.search = "";
  const scratchUrl = scratch.toString();

  const adminCandidates = ["postgres", "template1"];
  let admin = null;
  for (const maintenance of adminCandidates) {
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
    console.error("test-lane-gate: cannot connect to a maintenance database to create the scratch DB.");
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
      console.error(migrate.stdout);
      console.error(migrate.stderr);
      throw new Error("migrations failed on the scratch database");
    }
    const applied0053 = migrate.stdout.includes("applied 0053_project_lanes_enforce.sql");
    check("migrations applied, including 0053", applied0053, migrate.stdout.trim().split("\n").pop());

    const client = new pg.Client({ connectionString: scratchUrl });
    await client.connect();
    try {
      const col = await client.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name = 'ar_projects' AND column_name = 'lanes_enforce'`,
      );
      check("0053 adds ar_projects.lanes_enforce", col.rowCount === 1);

      const def = await client.query(
        `SELECT column_default, is_nullable FROM information_schema.columns
          WHERE table_name = 'ar_projects' AND column_name = 'lanes_enforce'`,
      );
      check(
        "lanes_enforce defaults to false and is NOT NULL",
        /false/.test(def.rows[0]?.column_default ?? "") && def.rows[0]?.is_nullable === "NO",
        JSON.stringify(def.rows[0]),
      );

      await seed(client);
    } finally {
      await client.end();
    }

    // ---------------------------------------------------------------- CLI ----
    const scopedA = runCli(scratchUrl, ["--project-id", PROJECT_A, "--json"]);
    eq("CLI scoped exit code is 1 (violations present)", scopedA.status, 1);
    eq("CLI scoped counts", JSON.stringify(scopedA.json?.counts), JSON.stringify({
      scoped: 2,
      null_project_id: 1,
      global: 3,
    }));
    eq("CLI scoped ok=false", scopedA.json?.ok, false);
    eq("CLI scoped project_id", scopedA.json?.project_id, PROJECT_A);
    eq(
      "CLI scoped rows are the two seeded rules",
      JSON.stringify((scopedA.json?.violations ?? []).map((v) => [v.mission_id, v.rule_code])),
      JSON.stringify([
        ["msn_gate_closed_bad", "closed_no_authority"],
        ["msn_gate_pass_noref", "pass_no_ref"],
      ]),
    );
    eq(
      "CLI scoped closed_no_authority detail",
      scopedA.json?.violations?.[0]?.detail,
      "closed lane without shane authority (authority=null)",
    );
    eq("CLI scoped enforce_active false (LANES_ENFORCE unset)", scopedA.json?.enforce_active, false);

    const cleanB = runCli(scratchUrl, ["--project-id", PROJECT_B, "--json"]);
    eq(
      "CLI clean board without null orphans still exits 1 while null_project_id > 0",
      cleanB.status,
      1,
    );
    eq("CLI clean board counts", JSON.stringify(cleanB.json?.counts), JSON.stringify({
      scoped: 0,
      null_project_id: 1,
      global: 3,
    }));

    const all = runCli(scratchUrl, ["--all", "--json"]);
    eq("CLI --all exit code is 1", all.status, 1);
    eq("CLI --all counts (scoped==global)", JSON.stringify(all.json?.counts), JSON.stringify({
      scoped: 3,
      null_project_id: 1,
      global: 3,
    }));
    eq("CLI --all project_id is null", all.json?.project_id, null);
    eq(
      "CLI --all includes the orphan row",
      (all.json?.violations ?? []).filter((v) => v.project_id === null).length,
      1,
    );

    // Requirement (d): env on, board flag off -> still false.
    const envOnA = runCli(scratchUrl, ["--project-id", PROJECT_A, "--json"], "1");
    eq("CLI enforce_active false when LANES_ENFORCE=1 but lanes_enforce=false", envOnA.json?.enforce_active, false);

    // Non-vacuous AND: board flag on + env on -> true.
    const setFlag = new pg.Client({ connectionString: scratchUrl });
    await setFlag.connect();
    await setFlag.query(`UPDATE ar_projects SET lanes_enforce = true WHERE id = $1`, [PROJECT_C]);
    await setFlag.end();
    const flagOnC = runCli(scratchUrl, ["--project-id", PROJECT_C, "--json"], "1");
    eq("CLI enforce_active true only when board AND env are on", flagOnC.json?.enforce_active, true);
    const flagOnCNoEnv = runCli(scratchUrl, ["--project-id", PROJECT_C, "--json"]);
    eq("CLI enforce_active false when board on but LANES_ENFORCE unset", flagOnCNoEnv.json?.enforce_active, false);

    const human = runCli(scratchUrl, ["--project-id", PROJECT_A]);
    check(
      "CLI human output prints all three counts",
      ["scoped", "null_project_id", "global"].every((k) => human.stdout.includes(k)),
      human.stdout,
    );

    eq("CLI --help exits 0", runCli(scratchUrl, ["--help"]).status, 0);
    eq("CLI with no scope exits 2", runCli(scratchUrl, []).status, 2);
    eq("CLI bad flag exits 2", runCli(scratchUrl, ["--nope"]).status, 2);

    // ----------------------------------------------------------- endpoint ----
    const epScoped = runEndpoint(scratchUrl, `?project_id=${PROJECT_A}`);
    eq("endpoint scoped HTTP status 200", epScoped.status, 200);
    eq(
      "endpoint scoped body === CLI --json body",
      JSON.stringify(epScoped.body),
      JSON.stringify(scopedA.json),
    );

    const epAll = runEndpoint(scratchUrl, "");
    eq(
      "endpoint all-body === CLI --all --json body",
      JSON.stringify(epAll.body),
      JSON.stringify(all.json),
    );

    const epEnvOnA = runEndpoint(scratchUrl, `?project_id=${PROJECT_A}`, "1");
    eq(
      "endpoint enforce_active false with lanes_enforce=false even if LANES_ENFORCE=1",
      epEnvOnA.body?.enforce_active,
      false,
    );
    eq(
      "endpoint counts unchanged by enforce flags",
      JSON.stringify(epEnvOnA.body?.counts),
      JSON.stringify({ scoped: 2, null_project_id: 1, global: 3 }),
    );

    // ----------------------------------------------------- clean exit path ----
    const del = new pg.Client({ connectionString: scratchUrl });
    await del.connect();
    await del.query(`DELETE FROM ar_missions WHERE project_id IS NULL`);
    const cleanRun = await (async () => {
      const res = runCli(scratchUrl, ["--project-id", PROJECT_B, "--json"]);
      return res;
    })();
    const globalAfter = await del.query(`SELECT count(*)::int AS c FROM ar_mission_lane_violations`);
    await del.end();
    eq("CLI scoped clean run exits 0 after orphan removed", cleanRun.status, 0);
    eq("CLI scoped clean run ok=true", cleanRun.json?.ok, true);
    eq("CLI scoped clean run null_project_id=0", cleanRun.json?.counts?.null_project_id, 0);
    eq("view still has the two board-A violations", globalAfter.rows[0]?.c, 2);
  } finally {
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName],
      );
      if (created) await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    } catch (error) {
      console.error(`test-lane-gate: cleanup warning: ${error?.message || error}`);
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
  console.error(`test-lane-gate: ${error?.stack || error}`);
  process.exit(1);
});
