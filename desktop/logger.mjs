/**
 * File logging for the packaged app — so a launch failure leaves evidence.
 *
 * 0.2.0 shipped an `ERR_MODULE_NOT_FOUND` that killed the main process before a
 * single line of its own code ran. The user saw a generic Electron dialog, the
 * install folder held nothing, and the only way to diagnose it was to read the
 * asar by hand. A packaged app must always be able to answer "what happened".
 *
 * Design rules, each from a failure mode:
 *   - **Synchronous appends.** A buffered stream loses the last lines exactly
 *     when the process dies, which is the case worth logging.
 *   - **Installed at the top of main.mjs, before anything that can throw.**
 *   - **Tee, not replace.** `console.log/warn/error` keep writing to stdout (so
 *     `beezilla run` in a terminal still reads normally) and also land in the
 *     file with a timestamp and level.
 *   - **Location the user can find.** `<APPDATA>\BeeZilla\logs\main.log` — the
 *     same userData root as `%APPDATA%\BeeZilla\data`. Override with BZ_LOG_DIR.
 *     Never the install folder: it sits under Program Files for an all-user
 *     install, where writing needs elevation.
 *   - **Rotation, not growth.** 2 MB then `main.1.log`; a log nobody can open
 *     is not a log.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_BYTES = 2 * 1024 * 1024;
const KEEP = 2;

let dir = null;
let file = null;
let installed = false;
const original = { log: console.log, warn: console.warn, error: console.error };

/** `<userData>/logs` — the same root Electron uses for BeeZilla's data. */
export function resolveLogDir() {
  if (process.env.BZ_LOG_DIR) return process.env.BZ_LOG_DIR;
  const home = homedir();
  if (process.platform === "win32") {
    const base = process.env.APPDATA || join(home, "AppData", "Roaming");
    return join(base, "BeeZilla", "logs");
  }
  if (process.platform === "darwin") return join(home, "Library", "Logs", "BeeZilla");
  return join(process.env.XDG_STATE_HOME || join(home, ".local", "state"), "BeeZilla", "logs");
}

function rotate() {
  try {
    if (!existsSync(file) || statSync(file).size < MAX_BYTES) return;
    for (let i = KEEP - 1; i >= 1; i--) {
      const from = i === 1 ? file : `${file}.${i}`;
      const to = `${file}.${i + 1}`;
      if (existsSync(from)) renameSync(from, to);
    }
    renameSync(file, `${file}.1`);
  } catch {
    // Rotation is housekeeping; never let it break startup.
  }
}

/** One line, timestamped, level-tagged. Never throws. */
export function logLine(level, args) {
  const text = args
    .map((a) => (a instanceof Error ? a.stack || a.message : typeof a === "string" ? a : safeJson(a)))
    .join(" ");
  const line = `${new Date().toISOString()} ${String(level).toUpperCase().padEnd(5)} ${text}\n`;
  if (!file) return line;
  try {
    appendFileSync(file, line);
  } catch {
    // Disk full / permissions: keep the app running, keep printing to stdout.
  }
  return line;
}

const safeJson = (v) => {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

export const logPaths = () => ({ dir, file });

/**
 * Install the logger. Call as the first statement of main.mjs.
 *
 * @param {{version?: string, onFatal?: (kind: string, err: unknown) => void, facts?: Record<string, unknown>}} opts
 * @returns {{dir: string, file: string}}
 */
export function installLogging(opts = {}) {
  dir = resolveLogDir();
  file = join(dir, "main.log");
  if (!installed) {
    try {
      mkdirSync(dir, { recursive: true });
      rotate();
      if (!existsSync(file)) writeFileSync(file, "");
    } catch {
      file = null; // logging degrades to stdout; it must never block a launch
    }

    for (const level of ["log", "warn", "error"]) {
      console[level] = (...args) => {
        original[level](...args);
        logLine(level === "log" ? "info" : level, args);
      };
    }

    process.on("exit", (code) => logLine("info", [`process exit code=${code}`]));
    installed = true;
  }

  const { version, facts, onFatal } = opts;
  logLine("info", ["==== session start ===="]);
  logLine("info", [
    safeJson({
      version: version ?? null,
      packaged: typeof process.resourcesPath === "string" && !process.defaultApp,
      resourcesPath: process.resourcesPath ?? null,
      resourcesRoot: process.resourcesPath ? join(process.resourcesPath, "app") : null,
      execPath: process.execPath,
      cwd: process.cwd(),
      argv: process.argv,
      electron: process.versions?.electron ?? null,
      chrome: process.versions?.chrome ?? null,
      node: process.versions?.node ?? null,
      platform: `${process.platform} ${process.arch}`,
      logFile: file,
      ...(facts ?? {}),
    }),
  ]);

  // An uncaught exception without a listener is what produced the bare Electron
  // "A JavaScript error occurred in the main process" box: no stack on disk, no
  // path, nothing to report. Take it over, write it, and show it.
  process.on("uncaughtException", (err) => {
    logLine("error", ["uncaughtException", err instanceof Error ? err.stack || err.message : err]);
    onFatal?.("unexpected error", err);
  });
  process.on("unhandledRejection", (err) => {
    logLine("error", ["unhandledRejection", err instanceof Error ? err.stack || err.message : err]);
  });

  return { dir, file };
}
