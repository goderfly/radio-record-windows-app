import { create } from "zustand";
import type {
  AirplayTrack,
  Genre,
  PersistedSettings,
  PlaybackStatus,
  Station,
} from "@shared/types";
import { RadioEngine } from "../lib/audio";
import { resolveBitrate } from "../lib/format";
import { scoreStation } from "../lib/fuzzy";

export type ViewId = "channels" | "favorites" | "recent" | "history";
export type SortId = "site" | "title" | "genre";

export interface Toast {
  id: number;
  message: string;
  tone: "info" | "error" | "success";
}

interface AppState {
  /* catalog */
  stations: Station[];
  genres: Genre[];
  catalogState: "loading" | "ready" | "error";
  catalogError: string | null;

  /* persisted settings */
  settings: PersistedSettings | null;

  /* view state */
  view: ViewId;
  query: string;
  genreFilter: number | null;
  sort: SortId;
  maximized: boolean;
  expandedPlayer: boolean;
  settingsOpen: boolean;
  sidebarOpen: boolean;

  /* playback */
  station: Station | null;
  status: PlaybackStatus;
  error: string | null;
  signalKbps: number | null;
  track: AirplayTrack | null;
  history: AirplayTrack[];
  historyStationId: number | null;
  historyLoading: boolean;
  /**
   * How far back into the channel's on-air log the listener has stepped.
   * `0` is the live track; `1` is the one before it, and so on.
   */
  trackCursor: number;
  /**
   * Id of the track whose ~30s excerpt is loaded instead of the live stream.
   * `null` while the radio is live. A live stream cannot be rewound, so this is
   * what actually makes an entry of the log audible.
   */
  previewTrackId: number | null;

  /* sleep timer */
  sleepTimerEndsAt: number | null;

  toasts: Toast[];
}

interface AppActions {
  init(): Promise<void>;
  playStation(station: Station): Promise<void>;
  togglePlay(): Promise<void>;
  stop(): void;
  nextStation(direction: 1 | -1): Promise<void>;
  /** Step one track back in the channel's on-air log. */
  prevTrack(): Promise<void>;
  /** Step one track forward; returns to the live track at the end. */
  nextTrack(): Promise<void>;
  /** Jump straight back to what is on air right now. */
  goLive(): Promise<void>;
  /** Show and play a specific entry of the on-air log, e.g. from the history list. */
  jumpToTrack(index: number): Promise<void>;
  refreshCatalog(): Promise<void>;

  setView(view: ViewId): void;
  setQuery(query: string): void;
  setGenreFilter(id: number | null): void;
  setSort(sort: SortId): void;
  toggleFavorite(prefix: string): Promise<void>;
  setExpanded(open: boolean): void;
  setSettingsOpen(open: boolean): void;
  toggleSidebar(): void;
  setMaximized(value: boolean): void;

  setVolume(volume: number): Promise<void>;
  nudgeVolume(delta: number): Promise<void>;
  toggleMute(): Promise<void>;
  setQuality(quality: PersistedSettings["quality"]): Promise<void>;
  setTheme(theme: PersistedSettings["theme"]): Promise<void>;
  setCrossfade(ms: number): Promise<void>;
  patchSettings(patch: Partial<PersistedSettings>): Promise<PersistedSettings>;

  startSleepTimer(minutes: number): void;
  cancelSleepTimer(): void;

  pushToast(message: string, tone?: Toast["tone"]): void;
  dismissToast(id: number): void;

  handleShortcut(action: string): void;
  handleTrayCommand(command: string, payload?: unknown): void;
  refreshHistory(stationId: number): Promise<void>;
}

export type Store = AppState & AppActions;

/**
 * Stable empty array used as a selector fallback.
 *
 * Zustand v5 compares selector results by reference; returning a fresh `[]`
 * from a selector makes every snapshot look changed, which drives React into an
 * infinite re-render loop (React error #185).
 */
const NO_FAVORITES: readonly string[] = Object.freeze([]);
const NO_RECENTS: readonly string[] = Object.freeze([]);

/* --------------------------------------------------------------- engine */

let engine: RadioEngine | null = null;
let toastSeq = 0;
let historyPollTimer: ReturnType<typeof setInterval> | null = null;
let lastNotifiedTrackId: number | null = null;

