import { app, BrowserWindow } from "electron";
import { createStreamProxy, type StreamProxy } from "./stream-proxy";
import { createMainWindow, getMainWindow } from "./window";
import { registerAppScheme, serveRendererFrom } from "./app-protocol";
import { initIpc, emitStreamStatus, applySystemIntegrations, ensureTrayPresent } from "./ipc";
import { settings } from "./settings-store";
import { unregisterShortcuts } from "./shortcuts";
import { APP_ID } from "./app-identity";
import { join } from "node:path";

/** Honour `--hidden` (used by the autostart entry) even before settings are read. */
const launchedHidden = process.argv.includes("--hidden");

// Must run before `app.whenReady()`.
// Keeps the toast header off the executable's name; see ./app-identity.
app.setAppUserModelId(APP_ID);
registerAppScheme();

// A second launch should surface the existing window instead of a second copy.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = getMainWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  void start();
}

async function start(): Promise<void> {
  await app.whenReady();

  // Playback cannot work without the loopback proxy, so this is fatal.
  let proxy: StreamProxy;
  try {
    proxy = await createStreamProxy((event) => emitStreamStatus(event));
  } catch (err) {
    console.error("[main] stream proxy failed to start:", err);
    app.quit();
    return;
  }

  initIpc(proxy);
  serveRendererFrom(join(__dirname, "../renderer"));
  applySystemIntegrations(settings.get());
  ensureTrayPresent();

  if (launchedHidden) settings.set({ startMinimized: true });
  const win = createMainWindow();

  const smokeOut = process.env["RECORD_MINI_SMOKE"];
  if (smokeOut) {
    // Verification run: exercise the real UI and the real stream, then exit.
    win.webContents.once("did-finish-load", () => {
      void import("./smoke").then((m) => m.runSmoke(win));
    });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    else getMainWindow()?.show();
  });

  app.on("window-all-closed", () => {
    // With a tray icon the app keeps running; without one, closing exits.
    if (process.platform !== "darwin" && !settings.get().showTray) app.quit();
  });

  app.on("before-quit", () => {
    settings.flushNow();
    unregisterShortcuts();
    void proxy.close();
  });
}
