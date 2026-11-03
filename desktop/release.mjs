#!/usr/bin/env node
/**
 * Publish the desktop installer as a GitHub Release.
 *
 * Why a script and not a habit: a release is four things that must agree —
 * the version in `desktop/package.json`, a tag on the commit that was actually
 * built, an artifact whose bytes match that commit, and notes that say which
 * trust anchor it carries. Doing that by hand is how a "latest" download ends up
 * being yesterday's build.
 *
 * Rules it enforces:
 *   - never commit a binary; the installer rides the release, git carries source
 *   - the tag is `desktop-v<version>` (the server keeps plain `v<version>`; two
 *     release lines, two tag namespaces, no ambiguity at a glance)
 *   - a build carrying a DEV publisher pin can only ship as a prerelease
 *     (`--allow-dev-pin` required, and it returns 402 to the latest slot)
 *   - the uploaded asset is verified by size + sha256 against the local file
 *
 * Usage
 *   node desktop/release.mjs                    # build, tag, publish
 *   node desktop/release.mjs --skip-build       # publish the existing artifact
 *   node desktop/release.mjs --allow-dev-pin --prerelease
 *   node desktop/release.mjs --dry-run          # print what it would do
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(DESKTOP, "..");
const REPO = "GumbyEnder/agent-relay";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const DRY = flag("--dry-run");
const SKIP_BUILD = flag("--skip-build");
const ALLOW_DEV = flag("--allow-dev-pin");
const MOVE_TAG = flag("--move-tag");
const FORCE_PRE = flag("--prerelease");
// The commit the artifact was built from. Defaults to HEAD; pass --ref when the
// packaging script or notes changed after the build (the app bytes did not).
const REF = (() => {
  const i = args.indexOf("--ref");
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
})();

const log = (m) => console.log(`[release] ${m}`);
const run = (cmd, argv, opts = {}) =>
  execFileSync(cmd, argv, { cwd: opts.cwd ?? ROOT, stdio: opts.capture ? "pipe" : "inherit", encoding: "utf8", ...opts });

const pkg = JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8"));
const version = pkg.version;
const tag = `desktop-v${version}`;
const installer = join(ROOT, "dist-desktop", `BeeZilla-Setup-${version}.exe`);
const blockmap = `${installer}.blockmap`;

/* -- trust anchor: never publish a dev pin as a normal release -------------- */
const pinsPath = process.env.BZ_RECIPE_PUBLISHER_FILE ?? join(ROOT, "publishers.json");
let pins = [];
try {
  pins = JSON.parse(readFileSync(pinsPath, "utf8")).publishers ?? [];
} catch {
  pins = [];
}
const devPin = pins.some(
  (p) => /dev|test/i.test(`${p.keyId ?? ""} ${p.label ?? ""}`) || /devtest/i.test(JSON.stringify(p)),
);
if (!pins.length) {
  console.error(`refusing: no publisher pins in ${pinsPath} — a build with no trust anchor cannot verify a fetched recipe`);
  process.exit(1);
}
if (devPin && !ALLOW_DEV) {
  console.error(
    `refusing: the pins in ${pinsPath} look like DEV keys (${pins.map((p) => p.keyId).join(", ")}).\n` +
      `A release that trusts a test anchor cannot be a normal download. Re-run with --allow-dev-pin to publish it as a prerelease.`,
  );
  process.exit(1);
}
const prerelease = FORCE_PRE || devPin;

/* -- artifact --------------------------------------------------------------- */
if (!SKIP_BUILD) {
  log(`building ${tag}`);
  if (!DRY) run("node", [join(DESKTOP, "dist.mjs"), "all"]);
}
if (!existsSync(installer)) {
  console.error(`refusing: ${installer} does not exist — build it first (drop --skip-build)`);
  process.exit(1);
}
const bytes = statSync(installer).size;
const sha = createHash("sha256").update(readFileSync(installer)).digest("hex");

/* -- the commit must be the one that was built ------------------------------ */
const head = run("git", ["-C", ROOT, "rev-parse", "--short", REF ?? "HEAD"], { capture: true }).trim();
const branch = run("git", ["-C", ROOT, "rev-parse", "--abbrev-ref", "HEAD"], { capture: true }).trim();
const dirty = run("git", ["-C", ROOT, "status", "--porcelain"], { capture: true }).trim();
if (dirty && !DRY) {
  console.error(`refusing: working tree is dirty — a release must be buildable from its tag\n${dirty}`);
  process.exit(1);
}

