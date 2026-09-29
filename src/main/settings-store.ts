import { app } from "electron";
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { PersistedSettings, Settings } from "@shared/types";

const SETTINGS_VERSION = 1;
const FILE = "settings.json";

export const DEFAULT_SETTINGS: PersistedSettings = {
  volume: 0.8,
  muted: false,
  quality: "auto",
  theme: "dark",
  favorites: ["record", "rus", "khity-vsekh-vremen"],
  recents: [],
  crossfadeMs: 600,
  startMinimized: false,
  closeToTray: true,
  launchOnStartup: false,
  showTray: true,
  notificationsOnTrackChange: true,
  globalShortcutsEnabled: true,
  globalShortcuts: {
    playPause: "CommandOrControl+Shift+P",
    nextChannel: "CommandOrControl+Shift+Right",
    prevChannel: "CommandOrControl+Shift+Left",
    toggleWindow: "CommandOrControl+Shift+R",
  },
  lastStation: "record",
  compactNowPlaying: false,
};

type Listener = (settings: PersistedSettings) => void;

let cache: PersistedSettings | null = null;
let filePath: string | null = null;
let writeTimer: NodeJS.Timeout | null = null;
const listeners = new Set<Listener>();

function resolvePath(): string {
  if (!filePath) filePath = join(app.getPath("userData"), FILE);
  return filePath;
}

/** Accepts only known keys so a corrupted/hand-edited file can never inject fields. */
function sanitise(input: unknown): PersistedSettings {
  const src = (input ?? {}) as Partial<PersistedSettings>;
  const out: PersistedSettings = { ...DEFAULT_SETTINGS };
  const num = (v: unknown, min: number, max: number, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  const str = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

  if (typeof src.volume === "number") out.volume = num(src.volume, 0, 1, DEFAULT_SETTINGS.volume);
  out.muted = bool(src.muted, DEFAULT_SETTINGS.muted);
  out.quality = str(src.quality, ["auto", "low", "medium", "high"] as const, DEFAULT_SETTINGS.quality);
  out.theme = str(src.theme, ["dark", "light", "system"] as const, DEFAULT_SETTINGS.theme);
  out.crossfadeMs = num(src.crossfadeMs, 0, 5000, DEFAULT_SETTINGS.crossfadeMs);
  out.startMinimized = bool(src.startMinimized, DEFAULT_SETTINGS.startMinimized);
  out.closeToTray = bool(src.closeToTray, DEFAULT_SETTINGS.closeToTray);
  out.launchOnStartup = bool(src.launchOnStartup, DEFAULT_SETTINGS.launchOnStartup);
  out.showTray = bool(src.showTray, DEFAULT_SETTINGS.showTray);
  out.notificationsOnTrackChange = bool(
    src.notificationsOnTrackChange,
    DEFAULT_SETTINGS.notificationsOnTrackChange,
  );
  out.globalShortcutsEnabled = bool(
    src.globalShortcutsEnabled,
    DEFAULT_SETTINGS.globalShortcutsEnabled,
  );
  out.compactNowPlaying = bool(src.compactNowPlaying, DEFAULT_SETTINGS.compactNowPlaying);
  out.lastStation = typeof src.lastStation === "string" ? src.lastStation : null;

  const cleanList = (v: unknown, limit: number) =>
    Array.isArray(v)
      ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.length > 0))].slice(0, limit)
      : ([] as string[]);
  out.favorites = src.favorites === undefined ? DEFAULT_SETTINGS.favorites : cleanList(src.favorites, 200);
  out.recents = src.recents === undefined ? DEFAULT_SETTINGS.recents : cleanList(src.recents, 50);

  if (src.globalShortcuts && typeof src.globalShortcuts === "object") {
    const gs = src.globalShortcuts as Record<string, unknown>;
    const clean: Record<string, string> = { ...DEFAULT_SETTINGS.globalShortcuts };
    for (const action of Object.keys(DEFAULT_SETTINGS.globalShortcuts)) {
      const v = gs[action];
      if (typeof v === "string" && v.trim()) clean[action] = v.trim();
    }
    out.globalShortcuts = clean;
  }
  return out;
}

function readFromDisk(): PersistedSettings {
  try {
    const p = resolvePath();
    if (!existsSync(p)) return { ...DEFAULT_SETTINGS };
    return sanitise(JSON.parse(readFileSync(p, "utf8")));
  } catch (err) {
    console.warn("[settings] unreadable, falling back to defaults:", err);
    return { ...DEFAULT_SETTINGS };
  }
}

function flush(): void {
  if (!cache) return;
  try {
    const p = resolvePath();
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: SETTINGS_VERSION, ...cache }, null, 2), "utf8");
    renameSync(tmp, p); // atomic swap so a crash cannot truncate the file
  } catch (err) {
    console.error("[settings] write failed:", err);
  }
}

export const settings = {
  get(): PersistedSettings {
    if (!cache) cache = readFromDisk();
    return cache;
  },

  set(patch: Partial<PersistedSettings>): PersistedSettings {
    const next = sanitise({ ...settings.get(), ...patch });
    cache = next;
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(flush, 250);
    for (const l of listeners) {
      try {
        l(next);
      } catch (err) {
        console.error("[settings] listener failed:", err);
      }
    }
    return next;
  },

  reset(): PersistedSettings {
    cache = { ...DEFAULT_SETTINGS };
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(flush, 250);
    for (const l of listeners) l(cache);
    return cache;
  },

  onChange(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** Forces an immediate write — used on quit so nothing is lost. */
  flushNow(): void {
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = null;
    flush();
  },
};

export type FullSettings = Settings;
