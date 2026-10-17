#!/usr/bin/env node
/**
 * test-buzzy-team.mjs — BZ-F041 E2E: multi-user identity and scoped access.
 *
 * Asserts the things F034 depends on:
 *  1. Owner invites a teammate → invitation record + one-time link, and the
 *     response says plainly that no email was sent.
 *  2. Accepting with the WRONG signed-in account is refused (403 wrong_account).
 *  3. Accepting with the invited account binds it and activates membership.
 *  4. A second use of the same invitation is refused (single-use).
 *  5. The member's scope resolves to the OWNER's account and sees the owner's
 *     work — with their own sign-in, no shared credentials.
 *  6. Role enforcement in code: a plain member cannot accept a document,
 *     cannot invite, cannot revoke; an admin can accept but cannot delete.
 *  7. Revoking removes access: scope falls back to the member's own empty account.
 *  8. Ownership negatives: a stranger cannot accept or manage the owner's team.
 *
 * Usage: node scripts/test-buzzy-team.mjs [baseUrl] [mailLogPath]
 */
import { readFileSync, existsSync } from "node:fs";

const BASE = process.argv[2] || "http://127.0.0.1:8090";
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
            const url = mail.actionUrl ||
              (mail.html || "").match(/href="([^"]*magic-link\/verify[^"]*)"/)?.[1] ||
              (mail.text || "").match(/https?:\/\/\S*magic-link\/verify\S*/)?.[0];
            if (url) return url.replace(/&amp;/g, "&");
          }
        } catch { /* partial line */ }
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no magic-link mail found for ${email}`);
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
  const cookie = (vres.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  if (!cookie.includes("session_token")) throw new Error("no session cookie from verify");
  return cookie;
}

async function api(cookie, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: BASE, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = JSON.parse(await res.text()); } catch { /* non-json */ }
  return { status: res.status, json };
}

const run = `tm${Date.now().toString(36)}`;
const ownerEmail = `bz-team-owner-${run}@test.local`;
const memberEmail = `bz-team-member-${run}@test.local`;
const adminEmail = `bz-team-admin-${run}@test.local`;
const strangerEmail = `bz-team-stranger-${run}@test.local`;

console.log(`base=${BASE} run=${run}`);

const owner = await signIn(ownerEmail);
const member = await signIn(memberEmail);
const admin = await signIn(adminEmail);
const stranger = await signIn(strangerEmail);

// Owner does some work that a teammate must be able to see.
let r = await api(owner, "POST", "/api/buzzy/recipes/quote-comparison/start", {});
const ownerJob = r.json?.job?.id;
check("setup: owner has work to share", r.status === 201 && typeof ownerJob === "string", `status ${r.status}`);

// 1. invite
r = await api(owner, "POST", "/api/buzzy/team/invite", { email: memberEmail, role: "member" });
const inviteUrl = r.json?.inviteUrl ?? "";
const memberId = r.json?.member?.id;
const token = inviteUrl.split("token=")[1] ?? "";
check(
  "BZ-F041 owner invites a teammate and gets a one-time link",
  r.status === 201 && r.json?.member?.role === "member" && r.json?.member?.status === "invited" && token.length > 8,
  JSON.stringify(r.json).slice(0, 250),
);
check(
  "BZ-F041 invite says plainly that NO email was sent",
  /no email was sent/i.test(r.json?.note ?? ""),
  r.json?.note,
);
check(
  "BZ-F041 inviting your own address is refused",
  (await api(owner, "POST", "/api/buzzy/team/invite", { email: ownerEmail })).status === 400,
);

// 2. wrong account cannot accept someone else's invitation
r = await api(stranger, "POST", "/api/buzzy/team/accept", { token });
check(
  "BZ-F041 wrong signed-in account cannot accept (403 wrong_account)",
  r.status === 403 && r.json?.code === "wrong_account",
  `status ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`,
);

// 3. invited account accepts
r = await api(member, "POST", "/api/buzzy/team/accept", { token });
check(
  "BZ-F041 invited account accepts and activates membership",
  r.status === 200 && r.json?.joined?.role === "member",
  JSON.stringify(r.json).slice(0, 200),
);

// 4. single use
r = await api(member, "POST", "/api/buzzy/team/accept", { token });
check("BZ-F041 invitation is single-use (409 already_used)", r.status === 409 && r.json?.code === "already_used", `status ${r.status}`);
r = await api(owner, "POST", "/api/buzzy/team/accept", { token: "nope-not-a-token" });
check("BZ-F041 unknown invitation token → 404", r.status === 404, `status ${r.status}`);

// 5. scoped access — member sees the OWNER's work with their own sign-in
r = await api(member, "GET", "/api/buzzy/team/scope");
const mScope = r.json ?? {};
check(
  "BZ-F041 member scope resolves to the owner's account",
  r.status === 200 && mScope.acting?.accountId && mScope.acting.accountId !== "self" &&
    mScope.acting?.role === "member",
  JSON.stringify(mScope).slice(0, 250),
);
check(
  "BZ-F041 member sees the owner's job (shared without sharing credentials)",
  (mScope.visible?.jobs ?? 0) >= 1,
  JSON.stringify(mScope.visible),
);
check(
  "BZ-F041 member can draft but CANNOT accept or send",
  (mScope.can ?? []).includes("draft") &&
    (mScope.cannot ?? []).some((c) => c.action === "accept_document") &&
    (mScope.cannot ?? []).some((c) => c.action === "send_outbound"),
  JSON.stringify(mScope.can),
);
check(
  "BZ-F041 refusals carry a plain-language reason, not a bare 403",
  (mScope.cannot ?? []).every((c) => typeof c.reason === "string" && c.reason.length > 20),
  JSON.stringify(mScope.cannot).slice(0, 200),
);

// 6. role enforcement on real actions
r = await api(member, "POST", "/api/buzzy/team/invite", { email: strangerEmail });
check(
  "BZ-F041 plain member cannot invite (403 role_denied)",
  r.status === 403 && r.json?.code === "role_denied",
  `status ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`,
);
r = await api(member, "DELETE", `/api/buzzy/team/${memberId}`, {});
check("BZ-F041 plain member cannot revoke (403)", r.status === 403, `status ${r.status}`);

// 7. admin can run the work but not delete the account
r = await api(owner, "POST", "/api/buzzy/team/invite", { email: adminEmail, role: "admin" });
const adminToken = (r.json?.inviteUrl ?? "").split("token=")[1] ?? "";
check("BZ-F041 owner can invite an admin", r.status === 201 && !!adminToken, JSON.stringify(r.json).slice(0, 150));
r = await api(admin, "POST", "/api/buzzy/team/accept", { token: adminToken });
check("BZ-F041 admin accepts", r.status === 200, `status ${r.status}`);
r = await api(admin, "GET", "/api/buzzy/team/scope");
const aScope = r.json ?? {};
check(
  "BZ-F041 admin can accept documents and send, but cannot delete the account",
  (aScope.can ?? []).includes("accept_document") && (aScope.can ?? []).includes("send_outbound") &&
    !(aScope.can ?? []).includes("delete_account"),
  JSON.stringify(aScope.can),
);

// 8. revoke removes access
r = await api(owner, "DELETE", `/api/buzzy/team/${memberId}`, {});
check("BZ-F041 owner revokes a teammate", r.status === 200 && r.json?.ok === true, JSON.stringify(r.json).slice(0, 150));
r = await api(member, "GET", "/api/buzzy/team/scope");
check(
  "BZ-F041 revoked member falls back to their OWN empty account",
  r.status === 200 && (r.json?.visible?.jobs ?? -1) === 0 && r.json?.acting?.role === "owner",
  JSON.stringify(r.json?.visible),
);
r = await api(owner, "GET", "/api/buzzy/team");
const listed = (r.json?.members ?? []).find((m) => m.id === memberId);
check("BZ-F041 revoked teammate is listed as revoked", listed?.status === "revoked", JSON.stringify(listed));
check(
  "BZ-F041 member list shows every teammate with role + status",
  (r.json?.members ?? []).length >= 2 && (r.json?.members ?? []).every((m) => m.role && m.status),
  JSON.stringify(r.json?.members).slice(0, 200),
);

// 9. negatives
r = await api(stranger, "GET", "/api/buzzy/team/scope");
check("BZ-F041 stranger sees their own empty scope, not the owner's", r.status === 200 && (r.json?.visible?.jobs ?? -1) === 0, JSON.stringify(r.json?.visible));
r = await api(stranger, "DELETE", `/api/buzzy/team/${memberId}`, {});
check("BZ-F041 stranger cannot revoke someone else's teammate (404)", r.status === 404, `status ${r.status}`);
r = await api(null, "GET", "/api/buzzy/team");
check("BZ-F041 anonymous team read → 401", r.status === 401, `status ${r.status}`);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
