#!/usr/bin/env node
/**
 * Refuse to deploy this repo into the wrong Railway service.
 *
 * The Railway CLI resolves a link by walking UP from the current directory. This repo
 * has no link of its own, so `railway up` here silently inherits
 * `~/.railway/config.json` for `/home/gumbyender` — which points at
 * **BNS Medusa Storefront**. That is a live storefront: deploying BeeZilla's server
 * into it would take a commerce site down and ship the wrong product.
 *
 * So the rule is explicit and the check is cheap: we deploy only into a service we
 * named on purpose, via BZ_RAILWAY_SERVICE (or the project in BZ_RAILWAY_PROJECT).
 *
 *   node scripts/check-deploy-target.mjs          # exit 0 = safe to `railway up`
 *   BZ_RAILWAY_SERVICE=<id|name> node scripts/check-deploy-target.mjs
 *
 * Read-only: it inspects the CLI's own config, never changes it.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const CONFIG = resolve(homedir(), ".railway", "config.json");
const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");

const expectedService = (process.env.BZ_RAILWAY_SERVICE ?? "").trim();
const expectedProject = (process.env.BZ_RAILWAY_PROJECT ?? "").trim();

const fail = (message) => {
  console.error(`\nREFUSING TO DEPLOY\n${message}\n`);
  process.exit(1);
};

if (!existsSync(CONFIG)) {
  fail(`no Railway CLI config at ${CONFIG} — check \`railway whoami\` and link a service explicitly:\n  railway link --project "<BeeZilla project>" --service "<BeeZilla service>"`);
}

let links = {};
try {
  links = JSON.parse(readFileSync(CONFIG, "utf8")).projects ?? {};
} catch (err) {
  fail(`could not read ${CONFIG}: ${err instanceof Error ? err.message : err}`);
}

// Mirror the CLI: nearest ancestor with a link wins.
let dir = ROOT;
let found = null;
while (dir !== "/" && !found) {
  if (links[dir]) found = { dir, ...links[dir] };
  dir = dirname(dir);
}

if (!found) {
  fail(
    `no Railway link found for ${ROOT} or any parent. Link one explicitly before deploying:\n` +
      `  railway link --project "<BeeZilla project>" --service "<BeeZilla service>"`,
  );
}

const where = `${found.name ?? "unknown project"} / service ${found.service ?? "unknown"} (env ${found.environmentName ?? "?"})`;
const inherited = found.dir !== ROOT;

console.log(`deploy target: ${where}`);
if (inherited) console.log(`  (inherited from ${found.dir}, not from this repo — that is exactly how the wrong service gets deployed)`);

if (expectedProject && !String(found.name ?? "").toLowerCase().includes(expectedProject.toLowerCase())) {
  fail(
    `this directory would deploy into "${found.name ?? "unknown"}", but BZ_RAILWAY_PROJECT expects "${expectedProject}".\n` +
      `Fix the link first:\n  railway link --project "${expectedProject}" --service "<BeeZilla service>"`,
  );
}

if (!expectedService) {
  fail(
    `the target is ${where}.\n\n` +
      `Nothing names this on purpose, so nothing here proves it is the BeeZilla cloud.\n` +
      `Set the service you intend to deploy to, then run this again:\n` +
      `  BZ_RAILWAY_SERVICE=<service id or name> node scripts/check-deploy-target.mjs\n\n` +
      `Known-good BeeZilla services live in the "Agent Relay" Railway project; look them up with:\n` +
      `  railway list`,
  );
}

const serviceField = String(found.service ?? found.name ?? "").toLowerCase();
if (!serviceField.includes(expectedService.toLowerCase())) {
  fail(
    `the link resolves to "${serviceField}", which does not match BZ_RAILWAY_SERVICE="${expectedService}".\n` +
      `Refusing to ship BeeZilla's server into a service someone else depends on.`,
  );
}

console.log("target matches BZ_RAILWAY_SERVICE — safe to deploy");
console.log("before shipping, set: BZ_INFERENCE_SIGNING_KEY (32+ chars), BZ_BRAVE_KEY, BZ_SEARCH_GATEWAY_URL");
process.exit(0);