function getEngine(): RadioEngine {
  if (engine) return engine;
  engine = new RadioEngine({
    resolveUrl: (station, bitrate) =>
      window.recordMini.player.streamUrl(station.prefix, bitrate ?? null),
    resolvePreviewUrl: (upstream) => window.recordMini.player.previewUrl(upstream),
    onStatus: ({ status, error, bitrateKbps }) => {
      useStore.setState({
        status,
        error,
        signalKbps: status === "playing" ? (bitrateKbps ?? useStore.getState().signalKbps) : null,
      });
    },
    onPreviewEnded: () => {
      // An excerpt is only ~30s long. Handing the radio back keeps the audio
      // running instead of stopping dead on an invisible boundary.
      void useStore.getState().goLive();
    },
  });
  return engine;
}

const HISTORY_POLL_MS = 15000;

function stopHistoryPolling(): void {
  if (historyPollTimer) clearInterval(historyPollTimer);
  historyPollTimer = null;
}

function startHistoryPolling(stationId: number): void {
  stopHistoryPolling();
  void useStore.getState().refreshHistory(stationId);
  historyPollTimer = setInterval(() => {
    if (!useStore.getState().station) return;
    void useStore.getState().refreshHistory(stationId);
  }, HISTORY_POLL_MS);
}

function pushTrayState(): void {
  const state = useStore.getState();
  const { station, status, track, settings, stations, view, query, genreFilter } = state;
  const titles = new Map(stations.map((s) => [s.prefix, s.title]));
  const playing = status === "playing" || status === "buffering" || status === "connecting";
  const list = visibleStations({ stations, view, query, genreFilter, settings });
  void window.recordMini.tray.setMenu({
    playing,
    stationTitle: station?.title ?? null,
    trackLabel: track ? `${track.artist} — ${track.song}` : null,
    favorites: (settings?.favorites ?? []).map((prefix) => ({
      prefix,
      title: titles.get(prefix) ?? prefix,
    })),
    hasPrev: list.length > 1,
    hasNext: list.length > 1,
  });
  void window.recordMini.tray.setPlaying(playing);
}

function notifyTrackChange(track: AirplayTrack, station: Station): void {
  const state = useStore.getState();
  if (!state.settings?.notificationsOnTrackChange) return;
  if (lastNotifiedTrackId === track.id) return;
  lastNotifiedTrackId = track.id;
  void window.recordMini.system.notify(
    station.title,
    `${track.artist} — ${track.song}`,
    track.image,
  );
}

/* ---------------------------------------------------------------- store */