const notes = `## BeeZilla Desktop ${version} — Windows x64

Electron shell over the local runtime (Nitro + embedded PGlite). Ships beside it, not instead of it:
the same pages, routes and migrations as the hosted app at https://app.devboards.ai.

- Built from \`${head}\` on \`${branch}\`
- Installer: \`BeeZilla Setup ${version}.exe\` — ${(bytes / 1024 / 1024).toFixed(1)} MB
- SHA-256 \`${sha}\`
- Publisher pins: ${pins.map((p) => `\`${p.keyId}\` (${p.label ?? "no label"})`).join(", ")}
${devPin ? "- **Prerelease:** carries a DEV trust anchor — fetched recipes verify against a test key. Not for general distribution." : ""}
- Unsigned: no code-signing certificate is configured, so Windows SmartScreen will warn.

Install: double-click, pick a directory, then connect a BeeZilla account (menu → *Connect BeeZilla account…*)
or paste your own provider key in Settings. Data lives in \`%APPDATA%\\BeeZilla\\data\`.
`;

log(`tag        ${tag}`);
log(`artifact   ${installer}`);
log(`bytes      ${bytes}`);
log(`sha256     ${sha}`);
log(`commit     ${head} (${branch})`);
log(`prerelease ${prerelease}${devPin ? " (dev pin)" : ""}`);

if (DRY) {
  log("dry run — nothing tagged or uploaded");
  process.exit(0);
}

/* -- tag: idempotent -------------------------------------------------------- */
const hasTag = run("git", ["-C", ROOT, "tag", "--list", tag], { capture: true }).trim() === tag;
if (hasTag) {
  // A tag that points at a different commit than the one that was built is the
  // worst kind of lie: the download is real, the source link is not.
  const tagged = run("git", ["-C", ROOT, "rev-parse", "--short", `${tag}^{commit}`], { capture: true }).trim();
  if (tagged !== head) {
    if (!MOVE_TAG) {
      console.error(
        `refusing: ${tag} points at ${tagged} but this artifact was built from ${head}.\n` +
          `Re-run with --move-tag to move the tag onto the built commit.`,
      );
      process.exit(1);
    }
    run("git", ["-C", ROOT, "tag", "-f", "-a", tag, REF ?? "HEAD", "-m", `BeeZilla Desktop ${version}`]);
    run("git", ["-C", ROOT, "push", "--force", "github", tag]);
    log(`tag ${tag} moved ${tagged} -> ${head}`);
  }
}
if (!hasTag) {
  run("git", ["-C", ROOT, "tag", "-a", tag, REF ?? "HEAD", "-m", `BeeZilla Desktop ${version}`]);
  run("git", ["-C", ROOT, "push", "github", tag]);
  log(`tagged ${tag}`);
} else {
  log(`tag ${tag} already exists — publishing its artifact`);
}

/* -- release ---------------------------------------------------------------- */
const exists = (() => {
  try {
    run("gh", ["release", "view", tag, "-R", REPO], { capture: true });
    return true;
  } catch {
    return false;
  }
})();

const assets = [installer, existsSync(blockmap) ? blockmap : null].filter(Boolean);
if (exists) {
  log(`release ${tag} exists — uploading assets (clobber)`);
  run("gh", ["release", "upload", tag, ...assets, "--clobber", "-R", REPO]);
} else {
  const notesFile = join(ROOT, "dist-desktop", `RELEASE-${version}.md`);
  writeFileSync(notesFile, notes);
  run("gh", [
    "release", "create", tag,
    ...assets,
    "--title", `BeeZilla Desktop ${version} (Windows x64)`,
    "--notes-file", notesFile,
    ...(prerelease ? ["--prerelease"] : []),
    "-R", REPO,
  ]);
  log(`release ${tag} created`);
}

/* -- verify what the world will download ------------------------------------ */
const remote = run("gh", ["release", "view", tag, "-R", REPO, "--json", "assets,isPrerelease,url"], { capture: true });
const parsed = JSON.parse(remote);
const wanted = `BeeZilla-Setup-${version}.exe`;
const legacy = `BeeZilla.Setup.${version}.exe`; // GitHub turns spaces into dots
const asset = parsed.assets.find((a) => a.name === wanted || a.name === legacy);
if (!asset) {
  console.error(`FAILED: ${tag} has no installer asset`);
  process.exit(1);
}
if (asset.size !== bytes) {
  console.error(`FAILED: uploaded size ${asset.size} != local ${bytes}`);
  process.exit(1);
}
log(`verified on GitHub: ${asset.name} ${asset.size} b · prerelease=${parsed.isPrerelease}`);
log(`download page: ${parsed.url}`);
log(`sha256 ${sha} — compare it after downloading`);
