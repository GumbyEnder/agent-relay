/**
 * Recipe Seal — Step 3: the only logger on the execution path.
 *
 * Prompt text must never reach a log line. This module does not redact a generic
 * object — it accepts an explicit allow-list of scalar fields and drops
 * everything else. "Forbidden key" filters fail the moment someone renames a
 * field; an allow-list cannot.
 */
import { createHash } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** The complete set of fields an execution log line may carry. */
export interface SafeEvent {
  event: string;
  recipeHash?: string;
  licenseIdHash?: string;
  promptSha256?: string;
  tokensIn?: number;
  tokensOut?: number;
  ms?: number;
  codes?: string[];
  costCents?: number;
  lane?: "api" | "local";
  errCode?: string;
  traceId?: string;
  attempt?: number;
}

const ALLOWED = new Set<keyof SafeEvent>([
  "event", "recipeHash", "licenseIdHash", "promptSha256", "tokensIn", "tokensOut",
  "ms", "codes", "costCents", "lane", "errCode", "traceId", "attempt",
]);

export interface LogSink {
  write(line: string): void;
}

export interface SafeLogger {
  log(level: LogLevel, evt: SafeEvent): void;
  debug(evt: SafeEvent): void;
  info(evt: SafeEvent): void;
  warn(evt: SafeEvent): void;
  error(evt: SafeEvent): void;
}

/**
 * Build a logger. Anything not in SafeEvent is discarded, whatever its name.
 * `extra` exists only for level filtering configuration.
 */
export function createSafeLogger(sink: LogSink, opts: { level?: LogLevel; now?: () => number } = {}): SafeLogger {
  const min = LEVELS[opts.level ?? "info"];
  const now = opts.now ?? (() => Date.now());

  function log(level: LogLevel, evt: SafeEvent): void {
    if (LEVELS[level] < min) return;
    const out: Record<string, unknown> = { ts: now(), level };
    for (const [k, v] of Object.entries(evt)) {
      if (!ALLOWED.has(k as keyof SafeEvent)) continue;
      if (v === undefined) continue;
      // Only scalars and string arrays are ever serialised.
      if (Array.isArray(v)) {
        out[k] = v.filter((x) => typeof x === "string").slice(0, 32);
      } else if (typeof v === "string" || typeof v === "number") {
        out[k] = v;
      }
    }
    sink.write(JSON.stringify(out));
  }

  return {
    log,
    debug: (e) => log("debug", e),
    info: (e) => log("info", e),
    warn: (e) => log("warn", e),
    error: (e) => log("error", e),
  };
}

/** Hash a prompt so runs can be correlated without storing content. */
export function promptFingerprint(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

/** Hash a tenant id for logs: correlation without identification. */
export function idFingerprint(id: string): string {
  return createHash("sha256").update(`recipe-seal:${id}`, "utf8").digest("hex").slice(0, 24);
}

/** Collects sink output for tests and for the log-audit check. */
export function memorySink(): LogSink & { lines: string[] } {
  const lines: string[] = [];
  return { lines, write: (l) => lines.push(l) };
}
