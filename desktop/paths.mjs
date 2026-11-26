/**
 * Where the runtime tree lives, in BOTH layouts — one authority.
 *
 * The desktop shell is two different shapes at runtime:
 *
 *   dev      desktop/main.mjs            → <repo>/scripts/lib/*.mjs
 *   packaged resources/app.asar/main.mjs → <install>/resources/app/scripts/lib/*.mjs
 *
 * `../scripts/lib/inference.mjs`, written from the dev shape, resolves in the
 * packaged app to `<install>/resources/scripts/lib/inference.mjs` — a directory
 * the installer does not create. Electron answers that with
 * `ERR_MODULE_NOT_FOUND` **at module-link time**, before any of main.mjs runs,
 * so the app dies on launch with a dialog and no log. That is exactly what
 * shipped in 0.2.0.
 *
 * Rule: nothing inside the asar may reach the runtime tree with a relative
 * import. It asks `ROOT` and loads through `runtimeLib()`, which is a runtime
 * `import()` of an absolute file URL — valid in every layout, and its failure is
 * catchable (so it can be logged and shown as a sentence instead of a stack).
 *
 * Electron-free on purpose: `scripts/test-desktop-*.mjs` import this module
 * under plain node, where `process.resourcesPath` does not exist.
 */
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

// `process.defaultApp` is Electron's own discriminator: true when the binary was
// handed an app directory (`electron .`), undefined when it is a packaged app.
// Checking resourcesPath alone is not enough — dev Electron sets that too.
const PACKAGED = typeof process.resourcesPath === "string" && !process.defaultApp;

/** The runtime tree: .output/ scripts/ bin/ migrations/ public/ node_modules/. */
export const ROOT = PACKAGED
  ? join(process.resourcesPath, "app")
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const PACKAGED_BUILD = PACKAGED;

/** Absolute path to a file inside the runtime tree. */
export const runtimeFile = (...parts) => (isAbsolute(parts[0]) ? join(...parts) : join(ROOT, ...parts));

/**
 * Import a module from the runtime tree. Throws a sentence naming the missing
 * file rather than Node's resolution stack — a missing runtime file is a broken
 * install, not a bug the user can debug.
 */
export async function runtimeLib(relPath) {
  const file = runtimeFile(relPath);
  if (!existsSync(file)) {
    throw new Error(
      `the BeeZilla runtime is incomplete: ${relPath} is missing from ${ROOT}. ` +
        `Reinstall the app (or run \`beezilla doctor\` from the install folder).`,
    );
  }
  return import(pathToFileURL(file).href);
}
