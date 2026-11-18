/**
 * Routing matrix for the two-service split.
 *
 * `src/lib/product-surface.ts` decides, from (surface, host, path, method), whether
 * a request is served, redirected or refused. This script drives every case we care
 * about, including the ones that only exist because there are now two services:
 *
 *   - the consumer service must refuse console paths with a 404, not a chat page;
 *   - the platform healthcheck must be served on the consumer service, because
 *     `railway.json` probes `/api/agent/health` on every service and a refusal means
 *     a healthy service gets rolled back;
 *   - a consumer host still behaves exactly as before, whichever surface the
 *     process thinks it is.
 *
 * Run: `npx tsx scripts/test-surface-routing.ts` (wired into `test:ci`).
 */
import { CONSUMER_ORIGIN } from "../src/lib/product-hosts";
import {
  decideSurface,
  moveEnabled,
  surfaceFromEnv,
  type Surface,
  type SurfaceInput,
} from "../src/lib/product-surface";

const CONSUMER = "beezilla.net";
const CONSOLE = "app.devboards.ai";
const RAILWAY = "agent-relay-production.up.railway.app";

interface Case {
  name: string;
  surface: Surface;
  host: string;
  path: string;
  method?: string;
  search?: string;
  move?: boolean;
  want: "allow" | string; // "allow" or "<status> <target>"
}

const consumerHost = (h: string) => h === CONSUMER || h === "www." + CONSUMER;

function decision(c: Case): string {
  const input: SurfaceInput = {
    surface: c.surface,
    host: c.host,
    pathname: c.path.split("?")[0],
    method: c.method ?? "GET",
    search: c.path.includes("?") ? "?" + c.path.split("?")[1] : (c.search ?? ""),
    moveEnabled: c.move ?? true,
    consumerOrigin: CONSUMER_ORIGIN,
    isConsumerHost: consumerHost(c.host),
  };
  const d = decideSurface(input);
  if (d.kind === "allow") return "allow";
  if (d.kind === "redirect") return `${d.status} ${d.to}`;
  return `${d.status} deny`;
}

