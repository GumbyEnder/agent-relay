#!/usr/bin/env node
/**
 * Ambient Honcho regression checks, using synthetic data and no network/deps.
 * Runs the actual legacy UI action bodies with a minimal DOM and the actual
 * server module with a fetch recorder. Other UI/network providers are outside
 * this test; passing does not establish offline mode or a full application build.
 * Run: npm run test:honcho-privacy (uses Node built-in TypeScript stripping).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

// index.html was renamed to library.html upstream. The demo is a separate deployment with its own copy.
const pages = [
  { name: "library", file: "public/buzzy/library.html" },
  { name: "talk", file: "public/buzzy/talk.html" },
  { name: "demo", file: "packages/beezilla-demo/index.html" },
].map(({ name, file }) => ({
  name,
  source: readFileSync(new URL(`../${file}`, import.meta.url), "utf8"),
}));
const ambientHoncho = /HONCHO_BASE|ensureHonchoPeer|syncHonchoChat|honcho-api-production|\/v3\/workspaces\//;
const serverSource = readFileSync(new URL("../src/lib/buzzy/honcho.ts", import.meta.url), "utf8");

function functionSource(source, name) {
  const start = source.indexOf(`    function ${name}() {`);
  assert.notEqual(start, -1, `production ${name} still exists`);
  const end = source.indexOf("\n    }\n", start);
  assert.notEqual(end, -1, `production ${name} is complete`);
  return source.slice(start, end + "\n    }".length);
}

function browserHarness(source, origin) {
  const requests = [];
  const effects = { renders: 0, snapshots: 0, drafts: 0, generations: 0 };
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { value: "", innerHTML: "", onclick: null, focus() {} });
    return elements.get(id);
  };
  let sequence = 0;
  const emptyJob = () => ({
    id: `synthetic-job-${++sequence}`, template: "synthetic-template",
    problem: "", messages: [], screen: "jobs",
  });
  const context = vm.createContext({
    window: { location: { origin } },
    document: { getElementById: element },
    catalog: { userId: "synthetic-owner", jobs: [], currentId: null },
    state: emptyJob(),
    TEMPLATES: [{ id: "synthetic-template", name: "Fixture" }],
    emptyJob,
    setPhase() {},
    snapshotCurrent() { effects.snapshots++; },
    render() { effects.renders++; },
    buildDraft() { effects.drafts++; },
    generateDraft() { effects.generations++; },
    fetch: async (...args) => { requests.push(args); return { ok: true }; },
  });
  vm.runInContext(["newJob", "goProblem", "goChat"].map((name) => functionSource(source, name)).join("\n"), context);
  return { context, element, requests, effects };
}

for (const { name, source } of pages) {
  test(`${name}: all inline scripts parse and no ambient Honcho endpoint/helper remains`, () => {
    let count = 0;
    for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      if (/\bsrc\s*=/.test(match[1])) continue;
      new vm.Script(match[2], { filename: `${name}.html:inline-${++count}` });
    }
    assert.ok(count >= 1, "the production inline scripts were inspected");
    assert.doesNotMatch(source, ambientHoncho);
  });

  for (const origin of ["http://127.0.0.1:4747", "https://hosted.example"]) {
    test(`${name} at ${origin}: new job, problem, draft and both send branches do not sync memory`, async () => {
      const h = browserHarness(source, origin);
      const { context: c, element } = h;
      c.newJob();
      assert.equal(c.catalog.currentId, c.state.id);
      assert.equal(c.catalog.jobs[0], c.state);
      assert.equal(c.state.screen, "pick");

      c.goProblem();
      element("prob").value = "synthetic private problem";
      element("go").onclick();
      assert.equal(c.state.problem, "synthetic private problem");
      assert.equal(c.state.messages[0].text, "synthetic private problem");
      assert.equal(c.state.screen, "chat");

      c.goChat();
      element("draft").onclick();
      assert.equal(c.state.screen, "draft");

      c.goChat();
      element("more").value = "";
      element("send").onclick();
      assert.equal(c.state.screen, "draft");

      c.goChat();
      element("more").value = "synthetic private follow-up";
      element("send").onclick();
      assert.equal(c.state.messages.at(-1).text, "synthetic private follow-up");
      assert.equal(c.state.problem, "synthetic private problem\n\nsynthetic private follow-up");
      assert.equal(c.state.screen, "draft");
      assert.equal(h.effects.snapshots, 1);
      assert.equal(h.effects.renders, 5);
      assert.equal(h.effects.drafts, 3);
      assert.equal(h.effects.generations, name === "library" ? 1 : 0);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(h.requests.length, 0, "UI actions must not initiate third-party memory requests");
    });
  }
}

// Covers pages added later too: every browser-served file must stay free of the ambient uploader.
test("every browser-served .html/.js under public/ and packages/beezilla-demo is free of ambient Honcho", () => {
  const files = ["public", "packages/beezilla-demo"].flatMap((dir) =>
    readdirSync(new URL(`../${dir}/`, import.meta.url), { recursive: true })
      .filter((file) => /\.(html|js)$/.test(file))
      .map((file) => `${dir}/${file}`));
  assert.ok(files.includes("public/buzzy/library.html") && files.includes("packages/beezilla-demo/index.html"),
    "the browser pages were inspected");
  for (const file of files) {
    assert.doesNotMatch(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), ambientHoncho, file);
  }
});

function serverHarness(env) {
  const requests = [];
  const context = vm.createContext({
    process: { env },
    fetch: async (...args) => { requests.push(args); return { ok: true }; },
  });
  // This module has no dependencies. Execute its production TypeScript after
  // built-in stripping; never load provider code or real process credentials.
  const code = stripTypeScriptTypes(serverSource).replace(/^export /gm, "");
  vm.runInContext(code, context);
  return { api: context, requests };
}

for (const mode of [undefined, "local", "cloud"]) {
  test(`server: ${mode ?? "default"} runtime cannot treat configured credentials as consent`, async () => {
    const env = {
      BZ_HONCHO_URL: "https://synthetic-memory.example",
      BZ_HONCHO_KEY: "synthetic-honcho-key-not-real",
      BZ_HONCHO_WORKSPACE: "synthetic-workspace",
      ...(mode ? { BZ_RUNTIME: mode } : {}),
    };
    const h = serverHarness(env);
    assert.equal(h.api.honchoAvailable(), false, "disabled by policy, not merely unconfigured");
    assert.equal(await h.api.ensurePeer("synthetic-owner"), undefined);
    assert.equal(await h.api.ensureSession("synthetic-session", "synthetic-owner"), "synthetic-session");
    assert.equal(await h.api.syncMessages("synthetic-session", "synthetic-owner", [
      { peer_id: "synthetic-owner", content: "synthetic private owner message" },
      { peer_id: "beezilla", content: "synthetic private answer" },
    ]), undefined);
    await h.api.syncMessages("synthetic-session", "synthetic-owner", []);
    // Cached or changed credentials cannot re-enable ambient transmission.
    env.BZ_HONCHO_URL = "https://replacement-memory.example";
    env.BZ_HONCHO_KEY = "synthetic-replacement-key-not-real";
    assert.equal(h.api.honchoAvailable(), false);
    await h.api.ensurePeer("synthetic-other-owner");
    assert.equal(await h.api.ensureSession("synthetic-other-session", "synthetic-other-owner"), "synthetic-other-session");
    await h.api.syncMessages("synthetic-other-session", "synthetic-other-owner", [
      { peer_id: "synthetic-other-owner", content: "synthetic private message after env change" },
    ]);
    assert.equal(h.requests.length, 0, "all public helpers fail closed before fetch");
  });
}

test("server: unconfigured compatibility API remains available without network", async () => {
  const h = serverHarness({});
  assert.equal(h.api.honchoAvailable(), false);
  await h.api.ensurePeer("synthetic-owner");
  assert.equal(await h.api.ensureSession("synthetic-session", "synthetic-owner"), "synthetic-session");
  await h.api.syncMessages("synthetic-session", "synthetic-owner", []);
  assert.equal(h.requests.length, 0);
});

test("network recorders observe attempted requests without performing network IO", async () => {
  const browser = browserHarness(pages[0].source, "https://hosted.example");
  const server = serverHarness({});
  await vm.runInContext('fetch("https://synthetic-memory.example/probe")', browser.context);
  await vm.runInContext('fetch("https://synthetic-memory.example/probe")', server.api);
  assert.equal(browser.requests.length, 1);
  assert.equal(server.requests.length, 1);
});
