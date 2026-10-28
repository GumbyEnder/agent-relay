/**
 * S14: the recipe catalog — the one cloud call a local install makes.
 *
 * The catalog is UNTRUSTED even though it is ours, so most of this is about what a
 * hostile or broken catalog must NOT be able to do:
 *   - install a bundle whose bytes do not match the advertised digest
 *   - install a bundle signed by a key this build does not pin
 *   - install an oversize blob, or anything from a file:// "catalog"
 *
 * Run: npx tsx scripts/test-recipe-catalog.ts
 */
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECIPES } from "../src/lib/buzzy/recipes";
import { compileRecipeChecks } from "../src/lib/recipe-checks";
import { generateAuthorKey, sealBundle, type Capability, type SealInput } from "../src/lib/recipe-seal/bundle";
import { catalogBaseUrl, downloadBundle, fetchCatalog, installRecipe } from "../src/lib/recipe-seal/catalog";
import { listRecipes } from "../src/lib/recipe-seal/cache";
import { trustAnchorsFromEnv, type TrustAnchor } from "../src/lib/recipe-seal/trust";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const recipe = RECIPES[0];
const compiled = compileRecipeChecks(recipe.id, { salt: new Uint8Array(8) });
const KEK = new Uint8Array(32).fill(7);
const capability: Capability = {
  inputs: [{ name: "quotes", type: "file[]", required: true }],
  outputs: ["comparison-table", "recommendation"],
  tools: recipe.tools,
  forbidden_tools: ["send", "email", "submit", "publish", "pay", "sign"],
  boundary_summary: "read-only; nothing is sent",
};
const SEMANTIC = {
  discovery: recipe.discovery,
  checklist: recipe.checklist,
  firstQuestion: recipe.firstQuestion,
  outputContract: recipe.outputContract,
  boundary: recipe.boundary,
};

const seal = (authorKey: ReturnType<typeof generateAuthorKey>) =>
  sealBundle({
    recipeId: recipe.id,
    version: "1.0.0",
    semantic: SEMANTIC,
    checksWasm: compiled.wasm,
    checks: compiled.manifest,
    capability,
    author: { id: "acct_beezilla", name: "BeeZilla", keyId: authorKey.keyId, privateKey: authorKey.privateKey },
    kek: KEK,
    createdAt: "2026-10-20T12:00:00.000Z",
  } as SealInput);

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const goodKey = generateAuthorKey();
const goodSealed = seal(goodKey);
const goodBundle = goodSealed.bytes;
const rogueKey = generateAuthorKey();
const rogueBundle = seal(rogueKey).bytes;

const pin: TrustAnchor = { keyId: goodKey.keyId, publicKey: goodKey.publicKeyRaw };

const state = {
  catalogMode: "ok" as "ok" | "404" | "garbage" | "empty",
  bundleMode: "ok" as "ok" | "rogue" | "oversize",
};

let server: Server;
let base = "";

const startServer = async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/catalog.json") {
      if (state.catalogMode === "404") return void res.writeHead(404).end("nope");
      if (state.catalogMode === "garbage") return void res.writeHead(200, { "content-type": "application/json" }).end("{not json");
      const recipes =
        state.catalogMode === "empty"
          ? []
          : [
              {
                id: recipe.id,
                version: "1.0.0",
                title: recipe.id,
                url: "/recipes/good.bezz",
                sha256: sha256(goodBundle),
                keyId: goodKey.keyId,
              },
            ];
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ recipes }));
    }
    if (url === "/recipes/good.bezz") {
      if (state.bundleMode === "oversize") {
        // The declared length alone must stop us before reading a huge body.
        return void res.writeHead(200, { "content-length": String(9 * 1024 * 1024) }).end();
      }
      const bytes = state.bundleMode === "rogue" ? rogueBundle : goodBundle;
      return void res.writeHead(200, { "content-type": "application/octet-stream" }).end(Buffer.from(bytes));
    }
    res.writeHead(404).end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
};

await startServer();
const dataDir = mkdtempSync(join(tmpdir(), "bz-catalog-"));

// ── listing ─────────────────────────────────────────────────────────────────
{
  const listing = await fetchCatalog(base);
  check("catalog lists recipes", listing.ok && listing.entries.length === 1, listing.entries[0]?.id);
  check("catalog keeps the digest for verification", listing.entries[0]?.sha256 === sha256(goodBundle));

  state.catalogMode = "404";
  const missing = await fetchCatalog(base);
  check("a missing catalog reports the status", !missing.ok && /404/.test(missing.error ?? ""), missing.error);

  state.catalogMode = "garbage";
  const broken = await fetchCatalog(base);
  check("a broken catalog is refused with a reason", !broken.ok && /valid JSON/.test(broken.error ?? ""), broken.error);

  state.catalogMode = "empty";
  const empty = await fetchCatalog(base);
  check("an empty catalog is not an error", empty.ok && empty.entries.length === 0);

  state.catalogMode = "ok";
}

// ── the URL we accept ───────────────────────────────────────────────────────
{
  let thrown = "";
  try {
    catalogBaseUrl("file:///etc");
  } catch (err) {
    thrown = err instanceof Error ? err.message : String(err);
  }
  check("a file:// catalog is refused", /must be http/.test(thrown), thrown);
  check("trailing slashes are normalised", catalogBaseUrl("https://api.example.com//") === "https://api.example.com");

  const none = await fetchCatalog("");
  check("an unconfigured catalog says so by name", !none.ok && /BZ_CATALOG_URL/.test(none.error ?? ""), none.error);
}