const cases: Case[] = [
  // ── one service (`all`): today's behaviour, unchanged ──────────────────────
  { name: "all · consumer host · /buzzy/talk", surface: "all", host: CONSUMER, path: "/buzzy/talk", want: "allow" },
  { name: "all · consumer host · /api/buzzy/chat", surface: "all", host: CONSUMER, path: "/api/buzzy/chat", want: "allow" },
  { name: "all · consumer host · /api/auth/session", surface: "all", host: CONSUMER, path: "/api/auth/session", want: "allow" },
  { name: "all · consumer host · /robots.txt", surface: "all", host: CONSUMER, path: "/robots.txt", want: "allow" },
  { name: "all · consumer host · /api/agent/health", surface: "all", host: CONSUMER, path: "/api/agent/health", want: "allow" },
  { name: "all · consumer host · / (front door)", surface: "all", host: CONSUMER, path: "/", want: "302 /buzzy/talk" },
  { name: "all · consumer host · console path", surface: "all", host: CONSUMER, path: "/boards", want: "302 /buzzy/talk" },
  { name: "all · consumer host · console API", surface: "all", host: CONSUMER, path: "/api/agent/boards", want: "302 /buzzy/talk" },
  { name: "all · www host · 301 to apex", surface: "all", host: "www." + CONSUMER, path: "/buzzy/talk", want: `301 ${CONSUMER_ORIGIN}/buzzy/talk` },
  { name: "all · www host · keeps query", surface: "all", host: "www." + CONSUMER, path: "/buzzy/talk?job=7", want: `301 ${CONSUMER_ORIGIN}/buzzy/talk?job=7` },

  { name: "all · console host · move on · buzzy page 301", surface: "all", host: CONSOLE, path: "/buzzy/library", want: `301 ${CONSUMER_ORIGIN}/buzzy/library` },
  { name: "all · console host · move on · POST is not redirected", surface: "all", host: CONSOLE, path: "/buzzy/talk", method: "POST", want: "allow" },
  { name: "all · console host · move off · buzzy page served", surface: "all", host: CONSOLE, path: "/buzzy/talk", move: false, want: "allow" },
  { name: "all · console host · board page", surface: "all", host: CONSOLE, path: "/boards", want: "allow" },
  { name: "all · console host · board API", surface: "all", host: CONSOLE, path: "/api/agent/boards", want: "allow" },

  // ── consumer service (`BZ_SURFACE=buzzy`) ──────────────────────────────────
  { name: "buzzy service · /buzzy/talk", surface: "buzzy", host: RAILWAY, path: "/buzzy/talk", want: "allow" },
  { name: "buzzy service · /api/buzzy/chat", surface: "buzzy", host: RAILWAY, path: "/api/buzzy/chat", want: "allow" },
  { name: "buzzy service · /api/auth/session", surface: "buzzy", host: RAILWAY, path: "/api/auth/session", want: "allow" },
  { name: "buzzy service · /api/inference/chat", surface: "buzzy", host: RAILWAY, path: "/api/inference/chat", want: "allow" },
  { name: "buzzy service · /api/recipes", surface: "buzzy", host: RAILWAY, path: "/api/recipes", want: "allow" },
  { name: "buzzy service · healthcheck MUST pass", surface: "buzzy", host: RAILWAY, path: "/api/agent/health", want: "allow" },
  { name: "buzzy service · board page refused", surface: "buzzy", host: RAILWAY, path: "/boards", want: "404 deny" },
  { name: "buzzy service · board API refused", surface: "buzzy", host: RAILWAY, path: "/api/agent/boards", want: "404 deny" },
  { name: "buzzy service · admin refused", surface: "buzzy", host: RAILWAY, path: "/admin", want: "404 deny" },
  { name: "buzzy service · agent key refused", surface: "buzzy", host: RAILWAY, path: "/api/agent/keys", want: "404 deny" },
  { name: "buzzy service · consumer host still wins", surface: "buzzy", host: CONSUMER, path: "/buzzy/talk", want: "allow" },
  { name: "buzzy service · consumer host front door", surface: "buzzy", host: CONSUMER, path: "/", want: "302 /buzzy/talk" },

  // ── console service (`BZ_SURFACE=console`) ─────────────────────────────────
  { name: "console service · board API", surface: "console", host: CONSOLE, path: "/api/agent/boards", want: "allow" },
  { name: "console service · buzzy page 301s", surface: "console", host: CONSOLE, path: "/buzzy/talk", want: `301 ${CONSUMER_ORIGIN}/buzzy/talk` },
  { name: "console service · buzzy API still answers", surface: "console", host: CONSOLE, path: "/api/buzzy/chat", want: "allow" },
];

let failures = 0;
for (const c of cases) {
  const got = decision(c);
  const ok = got === c.want;
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${c.name}${ok ? "" : `  — want ${c.want}, got ${got}`}`);
}

// ── env parsing ─────────────────────────────────────────────────────────────
const envCases: Array<[Record<string, string | undefined>, Surface, string]> = [
  [{}, "all", "unset → all"],
  [{ BZ_SURFACE: "" }, "all", "empty → all"],
  [{ BZ_SURFACE: "all" }, "all", "'all' → all"],
  [{ BZ_SURFACE: "buzzy" }, "buzzy", "'buzzy' → buzzy"],
  [{ BZ_SURFACE: "  BUZZY  " }, "buzzy", "whitespace + case are tolerated"],
  [{ BZ_SURFACE: "console" }, "console", "'console' → console"],
  [{ BZ_SURFACE: "beezilla" }, "all", "unknown value falls back to all (never guesses)"],
];
for (const [env, want, name] of envCases) {
  const got = surfaceFromEnv(env);
  const ok = got === want;
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} env ${name}${ok ? "" : `  — want ${want}, got ${got}`}`);
}

const moveCases: Array<[Record<string, string | undefined>, boolean, string]> = [
  [{}, false, "BZ_MOVE_BUZZY unset → off"],
  [{ BZ_MOVE_BUZZY: "0" }, false, "'0' → off"],
  [{ BZ_MOVE_BUZZY: "1" }, true, "'1' → on"],
];
for (const [env, want, name] of moveCases) {
  const got = moveEnabled(env);
  const ok = got === want;
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  — want ${want}, got ${got}`}`);
}

console.log(
  failures === 0
    ? `\nsurface routing: all checks passed (${cases.length} routes, ${envCases.length + moveCases.length} env cases)`
    : `\nsurface routing: ${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
