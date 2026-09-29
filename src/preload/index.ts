import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  AirplayTrack,
  PersistedSettings,
  RecordMiniBridge,
  Station,
  StreamStatusEvent,
  TrayMenuPayload,
} from "@shared/types";

/** Wraps a subscribe/unsubscribe pair so callers get a disposer back. */
function subscribe<T extends unknown[]>(
  channel: string,
  callback: (...args: T) => void,
): () => void {
  const listener = (_event: IpcRendererEvent, ...args: unknown[]) => {
    callback(...(args as T));
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: RecordMiniBridge = {
  settings: {
    get: () => ipcRenderer.invoke("settings:get") as Promise<PersistedSettings>,
    set: (patch) => ipcRenderer.invoke("settings:set", patch) as Promise<PersistedSettings>,
    reset: () => ipcRenderer.invoke("settings:reset") as Promise<PersistedSettings>,
  },

  stations: {
    bundled: () => ipcRenderer.invoke("stations:bundled") as Promise<Station[]>,
    refresh: () => ipcRenderer.invoke("stations:refresh") as Promise<Station[]>,
  },

  onAir: {
    history: (stationId: number) =>
      ipcRenderer.invoke("onair:history", stationId) as Promise<AirplayTrack[]>,
  },

  player: {
    streamUrl: (prefix: string, bitrate: number | null) =>
      ipcRenderer.invoke("player:stream-url", prefix, bitrate) as Promise<string>,
    previewUrl: (upstream: string) =>
      ipcRenderer.invoke("player:preview-url", upstream) as Promise<string>,
  },

  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
    close: () => ipcRenderer.send("window:close"),
    hide: () => ipcRenderer.send("window:hide"),
    onMaximizeChange: (cb) => subscribe<[boolean]>("window:maximize-change", cb),
    onCloseRequested: (cb) => subscribe<[]>("window:close-requested", cb),
  },

  tray: {
    setMenu: (payload: TrayMenuPayload) => ipcRenderer.invoke("tray:set-menu", payload) as Promise<void>,
    setTooltip: (text: string) => ipcRenderer.invoke("tray:set-tooltip", text) as Promise<void>,
    setPlaying: (playing: boolean) => ipcRenderer.invoke("tray:set-playing", playing) as Promise<void>,
    onCommand: (cb) => subscribe<[string, unknown]>("tray:command", cb),
  },

  shortcuts: {
    register: (map) => ipcRenderer.invoke("shortcuts:register", map) as Promise<string[]>,
    unregisterAll: () => ipcRenderer.invoke("shortcuts:unregister-all") as Promise<void>,
    onTrigger: (cb) => subscribe<[string]>("shortcut:trigger", cb),
  },

  system: {
    openExternal: (url: string) => ipcRenderer.invoke("system:open-external", url) as Promise<void>,
    notify: (title, body, artwork) =>
      ipcRenderer.invoke("system:notify", title, body, artwork ?? null) as Promise<void>,
    getVersion: () => ipcRenderer.invoke("system:version") as Promise<string>,
    platform: process.platform,
  },
};

contextBridge.exposeInMainWorld("recordMini", api);

// Stream status is a listener, not part of the bridge interface above.
contextBridge.exposeInMainWorld("recordMiniEvents", {
  onStreamStatus: (cb: (e: StreamStatusEvent) => void) =>
    subscribe<[StreamStatusEvent]>("stream:status", cb),
});

export type RecordMiniBridgeApi = RecordMiniBridge;
