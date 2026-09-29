/**
 * Types shared between the main, preload and renderer processes.
 * Keep this file free of Electron imports so all three bundles can use it.
 */

/* ----------------------------------------------------------------- catalog */

export interface Genre {
  id: number;
  name: string;
  /** Decorative artwork shipped with the genre, if any. */
  detailPicture?: string | null;
}

/**
 * A single selectable stream of a station. The API field names
 * (`stream_64` / `stream_128` / `stream_320`) do not match the real bitrates,
 * so the bitrate is always re-derived from the URL filename.
 */
export interface StationSource {
  bitrate: number;
  url: string;
}

export interface Station {
  id: number;
  /** Stable slug used for URLs and as a React key. */
  prefix: string;
  title: string;
  shortTitle: string;
  /** One-line channel description from the site. */
  tooltip: string;
  genres: Genre[];
  /**
   * Channel logo as inline SVG markup (200x200, `fill="white"`).
   * Preferred over `image` everywhere a channel is shown.
   */
  logoSvg: string | null;
  /** Wide banner from the site. Kept as a fallback when a logo is missing. */
  image: string;
  pageUrl: string;
  /** Progressive AAC streams, lowest bitrate first. */
  sources: StationSource[];
  hlsUrl: string | null;
  /** Some channels are marked 18+ on the site. */
  adult: boolean;
}

/* -------------------------------------------------------------- now playing */

export interface AirplayTrack {
  id: number;
  artist: string;
  song: string;
  image: string | null;
  /** Seconds since epoch of when the track went on air. */
  airTime: number;
  /** Human label from the API, e.g. "20:53:16". */
  airTimeLabel: string | null;
  /** Link to the track page on radiorecord.ru. */
  shareUrl: string | null;
  /** Yandex Music search link for this artist and title. */
  yandexUrl: string;
  /**
   * ~30 second preview clip (AAC in an M4A container) that the on-air API ships
   * for almost every track. This is the only way to actually hear a track from
   * the log: the live stream itself cannot be rewound.
   */
  previewUrl: string | null;
}

/* ---------------------------------------------------------------- settings */

export type QualityPreference = "auto" | "low" | "medium" | "high";

export type ThemeMode = "dark" | "light" | "system";

export interface Settings {
  version: number;
  volume: number;
  muted: boolean;
  quality: QualityPreference;
  theme: ThemeMode;
  favorites: string[];
  /** Most-recently played station prefixes. */
  recents: string[];
  crossfadeMs: number;
  sleepTimerMinutes: number | null;
  startMinimized: boolean;
  closeToTray: boolean;
  launchOnStartup: boolean;
  showTray: boolean;
  notificationsOnTrackChange: boolean;
  globalShortcutsEnabled: boolean;
  globalShortcuts: Record<string, string>;
  lastStation: string | null;
  compactNowPlaying: boolean;
}

export type PersistedSettings = Pick<
  Settings,
  | "volume"
  | "muted"
  | "quality"
  | "theme"
  | "favorites"
  | "recents"
  | "crossfadeMs"
  | "startMinimized"
  | "closeToTray"
  | "launchOnStartup"
  | "showTray"
  | "notificationsOnTrackChange"
  | "globalShortcutsEnabled"
  | "globalShortcuts"
  | "lastStation"
  | "compactNowPlaying"
>;

/* ------------------------------------------------------------- player state */

export type PlaybackStatus =
  | "idle"
  | "connecting"
  | "buffering"
  | "playing"
  | "reconnecting"
  | "error";

export interface StreamStatusEvent {
  status: PlaybackStatus;
  error?: string | null;
  /** Upstream throughput in kbps, used for the signal/quality hint. */
  bitrateKbps?: number | null;
}

export interface PlayerSnapshot {
  station: Station | null;
  status: PlaybackStatus;
  /** Seconds of audio decoded by the renderer, or null while stopped. */
  position: number | null;
  volume: number;
  muted: boolean;
  bitrate: number | null;
  track: AirplayTrack | null;
  error: string | null;
}

/* -------------------------------------------------------------- bridge API */

export interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface RecordMiniBridge {
  settings: {
    get(): Promise<PersistedSettings>;
    set(patch: Partial<PersistedSettings>): Promise<PersistedSettings>;
    reset(): Promise<PersistedSettings>;
  };
  stations: {
    /** Bundled snapshot, so the UI renders instantly and offline. */
    bundled(): Promise<Station[]>;
    /** Live list from radiorecord.ru. */
    refresh(): Promise<Station[]>;
  };
  onAir: {
    history(stationId: number, signal?: AbortSignal): Promise<AirplayTrack[]>;
  };
  player: {
    streamUrl(prefix: string, bitrate: number | null): Promise<string>;
    /**
     * Proxied URL for a track's preview clip. Takes the upstream URL rather
     * than a track id so the renderer can pass through whatever the API
     * returned; main validates the host before it will fetch it.
     */
    previewUrl(upstream: string): Promise<string>;
  };
  window: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    hide(): void;
    onMaximizeChange(cb: (maximized: boolean) => void): () => void;
    onCloseRequested(cb: () => void): () => void;
  };
  tray: {
    setMenu(payload: TrayMenuPayload): Promise<void>;
    setTooltip(text: string): Promise<void>;
    setPlaying(playing: boolean): Promise<void>;
    onCommand(cb: (command: string, payload?: unknown) => void): () => void;
  };
  shortcuts: {
    register(map: Record<string, string>): Promise<string[]>;
    unregisterAll(): Promise<void>;
    onTrigger(cb: (action: string) => void): () => void;
  };
  system: {
    openExternal(url: string): Promise<void>;
    notify(title: string, body: string, artwork?: string | null): Promise<void>;
    getVersion(): Promise<string>;
    platform: NodeJS.Platform;
  };
}

export interface TrayMenuPayload {
  playing: boolean;
  stationTitle: string | null;
  trackLabel: string | null;
  favorites: Array<{ prefix: string; title: string }>;
  /** False when the previous/next channel button should be greyed out. */
  hasPrev: boolean;
  hasNext: boolean;
}