export const useStore = create<Store>((set, get) => ({
  stations: [],
  genres: [],
  catalogState: "loading",
  catalogError: null,

  settings: null,

  view: "channels",
  query: "",
  genreFilter: null,
  sort: "site",
  maximized: false,
  expandedPlayer: false,
  settingsOpen: false,
  sidebarOpen: true,

  station: null,
  status: "idle",
  error: null,
  signalKbps: null,
  track: null,
  history: [],
  historyStationId: null,
  historyLoading: false,
  trackCursor: 0,
  previewTrackId: null,

  sleepTimerEndsAt: null,
  toasts: [],

  /* ------------------------------------------------------------- startup */

  async init() {
    const settings = await window.recordMini.settings.get();
    set({ settings });

    const e = getEngine();
    e.setVolume(settings.volume, settings.muted);
    e.setCrossfade(settings.crossfadeMs);

    applyTheme(settings.theme);

    try {
      const stations = await window.recordMini.stations.bundled();
      set({ stations, genres: deriveGenres(stations), catalogState: "ready" });
    } catch (err) {
      set({ catalogState: "error", catalogError: String(err) });
    }

    // Refresh from the site in the background so the list stays current.
    void get().refreshCatalog();

    const last = settings.lastStation
      ? get().stations.find((s) => s.prefix === settings.lastStation)
      : undefined;
    if (last && !settings.startMinimized) await get().playStation(last);
    else set({ status: "idle" });

    window.recordMini.window.onMaximizeChange((maximized) => set({ maximized }));
    window.recordMiniEvents.onStreamStatus(({ status, error, bitrateKbps }) => {
      set({ status, error, signalKbps: status === "playing" ? (bitrateKbps ?? null) : null });
      pushTrayState();
    });
    window.recordMini.tray.onCommand((command, payload) =>
      get().handleTrayCommand(command, payload),
    );
    window.recordMini.shortcuts.onTrigger((action) => get().handleShortcut(action));
  },

  async refreshCatalog() {
    try {
      const stations = await window.recordMini.stations.refresh();
      if (!stations.length) return;
      const current = get().station;
      const stillThere = current ? stations.find((s) => s.prefix === current.prefix) : null;
      set({
        stations,
        genres: deriveGenres(stations),
        catalogState: "ready",
        catalogError: null,
        // keep the live object in sync so volume/bitrate choices stay correct
        station: stillThere ?? (current ?? null),
      });
    } catch (err) {
      set({ catalogState: "error", catalogError: String(err) });
    }
  },

  /* ------------------------------------------------------------ playback */

  async playStation(station) {
    const { settings, station: current } = get();
    const switching = current?.prefix !== station.prefix;
    if (!switching && get().status === "playing") return;

    set({
      station,
      error: null,
      track: switching ? null : get().track,
      trackCursor: switching ? 0 : get().trackCursor,
      previewTrackId: switching ? null : get().previewTrackId,
    });

    const bitrate = resolveBitrate(settings?.quality ?? "auto", station);
    const e = getEngine();
    e.setCrossfade(settings?.crossfadeMs ?? 600);
    await e.select(station, true, bitrate);

    if (switching) {
      lastNotifiedTrackId = null;
      startHistoryPolling(station.id);
      void get().patchSettings({ lastStation: station.prefix });
      touchRecents(station.prefix);
    }
    pushTrayState();
  },

  async togglePlay() {
    const { station, status } = get();
    if (!station) {
      const first = firstStation(get().stations, get().settings?.favorites ?? []);
      if (first) await get().playStation(first);
      return;
    }
    if (status === "playing" || status === "buffering" || status === "connecting") {
      getEngine().pause();
    } else {
      await getEngine().play();
    }
    pushTrayState();
  },

  stop() {
    stopHistoryPolling();
    getEngine().stop();
    set({
      station: null,
      track: null,
      history: [],
      historyStationId: null,
      trackCursor: 0,
      previewTrackId: null,
      signalKbps: null,
    });
    pushTrayState();
  },

  async nextStation(direction) {
    const { stations, view, query, genreFilter, station } = get();
    const list = visibleStations({ stations, view, query, genreFilter, settings: get().settings });
    if (!list.length) return;
    const index = list.findIndex((s) => s.prefix === station?.prefix);
    const nextIndex = index < 0 ? 0 : (index + direction + list.length) % list.length;
    await get().playStation(list[nextIndex]);
  },

  /* --------------------------------------------------- track navigation */

  /**
   * Steps through the channel's on-air log.
   *
   * `history[0]` is the live track and every later index is older, so
   * "previous" grows the cursor. An older track plays its preview excerpt; the
   * newest one hands the stream back.
   */
  async prevTrack() {
    await stepTrackCursor(get, 1);
  },

  async nextTrack() {
    await stepTrackCursor(get, -1);
  },

  async goLive() {
    const { history } = get();
    set({ trackCursor: 0, track: history[0] ?? null, previewTrackId: null });
    await getEngine().resumeLive();
    pushTrayState();
  },

  /**
   * Selects an entry of the on-air log and plays it.
   *
   * The live stream cannot be rewound, so an older track is heard through the
   * ~30s excerpt the on-air API ships for it. Tracks the API has no excerpt for
   * still move the display, they just cannot make a sound.
   */
  async jumpToTrack(index) {
    const { history } = get();
    const track = history[index];
    if (!track) return;
    // The newest entry is the radio itself, not a clip to play.
    if (index <= 0) {
      await get().goLive();
      return;
    }

    set({ trackCursor: index, track });
    const station = get().station;
    if (!station || !track.previewUrl) {
      set({ previewTrackId: null });
      if (station) get().pushToast("У этого трека нет фрагмента для прослушивания", "info");
      return;
    }

    set({ previewTrackId: track.id });
    try {
      await getEngine().playPreview(track.id, track.previewUrl, true);
    } catch (err) {
      set({ previewTrackId: null });
      get().pushToast(
        err instanceof Error ? err.message : "Не удалось загрузить фрагмент трека",
        "error",
      );
    }
    pushTrayState();
  },

  /* ---------------------------------------------------------------- view */

  setView: (view) => set({ view, expandedPlayer: false }),
  setQuery: (query) => set({ query }),
  setGenreFilter: (genreFilter) => set({ genreFilter }),
  setSort: (sort) => set({ sort }),
  setExpanded: (expandedPlayer) => set({ expandedPlayer }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setMaximized: (maximized) => set({ maximized }),

  async toggleFavorite(prefix) {
    const settings = get().settings;
    if (!settings) return;
    const favorites = settings.favorites.includes(prefix)
      ? settings.favorites.filter((p) => p !== prefix)
      : [prefix, ...settings.favorites];
    await get().patchSettings({ favorites });
    const station = get().stations.find((s) => s.prefix === prefix);
    get().pushToast(
      favorites.includes(prefix)
        ? `«${station?.shortTitle ?? prefix}» в избранном`
        : `«${station?.shortTitle ?? prefix}» удалён из избранного`,
      "success",
    );
    pushTrayState();
  },

  /* ------------------------------------------------------------ settings */

  async setVolume(volume) {
    const settings = await get().patchSettings({ volume });
    getEngine().setVolume(settings.volume, settings.muted);
  },

  async nudgeVolume(delta) {
    const current = get().settings?.volume ?? 0.8;
    await get().setVolume(Math.max(0, Math.min(1, Math.round((current + delta) * 100) / 100)));
  },

  async toggleMute() {
    const settings = await get().patchSettings({ muted: !get().settings?.muted });
    getEngine().setVolume(settings.volume, settings.muted);
  },

  async setQuality(quality) {
    const settings = await get().patchSettings({ quality });
    const station = get().station;
    // Reconnect the live stream so the new rung takes effect immediately.
    if (station && get().status !== "idle") {
      await getEngine().select(station, true, resolveBitrate(quality, station));
      pushTrayState();
    }
    void settings;
  },

  async setTheme(theme) {
    await get().patchSettings({ theme });
    applyTheme(theme);
  },

  async setCrossfade(ms) {
    await get().patchSettings({ crossfadeMs: ms });
    getEngine().setCrossfade(ms);
  },

  async patchSettings(patch) {
    const settings = await window.recordMini.settings.set(patch);
    set({ settings });
    if (patch.theme) applyTheme(patch.theme);
    return settings;
  },

  /* -------------------------------------------------------- sleep timer */

  startSleepTimer(minutes) {
    get().cancelSleepTimer();
    const endsAt = Date.now() + minutes * 60_000;
    set({ sleepTimerEndsAt: endsAt });
    get().pushToast(`Таймер сна: ${minutes} мин`);
    const tick = setInterval(() => {
      if (useStore.getState().sleepTimerEndsAt !== endsAt) {
        clearInterval(tick);
        return;
      }
      if (Date.now() >= endsAt) {
        clearInterval(tick);
        useStore.setState({ sleepTimerEndsAt: null });
        const e = engine;
        if (e) {
          e.pause();
        }
        useStore.getState().pushToast("Таймер сна: воспроизведение остановлено");
        pushTrayState();
      }
    }, 1000);
  },

  cancelSleepTimer() {
    set({ sleepTimerEndsAt: null });
  },

  /* -------------------------------------------------------------- toasts */

  pushToast(message, tone = "info") {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, message, tone }] }));
    setTimeout(() => get().dismissToast(id), 3600);
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  /* -------------------------------------------------------- OS integration */

  handleShortcut(action) {
    switch (action) {
      case "play-pause":
        void get().togglePlay();
        break;
      case "next-channel":
        void get().nextStation(1);
        break;
      case "prev-channel":
        void get().nextStation(-1);
        break;
      case "next-track":
        get().nextTrack();
        break;
      case "prev-track":
        get().prevTrack();
        break;
      case "volume-up":
        void get().nudgeVolume(0.05);
        break;
      case "volume-down":
        void get().nudgeVolume(-0.05);
        break;
      case "mute-toggle":
        void get().toggleMute();
        break;
      default:
        break;
    }
  },

  handleTrayCommand(command, payload) {
    if (command === "play-pause") {
      void get().togglePlay();
      return;
    }
    if (command === "next-channel") {
      void get().nextStation(1);
      return;
    }
    if (command === "prev-channel") {
      void get().nextStation(-1);
      return;
    }
    if (command === "play-station" && typeof payload === "string") {
      const station = get().stations.find((s) => s.prefix === payload);
      if (station) void get().playStation(station);
    }
  },

  /* -------------------------------------------------------------- history */

  async refreshHistory(stationId) {
    if (useStore.getState().historyLoading) return;
    set({ historyLoading: true });
    try {
      const history = await window.recordMini.onAir.history(stationId);
      const state = useStore.getState();
      const previous = state.history[0]?.id ?? null;

      // The log is newest-first, so every track slides down one slot when a song
      // ends. Someone reading back through it should stay on the same song
      // rather than be yanked forward to live.
      const pinned = state.trackCursor > 0 ? state.track?.id ?? null : null;
      // A track the listener is parked on can age out of the window entirely.
      const stillThere = pinned ? history.some((t) => t.id === pinned) : false;
      const cursor = pinned && stillThere ? history.findIndex((t) => t.id === pinned) : 0;
      const current = history[0] ?? null;

      set({
        history,
        historyStationId: stationId,
        historyLoading: false,
        trackCursor: cursor,
        track: history[cursor] ?? current,
      });

      if (current) {
        const station = state.station;
        if (station) notifyTrackChange(current, station);
        if (previous && previous !== current.id) pushTrayState();
      }

      // The pinned entry is gone from the log, so its excerpt is the only thing
      // left to describe the selection. Hand the radio back rather than show a
      // live track while a stale clip is still playing.
      if (pinned && !stillThere) {
        set({ previewTrackId: null });
        await useStore.getState().goLive();
      }
    } catch {
      set({ historyLoading: false });
    }
  },
}));