// ── installing ──────────────────────────────────────────────────────────────
const entry = {
  id: recipe.id,
  version: "1.0.0",
  title: recipe.id,
  url: "/recipes/good.bezz",
  sha256: sha256(goodBundle),
  keyId: goodKey.keyId,
};

{
  const installed = await installRecipe(dataDir, entry, { anchors: [pin], base });
  check("a pinned, digest-matching bundle installs", installed.ok, installed.error ?? installed.cached?.id);
  check("the recipe lands in the offline cache", (listRecipes(dataDir, [pin]).valid?.length ?? 0) === 1);
  check("the cached file exists on disk", Boolean(installed.cached && existsSync(installed.cached.file)));
}

{
  const lie = await installRecipe(dataDir, { ...entry, sha256: "0".repeat(64) }, { anchors: [pin], base });
  check(
    "a digest mismatch is refused before verification",
    !lie.ok && /does not match the catalog digest/.test(lie.error ?? ""),
    lie.error,
  );
}

{
  state.bundleMode = "rogue";
  const rogue = await installRecipe(dataDir, { ...entry, sha256: sha256(rogueBundle) }, { anchors: [pin], base });
  check(
    "a bundle signed by an unpinned key is refused",
    !rogue.ok && rogue.verdict?.reason === "UNPINNED_PUBLISHER",
    rogue.verdict?.reason,
  );
  state.bundleMode = "ok";
}

{
  const noPins = await installRecipe(dataDir, entry, { anchors: [], base });
  check("no pinned publishers means nothing installs", !noPins.ok && noPins.verdict?.reason === "NO_TRUST_ANCHOR", noPins.verdict?.reason);
}

{
  state.bundleMode = "oversize";
  const huge = await downloadBundle(base, entry);
  check("an oversize bundle is refused on the header alone", !huge.ok && /over the .* limit/.test(huge.error ?? ""), huge.error);
  state.bundleMode = "ok";
}

{
  const missing = await downloadBundle(base, { ...entry, url: "/recipes/nope.bezz" });
  check("a missing bundle reports the status", !missing.ok && /404/.test(missing.error ?? ""), missing.error);
}

// ── env-driven pins behave like the rest of the app ─────────────────────────
{
  process.env.BZ_RECIPE_PUBLISHER_KEYS = `${goodKey.keyId}:${goodKey.publicKeyRaw}`;
  const fromEnv = trustAnchorsFromEnv();
  check("pins parse from the environment", fromEnv.length === 1 && fromEnv[0].keyId === goodKey.keyId, `${fromEnv.length} anchors`);
}

// ── the same thing through the real local runtime ───────────────────────────
// Unit tests prove the functions; this proves a user can do it through the app:
// the desktop window and the CLI both go through these two routes.
{
  const { spawn } = await import("node:child_process");
  const { readFileSync } = await import("node:fs");
  const runtimeDir = mkdtempSync(join(tmpdir(), "bz-catalog-rt-"));
  const child = spawn(process.execPath, [join(process.cwd(), "scripts", "beezilla-local.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BZ_RUNTIME: "local",
      BZ_DATA_DIR: runtimeDir,
      BZ_CHAT_KEY: "sk-catalog-probe",
      BZ_CATALOG_URL: base,
      BZ_RECIPE_PUBLISHER_KEYS: `${goodKey.keyId}:${goodKey.publicKeyRaw}`,
      HOST: "127.0.0.1",
    },
    stdio: "ignore",
  });

  const waitFor = async () => {
    const file = join(runtimeDir, "runtime.json");
    for (let i = 0; i < 120; i++) {
      try {
        const rt = JSON.parse(readFileSync(file, "utf8"));
        if (rt?.port) return rt as { port: number; host: string; token: string };
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  };

  const rt = await waitFor();
  check("the local runtime comes up with a catalog configured", Boolean(rt), rt ? `port ${rt.port}` : "no runtime.json");

  if (rt) {
    const call = async (path: string, init?: RequestInit) => {
      const res = await fetch(`http://${rt.host}:${rt.port}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${rt.token}`, "content-type": "application/json", ...(init?.headers ?? {}) },
      });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };

    const catalog = await call("/api/recipes/local/catalog");
    check(
      "the API lists the cloud catalog",
      catalog.status === 200 && catalog.body.ok === true && catalog.body.entries?.length === 1,
      `${catalog.status} ${JSON.stringify(catalog.body.entries?.[0]?.id ?? catalog.body.error ?? null)}`,
    );

    const fetched = await call("/api/recipes/local/fetch", { method: "POST", body: JSON.stringify({ id: recipe.id }) });
    check("the API installs a listed recipe", fetched.status === 201 && fetched.body.ok === true, `${fetched.status} ${fetched.body.error ?? ""}`);

    const listed = await call("/api/recipes/local");
    check("the installed recipe shows up as cached", listed.body.valid?.length === 1, `${listed.body.valid?.length ?? 0} cached`);

    const missing = await call("/api/recipes/local/fetch", { method: "POST", body: JSON.stringify({ id: "no-such-recipe" }) });
    check("fetching an unlisted id is a 404 with a reason", missing.status === 404 && /no recipe/.test(String(missing.body.error)), String(missing.status));

    const unauth = await fetch(`http://${rt.host}:${rt.port}/api/recipes/local/catalog`);
    check("the catalog route still requires the local token", unauth.status === 401, String(unauth.status));

    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 2500));
  } else {
    child.kill("SIGKILL");
  }
  rmSync(runtimeDir, { recursive: true, force: true });
}

server.close();
rmSync(dataDir, { recursive: true, force: true });
console.log(`\nrecipe catalog E2E: ${failures === 0 ? "passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
