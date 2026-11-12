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
import { app, BrowserWindow, Menu, session, shell, dialog, safeStorage, ipcMain, systemPreferences } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeSupervisor } from "./supervisor.mjs";
import { ROOT, runtimeLib } from "./paths.mjs";
import { installLogging, logLine, logPaths } from "./logger.mjs";
import { connectAccount } from "./connect.mjs";

// FIRST, before anything that can throw. 0.2.0 died at module-link time and left
// no trace anywhere; every launch now writes a session block to
// %APPDATA%\BeeZilla\logs\main.log (BZ_LOG_DIR overrides), tees console output into
// it, and turns an uncaught exception into a readable dialog naming that file.
installLogging({
  version: app.getVersion(),
  facts: { resourcesRoot: ROOT },
  onFatal: (kind, err) => {
    const detail = err instanceof Error ? err.stack || err.message : String(err);
    const { file, dir } = logPaths();
    try {
      dialog.showErrorBox(
        `BeeZilla — ${kind}`,
        `${detail}\n\nLog file:\n${file ?? dir ?? "(logging unavailable)"}\n\n` +
          `Send this file to support; it records what the app was doing.`,
      );
    } finally {
      app.exit(1);
    }
  },
});

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

// Silence is the worst failure mode in a packaged app. The logger installs the
// process handlers (uncaught exception → dialog naming the log file); here we
// only add the exit breadcrumb, so "it closed itself" is answerable from disk.
process.on("exit", (code) => console.log(`[desktop] exiting code=${code}`));

let mainWindow = null;
let settingsWindow = null;
let runtimeBase = null;

/**
 * Identity for the local runtime.
 *
 * Without this the window shows the synthetic local row — name "Owner",
 * `owner@beezilla.local` — even right after the user signed in with their real
 * account, which reads as "the app doesn't know me". A connected account's
 * name/email is written to `<dataDir>/identity.json` and exported into the
 * runtime's environment before it starts, so the owner row adopts it.
 */
function identityFile() {
  return join(supervisor.dataDir, "identity.json");
}

function applyIdentityToEnv() {
  try {
    if (!existsSync(identityFile())) return;
    const id = JSON.parse(readFileSync(identityFile(), "utf8"));
    if (id?.name) process.env.BZ_LOCAL_OWNER_NAME = String(id.name);
    if (id?.email) process.env.BZ_LOCAL_OWNER_EMAIL = String(id.email);
    console.log(`[desktop] identity: ${id.name || "(no name)"} <${id.email || "(no email)"}>`);
  } catch (err) {
    console.warn("[desktop] could not read identity.json:", err instanceof Error ? err.message : err);
  }
}

function saveIdentity(account) {
  if (!account?.email) return;
  try {
    mkdirSync(supervisor.dataDir, { recursive: true });
    writeFileSync(identityFile(), JSON.stringify({ ...account, savedAt: new Date().toISOString() }, null, 2) + "\n");
    applyIdentityToEnv();
    console.log(`[desktop] identity saved: ${account.name || "(no name)"} <${account.email}>`);
  } catch (err) {
    console.warn("[desktop] could not save identity.json:", err instanceof Error ? err.message : err);
  }
}

/**
 * Decrypt the stored inference key into the environment the runtime inherits.
 * safeStorage only works after `app.whenReady()`, so this cannot run at module
 * load — and it must run again after the user saves a key, before the restart.
 *
 * Async only because the inference library is loaded from the runtime tree at
 * call time (see paths.mjs); a missing file becomes a sentence, not a crash.
 */
