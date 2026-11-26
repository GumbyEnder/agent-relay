/**
 * Desktop runtime supervisor — pure Node, no Electron imports.
 *
 * The Electron main process and the test harness both use this, so the contract
 * that actually matters (start the runtime, hand back an authenticated endpoint,
 * shut it down cleanly) is verifiable headlessly instead of only by clicking a
 * window. Anything Electron-specific lives in main.mjs.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
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
        // Electron's binary IS process.execPath inside the app, so the child must
        // be told to behave as plain Node. Set explicitly: leaving it undefined
        // happens to work (Electron sees the string "undefined" and treats it as
        // set) but that is an accident, not a contract.
        ELECTRON_RUN_AS_NODE: "1",
        BZ_DATA_DIR: this.dataDir,
        BZ_RUNTIME: "local",
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

    // The old failure said only "did not become ready", then the exit handler
    // appended "runtime exited unexpectedly (code 0)" — while the server was
    // demonstrably listening. Two contradictory sentences and no port, error code or
    // distinction between "dead" and "alive but unreachable" is what a firewall,
    // an antivirus, or a Wine loopback limitation all look like from here. Collect
    // the facts while waiting instead of guessing at the end.
    const deadline = Date.now() + timeoutMs;
    let lastProbe = { ok: false, error: "not attempted", code: null, ms: 0, rt: null };
    let sawRuntimeFile = false;
    while (Date.now() < deadline) {
      const rt = this.readRuntimeFile();
      if (rt) sawRuntimeFile = true;
      if (rt) {
        const probe = await this.probe(rt);
        if (probe.ok) {
          this.runtime = rt;
          return rt;
        }
        lastProbe = probe;
      }
      await new Promise((r) => setTimeout(r, 400));
    }

    const alive = Boolean(this.child && this.child.exitCode === null);
    const where = lastProbe.rt ? `http://${lastProbe.rt.host}:${lastProbe.rt.port}` : "(no runtime.json written)";
    const hint = alive
      ? "The runtime process is still running, so this is a reachability problem, not a crash: " +
        "something is blocking this app's connection to its own loopback port (firewall, antivirus, " +
        "VPN/proxy, or a Wine/VM network stack). Allow BeeZilla in the firewall, or set " +
        "BZ_SKIP_READY_PROBE=1 to open the window anyway and let the UI report what it can reach."
      : "The runtime process exited before answering, so this is a start-up failure: read the lines above " +
        "it for the reason (a missing data directory, a port already in use, or a module that failed to load).";
    const message =
      `local runtime did not answer within ${timeoutMs}ms. ` +
      `Probe: ${where} · ${lastProbe.error}${lastProbe.code ? ` (${lastProbe.code})` : ""} · ` +
      `last attempt ${lastProbe.ms}ms · runtime.json ${sawRuntimeFile ? "present" : "absent"} · ` +
      `process ${alive ? "alive" : "exited"}. ${hint}`;

    // Escape hatch for environments where loopback from the shell is broken but the
    // port is genuinely serving (observed under Wine: the server logs "Listening"
    // and the host curls it fine, while the shell's fetch fails). Explicit, never
    // automatic, and never quiet.
    if (alive && process.env.BZ_SKIP_READY_PROBE === "1") {
      const rt = this.readRuntimeFile();
      if (rt) {
        this.onLog(`[supervisor] BZ_SKIP_READY_PROBE=1 — opening the window without a healthy probe. ${message}`);
        this.runtime = rt;
        return rt;
      }
    }
    throw new Error(message);
  }

  /** A listening socket, asked without DNS (see probe()). */
  tcpReachable(port, host = "127.0.0.1") {
    return new Promise((done) => {
      const sock = connect(port, host);
      const finish = (ok) => {
        try { sock.destroy(); } catch { /* closed */ }
        done(ok);
      };
      sock.setTimeout(1200);
      sock.once("connect", () => finish(true));
      sock.once("timeout", () => finish(false));
      sock.once("error", () => finish(false));
    });
  }

  /** One readiness attempt, with the failure kept instead of discarded. */
  async probe(rt) {
    const started = Date.now();
    try {
      const res = await fetch(`http://${rt.host}:${rt.port}/api/agent/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) return { ok: true, error: null, code: null, ms: Date.now() - started, rt };
      return { ok: false, error: `HTTP ${res.status}`, code: String(res.status), ms: Date.now() - started, rt };
    } catch (err) {
      // undici can fail before sending a packet (name resolution on Wine/Windows
      // answers an opaque UNKNOWN). Ask the same question with a raw TCP connect to
      // the literal — a listening port must never be reported unreachable.
      const tcp = await this.tcpReachable(rt.port, rt.host);
      if (tcp) {
        return { ok: true, error: null, code: "tcp-only", ms: Date.now() - started, rt };
      }
      // fetch wraps the useful part: "fetch failed" alone hides ECONNREFUSED,
      // EHOSTUNREACH, a TLS problem, or a timeout.
      const cause = err?.cause ?? err;
      return {
        ok: false,
        error: String(err?.message ?? err),
        code: cause?.code ?? cause?.name ?? null,
        ms: Date.now() - started,
        rt,
      };
    }
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
