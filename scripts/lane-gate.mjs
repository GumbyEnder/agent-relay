#!/usr/bin/env node
/**
 * lane-gate — read-only mission-lane violation report (P2).
 *
 * Reads `ar_mission_lane_violations` (0052) and reports THREE counts together,
 * every run, in both human and --json output:
 *
 *   scoped           rows for --project-id (all rows for --all)
 *   null_project_id  rows the gate cannot attribute to a board (disclosure)
 *   global           every row (cross-check; project_id can be null)
 *
 * Exit codes:
 *   0  scoped run: scoped == 0 AND null_project_id == 0
 *      --all run:  global == 0
 *   1  the gate is not clean
 *   2  usage / database error (the gate could not answer — never report that
 *      as clean)
 *
 * Enforcing is NOT this script's job. `enforce_active` is informational:
 *   enforce_active = ar_projects.lanes_enforce AND LANES_ENFORCE (truthy)
 * An unset/empty LANES_ENFORCE is 0. Nothing here flips a flag or writes a row.
 *
 * Usage:
 *   node scripts/lane-gate.mjs --project-id proj_default
 *   node scripts/lane-gate.mjs --all --json
 *   DATABASE_URL=postgres://… node scripts/lane-gate.mjs --all
 */
import pg from "pg";
import { pathToFileURL } from "node:url";

const HELP = `lane-gate — mission-lane violation report (read-only)

Usage:
  node scripts/lane-gate.mjs --project-id <id> [--json]
  node scripts/lane-gate.mjs --all [--json]

Flags:
  --project-id <id>  scope the report to one board
  --all              report every board (no project filter)
  --json             machine-readable output
  --help, -h         this text

Environment:
  DATABASE_URL       required; the database holding ar_mission_lane_violations
  LANES_ENFORCE      optional global veto; unset or empty reads as 0

Exit: 0 clean · 1 violations · 2 usage/database error

Always prints three counts: scoped, null_project_id, global. A scoped run is
clean only when scoped == 0 AND null_project_id == 0; --all is clean only when
global == 0.
`;

/** Unset/empty/"0"/"false" -> false. An absent env var is not consent. */
function envEnabled(name) {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return false;
  return !["0", "false", "off", "no", "none", "disabled"].includes(raw);
}

function parseArgs(argv) {
  const out = { projectId: null, all: false, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--all") out.all = true;
    else if (arg === "--project-id") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--project-id requires a value");
      }
      out.projectId = value.trim();
      i += 1;
    } else if (arg.startsWith("--project-id=")) {
      out.projectId = arg.slice("--project-id=".length).trim();
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (out.help) return out;
  if (out.all && out.projectId) throw new Error("--all and --project-id are mutually exclusive");
  if (!out.all && !out.projectId) throw new Error("one of --project-id <id> or --all is required");
  if (out.projectId === "") throw new Error("--project-id must not be empty");
  return out;
}

/**
 * The same report the endpoint returns. Exported so a test can compare a
 * direct-invocation snapshot against the HTTP handler shape without a server.
 */
export async function readLaneGate({ projectId = null } = {}) {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required (this repo's local DB: see docker-compose.yml)");
  }

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const client = await pool.connect();
  try {
    const counts = (
      await client.query(
        `SELECT count(*)::int AS global,
                count(*) FILTER (WHERE project_id IS NULL)::int AS null_project_id,
                count(*) FILTER (WHERE project_id = $1)::int AS scoped
           FROM ar_mission_lane_violations`,
        [projectId],
      )
    ).rows[0];

    const scopedCount = projectId ? counts.scoped : counts.global;

    const violations = (
      await client.query(
        `SELECT mission_id, project_id, rule_code, detail
           FROM ar_mission_lane_violations
          WHERE ($1::text IS NULL OR project_id = $1)
          ORDER BY project_id NULLS FIRST, mission_id, rule_code`,
        [projectId],
      )
    ).rows;

    // Degrade to false when 0053 has not reached this database: a gate that
    // cannot prove the flag is on is not enforcing.
    let perBoard = false;
    try {
      const row = (
        await client.query(
          `SELECT COALESCE(bool_or(lanes_enforce), false) AS enforce
             FROM ar_projects
            WHERE ($1::text IS NULL OR id = $1)`,
          [projectId],
        )
      ).rows[0];
      perBoard = row?.enforce === true;
    } catch (error) {
      if (error?.code !== "42703") throw error; // undefined_column only
      perBoard = false;
    }

    const report = {
      ok: projectId
        ? scopedCount === 0 && counts.null_project_id === 0
        : counts.global === 0,
      project_id: projectId,
      counts: {
        scoped: scopedCount,
        null_project_id: counts.null_project_id,
        global: counts.global,
      },
      enforce_active: perBoard && envEnabled("LANES_ENFORCE"),
      violations: violations.map((v) => ({
        mission_id: v.mission_id,
        project_id: v.project_id,
        rule_code: v.rule_code,
        detail: v.detail,
      })),
    };
    return report;
  } finally {
    client.release();
    await pool.end();
  }
}

function printHuman(report) {
  const scope = report.project_id ? `project=${report.project_id}` : "all boards";
  console.log(`lane-gate  ${scope}  enforce_active=${report.enforce_active}`);
  console.log(`  scoped           ${report.counts.scoped}`);
  console.log(`  null_project_id  ${report.counts.null_project_id}`);
  console.log(`  global           ${report.counts.global}`);
  if (report.violations.length) {
    console.log("");
    console.log("violations:");
    for (const v of report.violations) {
      console.log(
        `  ${v.rule_code}  ${v.mission_id}  ${v.project_id ?? "<null>"}  ${v.detail}`,
      );
    }
  }
  console.log("");
  console.log(report.ok ? "RESULT: CLEAN" : "RESULT: BLOCKED");
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`lane-gate: ${error.message}`);
    console.error("Try `node scripts/lane-gate.mjs --help`.");
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  let report;
  try {
    report = await readLaneGate({ projectId: args.projectId });
  } catch (error) {
    console.error(`lane-gate: ${error?.message || error}`);
    process.exit(2);
  }

  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printHuman(report);

  process.exit(report.ok ? 0 : 1);
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`lane-gate: ${error?.message || error}`);
    process.exit(2);
  });
}
