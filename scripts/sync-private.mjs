#!/usr/bin/env node
/**
 * Populate `src/lib/private/` (and `scripts/private/`) from the private
 * beezilla-recipes repository, or from the committed stubs when this build has
 * no credential for it.
 *
 * Why a copy and not an npm dependency: the private modules are TypeScript that
 * has to sit in the tree for `tsc --noEmit` and for nitro's bundler to see it
 * with the same module resolution as everything else. A private package would
 * need a build step, an `exports` map and a transpile path through
 * node_modules — three things that can break a production deploy that a copy
 * cannot.
 *
 * Resolution order:
 *   1. BZ_PRIVATE_LOCAL_PATH  — an existing checkout (dev machine)
 *   2. .private/beezilla-recipes — clone kept by this script (fetch + checkout)
 *   3. a fresh clone using BZ_PRIVATE_REPO_TOKEN (https) or BZ_PRIVATE_DEPLOY_KEY (ssh)
 *   4. stubs — the public build. Loudly logged, recorded in the manifest.
 *
 * The commit is pinned in `private.lock.json`. A source that cannot produce that
 * exact commit is refused, not substituted: building an unpinned commit would
 * make "what is in production" unanswerable.
 *
 * Usage: node scripts/sync-private.mjs [--check] [--require-private]
 *   --check           verify the tree already matches the lock; no writes
 *   --require-private exit 1 instead of falling back to stubs
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const PRIVATE_DIR = join(ROOT, "src/lib/private");
const PRIVATE_TESTS = join(ROOT, "scripts/private");
const CACHE = join(ROOT, ".private/beezilla-recipes");
const MANIFEST = join(PRIVATE_DIR, ".manifest.json");

const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes("--check");
const REQUIRE_PRIVATE = argv.includes("--require-private") || process.env.BZ_REQUIRE_PRIVATE === "1";

const log = (msg) => console.log(`[private] ${msg}`);
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

function lock() {
  const path = join(ROOT, "private.lock.json");
  if (!existsSync(path)) throw new Error("private.lock.json is missing — the private modules are unpinned");
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed.repo || !parsed.commit) throw new Error("private.lock.json needs { repo, commit }");
  return parsed;
}

function git(args, cwd, env = {}) {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Credential material for a clone, or null when this build has none. */
function credentialEnv() {
  const token = process.env.BZ_PRIVATE_REPO_TOKEN?.trim();
  if (token) return { url: null, token };
  const key = process.env.BZ_PRIVATE_DEPLOY_KEY?.trim();
  if (key) {
    const keyPath = join(ROOT, ".private/deploy_key");
    mkdirSync(join(ROOT, ".private"), { recursive: true });
    writeFileSync(keyPath, Buffer.from(key, "base64").toString("utf8").trim() + "\n", { mode: 0o600 });
    return {
      url: null,
      ssh: `ssh -i "${keyPath}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null`,
    };
  }
  return null;
}

function repoUrl(lockfile, cred) {
  if (cred?.token) return `https://x-access-token:${cred.token}@github.com/${lockfile.repo}.git`;
  return `git@github.com:${lockfile.repo}.git`;
}

/** Bring the vendored checkout to exactly the locked commit. Returns true on success. */
function syncCheckout(lockfile) {
  const local = process.env.BZ_PRIVATE_LOCAL_PATH?.trim();
  if (local) {
    if (!existsSync(join(local, ".git"))) throw new Error(`BZ_PRIVATE_LOCAL_PATH is not a git checkout: ${local}`);
    checkout(local, lockfile.commit);
    return local;
  }

  if (existsSync(join(CACHE, ".git"))) {
    try {
      checkout(CACHE, lockfile.commit);
      return CACHE;
    } catch {
      log("cached clone does not have the locked commit — fetching");
    }
  }

  const cred = credentialEnv();
  if (!cred) return null;
  mkdirSync(join(ROOT, ".private"), { recursive: true });
  if (!existsSync(join(CACHE, ".git"))) {
    if (CHECK_ONLY) return null;
    log(`cloning ${lockfile.repo}`);
    git(["clone", "--quiet", "--no-single-branch", repoUrl(lockfile, cred), CACHE], ROOT, cred.ssh ? { GIT_SSH_COMMAND: cred.ssh } : {});
  }
  git(["fetch", "--quiet", "origin"], CACHE, cred.ssh ? { GIT_SSH_COMMAND: cred.ssh } : {});
  checkout(CACHE, lockfile.commit);
  return CACHE;
}

