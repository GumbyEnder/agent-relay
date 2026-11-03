#!/usr/bin/env node
/**
 * BeeZilla local launcher — the runtime under both the desktop window and the CLI.
 *
 *   node scripts/beezilla-local.mjs            # serve on a free loopback port
 *   node scripts/beezilla-local.mjs --port 7400
 *   PORT=7400 node scripts/beezilla-local.mjs
 *
 * Responsibilities, all of them Windows-hostile if done wrong:
 *   - BZ_RUNTIME=local (durable on-disk PGLite, single owner, refusal-by-name)
 *   - bind 127.0.0.1 ONLY     → no Defender Firewall dialog, nothing on the LAN
 *   - pick a free port        → two installs / a stray instance must not fight
 *   - write runtime.json      → the window and the CLI find the live server
 *   - graceful shutdown       → PGLite flushes its WAL instead of being killed
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync, copyFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isExpired, resolveInference } from "./lib/inference.mjs";
import { loadManagedSearch, resolveSearch } from "./lib/search-keys.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "127.0.0.1";
const DEFAULT_PORT = 7331;

function dataDir() {
  const override = (process.env.BZ_DATA_DIR ?? "").trim();
  if (override) return override;
  if (platform() === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "BeeZilla", "data");
  }
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "BeeZilla", "data");
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "beezilla", "data");
}

function portFree(port) {
  return new Promise((done) => {
    const srv = createServer();
    srv.once("error", () => done(false));
    srv.once("listening", () => srv.close(() => done(true)));
    srv.listen(port, HOST);
  });
}

async function pickPort(preferred) {
  for (let p = preferred; p < preferred + 25; p++) {
    if (await portFree(p)) return p;
  }
  throw new Error(`no free loopback port in ${preferred}..${preferred + 25}`);
}

function argPort() {
  const i = process.argv.indexOf("--port");
  if (i !== -1) return Number(process.argv[i + 1]);
  if (process.env.PORT) return Number(process.env.PORT);
  return DEFAULT_PORT;
}

const dir = dataDir();
mkdirSync(dir, { recursive: true });

const entry = join(ROOT, ".output", "server", "index.mjs");
if (!existsSync(entry)) {
  console.error(
    `[beezilla] built server missing: ${entry}\n` +
      `           run \`npm run build\` first (the desktop installer ships this artifact).`,
  );
  process.exit(2);
}

// Nitro bundles the PGLite JS but NOT its wasm/data payloads, so a plain
// `vite build` produces a server that starts cleanly and then 500s on every
// database route. Restore them from node_modules so a local build is runnable.
function ensurePgliteAssets() {
  const dest = join(ROOT, ".output", "server", "_libs");
  const src = join(ROOT, "node_modules", "@electric-sql", "pglite", "dist");
  for (const file of ["pglite.data", "pglite.wasm", "initdb.wasm"]) {
    const target = join(dest, file);
    if (existsSync(target)) continue;
    if (!existsSync(join(src, file))) {
      console.error(`[beezilla] missing ${file} in both ${dest} and ${src}`);
      process.exit(2);
    }
    copyFileSync(join(src, file), target);
    console.log(`[beezilla] restored ${file} into .output/server/_libs`);
  }
}
ensurePgliteAssets();

const port = await pickPort(argPort());
const runtimeFile = join(dir, "runtime.json");

// Inference credentials: env wins, then the local store (BYOK or our device
// token). The runtime reads plain env, so this is where the store becomes reach.
const inference = resolveInference(dir);
const managedExpired = Boolean(inference && inference.provider === "beezilla" && isExpired(inference));
if (managedExpired) {
  console.warn("[beezilla] BeeZilla token expired — chat will ask the owner to reconnect");
}
if (inference && !managedExpired) {
  console.log(
    `[beezilla] inference: ${inference.provider}${inference.encrypted === false ? " (stored, unencrypted)" : inference.encrypted ? " (stored, encrypted)" : ""}`,
  );
} else if (!inference) {
  console.log("[beezilla] inference: none — chat will refuse by name");
}

// Web search: our Brave key (injected for the desktop build) or the owner's own
// stored key. Logged without the secret, like every other credential.
const search = resolveSearch(dir);
// An expired managed search token means "reconnect", not "search is off". Resolved
// here so the runtime can say which, without ever seeing an expired credential.
const managedSearchExpired = !search && Boolean(loadManagedSearch(dir));
console.log(
  search
    ? `[beezilla] web search: brave via ${search.source}${search.encrypted === false ? " (stored, unencrypted)" : ""}`
    : "[beezilla] web search: not configured — the model will answer without sources",
);

// Per-launch auth token: dies with the process, so a stale copy on disk is
// useless. The window receives it via preload; the CLI reads runtime.json.
const localToken = randomBytes(32).toString("base64url");

const child = spawn(process.execPath, [entry], {
  cwd: ROOT,
  env: {
    ...process.env,
    BZ_RUNTIME: "local",
    BZ_DATA_DIR: dir,
    BZ_LOCAL_TOKEN: localToken,
    ...(search && search.provider === "beezilla"
      ? { BZ_SEARCH_TOKEN: search.token, BZ_SEARCH_GATEWAY_URL: search.gateway }
      : search
        ? { BZ_BRAVE_KEY: search.key }
        : {}),
    ...(managedExpired ? { BZ_MANAGED_EXPIRED: "1" } : {}),
    ...(managedSearchExpired ? { BZ_SEARCH_EXPIRED: "1" } : {}),
    ...(inference && !managedExpired
      ? {
          BZ_CHAT_KEY: inference.key,
          ...(inference.baseUrl ? { BZ_CHAT_BASE_URL: inference.baseUrl } : {}),
          ...(inference.model ? { BZ_CHAT_MODEL: inference.model } : {}),
        }
      : {}),
    HOST,
    NITRO_HOST: HOST,
    PORT: String(port),
    NITRO_PORT: String(port),
    // The child must not outlive this launcher. If this process is SIGKILLed it
    // cannot clean up, so the child watches the pid itself.
    BZ_PARENT_PID: String(process.pid),
    // The watchdog is injected through NODE_OPTIONS, which is re-parsed by the
    // child's own option parser: double quotes group a path with spaces, but a
    // BACKSLASH inside them is an escape, so `--require "C:\Users\...\watchdog.cjs"`
    // arrived as `C:usersgumbyender...` and the child died at preload with
    // MODULE_NOT_FOUND. Node accepts forward slashes on Windows, and only the
    // quoting is then left to matter.
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS,
      `--require "${join(ROOT, "scripts/lib/parent-watchdog.cjs").replace(/\\/g, "/")}"`,
    ]
      .filter(Boolean)
      .join(" "),
  },
  stdio: ["ignore", "inherit", "inherit"],
});

// Same contract one level up: if whatever spawned this launcher disappears
// (electron crash, `timeout`, a test harness that gave up), stop cleanly instead
// of lingering as an orphan holding the port.
const launcherParent = process.ppid;
if (process.env.BZ_DEBUG) console.log(`[beezilla] launcher pid=${process.pid} ppid=${launcherParent}`);
const parentTimer = setInterval(() => {
  try {
    process.kill(launcherParent, 0);
  } catch {
    if (process.env.BZ_DEBUG) console.log(`[beezilla] parent ${launcherParent} is gone — shutting down`);
    stop("SIGTERM");
  }
}, 2000);
parentTimer.unref();

let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  try {
    rmSync(runtimeFile, { force: true });
  } catch {}
  child.kill(signal === "SIGINT" ? "SIGINT" : "SIGTERM");
  // PGLite needs a moment to flush; do not SIGKILL on a normal stop.
  setTimeout(() => process.exit(0), 3000).unref();
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => stop(sig));
}

child.on("exit", (code) => {
  try {
    rmSync(runtimeFile, { force: true });
  } catch {}
  process.exit(code ?? 0);
});

// Publish the endpoint as soon as the server answers, so a window/CLI never
// has to poll a hard-coded port.
const deadline = Date.now() + 60_000;
// "did not become ready" on its own sends the reader to the wrong place: a
// server that is listening but answering 500 and one that never bound look
// identical. Keep the last probe outcome and print it.
let lastProbe = "no probe completed";
for (;;) {
  if (Date.now() > deadline) {
    console.error(`[beezilla] server did not become ready within 60s — last probe: ${lastProbe}`);
    stop("SIGTERM");
    break;
  }
  try {
    const res = await fetch(`http://${HOST}:${port}/api/agent/health`, {
      signal: AbortSignal.timeout(1500),
    });
    lastProbe = `HTTP ${res.status}`;
    if (res.ok) {
      writeFileSync(
        runtimeFile,
        JSON.stringify(
          {
            pid: child.pid,
            host: HOST,
            port,
            dataDir: dir,
            token: localToken,
            startedAt: new Date().toISOString(),
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
      console.log(`[beezilla] local runtime ready → http://${HOST}:${port}`);
      console.log(`[beezilla] data ${dir}`);
      break;
    }
  } catch (err) {
    // Not up yet — but say WHY on the final report; a refused TCP connection and
    // a 500 are different bugs.
    lastProbe = `error: ${err?.cause?.code || err?.cause?.message || err?.message || String(err)}`;
  }
  await new Promise((r) => setTimeout(r, 400));
}
