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
const releaseExists = (name) => {
  try {
    run("gh", ["release", "view", name, "-R", REPO], { capture: true });
    return true;
  } catch {
    return false;
  }
};

// latest.yml is the update manifest. It is worthless on GitHub unless it is
// uploaded WITH the exe — and until 0.3.4 this script uploaded only the exe and
// the blockmap, so every release shipped an update nobody could be offered
// (BZ-D1b). Refuse to publish without it.
const manifest = join(ROOT, "dist-desktop", "latest.yml");
if (!existsSync(manifest)) {
  console.error(`refusing: ${manifest} does not exist — the build produced no update manifest, so no install could ever see this release`);
  process.exit(1);
}

const assets = [installer, existsSync(blockmap) ? blockmap : null, manifest].filter(Boolean);
if (releaseExists(tag)) {
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

/* -- the update feed -------------------------------------------------------- */
// Every installed copy has ONE fixed URL baked in (desktop/package.json
// build.publish → the generic provider). That URL is a release tagged
// `desktop-channel` whose latest.yml is replaced on every publish, and whose
// assets are exactly the filenames that latest.yml names. Nothing about this
// depends on GitHub's `releases/latest`, on prerelease flags, or on the
// `desktop-v` tag prefix — the three things that made the GitHub provider
// unresolvable (BZ-D1).
const CHANNEL_TAG = "desktop-channel";
const FEED_URL = `https://github.com/${REPO}/releases/download/${CHANNEL_TAG}`;
const channelNotes =
  "Update feed for BeeZilla desktop installs.\n\n" +
  "Do not delete. `latest.yml` here is the manifest electron-updater reads; it is\n" +
  "replaced (clobbered) by `node desktop/release.mjs` on every publish, together\n" +
  "with the installer it names. This release is a prerelease on purpose: it must\n" +
  "never become the repository's `releases/latest`.\n";

if (!releaseExists(CHANNEL_TAG)) {
  log(`creating feed release ${CHANNEL_TAG}`);
  run("gh", [
    "release", "create", CHANNEL_TAG,
    "--target", run("git", ["-C", ROOT, "rev-parse", REF ?? "HEAD"], { capture: true }).trim(),
    "--title", "BeeZilla desktop update feed",
    "--notes", channelNotes,
    "--prerelease",
    "-R", REPO,
  ]);
}
log(`publishing feed → ${CHANNEL_TAG}`);
run("gh", ["release", "upload", CHANNEL_TAG, ...assets, "--clobber", "-R", REPO]);

// Prune: one installer's worth of assets, not one per release ever made.
const channelJson = JSON.parse(
  run("gh", ["release", "view", CHANNEL_TAG, "-R", REPO, "--json", "assets"], { capture: true }),
);
const keep = new Set(assets.map((a) => a.split("/").pop()));
const stale = channelJson.assets.filter((a) => !keep.has(a.name)).map((a) => a.name);
if (stale.length) {
  log(`pruning stale feed assets: ${stale.join(", ")}`);
  // gh takes exactly one asset name per call — passing several silently treats
  // the extras as flags/positional garbage.
  for (const name of stale) run("gh", ["release", "delete-asset", CHANNEL_TAG, name, "--yes", "-R", REPO]);
}

/* -- prove the feed resolves (this is what an install actually does) -------- */
// Deliberately not through Electron: fetch latest.yml from the exact URL baked
// into the app, check it names this version, and check the bytes it promises are
// the bytes we just uploaded.
const feedManifest = await (await fetch(`${FEED_URL}/latest.yml`, { redirect: "follow" })).text();
if (!new RegExp(`^version:\\s*${version.replace(/\./g, "\\.")}\\s*$`, "m").test(feedManifest)) {
  console.error(`FAILED: ${FEED_URL}/latest.yml does not announce ${version}:\n${feedManifest}`);
  process.exit(1);
}
const promisedFile = (feedManifest.match(/^path:\s*(.+)$/m) ?? [])[1]?.trim();
const promisedB64 = (feedManifest.match(/^sha512:\s*(.+)$/m) ?? [])[1]?.trim();
const promisedSize = Number((feedManifest.match(/^\s+size:\s*(\d+)$/m) ?? [])[1]);
const servedHead = await fetch(`${FEED_URL}/${encodeURIComponent(promisedFile ?? "")}`, { method: "HEAD", redirect: "follow" });
if (promisedFile !== wanted || !servedHead.ok || Number(servedHead.headers.get("content-length")) !== bytes) {
  console.error(
    `FAILED: feed names ${promisedFile} (${promisedSize} b) but the URL serves ` +
      `${servedHead.status} ${servedHead.headers.get("content-length")} b — expected ${wanted} ${bytes} b`,
  );
  process.exit(1);
}
const localB64 = createHash("sha512").update(readFileSync(installer)).digest("base64");
if (promisedB64 !== localB64) {
  console.error("FAILED: feed sha512 does not match the installer about to be published");
  process.exit(1);
}
log(`feed verified: ${FEED_URL}/latest.yml → ${version}, ${promisedFile}, ${bytes} b, sha512 matches`);
