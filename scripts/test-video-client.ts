/**
 * The video kit CLIENT, against a mock kit server that speaks the REAL contract.
 *
 * The wire format here is not invented: every field name and limit came out of
 * `engines/tips/serve.py` and `engines/tips/JOB-CONTRACT.md` in the Breadcrumbs
 * kit (read 2026-11-17, zip sha256 9793bbbc…8364). What this file pins:
 *
 *   - one `POST /jobs` body per kind, with serve.py's own field names
 *     (`kind`, `user`, `topic`, `look`, `board`, `question`, `data_csv`,
 *     `source`, `unit`, `format`, `ai_text`, `pictures`);
 *   - NONE of the three keys the old body invented (`recipe`, `brand`,
 *     `text_model`) and not `user_id` — serve.py ignores unknown keys silently,
 *     so sending them looked like it worked and did nothing;
 *   - the kit's validation run locally first, in the kit's own words, so a
 *     person is never charged a queue slot to learn "8 to 200 characters";
 *   - the status shape: `files` is an OBJECT keyed by role, and the reference
 *     worker writes `attempts` where the contract says `attempt`;
 *   - refusals (401 / 400 / 429 / 503) as sentences a person can act on;
 *   - a filename with a separator or ".." never reaches the kit.
 *
 * The write path (ownership row, daily count, asset storage) needs Postgres and
 * is covered by the live E2E, not here — this file touches no database.
 *
 * Run: npx tsx scripts/test-video-client.ts
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

process.env.BZ_VIDEO_BASE = "http://127.0.0.1:0"; // replaced below with the real port
process.env.BZ_VIDEO_KIT_TOKEN = "test-kit-token";
delete process.env.BZ_VIDEO_BRAND;
delete process.env.BZ_VIDEO_TEXT_MODEL;

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label}${extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
  }
}

interface Seen {
  path: string;
  token: string | undefined;
  body: Record<string, unknown> | null;
}
const seen: Seen[] = [];

const CSV = "date,China,United States\n2005,0.1,0.5\n2006,0.2,0.6\n2007,0.3,0.7\n2008,0.4,0.8\n2009,0.5,0.9\n2010,0.6,1.0";

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    let body: Record<string, unknown> | null = null;
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    seen.push({ path: url.pathname, token: req.headers["x-kit-token"] as string | undefined, body });
    const send = (status: number, payload: unknown, type = "application/json") => {
      res.writeHead(status, { "content-type": type });
      res.end(type === "application/json" ? JSON.stringify(payload) : (payload as Buffer));
    };

    if (url.pathname === "/jobs" && req.method === "POST") {
      if (req.headers["x-kit-token"] !== "test-kit-token") return send(401, { error: "unauthorized" });
      // Serve.py's own gate: no Content-Length means an empty body.
      if (!req.headers["content-length"]) return send(400, { error: "body must be JSON" });
      const words = `${body?.topic ?? ""} ${body?.question ?? ""} ${body?.source ?? ""}`;
      if (/forbidden/i.test(words)) return send(400, { error: "invalid", message: "That topic is not allowed." });
      if (/limit/i.test(words)) {
        return send(429, { error: "daily_limit", message: "You've made 5 videos today. Come back tomorrow." });
      }
      if (/full/i.test(words)) {
        return send(503, { error: "busy", message: "We're busy right now. Please try again in a few minutes." });
      }
      return send(202, { job_id: "job_abc123", kind: body?.kind ?? "tips", state: "queued", eta_minutes: 6 });
    }
    if (url.pathname === "/jobs/job_abc123" && req.method === "GET") {
      return send(200, {
        job_id: "job_abc123",
        state: "done",
        attempt: 1,
        attempts: 1,
        cause: null,
        message: null,
        files: { video: "the-water-cycle.mp4", thumbnail: "the-water-cycle.jpg", post: "the-water-cycle.post.txt" },
        rounds: 2,
        seconds: 214.6,
        charge: true,
      });
    }
    if (url.pathname === "/jobs/job_failed" && req.method === "GET") {
      return send(200, {
        job_id: "job_failed",
        state: "failed",
        attempts: 2,
        cause: "quality_failed",
        message: "The video did not pass our quality check. Please try again.",
        files: null,
        charge: false,
      });
    }
    if (url.pathname === "/jobs/job_old" && req.method === "GET") {
      return send(200, { job_id: "job_old", state: "done", files: { video: "v.mp4" }, charge: true });
    }
    if (url.pathname === "/jobs/job_old/files/v.mp4") {
      return send(410, { error: "file expired" });
    }
    if (url.pathname === "/jobs/job_abc123/files/the-water-cycle.mp4") {
      return send(200, Buffer.from("MP4BYTES"), "video/mp4");
    }
    return send(404, { error: "no such job" });
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const port = (server.address() as AddressInfo).port;
process.env.BZ_VIDEO_BASE = `http://127.0.0.1:${port}`;
const video = await import("../src/lib/buzzy/video");

console.log("configuration defaults (Shane, 2026-11-17 15:46 ET, room 6615):");
ok("writer is gemini-flash-latest", video.VIDEO_WRITER === "gemini-flash-latest", video.VIDEO_WRITER);
ok("end card off by default", video.VIDEO_BRAND === false, video.VIDEO_BRAND);

// The cap is ONE flat number for every plan (6615 DAILY_LIMIT_PER_USER=5,
// restated in 6874). These assertions are deliberately written so that a
// per-plan table (10 Pro / 1 Free) CANNOT pass: each plan must be 5, and the
// plan rules must not carry a video field at all.
const ents = await import("../src/lib/buzzy/entitlements");
const flat = video.videoDailyLimit as unknown as (plan?: string) => number;
ok("the published cap is 5 per user per UTC day", video.DAILY_LIMIT_PER_USER === 5, video.DAILY_LIMIT_PER_USER);
for (const plan of ["free", "starter", "pro"] as const) {
  ok(`${plan} plan gets 5 videos a day`, video.videoDailyLimit() === 5, video.videoDailyLimit());
  ok(`${plan} plan carries no per-plan video quota`, !("videosPerDay" in ents.PLANS[plan]), Object.keys(ents.PLANS[plan]));
}
ok("a plan argument changes nothing", flat("pro") === 5 && flat("free") === 5, [flat("free"), flat("pro")]);
ok("an unknown plan is still 5", flat("gold") === 5, flat("gold"));
process.env.BZ_VIDEO_DAILY_LIMIT = "12";
ok("BZ_VIDEO_DAILY_LIMIT is the only override, and it is flat", video.videoDailyLimit() === 12, video.videoDailyLimit());
delete process.env.BZ_VIDEO_DAILY_LIMIT;
ok("no override means 5 again", video.videoDailyLimit() === 5, video.videoDailyLimit());

console.log("the five ids are the kit's own recipe ids:");
const ids = video.VIDEO_RECIPES.map((r: { id: string }) => r.id);
ok("five recipes registered", ids.length === 5, ids);
for (const want of [
  "explain-on-a-chalkboard",
  "ai-creator-tips-paper-cut",
  "chart-race-from-your-numbers",
  "picture-reel",
  "narrated-explainer",
]) {
  ok(`${want} is registered`, ids.includes(want), ids);
}
ok(
  "each recipe names the kit kind it runs",
  video.VIDEO_RECIPES.every((r: { kind: string }) => ["tips", "chart", "reel", "explainer"].includes(r.kind)),
  video.VIDEO_RECIPES.map((r: { id: string; kind: string }) => `${r.id}:${r.kind}`),
);
ok(
  "the chart recipe is the only one that asks for a table",
  video.VIDEO_RECIPES.filter((r: { asks: { type: string }[] }) => r.asks.some((a) => a.type === "table")).map(
    (r: { id: string }) => r.id,
  ).join(",") === "chart-race-from-your-numbers",
);

console.log("POST /jobs — kinds tips (chalk), against serve.py's field names:");
const started = await video.startKitJob({ recipe: "explain-on-a-chalkboard", topic: "the water cycle", userId: "u1" });
ok("returns the kit job id", started.ok && started.jobId === "job_abc123", started);
ok("carries the ETA in minutes", started.ok && started.etaMinutes === 6, started);
const chalk = seen.find((s) => s.path === "/jobs")?.body ?? {};
ok("sends the token server-side only", seen[0]?.token === "test-kit-token");
ok("kind is tips", chalk.kind === "tips", chalk);
ok("look is chalk", chalk.look === "chalk", chalk.look);
ok("board defaults to forest", chalk.board === "forest", chalk.board);
ok("user carries the app user id", chalk.user === "u1", chalk.user);
ok("exactly the contract's keys", JSON.stringify(Object.keys(chalk).sort()) === JSON.stringify(["board", "kind", "look", "topic", "user"]), Object.keys(chalk));
ok("no invented `recipe` key", !("recipe" in chalk), chalk);
ok("no invented `brand` key (the end card is a render-side flag)", !("brand" in chalk), chalk);
ok("no invented `text_model` key (TEXT_MODEL is the worker's env)", !("text_model" in chalk), chalk);
ok("no `user_id` (serve.py reads `user`)", !("user_id" in chalk), chalk);

console.log("POST /jobs — the other four kinds:");
const paper = await video.startKitJob({ recipe: "ai-creator-tips-paper-cut", topic: "lighting words that help", userId: "u1" });
const paperBody = seen.at(-1)?.body ?? {};
ok("paper-cut is kind tips", paper.ok && paperBody.kind === "tips", paperBody);
ok("paper-cut is look paper", paperBody.look === "paper", paperBody.look);
ok("paper ignores board (not sent)", !("board" in paperBody), paperBody);

const reel = await video.startKitJob({ recipe: "picture-reel", topic: "stopping missed calls after hours", userId: "u1" });
const reelBody = seen.at(-1)?.body ?? {};
ok("reel is kind reel", reel.ok && reelBody.kind === "reel", reelBody);
ok("reel defaults to the library pictures", reelBody.pictures === "library", reelBody.pictures);

const expl = await video.startKitJob({ recipe: "narrated-explainer", topic: "how yeast works, simply", userId: "u1" });
const explBody = seen.at(-1)?.body ?? {};
ok("explainer is kind explainer", expl.ok && explBody.kind === "explainer", explBody);
ok("explainer sends only kind, topic, user", JSON.stringify(Object.keys(explBody).sort()) === JSON.stringify(["kind", "topic", "user"]), Object.keys(explBody));

console.log("POST /jobs — kind chart (the person's numbers):");
const chartJob = await video.startKitJob({
  recipe: "chart-race-from-your-numbers",
  userId: "u1",
  chart: {
    question: "Which country builds the most solar power?",
    dataCsv: CSV,
    source: "IRENA capacity statistics 2026, via Our World in Data (CC BY 4.0)",
    chart: "line",
    unit: "GW",
    format: "square",
    aiText: true,
  },
});
const chartBody = seen.at(-1)?.body ?? {};
ok("chart is kind chart", chartJob.ok && chartBody.kind === "chart", chartBody);
ok("question is passed through", chartBody.question === "Which country builds the most solar power?", chartBody.question);
ok("the table travels as data_csv", String(chartBody.data_csv ?? "").startsWith("date,China"), String(chartBody.data_csv ?? "").slice(0, 20));
ok("source is passed through", String(chartBody.source ?? "").includes("IRENA"), chartBody.source);
ok("bar/line choice is passed", chartBody.chart === "line", chartBody.chart);
ok("unit is passed", chartBody.unit === "GW", chartBody.unit);
ok("format is passed", chartBody.format === "square", chartBody.format);
ok("ai_text is a real boolean", chartBody.ai_text === true, chartBody.ai_text);
ok(
  "exactly the contract's chart keys",
  JSON.stringify(Object.keys(chartBody).sort()) ===
    JSON.stringify(["ai_text", "chart", "data_csv", "format", "kind", "question", "source", "unit", "user"]),
  Object.keys(chartBody),
);

console.log("the kit's own limits are applied BEFORE the network:");
const before = seen.length;
const shortTopic = await video.startKitJob({ recipe: "narrated-explainer", topic: "  tides ", userId: "u1" });
ok("a 5-character topic is refused locally", !shortTopic.ok && shortTopic.code === "topic_invalid", shortTopic);
ok("in the kit's own words", !shortTopic.ok && shortTopic.error === "Please describe the topic in 8 to 200 characters.", shortTopic);
const longTopic = await video.startKitJob({ recipe: "narrated-explainer", topic: "x".repeat(201), userId: "u1" });
ok("a 201-character topic is refused locally", !longTopic.ok && longTopic.code === "topic_invalid", longTopic);
const noTable = await video.startKitJob({
  recipe: "chart-race-from-your-numbers",
  userId: "u1",
  chart: { question: "Which lab is winning now?", dataCsv: "  ", source: "arena.ai" },
});
ok("a chart with no table is refused locally", !noTable.ok && noTable.code === "invalid_input", noTable);
ok("with the paste message", !noTable.ok && /paste the numbers as CSV/.test(noTable.error), noTable);
const badSource = await video.startKitJob({
  recipe: "chart-race-from-your-numbers",
  userId: "u1",
  chart: { question: "Which lab is winning now?", dataCsv: CSV, source: "x" },
});
ok("a 1-character source is refused locally", !badSource.ok && /3 to 120 characters/.test(badSource.error), badSource);
ok("nothing above reached the kit", seen.length === before, seen.length - before);
const blank = await video.startKitJob({ recipe: "narrated-explainer", topic: "   ", userId: "u1" });
ok("whitespace is collapsed before the length test", !blank.ok && blank.code === "topic_invalid", blank);
const userCut = await video.startKitJob({ recipe: "narrated-explainer", topic: "how yeast works, simply", userId: "u".repeat(120) });
ok("the user id is cut to 80 characters", userCut.ok && String(seen.at(-1)?.body?.user).length === 80, String(seen.at(-1)?.body?.user).length);

console.log("refusals come out as sentences a person can act on:");
const refused = await video.startKitJob({ recipe: "narrated-explainer", topic: "something forbidden here", userId: "u1" });
ok("400 invalid -> invalid_input", !refused.ok && refused.code === "invalid_input", refused);
ok("the kit's own wording is kept", !refused.ok && /not allowed/i.test(refused.error), refused);
const limited = await video.startKitJob({ recipe: "narrated-explainer", topic: "limit test topic", userId: "u1" });
ok("429 -> daily_limit", !limited.ok && limited.code === "daily_limit", limited);
ok("429 is retryable (tomorrow)", !limited.ok && limited.retryable === true, limited);
ok("429 keeps the kit's sentence", !limited.ok && /Come back tomorrow/.test(limited.error), limited);
const full = await video.startKitJob({ recipe: "narrated-explainer", topic: "queue full test now", userId: "u1" });
ok("503 -> queue_full", !full.ok && full.code === "queue_full", full);
ok("503 is retryable (later today)", !full.ok && full.retryable === true, full);

console.log("the finished job:");
const job = await video.readVideoJob("job_abc123");
ok("state done", job.ok && job.state === "done", job);
ok("files is read as an object by role", job.ok && job.files?.video === "the-water-cycle.mp4", job.ok ? job.files : job);
ok("the thumbnail role is read", job.ok && job.files?.thumbnail === "the-water-cycle.jpg", job.ok ? job.files : job);
ok("the post role is read", job.ok && job.files?.post === "the-water-cycle.post.txt", job.ok ? job.files : job);
ok("charge is surfaced", job.ok && job.charge === true, job.ok ? job.charge : job);
ok("rounds and seconds are surfaced", job.ok && job.rounds === 2 && job.seconds === 214.6, job.ok ? [job.rounds, job.seconds] : job);
const file = await video.fetchVideoFile("job_abc123", "the-water-cycle.mp4");
ok("the mp4 comes back with its bytes", file.ok && file.bytes.toString() === "MP4BYTES", file.ok ? file.bytes.length : file);
ok("content-type is video/mp4", file.ok && file.contentType === "video/mp4", file.ok ? file.contentType : file);
const traversal = await video.fetchVideoFile("job_abc123", "../../etc/passwd");
ok("path traversal is refused before the request", !traversal.ok && traversal.code === "bad_filename", traversal);

console.log("a failed job keeps the kit's cause and sentence:");
const failed = await video.readVideoJob("job_failed");
ok("state failed", failed.ok && failed.state === "failed", failed);
ok("cause is surfaced", failed.ok && failed.cause === "quality_failed", failed.ok ? failed.cause : failed);
ok("the person's sentence is surfaced", failed.ok && /did not pass our quality check/.test(failed.message ?? ""), failed.ok ? failed.message : failed);
ok("a failure is never charged", failed.ok && failed.charge === false, failed.ok ? failed.charge : failed);
ok("`attempts` from the worker reads as attempt", failed.ok && failed.attempt === 2, failed.ok ? failed.attempt : failed);

console.log("retention and unknown ids:");
const expired = await video.fetchVideoFile("job_old", "v.mp4");
ok("410 file expired is a failure, not a crash", !expired.ok && expired.code === "kit_failed", expired);
const missing = await video.readVideoJob("job_nope");
ok("an unknown job is a kit failure, not a crash", !missing.ok && missing.code === "kit_failed", missing);

server.close();
console.log("");
if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("all video-client tests passed");
