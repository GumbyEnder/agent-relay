#!/usr/bin/env node
/**
 * Is production running the commit I just pushed?
 *
 * `railway redeploy` exits 0 while doing nothing, and exits non-zero while the
 * push-triggered deploy is already in flight — so an exit code proves nothing
 * either way. This asks the only question that matters: which commit is serving
 * traffic right now.
 *
 *   node scripts/verify-deploy.mjs                 # HEAD vs live
 *   node scripts/verify-deploy.mjs --expect abc1234
 *   node scripts/verify-deploy.mjs --wait 480      # poll until it lands
 *   node scripts/verify-deploy.mjs --probe /api/buzzy/capabilities
 *
 * Exit 0 = live commit matches. Exit 1 = it does not (and says both hashes).
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * The railway binary.
 *
 * A background/cron wrapper runs with a different PATH than an interactive shell,
 * and `execFileSync("railway")` then throws ENOENT. That used to surface as a bare
 * "Node.js v25.x" stack tail with no PASS/FAIL line — which reads as a failed
 * deploy when in truth nothing was ever checked. Resolve the binary, and if it is
 * genuinely absent say so and exit 2 ("could not verify"), never 1 ("does not match").
 */
function resolveRailway() {
  const candidates = [
    process.env.RAILWAY_BIN,
    `${process.env.HOME}/.railway/bin/railway`,
    "/usr/local/bin/railway",
    "/opt/homebrew/bin/railway",
    "railway",
  ].filter(Boolean);
  for (const c of candidates) {
    if (c === "railway") {
      try {
        execFileSync("railway", ["--version"], { stdio: "ignore", cwd: process.env.HOME || "." });
        return "railway";
      } catch { /* not on PATH */ }
    } else if (existsSync(c)) {
      return c;
    }
  }
  return null;
}

/**
 * Where to run the CLI from.
 *
 * ~/.railway/config.json keys the linked project by PATH, not by repo. Invoked from
 * a scratch worktree (/tmp/bz-*), no ancestor is linked and the CLI answers
 * "Service 'agent-relay' not found" — which used to look like a failed deploy. Run
 * from a linked ancestor instead; --cwd / RAILWAY_CWD overrides.
 */
const RAILWAY_CWD = (() => {
  const explicit = (() => {
    const i = process.argv.indexOf("--cwd");
    return i >= 0 ? process.argv[i + 1] : null;
  })();
  if (explicit) return explicit;
  if (process.env.RAILWAY_CWD) return process.env.RAILWAY_CWD;
  // The link is per PATH PREFIX and /tmp is linked to a DIFFERENT project, so a
  // scratch worktree silently resolves to the wrong Railway project ("Service
  // 'agent-relay' not found"). Prefer a known Agent Relay checkout.
  const known = [`${process.env.HOME}/agents/agent-relay-recipes`, `${process.env.HOME}/agents/agent-relay`];
  for (const k of known) if (existsSync(`${k}/railway.toml`)) return k;
  return process.cwd();
})();

const RAILWAY = resolveRailway();
if (!RAILWAY) {
  console.error("verify-deploy: CANNOT VERIFY — the `railway` CLI was not found.");
  console.error(`  PATH=${process.env.PATH ?? "(unset)"}`);
  console.error("  set RAILWAY_BIN=/path/to/railway, or run this from a shell where it is on PATH.");
  console.error("  This is not a failed deploy: nothing was checked.");
  process.exit(2);
}

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};

const service = flag("service", "agent-relay");
const waitSeconds = Number(flag("wait", "0"));
const probePath = flag("probe", null);
const expect =
  flag("expect") ??
  (() => {
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  })();

if (!expect) {
  console.error("could not determine the expected commit (pass --expect <sha>)");
  process.exit(1);
}

const live = () => {
  let raw;
  try {
    raw = execFileSync(RAILWAY, ["deployment", "list", "--service", service, "--json"], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      cwd: RAILWAY_CWD,
    });
  } catch (err) {
    // CLI present but the call failed (network, auth, service name). Say which.
    console.error(`verify-deploy: CANNOT VERIFY — \`railway deployment list\` failed: ${err.stderr?.toString().trim() || err.message}`);
    process.exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("verify-deploy: CANNOT VERIFY — railway returned non-JSON:");
    console.error(String(raw).slice(0, 300));
    process.exit(2);
  }
  const rows = Array.isArray(parsed) ? parsed : (parsed.deployments ?? []);
  // Newest first as the CLI returns them; take the first that is not REMOVED.
  const active = rows.find((r) => String(r.status ?? "").toUpperCase() !== "REMOVED") ?? rows[0];
  return {
    commit: String((active?.meta ?? {}).commitHash ?? "").slice(0, 7),
    status: String(active?.status ?? "?"),
    createdAt: active?.createdAt ?? "?",
  };
};

const shortExpect = expect.slice(0, 7);
const deadline = Date.now() + waitSeconds * 1000;
let state = live();

// A matching commit is not a served commit: the build can still be running, and
// probing during BUILDING gave a 404 on a route that then existed.
const ready = () => state.commit === shortExpect && /SUCCESS|RUNNING/i.test(state.status);
while (!ready() && Date.now() < deadline) {
  console.log(`waiting: live ${state.commit || "(none)"} (${state.status}) vs ${shortExpect}`);
  await new Promise((r) => setTimeout(r, 15000));
  state = live();
}

const match = ready();
console.log(`${match ? "PASS" : "FAIL"}  live ${state.commit || "(none)"} · ${state.status} · ${state.createdAt}`);
console.log(`      expected ${shortExpect} (${expect})`);

if (match && probePath) {
  const base = flag("base", "https://app.devboards.ai");
  try {
    const res = await fetch(base + probePath, { redirect: "manual" });
    // 200 and 401 both prove the route exists; 404 means the build is older.
    const ok = res.status !== 404;
    console.log(`${ok ? "PASS" : "FAIL"}  probe ${probePath} -> ${res.status}`);
    if (!ok) process.exitCode = 1;
  } catch (err) {
    console.log(`FAIL  probe ${probePath} -> ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}

process.exitCode = match ? (process.exitCode ?? 0) : 1;
