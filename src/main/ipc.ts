import { ipcMain, Notification, shell, app } from "electron";
import type {
  AirplayTrack,
  PersistedSettings,
  StreamStatusEvent,
  TrayMenuPayload,
} from "@shared/types";
import { settings } from "./settings-store";
import { loadStations, fetchStations, fetchHistory } from "./radiorecord-api";
import { updateTray, setTrayPlaying, createTray } from "./tray";
import { registerShortcuts, unregisterShortcuts } from "./shortcuts";
import { getMainWindow, showMainWindow } from "./window";
import type { StreamProxy } from "./stream-proxy";
import type { ShortcutAction } from "./shortcuts";

let trayAttached = false;

/** Pushes a stream status event to the renderer. */
export function emitStreamStatus(event: StreamStatusEvent): void {
  getMainWindow()?.webContents.send("stream:status", event);
}

function relayToRenderer(action: ShortcutAction): void {
  getMainWindow()?.webContents.send("shortcut:trigger", action);
}

function relayTrayCommand(command: string, payload?: unknown): void {
  getMainWindow()?.webContents.send("tray:command", command, payload);
}

/* --------------------------------------------------- OS integration sync */

export function applySystemIntegrations(next: PersistedSettings): void {
  try {
    app.setLoginItemSettings({
      openAtLogin: next.launchOnStartup,
      // Start hidden so the user lands straight in music, not in a window.
      args: next.startMinimized ? ["--hidden"] : [],
    });
  } catch (err) {
    console.warn("[main] could not update login item settings:", err);
  }

  if (next.showTray && !trayAttached) {
    createTray(relayTrayCommand);
    trayAttached = true;
  }

  registerShortcuts(relayToRenderer, next.globalShortcuts, next.globalShortcutsEnabled);
}

/** Called once at startup; creates the tray only if the user wants it. */
export function ensureTrayPresent(): void {
  if (settings.get().showTray && !trayAttached) {
    createTray(relayTrayCommand);
    trayAttached = true;
  }
}

/* -------------------------------------------------------------- ipc setup */

export function initIpc(proxy: StreamProxy): void {
  /* settings */
  ipcMain.handle("settings:get", () => settings.get());

  ipcMain.handle("settings:set", (_e, patch: Partial<PersistedSettings>) => {
    const next = settings.set(patch);
    const touchesIntegration =
      patch.launchOnStartup !== undefined ||
      patch.showTray !== undefined ||
      patch.globalShortcutsEnabled !== undefined ||
      patch.globalShortcuts !== undefined;
    if (touchesIntegration) applySystemIntegrations(next);
    return next;
  });

  ipcMain.handle("settings:reset", () => {
    const next = settings.reset();
    applySystemIntegrations(next);
    return next;
  });

  /* catalog */
  ipcMain.handle("stations:bundled", () => loadStations());
  ipcMain.handle("stations:refresh", () => fetchStations());

  /* on-air history: [] on failure so the UI degrades to station-only mode */
  ipcMain.handle("onair:history", async (_e, stationId: number) => {
    try {
      return await fetchHistory(stationId);
    } catch (err) {
      console.warn("[onair] history fetch failed:", err);
      return [] as AirplayTrack[];
    }
  });

  /* player */
  ipcMain.handle("player:stream-url", (_e, prefix: string, bitrate: number | null) => {
    const b = bitrate && bitrate > 0 ? bitrate : 0;
    return `http://127.0.0.1:${proxy.port}/stream?s=${encodeURIComponent(prefix)}&b=${b}`;
  });

  ipcMain.handle("player:preview-url", (_e, upstream: string) => {
    // The proxy re-validates the host; this is just the hand-off.
    return `http://127.0.0.1:${proxy.port}/preview?u=${encodeURIComponent(upstream)}`;
  });

  /* window */
  ipcMain.on("window:minimize", () => getMainWindow()?.minimize());
  ipcMain.on("window:toggle-maximize", () => {
    const win = getMainWindow();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on("window:close", () => getMainWindow()?.close());
  ipcMain.on("window:hide", () => getMainWindow()?.hide());

  /* tray */
  ipcMain.handle("tray:set-menu", (_e, payload: TrayMenuPayload) => {
    updateTray(payload);
    setTrayPlaying(payload.playing);
  });
  ipcMain.handle("tray:set-tooltip", (_e, text: string) => updateTray({ trackLabel: text }));
  ipcMain.handle("tray:set-playing", (_e, playing: boolean) => setTrayPlaying(playing));

  /* global shortcuts */
  ipcMain.handle("shortcuts:register", (_e, map: Record<string, string>) =>
    registerShortcuts(relayToRenderer, map, settings.get().globalShortcutsEnabled),
  );
  ipcMain.handle("shortcuts:unregister-all", () => unregisterShortcuts());

  /* system */
  ipcMain.handle("system:open-external", async (_e, url: string) => {
    // Guard against `file://`, `javascript:` and other dangerous schemes.
    if (!/^https:\/\//i.test(url)) throw new Error("только https-ссылки разрешены");
    await shell.openExternal(url);
  });

  ipcMain.handle("system:notify", (_e, title: string, body: string, artwork?: string | null) => {
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title,
      body,
      silent: true,
      ...(artwork ? { icon: artwork } : {}),
    });
    notification.on("click", showMainWindow);
    notification.show();
  });

  ipcMain.handle("system:version", () => app.getVersion());
}
