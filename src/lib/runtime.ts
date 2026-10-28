/**
 * Runtime mode — the ONE switch that turns this same build into either the
 * hosted product or the self-hosted desktop/CLI app.
 *
 *   BZ_RUNTIME=local  → desktop app / CLI: loopback bind, on-disk PGLite under
 *                       the per-user app data dir, single owner, no cloud
 *                       dependency for day-to-day work.
 *   unset / cloud     → hosted product: unchanged behaviour, DATABASE_URL if
 *                       present, bind whatever HOST says.
 *
 * Local must be a MODE, never a fork: every local branch below has to degrade
 * to the cloud path untouched, or the two runtimes drift the way the three
 * Railway services already did.
 */
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { accessSync, constants, mkdirSync } from "node:fs";

export type RuntimeMode = "cloud" | "local";

export function runtimeMode(): RuntimeMode {
  const raw = (process.env.BZ_RUNTIME ?? "").trim().toLowerCase();
  return raw === "local" ? "local" : "cloud";
}

export function isLocalRuntime(): boolean {
  return runtimeMode() === "local";
}

/**
 * Per-user data directory for the self-hosted app.
 *
 * Windows is the first target, so `%APPDATA%\BeeZilla\data` is the canonical
 * location (Roaming: it survives a per-user reinstall and moves with a domain
 * profile). `BZ_DATA_DIR` always wins — the Electron shell passes it explicitly
 * from `app.getPath("userData")` so the renderer and the CLI agree on one path.
 */
export function localDataDir(): string {
  const override = (process.env.BZ_DATA_DIR ?? "").trim();
  if (override) return override;

  const os = platform();
  if (os === "win32") {
    const appData =
      (process.env.APPDATA ?? "").trim() ||
      join(homedir(), "AppData", "Roaming");
    return join(appData, "BeeZilla", "data");
  }
  if (os === "darwin") {
    return join(homedir(), "Library", "Application Support", "BeeZilla", "data");
  }
  const xdg = (process.env.XDG_DATA_HOME ?? "").trim();
  return join(xdg || join(homedir(), ".local", "share"), "beezilla", "data");
}

/**
 * Bind address for the local server. Loopback ONLY: binding 0.0.0.0 on Windows
 * raises a Defender Firewall dialog on first launch, and it would expose a
 * `beezilla doctor` port to the LAN for no reason.
 */
export function localBindHost(): string {
  return "127.0.0.1";
}

export type BootIssue = {
  code: string;
  /** "block" stops the app; "warn" boots and refuses the affected action by name. */
  severity: "block" | "warn";
  message: string;
};

/**
 * Local-mode preflight. The rule borrowed from `modelPolicy`: a constraint that
 * cannot be satisfied refuses **by name** rather than silently falling back, so
 * a missing inference key must not become a mysterious failed chat turn.
 */
export function localBootIssues(): BootIssue[] {
  const issues: BootIssue[] = [];
  const hasKey = !!(process.env.BZ_CHAT_KEY ?? "").trim();
  const hasBase = !!(process.env.BZ_CHAT_BASE_URL ?? "").trim();

  if (!hasKey || !hasBase) {
    issues.push({
      code: "no_inference_config",
      severity: "warn",
      message:
        "No inference provider configured. Sign in to use BeeZilla inference, or add your own key (BYOK). Everything local keeps working; chat will refuse until one is set.",
    });
  }

  if ((process.env.DATABASE_URL ?? "").trim()) {
    issues.push({
      code: "remote_db_in_local_mode",
      severity: "warn",
      message:
        "DATABASE_URL is set but this is a local install — the local app ignores it and uses its own on-disk store. Unset it if that is unexpected.",
    });
  }

  if (!(process.env.BZ_HONCHO_URL ?? "").trim()) {
    issues.push({
      code: "no_honcho",
      severity: "warn",
      message:
        "No long-term memory service — local memory stays in this app's database (jobs, slots, chat). Expected for a self-hosted install.",
    });
  }

  // The data dir must exist and be writable before migrations try to run.
  const dir = localDataDir();
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
  } catch (err) {
    issues.push({
      code: "data_dir_unwritable",
      severity: "block",
      message: `Cannot write the local data directory (${dir}): ${(err as Error).message}`,
    });
  }

  return issues;
}

export function blockingIssues(issues: BootIssue[] = localBootIssues()): BootIssue[] {
  return issues.filter((i) => i.severity === "block");
}
