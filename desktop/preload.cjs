/**
 * Preload — the ONLY privileged surface the page gets.
 *
 * CommonJS on purpose: a sandboxed renderer cannot load an ESM preload, and the
 * failure is silent — `window.beezilla` is simply undefined while the window
 * looks fine. Sandboxing wins over module style, so this file stays .cjs.
 *
 * Earlier the app tried to inject the auth header by patching `window.fetch`
 * here, which failed: with contextIsolation the preload's `fetch` is a different
 * JS world from the page's. Network auth now happens in
 * `session.onBeforeSendHeaders`. What a preload IS for is exactly this: a narrow,
 * explicit IPC bridge.
 *
 * Every method returns a promise and the main process answers
 * `{ ok, data }` / `{ ok: false, error }` — no silent `false`, so a settings form
 * can show the real error instead of "something went wrong".
 */
const { contextBridge, ipcRenderer } = require("electron");

const call = (channel, payload) => ipcRenderer.invoke(`beezilla:${channel}`, payload);

contextBridge.exposeInMainWorld("beezilla", {
  settings: {
    get: () => call("settings:get"),
    saveInference: (cfg) => call("settings:saveInference", cfg),
    saveSearch: (cfg) => call("settings:saveSearch", cfg),
    clear: (kind) => call("settings:clear", kind),
    /** sign in on our site and store the short-lived inference token */
    connect: () => call("settings:connect"),
  },
  app: {
    version: () => call("app:version"),
    /** where main.log lives — so a bug report can name a file instead of a symptom */
    logs: () => call("app:logPath"),
    openLogs: () => call("app:openLogs"),
  },
});
