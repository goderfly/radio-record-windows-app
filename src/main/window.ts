import { BrowserWindow, shell, screen, app } from "electron";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { WindowState } from "@shared/types";
import { settings } from "./settings-store";
import { APP_SCHEME, rendererEntryUrl } from "./app-protocol";

const MIN_WIDTH = 940;
const MIN_HEIGHT = 560;
const DEFAULT_SIZE = { width: 1280, height: 800 };
const STATE_FILE = "window-state.json";

let mainWindow: BrowserWindow | null = null;
let forceQuit = false;

/* -------------------------------------------------------- persisted bounds */

function statePath(): string {
  return join(app.getPath("userData"), STATE_FILE);
}

function readWindowState(): WindowState {
  try {
    const p = statePath();
    if (!existsSync(p)) throw new Error("no saved bounds");
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<WindowState>;
    const width = Number(raw.width);
    const height = Number(raw.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error("bad bounds");
    return {
      width,
      height,
      x: Number.isFinite(raw.x) ? (raw.x as number) : (undefined as unknown as number),
      y: Number.isFinite(raw.y) ? (raw.y as number) : (undefined as unknown as number),
      maximized: raw.maximized === true,
    };
  } catch {
    return {
      width: DEFAULT_SIZE.width,
      height: DEFAULT_SIZE.height,
      x: undefined as unknown as number,
      y: undefined as unknown as number,
      maximized: false,
    };
  }
}

function writeWindowState(win: BrowserWindow): void {
  try {
    const maximized = win.isMaximized();
    const bounds = maximized ? win.getNormalBounds() : win.getBounds();
    const payload: WindowState = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized,
    };
    const p = statePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(payload), "utf8");
  } catch (err) {
    console.warn("[window] could not persist bounds:", err);
  }
}

/** Makes sure restored bounds land on a display that still exists. */
function clampToVisibleArea(state: WindowState): WindowState {
  if (!Number.isFinite(state.x) || !Number.isFinite(state.y)) return state;
  const display = screen.getDisplayMatching({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
  });
  const area = display.workArea;
  const width = Math.min(Math.max(state.width, MIN_WIDTH), area.width);
  const height = Math.min(Math.max(state.height, MIN_HEIGHT), area.height);
  return {
    width,
    height,
    x: Math.min(Math.max(state.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(state.y, area.y), area.y + area.height - height),
    maximized: state.maximized,
  };
}

/* -------------------------------------------------------------- the window */

export function createMainWindow(): BrowserWindow {
  const bounds = clampToVisibleArea(readWindowState());

  mainWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    frame: false, // custom title bar so the chrome can carry the Record brand
    titleBarStyle: "hidden",
    backgroundColor: "#141414",
    icon: join(__dirname, "../../resources/icon-256.png"),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  if (bounds.maximized) mainWindow.maximize();

  mainWindow.once("ready-to-show", () => {
    if (!settings.get().startMinimized) mainWindow?.show();
  });

  let persistTimer: NodeJS.Timeout | null = null;
  const schedulePersist = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) writeWindowState(mainWindow);
    }, 300);
  };
  mainWindow.on("resize", schedulePersist);
  mainWindow.on("move", schedulePersist);
  mainWindow.on("maximize", () => {
    mainWindow?.webContents.send("window:maximize-change", true);
    schedulePersist();
  });
  mainWindow.on("unmaximize", () => {
    mainWindow?.webContents.send("window:maximize-change", false);
    schedulePersist();
  });

  // Close-to-tray is the expected behaviour for a media player.
  mainWindow.on("close", (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) writeWindowState(mainWindow);
    if (forceQuit || !settings.get().closeToTray) return;
    event.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // The renderer may not navigate away or open extra windows.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const devServer = process.env["ELECTRON_RENDERER_URL"];
    if (devServer && url.startsWith(devServer)) return;
    if (url.startsWith(`${APP_SCHEME}://`)) return;
    event.preventDefault();
  });

  const devServer = process.env["ELECTRON_RENDERER_URL"];
  if (!app.isPackaged && devServer) {
    void mainWindow.loadURL(devServer);
  } else {
    void mainWindow.loadURL(rendererEntryUrl());
  }

  return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

export function showMainWindow(): void {
  const win = getMainWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

export function toggleMainWindow(): void {
  const win = getMainWindow();
  if (!win) return;
  if (win.isVisible() && win.isFocused()) win.hide();
  else showMainWindow();
}

export function quitApp(): void {
  forceQuit = true;
  app.quit();
}
