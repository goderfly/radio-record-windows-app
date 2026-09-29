import { Tray, Menu, nativeImage, type MenuItemConstructorOptions } from "electron";
import { join } from "node:path";
import type { TrayMenuPayload } from "@shared/types";
import { getMainWindow, showMainWindow, toggleMainWindow, quitApp } from "./window";

type CommandHandler = (command: string, payload?: unknown) => void;

/**
 * Short name for the places with no room for the full one: the tray menu
 * header and the tooltip, both of which are read at a glance.
 */
const APP_SHORT_NAME = "RECORD";

let tray: Tray | null = null;
let current: TrayMenuPayload = {
  playing: false,
  stationTitle: null,
  trackLabel: null,
  favorites: [],
  hasPrev: false,
  hasNext: false,
};
let handler: CommandHandler = () => {};

function icon(name: string): Electron.NativeImage {
  return nativeImage.createFromPath(join(__dirname, "../../resources", name));
}

function buildMenu(payload: TrayMenuPayload): Menu {
  const send = (command: string, arg?: unknown) => () => {
    handler(command, arg);
    showMainWindow();
  };

  const items: MenuItemConstructorOptions[] = [
    { label: APP_SHORT_NAME, enabled: false },
    { type: "separator" },
    {
      label: payload.stationTitle ?? "Ничего не играет",
      enabled: false,
    },
    {
      label: payload.trackLabel && payload.trackLabel.length > 46
        ? `${payload.trackLabel.slice(0, 45)}…`
        : (payload.trackLabel ?? ""),
      enabled: false,
    },
    { type: "separator" },
    {
      label: payload.playing ? "Пауза" : "Слушать",
      click: send("play-pause"),
    },
    {
      label: "Предыдущий канал",
      enabled: payload.hasPrev,
      click: send("prev-channel"),
    },
    {
      label: "Следующий канал",
      enabled: payload.hasNext,
      click: send("next-channel"),
    },
  ];

  if (payload.favorites.length) {
    items.push({ type: "separator" });
    items.push({
      label: "Избранное",
      submenu: payload.favorites.map((f) => ({
        label: f.title,
        click: send("play-station", f.prefix),
      })),
    });
  }

  items.push(
    { type: "separator" },
    { label: "Показать окно", click: () => showMainWindow() },
    { label: "Скрыть в трей", click: () => getMainWindow()?.hide() },
    { type: "separator" },
    { label: "Выход", click: () => quitApp() },
  );

  return Menu.buildFromTemplate(items);
}

export function createTray(onCommand: CommandHandler): void {
  handler = onCommand;
  if (tray) return;

  tray = new Tray(icon("tray.png"));
  tray.setToolTip(`${APP_SHORT_NAME} — пауза`);
  tray.setContextMenu(buildMenu(current));
  tray.on("click", () => toggleMainWindow());
  tray.on("double-click", () => showMainWindow());

  // macOS users expect the tray icon to also carry a dock menu.
  if (process.platform === "darwin") {
    tray.on("right-click", () => tray?.popUpContextMenu(buildMenu(current)));
  }
}

export function updateTray(payload: Partial<TrayMenuPayload>): void {
  current = { ...current, ...payload };
  if (!tray) return;
  tray.setContextMenu(buildMenu(current));
  const label = current.trackLabel ? `${current.stationTitle ?? ""} — ${current.trackLabel}` : current.stationTitle;
  tray.setToolTip(label ? `${APP_SHORT_NAME}: ${label}` : APP_SHORT_NAME);
}

export function setTrayPlaying(playing: boolean): void {
  if (!tray) return;
  const image = icon(playing ? "tray-playing.png" : "tray.png");
  tray.setImage(image.isEmpty() ? icon("tray.png") : image);
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}
