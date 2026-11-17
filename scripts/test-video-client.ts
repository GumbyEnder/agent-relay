/**
 * The video kit CLIENT, against a mock kit server.
 *
 * What this pins is the part of the job API a person feels: the refusal they are
 * shown and whether they are told to retry. The kit's own rules (401 bad token,
 * 400 refused topic, 429 daily limit, 503 queue full) must come out as plain
 * sentences, not "kit_failed". The write path (ownership record, daily count,
 * asset storage) needs Postgres and is covered by the live E2E, not here — this
 * file deliberately touches no database.
 *
 * It also pins the two things that must never regress:
 *   - `brand: false` and `text_model: gemini-flash-latest` on every job (Shane,
 *     2026-11-17: no Breadcrumbs end card, Gemini Flash writes);
 *   - a filename with a separator or ".." never reaches the kit.
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
      if (req.headers["x-kit-token"] !== "test-kit-token") return send(401, { message: "bad token" });
      const topic = String(body?.topic ?? "");
      if (/forbidden/i.test(topic)) return send(400, { message: "That topic is not allowed." });
      if (/limit/i.test(topic)) return send(429, { message: "Daily limit reached for this user." });
      if (/full/i.test(topic)) return send(503, { message: "Queue is full, try later." });
      return send(202, { job_id: "job_abc123", state: "queued", eta_minutes: 6 });
    }
    if (url.pathname === "/jobs/job_abc123" && req.method === "GET") {
      return send(200, {
        job_id: "job_abc123",
        state: "done",
        message: "ok",
        files: ["out.mp4", "thumb.jpg", "post.txt"],
      });
    }
    if (url.pathname === "/jobs/job_abc123/files/out.mp4") {
      return send(200, Buffer.from("MP4BYTES"), "video/mp4");
    }
    return send(404, { message: "nope" });
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const port = (server.address() as AddressInfo).port;
process.env.BZ_VIDEO_BASE = `http://127.0.0.1:${port}`;
const video = await import("../src/lib/buzzy/video");

console.log("configuration defaults (Shane, 2026-11-17 15:46 ET):");
ok("writer is gemini-flash-latest", video.VIDEO_WRITER === "gemini-flash-latest", video.VIDEO_WRITER);
ok("end card off by default", video.VIDEO_BRAND === false, video.VIDEO_BRAND);
ok("daily limit is 5", video.VIDEO_DAILY_LIMIT === 5, video.VIDEO_DAILY_LIMIT);
ok("five recipes registered", video.VIDEO_RECIPES.length === 5, video.VIDEO_RECIPES.map((r: { id: string }) => r.id));

console.log("a job that is accepted:");
const started = await video.startKitJob({ recipe: "explain-on-a-chalkboard", topic: "the water cycle", userId: "u1" });
ok("returns the kit job id", started.ok && started.jobId === "job_abc123", started);
ok("carries the ETA in minutes", started.ok && started.etaMinutes === 6, started);
const posted = seen.find((s) => s.path === "/jobs")?.body ?? {};
ok("sends the token server-side only", seen[0]?.token === "test-kit-token");
ok("body says brand:false (no Breadcrumbs end card)", posted.brand === false, posted.brand);
ok("body names Gemini Flash as the writer", posted.text_model === "gemini-flash-latest", posted.text_model);
ok("body carries the recipe id", posted.recipe === "explain-on-a-chalkboard", posted.recipe);
ok("body carries the topic, not the request", posted.topic === "the water cycle", posted.topic);

console.log("refusals come out as sentences a person can act on:");
const refused = await video.startKitJob({ recipe: "chart-race", topic: "something forbidden", userId: "u1" });
ok("400 -> topic_refused", !refused.ok && refused.code === "topic_refused", refused);
ok("the kit's own wording is kept", !refused.ok && /not allowed/i.test(refused.error), refused);
const limited = await video.startKitJob({ recipe: "chart-race", topic: "limit test", userId: "u1" });
ok("429 -> daily_limit", !limited.ok && limited.code === "daily_limit", limited);
ok("429 is retryable (tomorrow)", !limited.ok && limited.retryable === true, limited);
const full = await video.startKitJob({ recipe: "chart-race", topic: "queue full", userId: "u1" });
ok("503 -> queue_full", !full.ok && full.code === "queue_full", full);
ok("503 is retryable (later today)", !full.ok && full.retryable === true, full);
const empty = await video.startKitJob({ recipe: "chart-race", topic: "   ", userId: "u1" });
ok("an empty topic never reaches the network", !empty.ok && empty.code === "no_topic", empty);

console.log("the finished job:");
const job = await video.readVideoJob("job_abc123");
ok("state done", job.ok && job.state === "done", job);
const pick = video.classifyFiles((job.ok && job.files) || []);
ok("the mp4 is found", pick.video === "out.mp4", pick);
ok("the thumbnail is found", pick.thumb === "thumb.jpg", pick);
ok("the post text is found", pick.postText === "post.txt", pick);
const file = await video.fetchVideoFile("job_abc123", "out.mp4");
ok("the mp4 comes back with its bytes", file.ok && file.bytes.toString() === "MP4BYTES", file.ok ? file.bytes.length : file);
ok("content-type is video/mp4", file.ok && file.contentType === "video/mp4", file.ok ? file.contentType : file);
const traversal = await video.fetchVideoFile("job_abc123", "../../etc/passwd");
ok("path traversal is refused before the request", !traversal.ok && traversal.code === "bad_filename", traversal);

const missing = await video.readVideoJob("job_nope");
ok("an unknown job is a kit failure, not a crash", !missing.ok && missing.code === "kit_failed", missing);

server.close();
console.log("");
if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("all video-client tests passed");
