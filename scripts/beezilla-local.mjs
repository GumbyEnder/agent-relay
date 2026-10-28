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
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync, copyFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const child = spawn(process.execPath, [entry], {
  cwd: ROOT,
  env: {
    ...process.env,
    BZ_RUNTIME: "local",
    BZ_DATA_DIR: dir,
    HOST,
    NITRO_HOST: HOST,
    PORT: String(port),
    NITRO_PORT: String(port),
  },
  stdio: ["ignore", "inherit", "inherit"],
});

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
for (;;) {
  if (Date.now() > deadline) {
    console.error("[beezilla] server did not become ready within 60s");
    stop("SIGTERM");
    break;
  }
  try {
    const res = await fetch(`http://${HOST}:${port}/api/agent/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) {
      writeFileSync(
        runtimeFile,
        JSON.stringify(
          { pid: child.pid, host: HOST, port, dataDir: dir, startedAt: new Date().toISOString() },
          null,
          2,
        ) + "\n",
      );
      console.log(`[beezilla] local runtime ready → http://${HOST}:${port}`);
      console.log(`[beezilla] data ${dir}`);
      break;
    }
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 400));
}
