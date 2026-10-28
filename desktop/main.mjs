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
import { app, BrowserWindow, Menu, session, shell, dialog } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeSupervisor } from "./supervisor.mjs";

const ROOT = app.isPackaged
  ? join(process.resourcesPath, "app")
  : join(dirname(fileURLToPath(import.meta.url)), "..");

const supervisor = new RuntimeSupervisor({
  root: ROOT,
  onLog: (line) => console.log(line),
});

let mainWindow = null;

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

async function createWindow() {
  console.log("[desktop] createWindow: starting runtime");
  const rt = await supervisor.start();
  console.log(`[desktop] runtime ready on ${rt.host}:${rt.port}`);
  const base = `http://${rt.host}:${rt.port}`;

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
  mainWindow.webContents.on("console-message", (_e, _level, message) =>
    console.log(`[renderer] ${message}`),
  );

  const loaded = await Promise.race([
    mainWindow.loadURL(`${base}/buzzy/talk`).then(() => true),
    new Promise((r) => setTimeout(() => r(false), 30_000)),
  ]);
  console.log(`[desktop] loadURL ${loaded ? "resolved" : "TIMED OUT"} ${base}/buzzy/talk`);

  // Headless smoke hook: render, capture what the user would see, exit. Lets CI
  // prove the window actually paints instead of only proving the process boots.
  // Capture AFTER loadURL resolves — registering a `did-finish-load` listener
  // here would never fire, because the event has already been emitted by then.
  if (process.env.BZ_SMOKE) {
    await new Promise((r) => setTimeout(r, Number(process.env.BZ_SMOKE_DELAY_MS ?? 2500)));
    // A capture that never resolves would hang CI forever; race it.
    const image = await Promise.race([
      mainWindow.webContents.capturePage(),
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
