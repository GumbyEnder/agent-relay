#!/usr/bin/env node
/**
 * test-library-finished.mjs — the Library shows finished work first (2026-11-18).
 *
 * Drives a RUNNING server (default http://127.0.0.1:3000) through the
 * magic-link dev-inbox sign-in, uploads three files a moment apart, and checks:
 *
 *   - GET /api/buzzy/assets?order=newest returns the newest file first, so the
 *     Library's limited list keeps the newest work
 *   - without ?order the list is still in path order (the folder views use it)
 *   - GET /api/buzzy/assets/:id serves each file inline with its own type: the
 *     Library's picture and audio previews load that address directly (the old
 *     shelf read an item.url the API never sends, so its previews were blank)
 *   - another account sees none of these files, and a signed-out caller gets 401
 *   - /buzzy/library serves the finished-work view
 *
 * Requires the dev mail inbox (.data/outbound-mail.jsonl in the server's cwd),
 * i.e. a server started WITHOUT SMTP/RESEND settings.
 *
 * Usage: node scripts/test-library-finished.mjs [baseUrl] [mailLogPath]
 */
import { readFileSync, existsSync } from "node:fs";

const BASE = process.argv[2] || "http://127.0.0.1:3000";
const MAIL_LOG = process.argv[3] || ".data/outbound-mail.jsonl";

let failures = 0;
function check(name, cond, detail = "") {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  — " + detail}`);
  if (!ok) failures++;
}

async function readMailUrl(email) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (existsSync(MAIL_LOG)) {
      const lines = readFileSync(MAIL_LOG, "utf8").trim().split("\n").reverse();
      for (const line of lines) {
        try {
          const mail = JSON.parse(line);
          if (mail.to === email) {
            const url =
              mail.actionUrl ||
              (mail.html || "").match(/href="([^"]*magic-link\/verify[^"]*)"/)?.[1] ||
              (mail.text || "").match(/https?:\/\/\S*magic-link\/verify\S*/)?.[0];
            if (url) return url.replace(/&amp;/g, "&");
          }
        } catch { /* partial line */ }
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no magic-link mail found for ${email} in ${MAIL_LOG}`);
}

async function signIn(email) {
  const res = await fetch(`${BASE}/api/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, callbackURL: "/" }),
  });
  if (!res.ok) throw new Error(`magic-link request failed ${res.status}: ${await res.text()}`);
  const url = await readMailUrl(email);
  const vres = await fetch(url, { redirect: "manual" });
  const setCookies = vres.headers.getSetCookie?.() ?? [];
  const cookie = setCookies.map((c) => c.split(";")[0]).join("; ");
  if (!cookie.includes("session_token")) {
    throw new Error(`no session cookie from verify (status ${vres.status})`);
  }
  return cookie;
}

async function upload(cookie, name, type, bytes) {
  const res = await fetch(`${BASE}/api/buzzy/assets`, {
    method: "POST",
    headers: { "content-type": type, "x-bz-path": name, origin: BASE, cookie },
    body: bytes,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function list(cookie, query = "") {
  const res = await fetch(`${BASE}/api/buzzy/assets${query}`, {
    headers: { accept: "application/json", origin: BASE, ...(cookie ? { cookie } : {}) },
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, items: (json && json.items) || [] };
}

const run = `lib${Date.now().toString(36)}`;
const owner = await signIn(`bz-library-${run}@test.local`);
const other = await signIn(`bz-library-other-${run}@test.local`);
console.log(`base=${BASE} run=${run}`);

// Path order and age order disagree on purpose: the newest file sorts last by path.
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360f8cfc0f00f0004010100" +
    "5a4d2e2b0000000049454e44ae426082",
  "hex",
);
const files = [
  { name: `a-oldest-${run}.txt`, type: "text/plain", bytes: Buffer.from(`oldest ${run}`) },
  { name: `b-middle-${run}.mp3`, type: "audio/mpeg", bytes: Buffer.from(`ID3 middle ${run}`) },
  { name: `c-newest-${run}.png`, type: "image/png", bytes: Buffer.concat([PNG, Buffer.from(run)]) },
];
const ids = [];
for (const f of files) {
  const up = await upload(owner, f.name, f.type, f.bytes);
  check(`upload ${f.name}`, up.status === 200 || up.status === 201, `status ${up.status} ${JSON.stringify(up.json)}`);
  ids.push(String(up.json?.id ?? up.json?.asset?.id ?? ""));
  await new Promise((r) => setTimeout(r, 1100)); // distinct created_at
}

const newest = await list(owner, "?limit=300&order=newest");
const mine = newest.items.filter((i) => String(i.filename).includes(run)).map((i) => i.filename);
check("order=newest lists the newest file first", mine[0] === files[2].name, JSON.stringify(mine));
check("order=newest lists all three, newest to oldest",
  JSON.stringify(mine) === JSON.stringify([files[2].name, files[1].name, files[0].name]), JSON.stringify(mine));

const limited = await list(owner, "?limit=1&order=newest");
check("with a limit, the newest file is the one kept", limited.items[0]?.filename === files[2].name,
  JSON.stringify(limited.items.map((i) => i.filename)));

const byPath = await list(owner, "?limit=300");
const pathOrder = byPath.items.filter((i) => String(i.filename).includes(run)).map((i) => i.filename);
check("without ?order the list stays in path order",
  JSON.stringify(pathOrder) === JSON.stringify([files[2].name, files[1].name, files[0].name].sort()), JSON.stringify(pathOrder));

const img = newest.items.find((i) => i.filename === files[2].name);
if (img) {
  const res = await fetch(`${BASE}/api/buzzy/assets/${img.id}`, { headers: { cookie: owner, origin: BASE } });
  check("a picture is served at /api/buzzy/assets/<id> as a picture",
    res.status === 200 && /^image\/png/.test(res.headers.get("content-type") || ""), `${res.status} ${res.headers.get("content-type")}`);
  check("and inline, so the Library can preview it",
    /^inline/.test(res.headers.get("content-disposition") || ""), String(res.headers.get("content-disposition")));
} else {
  check("the uploaded picture is listed", false, "missing from the list");
}

const theirs = await list(other, "?limit=300&order=newest");
check("another account sees none of these files", !theirs.items.some((i) => String(i.filename).includes(run)),
  JSON.stringify(theirs.items.map((i) => i.filename)));
const signedOut = await list(null, "?order=newest");
check("signed out gets 401", signedOut.status === 401, `status ${signedOut.status}`);

const page = await fetch(`${BASE}/buzzy/library`, { headers: { cookie: owner } });
const html = await page.text();
check("/buzzy/library serves the finished-work view",
  page.status === 200 && html.includes("finishedWork") && html.includes("Keep working on it"), `status ${page.status}`);
check("the Library no longer loads the old artifact shelf", !html.includes("loadArtifactShelf"), "old shelf code still served");

console.log(failures ? `test-library-finished: ${failures} check(s) failed` : "test-library-finished: all checks passed");
process.exit(failures ? 1 : 0);
