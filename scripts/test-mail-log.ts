/**
 * The mail log is a dev-inbox file, not a production record.
 *
 * A delivered magic link or password-reset link must not be written to
 * .data/outbound-mail.jsonl once real SMTP is configured: on Railway that file
 * sits on the customer-session filesystem and the link is a working sign-in.
 * This test pins the three states that matter:
 *
 *   1. dev inbox on, no SMTP        → file written, link present
 *   2. SMTP configured, no dev flag → no file, no link in the log stream
 *   3. SMTP configured, DEV_MAIL=1  → file written (the explicit opt-in wins)
 *
 * The SMTP host points at a closed port so the send fails fast and the code
 * takes its dev-fallback branch — the exact path that used to leak.
 *
 * Run: npx tsx scripts/test-mail-log.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LINK = "https://beezilla.net/api/auth/magic-link/verify?token=live-token-9f2c41";

const KEYS = [
  "RESEND_API_KEY",
  "SMTP_URL",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_PASSWORD",
  "SMTP_SECURE",
  "AGENT_RELAY_DEV_MAIL",
  "AGENT_RELAY_MAIL_LOG_DIR",
];

function clearEnv(): void {
  for (const k of KEYS) delete process.env[k];
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "bz-mail-log-"));
}

/** Collect everything the mailer prints, so a leaked link can be detected. */
function captureConsole(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const info = console.info;
  const error = console.error;
  console.info = (...args: unknown[]) => {
    chunks.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    chunks.push(args.map(String).join(" "));
  };
  return {
    text: () => chunks.join("\n"),
    restore: () => {
      console.info = info;
      console.error = error;
    },
  };
}

let passed = 0;
const failures: string[] = [];

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    failures.push(`${name}: ${(err as Error).message}`);
    console.log(`FAIL ${name} — ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  // Loaded after the env is in a known state, and re-used for every case: the
  // module reads process.env per call, so one import is enough.
  const { sendMagicLinkMail, isDevMailInboxEnabled } = await import("../src/lib/mailer");

  // 1. Plain local run: no SMTP, dev inbox on by default. The file is the
  //    probe/test contract, so this must keep working.
  await check("dev inbox on, no SMTP → file written with the link", async () => {
    clearEnv();
    const dir = freshDir();
    process.env.AGENT_RELAY_MAIL_LOG_DIR = dir;
    assert.equal(isDevMailInboxEnabled(), true, "dev inbox should default on without SMTP");
    const file = join(dir, "outbound-mail.jsonl");
    try {
      const sent = await sendMagicLinkMail({ to: "dev@example.com", url: LINK });
      assert.equal(sent.actionUrl, LINK);
      assert.equal(existsSync(file), true, "expected outbound-mail.jsonl");
      const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
      assert.equal(lines.length, 1, `expected 1 line, got ${lines.length}`);
      const row = JSON.parse(lines[0]) as { actionUrl?: string; transport?: string };
      assert.equal(row.actionUrl, LINK, "dev file should carry the link");
      assert.equal(row.transport, "dev");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 2. Production shape: SMTP configured, dev inbox off by default. The send
  //    fails (closed port), so the code walks the dev fallback — which is the
  //    branch that used to write the live link to disk and to stdout.
  await check("SMTP configured, no dev flag → no file, no link in logs", async () => {
    clearEnv();
    const dir = freshDir();
    process.env.AGENT_RELAY_MAIL_LOG_DIR = dir;
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = "1";
    assert.equal(isDevMailInboxEnabled(), false, "dev inbox must be off with SMTP set");
    const file = join(dir, "outbound-mail.jsonl");
    const cap = captureConsole();
    try {
      const sent = await sendMagicLinkMail({ to: "leak@example.com", url: LINK });
      // The link still belongs to the returned record (the caller may retry);
      // it just must not reach the filesystem or the log stream.
      assert.equal(sent.actionUrl, LINK);
      assert.equal(sent.transport, "dev");
      assert.equal(existsSync(file), false, "outbound-mail.jsonl must not exist with SMTP configured");
      const printed = cap.text();
      assert.equal(printed.includes("live-token-9f2c41"), false, "the link must not be printed");
      assert.equal(printed.includes(LINK), false, "the URL must not be printed");
    } finally {
      cap.restore();
      clearEnv();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 3. The explicit opt-in still wins: a developer running against a real SMTP
  //    server who sets AGENT_RELAY_DEV_MAIL=1 gets the inbox back knowingly.
  await check("SMTP configured + AGENT_RELAY_DEV_MAIL=1 → file written", async () => {
    clearEnv();
    const dir = freshDir();
    process.env.AGENT_RELAY_MAIL_LOG_DIR = dir;
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = "1";
    process.env.AGENT_RELAY_DEV_MAIL = "1";
    assert.equal(isDevMailInboxEnabled(), true);
    const file = join(dir, "outbound-mail.jsonl");
    const cap = captureConsole();
    try {
      await sendMagicLinkMail({ to: "optin@example.com", url: LINK });
      assert.equal(existsSync(file), true, "opt-in should restore the file");
      const row = JSON.parse(readFileSync(file, "utf8").trim().split("\n")[0]) as {
        actionUrl?: string;
      };
      assert.equal(row.actionUrl, LINK);
      assert.equal(cap.text().includes("Link: " + LINK), true, "opt-in should print the link");
    } finally {
      cap.restore();
      clearEnv();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  console.log(`\nmail log: ${passed}/${passed + failures.length} checks passed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
