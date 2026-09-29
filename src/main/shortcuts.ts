import { globalShortcut } from "electron";
import { getMainWindow } from "./window";

/**
 * Actions the OS media keys and the user's global hotkeys map onto.
 * The renderer owns playback, so main only translates and forwards.
 */
export type ShortcutAction =
  | "play-pause"
  | "next-channel"
  | "prev-channel"
  | "next-track"
  | "prev-track"
  | "toggle-window"
  | "volume-up"
  | "volume-down"
  | "mute-toggle";

type Trigger = (action: ShortcutAction) => void;

let trigger: Trigger = () => {};
const failures: string[] = [];

/** Media keys work everywhere; they are registered whenever the app runs. */
const MEDIA_KEYS: Array<[string, ShortcutAction]> = [
  ["MediaPlayPause", "play-pause"],
  // The OS labels these "next/previous track", and inside one channel that is
  // exactly what they do — hop back and forth through its on-air log.
  ["MediaNextTrack", "next-track"],
  ["MediaPreviousTrack", "prev-track"],
  ["MediaStop", "play-pause"],
  ["VolumeUp", "volume-up"],
  ["VolumeDown", "volume-down"],
  ["VolumeMute", "mute-toggle"],
];

/** User-configurable accelerators, only registered while enabled. */
const ACTION_BY_SETTING: Record<string, ShortcutAction> = {
  playPause: "play-pause",
  nextChannel: "next-channel",
  prevChannel: "prev-channel",
  toggleWindow: "toggle-window",
};

function forward(action: ShortcutAction): void {
  const win = getMainWindow();
  // Media keys must work with the window hidden, so do not force it into view.
  if (win && !win.isDestroyed() && win.isVisible()) win.webContents.send("shortcut:trigger", action);
  else trigger(action);
}

export function registerShortcuts(
  onTrigger: Trigger,
  map: Record<string, string>,
  enabled: boolean,
): string[] {
  trigger = onTrigger;
  failures.length = 0;

  globalShortcut.unregisterAll();

  for (const [accelerator, action] of MEDIA_KEYS) {
    try {
      // If another app already owns the key we simply do not get it; not fatal.
      const ok = globalShortcut.register(accelerator, () => forward(action));
      if (!ok) failures.push(accelerator);
    } catch {
      failures.push(accelerator);
    }
  }

  if (enabled) {
    for (const [setting, action] of Object.entries(ACTION_BY_SETTING)) {
      const accelerator = map[setting];
      if (!accelerator) continue;
      try {
        const ok = globalShortcut.register(accelerator, () => forward(action));
        if (!ok) failures.push(accelerator);
      } catch {
        failures.push(accelerator);
      }
    }
  }

  return [...new Set(failures)];
}

export function unregisterShortcuts(): void {
  globalShortcut.unregisterAll();
}