/* ------------------------------------------------------------- helpers */

/**
 * Moves the on-air log cursor and keeps `track` in sync with it.
 *
 * @param delta index step; `1` is older (back in time), `-1` is newer,
 *              `-Infinity` snaps to the live track at the head of the log.
 */
async function stepTrackCursor(get: () => Store, delta: number): Promise<void> {
  const { history, trackCursor } = get();
  if (history.length < 2) return;
  const next = Math.min(history.length - 1, Math.max(0, trackCursor + delta));
  if (next === trackCursor) return;
  await get().jumpToTrack(next);
}

/** Favourite station prefixes, with a reference-stable empty fallback. */
export function useFavorites(): readonly string[] {
  return useStore((s) => s.settings?.favorites ?? NO_FAVORITES);
}

/** Recently played station prefixes, with a reference-stable empty fallback. */
export function useRecents(): readonly string[] {
  return useStore((s) => s.settings?.recents ?? NO_RECENTS);
}

export function applyTheme(theme: PersistedSettings["theme"]): void {
  const prefersLight =
    theme === "light" ||
    (theme === "system" && window.matchMedia?.("(prefers-color-scheme: light)").matches);
  document.documentElement.dataset.theme = prefersLight ? "light" : "dark";
}

function deriveGenres(stations: Station[]): Genre[] {
  const map = new Map<number, Genre>();
  for (const s of stations) {
    for (const g of s.genres) {
      const existing = map.get(g.id);
      if (!existing) map.set(g.id, { ...g });
      else if (g.detailPicture && !existing.detailPicture) existing.detailPicture = g.detailPicture;
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

function touchRecents(prefix: string): void {
  const { settings } = useStore.getState();
  if (!settings) return;
  const recents = [prefix, ...settings.recents.filter((p) => p !== prefix)].slice(0, 20);
  void useStore.getState().patchSettings({ recents });
}

/** The single source of truth for what the grid shows. */
export function visibleStations(args: {
  stations: Station[];
  view: ViewId;
  query: string;
  genreFilter: number | null;
  settings: PersistedSettings | null;
}): Station[] {
  const { stations, view, query, genreFilter, settings } = args;
  let list = stations;

  if (view === "favorites") {
    const favs = settings?.favorites ?? [];
    const rank = new Map(favs.map((p, i) => [p, i]));
    list = list.filter((s) => rank.has(s.prefix)).sort((a, b) => rank.get(a.prefix)! - rank.get(b.prefix)!);
  } else if (view === "recent") {
    const recents = settings?.recents ?? [];
    const rank = new Map(recents.map((p, i) => [p, i]));
    list = list.filter((s) => rank.has(s.prefix)).sort((a, b) => rank.get(a.prefix)! - rank.get(b.prefix)!);
  }

  if (genreFilter !== null) {
    list = list.filter((s) => s.genres.some((g) => g.id === genreFilter));
  }

  if (query.trim()) {
    const scored = list
      .map((s) => ({ s, score: scoreStation(s, query.trim()) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score);
    return scored.map((x) => x.s);
  }

  return list;
}

export function sortStations(list: Station[], sort: SortId): Station[] {
  const copy = [...list];
  if (sort === "title") return copy.sort((a, b) => a.title.localeCompare(b.title, "ru"));
  if (sort === "genre") {
    return copy.sort((a, b) => {
      const ga = a.genres[0]?.name ?? "";
      const gb = b.genres[0]?.name ?? "";
      const cmp = ga.localeCompare(gb, "ru");
      return cmp !== 0 ? cmp : a.title.localeCompare(b.title, "ru");
    });
  }
  return copy;
}

function firstStation(stations: Station[], favorites: string[]): Station | null {
  const fav = favorites
    .map((p) => stations.find((s) => s.prefix === p))
    .find((s): s is Station => Boolean(s));
  return fav ?? stations[0] ?? null;
}