function checkout(dir, commit) {
  git(["checkout", "--quiet", "--detach", commit], dir);
  const head = git(["rev-parse", "HEAD"], dir);
  if (head !== commit) throw new Error(`checked out ${head}, expected ${commit}`);
}

function copyTree(from, to) {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
}

function hashTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name !== ".manifest.json") out[relative(dir, p)] = sha(readFileSync(p));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

function readManifest() {
  try {
    return JSON.parse(readFileSync(MANIFEST, "utf8"));
  } catch {
    return null;
  }
}

function main() {
  const lockfile = lock();

  if (CHECK_ONLY) {
    const manifest = readManifest();
    if (!manifest) {
      console.error("[private] no manifest — the tree has never been synced");
      process.exit(1);
    }
    const drift = [];
    if (manifest.mode === "stub" && REQUIRE_PRIVATE) drift.push("built from stubs");
    if (manifest.mode === "private" && manifest.commit !== lockfile.commit) {
      drift.push(`commit ${manifest.commit} != lock ${lockfile.commit}`);
    }
    if (JSON.stringify(hashTree(PRIVATE_DIR)) !== JSON.stringify(manifest.files ?? {})) {
      drift.push("src/lib/private does not match its manifest");
    }
    if (drift.length > 0) {
      console.error(`[private] CHECK FAILED: ${drift.join("; ")}`);
      process.exit(1);
    }
    log(`check ok — ${manifest.mode} @ ${manifest.commit}`);
    return;
  }

  let source = null;
  try {
    source = syncCheckout(lockfile);
  } catch (err) {
    log(`private source unavailable: ${err instanceof Error ? err.message : err}`);
  }

  if (!source) {
    if (REQUIRE_PRIVATE) {
      console.error("[private] BZ_PRIVATE_LOCAL_PATH / BZ_PRIVATE_REPO_TOKEN / BZ_PRIVATE_DEPLOY_KEY are all unset — refusing to build from stubs");
      process.exit(1);
    }
    copyStubs();
    return;
  }

  log(`source ${source} @ ${lockfile.commit}`);
  copyTree(join(source, "private"), PRIVATE_DIR);
  if (existsSync(join(source, "tests"))) copyTree(join(source, "tests"), PRIVATE_TESTS);

  if (existsSync(join(PRIVATE_DIR, "stubs"))) rmSync(join(PRIVATE_DIR, "stubs"), { recursive: true, force: true });
  const files = hashTree(PRIVATE_DIR);
  writeManifest({ mode: "private", commit: lockfile.commit, repo: lockfile.repo, files });
  log(`synced ${Object.keys(files).length} modules from ${lockfile.repo}@${lockfile.commit.slice(0, 8)}`);
}

function copyStubs() {
  const stubSrc = join(ROOT, ".private-stub");
  rmSync(PRIVATE_DIR, { recursive: true, force: true });
  mkdirSync(PRIVATE_DIR, { recursive: true });
  if (!existsSync(stubSrc)) throw new Error(".private-stub/ is missing — a public build has nothing to fall back to");
  for (const f of readdirSync(stubSrc)) cpSync(join(stubSrc, f), join(PRIVATE_DIR, f));
  rmSync(PRIVATE_TESTS, { recursive: true, force: true });
  const files = hashTree(PRIVATE_DIR);
  writeManifest({ mode: "stub", commit: "stub", repo: null, files });
  log(`STUB BUILD — ${Object.keys(files).length} module(s) stubbed, marketplace answers 503`);
}

function writeManifest(data) {
  writeFileSync(MANIFEST, JSON.stringify({ ...data, syncedAt: new Date().toISOString() }, null, 2) + "\n");
}

main();