async function applyStoredInferenceToEnv() {
  try {
    const { loadInference, isExpired } = await runtimeLib("scripts/lib/inference.mjs");
    const inf = loadInference(supervisor.dataDir, {
      decrypt: (buf) => safeStorage.decryptString(Buffer.from(buf)),
    });
    if (inf && inf.provider === "beezilla" && isExpired(inf)) {
      // Expiry is a session problem: refuse by name instead of spending a request
      // that comes back 401 and reads as "your key is wrong".
      delete process.env.BZ_CHAT_KEY;
      delete process.env.BZ_CHAT_BASE_URL;
      delete process.env.BZ_CHAT_MODEL;
      delete process.env.BZ_MUSIC_VIA_GATEWAY;
      process.env.BZ_MANAGED_EXPIRED = "1";
      console.warn("[desktop] BeeZilla token expired — Settings will ask you to reconnect");
      return;
    }
    delete process.env.BZ_MANAGED_EXPIRED;
    if (inf?.key) {
      process.env.BZ_CHAT_KEY = inf.key;
      if (inf.baseUrl) process.env.BZ_CHAT_BASE_URL = inf.baseUrl;
      if (inf.model) process.env.BZ_CHAT_MODEL = inf.model;
      // Managed music rides the same short-lived gateway token as chat: the app holds
      // no music key at all, and quota/plan are enforced on our side. BYOK installs
      // (provider "byok") keep using their own ElevenLabs key from Settings.
      if (inf.provider === "beezilla" && inf.baseUrl) process.env.BZ_MUSIC_VIA_GATEWAY = inf.baseUrl;
      else delete process.env.BZ_MUSIC_VIA_GATEWAY;
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
  delete process.env.BZ_MUSIC_VIA_GATEWAY;
}

/**
 * ElevenLabs key → BZ_ELEVEN_KEY before the runtime is spawned.
 *
 * The local runtime reads credentials from the environment at module load, and a
 * desktop install has no environment of its own — so this is the only path by
 * which the Music button can ever be configured (it answered `not_configured` on
 * every install until this existed). Same rule as inference: a store we cannot
 * read must not take the app down, it must refuse by name.
 */
async function applyStoredMusicToEnv() {
  try {
    const { resolveMusicKey } = await runtimeLib("scripts/lib/music-keys.mjs");
    const found = resolveMusicKey(supervisor.dataDir, {
      decrypt: (buf) => safeStorage.decryptString(Buffer.from(buf)),
    });
    if (found?.key) {
      process.env.BZ_ELEVEN_KEY = found.key;
      console.log(`[desktop] music: ${found.provider} (${found.source}${found.encrypted ? ", encrypted" : ""})`);
      return;
    }
  } catch (err) {
    console.warn("[desktop] could not read the stored music key:", err instanceof Error ? err.message : err);
  }
  delete process.env.BZ_ELEVEN_KEY;
}

/**
 * Settings IPC. `safeStorage` is only usable after `app.whenReady()`, so the
 * handlers are built there — but they are plain functions, so the contract can be
 * tested without a display (see scripts/test-desktop-settings.mjs).
 */
let settingsHandlers = null;

function registerSettingsIpc() {
  // Imported here, not at the top: settings.mjs loads the runtime's credential
  // libraries, so a broken install must fail inside this try/catch (logged, and
  // shown as a sentence) rather than at module-link time before logging exists.
  return import("./settings.mjs").then(({ createSettingsHandlers }) => {
    const handlers = createSettingsHandlers({
      dataDir: () => supervisor.dataDir,
      supervisor,
      cipher: {
        encrypt: (s) => safeStorage.encryptString(s),
        decrypt: (b) => safeStorage.decryptString(Buffer.from(b)),
      },
      beforeRestart: async () => {
        // Identity first: the runtime reads BZ_LOCAL_OWNER_* at spawn.
        applyIdentityToEnv();
        await applyStoredInferenceToEnv();
        await applyStoredMusicToEnv();
      },
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
    ipcMain.handle("beezilla:settings:saveMusic", wrap((cfg) => handlers.saveMusic(cfg)));
    ipcMain.handle("beezilla:settings:clear", wrap((kind) => handlers.clear(kind)));
    ipcMain.handle("beezilla:app:version", wrap(() => ({ version: app.getVersion(), update: updateState })));

    // Updates. Status is always answerable (even when the updater is unavailable,
    // so the UI can say "updates are off on this build" instead of showing nothing).
    ipcMain.handle("beezilla:update:status", wrap(() => ({ version: app.getVersion(), ...updateState })));
    ipcMain.handle("beezilla:update:check", wrap(async () => {
      if (!updaterRef) updaterRef = await installUpdater();
      else await updaterRef.checkForUpdates().catch((err) => logLine(`[update] check failed: ${err?.message ?? err}`));
      return { version: app.getVersion(), ...updateState };
    }));
    ipcMain.handle("beezilla:update:download", wrap(async () => {
      if (!updaterRef) return { ok: false, error: "updates are not available on this build" };
      await updaterRef.downloadUpdate();
      return { version: app.getVersion(), ...updateState };
    }));
    ipcMain.handle("beezilla:update:install", wrap(async () => {
      if (!updaterRef) return { ok: false, error: "updates are not available on this build" };
      // Never restart mid-conversation without being asked: this handler only runs
      // when the owner presses the button.
      setImmediate(() => updaterRef.quitAndInstall(false, true));
      return { ok: true };
    }));
    // "Connect BeeZilla account" from the Settings screen: same flow as the menu item.
    ipcMain.handle("beezilla:settings:connect", wrap(() => connectManagedAccount()));
    // Diagnostics from the UI: one click to the folder that holds main.log.
    ipcMain.handle("beezilla:app:openLogs", wrap(async () => {
      const { dir } = logPaths();
      if (dir) await shell.openPath(dir);
      return { dir, file: logPaths().file };
    }));
    ipcMain.handle("beezilla:app:logPath", wrap(async () => logPaths()));
    // The page knows things the shell cannot see: which device it got, what the
    // recorder produced, what the transcriber answered. Those lines belong in
    // main.log next to the launch breadcrumbs, not only in a DevTools console the
    // user will never open.
    ipcMain.handle("beezilla:app:log", wrap(async (message) => {
      const text = String(message ?? "").slice(0, 600);
      logLine("log", [`[ui] ${text}`]);
      return { logged: true };
    }));

    return handlers;
  });
}

// One install, one runtime: a second launch must focus the existing window, not
// open a second server against the same PGLite data directory.
// Update state lives at module scope: the IPC handlers, the tray/settings page and
// the updater's own event listeners all read it. It was missing at first, so every
// touch threw ReferenceError inside a promise — silently, because nothing logged.
let updateState = { available: null, downloaded: null, downloading: null, error: null, checkedAt: null };
let updaterRef = null;

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
          {
            label: "Connect BeeZilla account…",
            // On by default: a normal install must be able to connect. Only an explicit
            // BZ_CONNECT_DISABLED=1 turns it off (air-gapped or white-label builds).
            enabled: process.env.BZ_CONNECT_DISABLED !== "1",
            click: () => void connectManagedAccount(),
          },
          { type: "separator" },
          {
            label: "Open Logs Folder",
            click: () => {
              const { dir, file } = logPaths();
              console.log(`[desktop] opening logs folder ${dir}`);
              if (dir) void shell.openPath(dir);
              else dialog.showErrorBox("BeeZilla", `Logging is unavailable.\n${file ?? ""}`);
            },
          },
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

/**
 * Connect a BeeZilla account so the app can use OUR inference.
 *
 * The token is minted inside our own page (session cookie stays there) and handed
 * straight to the credential store; the store restart then puts it in the runtime's
 * environment. Nothing about the account itself is copied locally.
 */
async function connectManagedAccount() {
  const win = new BrowserWindow({
    width: 520,
    height: 760,
    title: "Connect BeeZilla",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);

  const outcome = await connectAccount({
    // undefined lets connectAccount resolve the baked default; an env value overrides.
    baseUrl: process.env.BZ_CLOUD_URL || undefined,
    open: (url) => win.loadURL(url),
    evaluate: (script) => win.webContents.executeJavaScript(script, true),
    isOpen: () => !win.isDestroyed(),
    close: () => {
      if (!win.isDestroyed()) win.destroy();
    },
    signInDeadlineMs: Number(process.env.BZ_CONNECT_DEADLINE_MS ?? 180_000),
  });

  if (!outcome.ok) {
    console.warn(`[desktop] connect: ${outcome.error}`);
    // Never leave a blank BeeZilla window behind after a failed load.
    if (!win.isDestroyed()) win.destroy();
    if (!process.env.BZ_CONNECT_TEST && mainWindow && !mainWindow.isDestroyed()) {
      void dialog.showMessageBox(mainWindow, {
        type: "info",
        title: "BeeZilla inference",
        message: outcome.unreachable
          ? "BeeZilla is not reachable."
          : outcome.needsSignIn
            ? "Sign-in did not complete."
            : "Could not connect.",
        detail: `${outcome.error}\n\nYou can still use your own key: BeeZilla → Settings.`,
      });
    }
    return outcome;
  }

  // Who signed in — saved before the credential so the restart that follows picks
  // the name up in the same pass.
  if (outcome.account) saveIdentity(outcome.account);

  const saved = await settingsHandlers.saveInference({
    provider: "beezilla",
    key: outcome.token,
    baseUrl: outcome.baseUrl,
    model: outcome.model,
    expiresAt: outcome.expiresAt,
  });
  console.log(
    `[desktop] connect: BeeZilla inference connected (expires ${outcome.expiresAt ?? "unknown"}), runtime ${saved.started ? "started" : "restarted"}`,
  );

  // Search is a second capability and is allowed to be missing. Saying so once, at
  // connect time, is better than a user discovering it later in a chat turn.
  let searchSaved = null;
  if (outcome.search?.ok) {
    try {
      const res = await settingsHandlers.saveManagedSearch({
        token: outcome.search.token,
        gateway: outcome.search.endpoint,
        expiresAt: outcome.search.expiresAt,
      });
      searchSaved = res.saved;
      console.log(`[desktop] connect: BeeZilla search connected (expires ${outcome.search.expiresAt ?? "unknown"})`);
    } catch (err) {
      console.warn(`[desktop] connect: search token not stored — ${err instanceof Error ? err.message : err}`);
    }
  } else if (outcome.search?.notDeployed) {
    console.log("[desktop] connect: BeeZilla search is not enabled on this deployment — BYOK search only");
  } else if (outcome.search?.error) {
    console.warn(`[desktop] connect: search token unavailable — ${outcome.search.error}`);
  }

  return { ...outcome, token: undefined, search: { ...outcome.search, token: undefined, saved: searchSaved }, savedTo: saved.saved?.key };
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
  // One check per launch, after the window is usable, never blocking start-up.
  setTimeout(() => { installUpdater().then((u) => { if (u) updaterRef = u; }); }, 4000);
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
  // The connect probe drives its own window; it must not be mistaken for the
  // settings probe (which loads test-settings.html and waits for a result line).
  const quiet = Boolean(probe || process.env.BZ_CONNECT_TEST);
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
  if (process.env.BZ_CONNECT_TEST) {
    // Drive the real flow (window -> mint inside the page -> credential store) and
    // report it in one parseable line for scripts/test-desktop-connect.mjs.
    const outcome = await connectManagedAccount();
    console.log(
      `CONNECT_RESULT:${JSON.stringify({
        ok: outcome.ok,
        error: outcome.error ?? null,
        needsSignIn: outcome.needsSignIn ?? false,
        // The search half is reported too: a connect that silently drops it looks
        // identical to one that never asked.
        search: outcome.search
          ? { ok: outcome.search.ok === true, notDeployed: outcome.search.notDeployed === true, error: outcome.search.error ?? null }
          : null,
      })}`,
    );
    setTimeout(() => app.quit(), 500);
    return;
  }

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
  if (!quiet && !process.env.BZ_CHAT_KEY) {
    console.log("[desktop] onboarding: no inference configured — opening Settings");
    void openSettings();
  }
  if (!quiet && process.env.BZ_FIRSTRUN_TEST) {
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

/**
 * Media permission, decided here instead of by a default.
 *
 * "It didn't hear me" has one silent cause above all others: getUserMedia rejects
 * and nothing records why. Electron answers permission requests from a handler or
 * from a default that has moved between versions; either way the renderer only
 * sees a rejected promise. Decide explicitly, log the decision with the requesting
 * origin, and the log then answers the question before the user has to describe it.
 */
function installMediaPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    const allowed = permission === "media" || permission === "audioCapture";
    logLine("log", [`[perm] request ${permission} ← ${wc?.getURL?.() ?? "?"} → ${allowed ? "allow" : "deny"}`]);
    callback(allowed);
  });
  // Chromium also asks about the DEVICE, not just the permission. Without this a
  // page may be allowed "media" and still be handed nothing.
  ses.setDevicePermissionHandler((details) => {
    const ok = details?.deviceType === "audioinput" || details?.deviceType === "audiooutput";
    logLine("log", [`[perm] device ${details?.deviceType ?? "?"} ${details?.origin ?? ""} → ${ok ? "allow" : "deny"}`]);
    return ok;
  });
  // Windows/macOS can refuse microphone access to the executable itself, and that
  // refusal shows up as a live stream delivering silence — no error anywhere.
  setTimeout(() => {
    try {
      const status = systemPreferences.getMediaAccessStatus?.("microphone");
      logLine("log", [`[perm] OS microphone access=${status ?? "unknown"}`]);
    } catch (err) {
      logLine("log", [`[perm] OS microphone access query failed: ${err?.message ?? err}`]);
    }
  }, 1500);

  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    const allowed = permission === "media" || permission === "audioCapture";
    logLine("log", [
      `[perm] check ${permission}${details?.mediaType ? `(${details.mediaType})` : ""} ← ${requestingOrigin} → ${allowed ? "allow" : "deny"}`,
    ]);
    return allowed;
  });
}

/**
 * Updates.
 *
 * Twelve releases shipped before this existed, and every one of them reached an
 * installed copy only because someone downloaded an installer by hand. The app
 * can be days behind the server it talks to and the owner has no way to know.
 *
 * Deliberately not silent: check on launch, download nothing until the owner says
 * so, and never restart under them mid-sentence. Prereleases are opt-in through
 * BZ_UPDATE_PRERELEASE (every build today is one).
 */
async function installUpdater() {
  // Every exit from here says why. Silent returns are how the updater would ship
  // broken for a third time — an early `return null` with no line is indistinguishable
  // from "no updates available" in the log, which is exactly what nobody can debug.
  if (!app.isPackaged) {
    logLine(`[update] skipped: app.isPackaged is false (running as a script, not an install)`);
    return null;
  }
  if (process.env.BZ_DISABLE_UPDATES === "1") {
    logLine("[update] disabled by BZ_DISABLE_UPDATES");
    return null;
  }
  logLine(
    `[update] check requested (installed ${app.getVersion()}, feed=${
      process.env.BZ_UPDATE_FEED_URL || "app-update.yml"
    })`,
  );
  let updater;
  try {
    // A dynamic import inside an asar can hang rather than throw on a hostile
    // platform; without a bound that hang is indistinguishable from success.
    const loaded = await Promise.race([
      import("electron-updater"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("import timed out after 20 s")), 20_000)),
    ]);
    // electron-updater is CommonJS; a dynamic import wraps it, and whether the
    // named export is hoisted depends on the interop. Take it from wherever it is
    // rather than assuming — `undefined.autoUpdater` was the second silent death.
    updater = loaded?.autoUpdater ?? loaded?.default?.autoUpdater ?? loaded?.default ?? null;
    if (!updater) {
      logLine(`[update] electron-updater loaded without an autoUpdater (keys: ${Object.keys(loaded ?? {}).join(",")})`);
      return null;
    }
    logLine("[update] electron-updater loaded");
  } catch (err) {
    logLine(`[update] electron-updater unavailable: ${err?.message ?? err}`);
    return null;
  }
  updater.logger = {
    info: (m) => logLine(`[update] ${m}`),
    warn: (m) => logLine(`[update] warn: ${m}`),
    error: (m) => logLine(`[update] error: ${m}`),
    debug: () => {},
  };
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  // BZ-D1: the GitHub provider resolved the release through `releases/latest`,
  // which is the newest NON-prerelease in this repo — the web release v0.3.0 —
  // so it asked for releases/download/v0.3.0/latest.yml and 404'd, forever.
  // `allowPrerelease` cannot fix that either: with a channel set it requires the
  // tag to parse as semver, and `desktop-v0.3.3` does not.
  // So the feed is a generic provider on a fixed URL: the `desktop-channel`
  // GitHub release, whose latest.yml is replaced on every publish
  // (desktop/package.json build.publish, desktop/release.mjs). No tag lookup,
  // no prerelease logic, nothing to regress when a web release appears.
  const feedOverride = process.env.BZ_UPDATE_FEED_URL || null;
  if (feedOverride) {
    updater.setFeedURL({ provider: "generic", url: feedOverride, channel: "latest" });
    logLine(`[update] feed overridden by BZ_UPDATE_FEED_URL → ${feedOverride}`);
  }
  updater.allowPrerelease = false;
  try {
    const feedFile = join(process.resourcesPath ?? "", "app-update.yml");
    logLine(
      `[update] feed config: ${
        existsSync(feedFile) ? readFileSync(feedFile, "utf8").replace(/\s+/g, " ").trim() : "MISSING app-update.yml"
      }`,
    );
  } catch (err) {
    logLine(`[update] feed config unreadable: ${err?.message ?? err}`);
  }
  updater.on("update-available", (info) => {
    updateState = { ...updateState, available: info?.version ?? null, error: null };
    logLine(`[update] ${info?.version} available (installed ${app.getVersion()})`);
  });
  updater.on("update-not-available", () => {
    updateState = { ...updateState, available: null, checkedAt: Date.now() };
    logLine(`[update] up to date (${app.getVersion()})`);
  });
  updater.on("download-progress", (p) => {
    updateState = { ...updateState, downloading: Math.round(p?.percent ?? 0) };
  });
  updater.on("update-downloaded", (info) => {
    updateState = { ...updateState, downloaded: info?.version ?? null, downloading: null };
    logLine(`[update] ${info?.version} downloaded — waiting for the owner`);
  });
  updater.on("error", (err) => {
    updateState = { ...updateState, error: String(err?.message ?? err) };
    logLine(`[update] error: ${err?.message ?? err}`);
  });
  try {
    // Bound the whole check: a check that never answers must read as "no answer",
    // not as "fine".
    await Promise.race([
      updater.checkForUpdates(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("no answer within 25 s")), 25_000)),
    ]);
    logLine(`[update] check finished (state ${JSON.stringify(updateState)})`);
  } catch (err) {
    logLine(`[update] check failed: ${err?.message ?? err}`);
  }
  return updater;
}

app.whenReady().then(async () => {
  installMenu();
  installMediaPermissions();

  try {
    applyIdentityToEnv();
    await applyStoredInferenceToEnv();
    await applyStoredMusicToEnv();
    settingsHandlers = await registerSettingsIpc();
    await createWindow();
  } catch (err) {
    const detail = err instanceof Error ? err.stack || err.message : String(err);
    console.error("[desktop] failed to start:", detail);
    const { file } = logPaths();
    dialog.showErrorBox(
      "BeeZilla could not start",
      `${err instanceof Error ? err.message : String(err)}\n\nLog file:\n${file ?? "(logging unavailable)"}\n\n` +
        `Run \`beezilla doctor\` from a terminal for details.`,
    );
    app.quit();
    return;
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
