/**
 * BeeZilla desktop — Electron main process.
 *
 * There is NO second server here. The window is a view over the same local
 * runtime the CLI drives; the shell's only jobs are: start it, point a window at
 * it, put the per-launch token on every request, and shut it down cleanly.
 *
 * Auth is injected at the NETWORK layer (`onBeforeSendHeaders`), not in a
 * preload script. A preload runs in an isolated world with contextIsolation on,
 * so patching `window.fetch` there does not touch the page's fetch — a trap that
 * produces a window where every API call 401s while the preload "looks right".
 */
import { app, BrowserWindow, Menu, session, shell, dialog, safeStorage, ipcMain } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeSupervisor, defaultDataDir } from "./supervisor.mjs";
import { loadInference } from "../scripts/lib/inference.mjs";
import { createSettingsHandlers } from "./settings.mjs";

const ROOT = app.isPackaged
  ? join(process.resourcesPath, "app")
  : join(dirname(fileURLToPath(import.meta.url)), "..");

const supervisor = new RuntimeSupervisor({
  root: ROOT,
  onLog: (line) => console.log(line),
});

/**
 * The runtime is local: caching its HTML/JS buys nothing and guarantees a stale
 * UI after an app update (Electron's disk cache outlives the process). This was
 * found by a test that kept seeing the previous build's copy while the file on
 * disk was current.
 */
app.commandLine.appendSwitch("disable-http-cache");

// Silence is the worst failure mode in a packaged app: log the real error and
// keep the process alive long enough to show it.
process.on("unhandledRejection", (err) => {
  console.error("[desktop] unhandled rejection:", err instanceof Error ? err.stack : err);
});
process.on("uncaughtException", (err) => {
  console.error("[desktop] uncaught exception:", err instanceof Error ? err.stack : err);
});
process.on("exit", (code) => console.log(`[desktop] exiting code=${code}`));

let mainWindow = null;
let settingsWindow = null;
let runtimeBase = null;

/**
 * Decrypt the stored inference key into the environment the runtime inherits.
 * safeStorage only works after `app.whenReady()`, so this cannot run at module
 * load — and it must run again after the user saves a key, before the restart.
 */
function applyStoredInferenceToEnv() {
  try {
    const inf = loadInference(supervisor.dataDir, {
      decrypt: (buf) => safeStorage.decryptString(Buffer.from(buf)),
    });
    if (inf?.key) {
      process.env.BZ_CHAT_KEY = inf.key;
      if (inf.baseUrl) process.env.BZ_CHAT_BASE_URL = inf.baseUrl;
      if (inf.model) process.env.BZ_CHAT_MODEL = inf.model;
      console.log(`[desktop] inference: ${inf.provider} (stored${inf.encrypted ? ", encrypted" : ""})`);
      return;
    }
  } catch (err) {
    // A store we cannot decrypt must not take the app down — chat refuses by name.
    console.warn("[desktop] could not read the stored inference key:", err instanceof Error ? err.message : err);
  }
  delete process.env.BZ_CHAT_KEY;
  delete process.env.BZ_CHAT_BASE_URL;
  delete process.env.BZ_CHAT_MODEL;
}

/**
 * Settings IPC. `safeStorage` is only usable after `app.whenReady()`, so the
 * handlers are built there — but they are plain functions, so the contract can be
 * tested without a display (see scripts/test-desktop-settings.mjs).
 */
