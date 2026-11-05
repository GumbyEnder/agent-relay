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
  const raw = execFileSync("railway", ["deployment", "list", "--service", service, "--json"], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  const parsed = JSON.parse(raw);
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
