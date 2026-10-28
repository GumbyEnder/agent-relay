/**
 * Desktop runtime supervisor — pure Node, no Electron imports.
 *
 * The Electron main process and the test harness both use this, so the contract
 * that actually matters (start the runtime, hand back an authenticated endpoint,
 * shut it down cleanly) is verifiable headlessly instead of only by clicking a
 * window. Anything Electron-specific lives in main.mjs.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

export function defaultDataDir() {
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

export class RuntimeSupervisor {
  /**
   * @param {{ root: string, dataDir?: string, onLog?: (line: string) => void }} opts
   */
  constructor({ root, dataDir = defaultDataDir(), onLog = () => {} }) {
    this.root = root;
    this.dataDir = dataDir;
    this.onLog = onLog;
    this.child = null;
    this.runtime = null;
    this.stopping = false;
  }

  get runtimeFile() {
    return join(this.dataDir, "runtime.json");
  }

  /** Base URL of the running runtime (throws before start() resolves). */
  get baseUrl() {
    if (!this.runtime) throw new Error("runtime not started");
    return `http://${this.runtime.host}:${this.runtime.port}`;
  }

  get token() {
    if (!this.runtime) throw new Error("runtime not started");
    return this.runtime.token;
  }

  async start({ timeoutMs = 90_000 } = {}) {
    if (this.runtime) return this.runtime;

    const launcher = join(this.root, "scripts", "beezilla-local.mjs");
    if (!existsSync(launcher)) throw new Error(`local runtime launcher missing: ${launcher}`);

    this.child = spawn(process.execPath, [launcher], {
      cwd: this.root,
      env: {
        ...process.env,
        // Electron main is NOT a normal Node process: clear the inspector/env
        // that would make the child inherit a debugger port.
        BZ_DATA_DIR: this.dataDir,
        BZ_RUNTIME: "local",
        ELECTRON_RUN_AS_NODE: undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.child.stdout?.on("data", (b) => this.onLog(String(b).trimEnd()));
    this.child.stderr?.on("data", (b) => this.onLog(String(b).trimEnd()));
    this.child.on("exit", (code) => {
      if (!this.stopping) this.onLog(`[supervisor] runtime exited unexpectedly (code ${code})`);
      this.runtime = null;
      this.child = null;
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rt = this.readRuntimeFile();
      if (rt && (await this.isHealthy(rt))) {
        this.runtime = rt;
        return rt;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(`local runtime did not become ready within ${timeoutMs}ms`);
  }

  readRuntimeFile() {
    try {
      return JSON.parse(readFileSync(this.runtimeFile, "utf8"));
    } catch {
      return null;
    }
  }

  async isHealthy(rt) {
    try {
      const res = await fetch(`http://${rt.host}:${rt.port}/api/agent/health`, {
        signal: AbortSignal.timeout(1500),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Graceful stop: the runtime flushes PGLite before exiting. */
  async stop({ timeoutMs = 20_000 } = {}) {
    this.stopping = true;
    const rt = this.runtime ?? this.readRuntimeFile();
    if (!rt?.pid) return;
    try {
      process.kill(rt.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.isHealthy(rt))) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    // The launcher removes the handshake when its child exits. Give it a moment,
    // then clean up ourselves: a leftover runtime.json naming a dead pid is what
    // makes the next launch report a stale handshake instead of starting.
    const fileDeadline = Date.now() + 5_000;
    while (Date.now() < fileDeadline && existsSync(this.runtimeFile)) {
      await new Promise((r) => setTimeout(r, 200));
    }
    try {
      rmSync(this.runtimeFile, { force: true });
    } catch {
      /* best effort */
    }
    this.runtime = null;
  }
}