function registerSettingsIpc() {
  const handlers = createSettingsHandlers({
    dataDir: () => supervisor.dataDir,
    supervisor,
    cipher: {
      encrypt: (s) => safeStorage.encryptString(s),
      decrypt: (b) => safeStorage.decryptString(Buffer.from(b)),
    },
    beforeRestart: applyStoredInferenceToEnv,
  });

  const wrap = (fn) => async (_event, payload) => {
    try {
      return { ok: true, data: await fn(payload) };
    } catch (err) {
      // The page shows this text, so it must be a sentence a user can act on.
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  ipcMain.handle("beezilla:settings:get", wrap(() => handlers.status()));
  ipcMain.handle("beezilla:settings:saveInference", wrap((cfg) => handlers.saveInference(cfg)));
  ipcMain.handle("beezilla:settings:saveSearch", wrap((cfg) => handlers.saveSearch(cfg)));
  ipcMain.handle("beezilla:settings:clear", wrap((kind) => handlers.clear(kind)));
  ipcMain.handle("beezilla:app:version", wrap(() => ({ version: app.getVersion() })));

  return handlers;
}

// One install, one runtime: a second launch must focus the existing window, not
// open a second server against the same PGLite data directory.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function installMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "BeeZilla",
        submenu: [
          {
            label: "Settings…",
            accelerator: "CmdOrCtrl+,",
            click: () => void openSettings(),
          },
          { type: "separator" },
          { role: "reload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { label: "Edit", submenu: [{ role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    ]),
  );
}

/**
 * Settings window — a second window over the SAME runtime, not a second server.
 * It shares the default session, so the auth header injected for `base` already
 * applies and the page can reach the preload bridge.
 */
function settingsWindowFor(url) {
  settingsWindow = new BrowserWindow({
    width: 760,
    height: 820,
    minWidth: 560,
    title: "BeeZilla — Settings",
    parent: mainWindow ?? undefined,
    modal: false,
    show: true,
    backgroundColor: "#f7f8fa",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(dirname(fileURLToPath(import.meta.url)), "preload.cjs"),
    },
  });
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
  settingsWindow.webContents.on("console-message", (_e, _l, message) =>
    console.log(`[settings] ${message}`),
  );
  void settingsWindow.loadURL(url);
  console.log(`[desktop] settings window opened ${url}`);
  return settingsWindow;
}

async function openSettings() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }
  // If the runtime is not up yet (first launch), bring it up rather than showing
  // an error page: the user asked to configure the thing that starts it.
  if (!runtimeBase) {
    const rt = await supervisor.start();
    const base = `http://${rt.host}:${rt.port}`;
    runtimeBase = base;
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${base}/*`] }, (details, callback) => {
      details.requestHeaders["Authorization"] = `Bearer ${supervisor.token}`;
      callback({ requestHeaders: details.requestHeaders });
    });
  }
  // .html explicitly: Nitro answers /buzzy/talk without the extension (that path
  // is registered) but a plain static page needs its filename.
  settingsWindowFor(`${runtimeBase}/buzzy/settings.html`);
}

async function createWindow() {
  console.log("[desktop] createWindow: starting runtime");
  const rt = await supervisor.start();
  console.log(`[desktop] runtime ready on ${rt.host}:${rt.port}`);
  const base = `http://${rt.host}:${rt.port}`;
  runtimeBase = base;

  // Every request to the local runtime carries the per-launch token. Loopback
  // alone is not auth (any local process can reach the port), so without this
  // the whole app would 401 — by design.
  const ses = session.defaultSession;
  ses.webRequest.onBeforeSendHeaders({ urls: [`${base}/*`] }, (details, callback) => {
    details.requestHeaders["Authorization"] = `Bearer ${supervisor.token}`;
    callback({ requestHeaders: details.requestHeaders });
  });

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#ffffff",
    title: "BeeZilla",
    show: Boolean(process.env.BZ_SMOKE),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      // .cjs: a sandboxed renderer cannot load an ESM preload, and it fails
      // silently — window.beezilla just does not exist.
      preload: join(dirname(fileURLToPath(import.meta.url)), "preload.cjs"),
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Links open in the user's real browser — a desktop app that traps the web in
  // an unstyled frame is worse than no window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) =>
    console.log(`[desktop] load failed ${code} ${desc} ${url}`),
  );
  mainWindow.webContents.on("console-message", (_e, _level, message) => {
    console.log(`[renderer] ${message}`);
    // Probe mode ends the moment the renderer reports — no fixed timeout to wait out.
    if (process.env.BZ_SETTINGS_TEST && message.startsWith("SETTINGS_RESULT:")) {
      setTimeout(() => app.quit(), 250);
    }
  });

  // Test hook: load a probe page instead of the product UI, so the privileged
// bridge can be exercised in a real sandboxed renderer.
  const probe = process.env.BZ_SETTINGS_TEST;
  // BZ_PROBE_URL lets a test load a real product page (e.g. the settings screen)
  // and drive it, instead of a synthetic probe document.
  const probePath = process.env.BZ_PROBE_PATH;
  const target =
    process.env.BZ_PROBE_URL ||
    (probePath ? `${base}${probePath}` : null) ||
    (probe ? `file://${join(dirname(fileURLToPath(import.meta.url)), "test-settings.html")}` : `${base}/buzzy/talk`);
  const loaded = await Promise.race([
    mainWindow.loadURL(target).then(() => true),
    new Promise((r) => setTimeout(() => r(false), 30_000)),
  ]);
  console.log(`[desktop] loadURL ${loaded ? "resolved" : "TIMED OUT"} ${target}`);

  // Headless smoke hook: render, capture what the user would see, exit. Lets CI
  // prove the window actually paints instead of only proving the process boots.
  // Capture AFTER loadURL resolves — registering a `did-finish-load` listener
  // here would never fire, because the event has already been emitted by then.
  if (probe && process.env.BZ_SETTINGS_DRIVE) {
    // Drive the real settings form: pick "my own key", paste, save, read the
    // result out of the DOM. A UI that renders but cannot save is not a feature.
    const driver = `(async () => {
      const out = {};
      out.hasBridge = Boolean(window.beezilla && window.beezilla.settings);
      out.formPresent = Boolean(document.getElementById("save-inference") && document.getElementById("provider-byok"));
      out.buttonsEnabled = !document.getElementById("save-inference").disabled;
      const radio = document.getElementById("provider-byok");
      if (radio) { radio.checked = true; radio.dispatchEvent(new Event("change", { bubbles: true })); }
      out.byokFieldsShown = !document.getElementById("byok-fields").hidden;
      // The unconfigured copy must match the radio just picked: "nothing to
      // configure" beside "answers will refuse" reads like a broken app.
      out.emptyNote = document.getElementById("inference-current").textContent.trim();
      out.clearDisabledWhenEmpty = document.getElementById("clear-inference").disabled;
      document.getElementById("key").value = "sk-drive-probe-1234567890";
      document.getElementById("save-inference").click();
      await new Promise((resolve) => {
        const started = Date.now();
        const tick = setInterval(() => {
          const text = document.getElementById("inference-status").textContent || "";
          if (/Saved|Could not|required|error/i.test(text) || Date.now() - started > 40000) { clearInterval(tick); resolve(); }
        }, 250);
      });
      out.statusText = document.getElementById("inference-status").textContent;
      out.currentText = document.getElementById("inference-current").textContent.trim();
      return JSON.stringify(out);
    })()`;
    const result = await mainWindow.webContents.executeJavaScript(driver).catch((err) => JSON.stringify({ ok: false, error: String(err) }));
    console.log(`SETTINGS_DRIVE_RESULT:${result}`);
    app.quit();
    return;
  }

  if (probe) {
    // Safety net only: the renderer normally quits the app as soon as it reports.
    setTimeout(() => {
      console.log("[desktop] probe timed out — no SETTINGS_RESULT");
      app.quit();
    }, 40_000);
    return;
  }

  // First run with nothing configured: chat can only refuse, so open the thing
  // that makes it usable instead of handing a new user a dead window.
  if (!probe && !process.env.BZ_CHAT_KEY) {
    console.log("[desktop] onboarding: no inference configured — opening Settings");
    void openSettings();
  }
  if (!probe && process.env.BZ_FIRSTRUN_TEST) {
    // Bounded test launch: a configured install has nothing to prove and no other
    // reason to exit, so without this the suite waits out its own timeout.
    setTimeout(() => app.quit(), 4000);
    return;
  }

  if (process.env.BZ_SMOKE) {
    await new Promise((r) => setTimeout(r, Number(process.env.BZ_SMOKE_DELAY_MS ?? 2500)));
    // A capture that never resolves would hang CI forever; race it.
    // Capture what the user actually sees: on a first run that is the Settings
    // window, not the chat window behind it.
    const shotWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().at(-1) ?? mainWindow;
    const image = await Promise.race([
      shotWindow.webContents.capturePage(),
      new Promise((r) => setTimeout(() => r(null), 15_000)),
    ]);
    const { writeFileSync } = await import("node:fs");
    if (image) {
      writeFileSync(process.env.BZ_SMOKE_OUT || "beezilla-smoke.png", image.toPNG());
      console.log("[smoke] captured window");
    } else {
      console.log("[smoke] capture timed out — window did not paint");
    }
    app.quit();
  }
}

app.whenReady().then(async () => {
  installMenu();

  applyStoredInferenceToEnv();
  registerSettingsIpc();

  try {
    await createWindow();
  } catch (err) {
    console.error("[desktop] failed to start:", err);
    dialog.showErrorBox(
      "BeeZilla could not start",
      `${err instanceof Error ? err.message : String(err)}\n\nRun \`beezilla doctor\` from a terminal for details.`,
    );
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

// The runtime holds an embedded Postgres. Killing it abruptly loses the WAL
// flush, so quitting waits for a graceful stop.
let quitting = false;
app.on("before-quit", async (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  try {
    await supervisor.stop();
  } finally {
    app.exit(0);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
