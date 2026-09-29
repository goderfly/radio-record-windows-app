import Hls from "hls.js";
import type { PlaybackStatus, Station } from "@shared/types";

export interface EngineStatus {
  status: PlaybackStatus;
  error: string | null;
  bitrateKbps: number | null;
}

export interface EngineOptions {
  /** Resolves a playable URL for a station (loopback proxy in production). */
  resolveUrl: (station: Station, bitrate: number | null) => Promise<string>;
  /** Resolves a playable URL for a track's preview clip. */
  resolvePreviewUrl: (upstream: string) => Promise<string>;
  /** Called whenever playback state changes. */
  onStatus: (status: EngineStatus) => void;
  /** A preview clip ran to its end (it is only ~30s long). */
  onPreviewEnded?: (trackId: number) => void;
  /** Fall back to the HLS rendition when the progressive stream keeps failing. */
  enableHlsFallback?: boolean;
}

const MAX_BACKOFF_MS = 15000;
const STABLE_PLAYBACK_MS = 10000;

function ramp(el: HTMLAudioElement, from: number, to: number, ms: number): Promise<void> {
  if (ms <= 0) {
    el.volume = to;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      // equal-power-ish curve sounds better than linear for fades
      el.volume = Math.max(0, Math.min(1, from + (to - from) * t));
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

/**
 * Plays a live ICY/HLS stream.
 *
 * Two media elements are used so switching stations can crossfade, and a failed
 * stream transparently falls back to the HLS rendition (and then retries with
 * exponential backoff) — live radio drops connections constantly.
 */
export class RadioEngine {
  private readonly els: [HTMLAudioElement, HTMLAudioElement];
  private activeIndex: 0 | 1 = 0;
  private options: EngineOptions;
  private station: Station | null = null;
  private wantPlaying = false;
  private bitrate: number | null = null;
  private hls: Hls | null = null;
  private usingHls = false;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private loadToken = 0;
  private crossfadeMs = 600;
  private masterVolume = 0.8;
  private masterMuted = false;
  private destroyed = false;
  /**
   * Set while a preview clip is loaded instead of the live stream. The two
   * sources behave very differently: the stream is infinite and wants retries
   * and an HLS fallback, the clip is a finite file where neither applies.
   */
  private preview: { trackId: number; upstream: string } | null = null;

  constructor(options: EngineOptions) {
    this.options = options;
    this.els = [new Audio(), new Audio()];
    for (const el of this.els) {
      el.preload = "none";
      el.autoplay = false;
      el.volume = 0;
      el.crossOrigin = "anonymous";
    }
    this.attachListeners(this.els[0], 0);
    this.attachListeners(this.els[1], 1);
  }

  private get active(): HTMLAudioElement {
    return this.els[this.activeIndex];
  }

  private get idle(): HTMLAudioElement {
    return this.els[this.activeIndex === 0 ? 1 : 0];
  }

  private attachListeners(el: HTMLAudioElement, index: 0 | 1): void {
    el.addEventListener("playing", () => {
      if (this.destroyed || index !== this.activeIndex) return;
      this.clearRetry();
      this.armStableTimer();
      this.report({ status: "playing", error: null });
    });
    el.addEventListener("waiting", () => {
      if (this.destroyed || index !== this.activeIndex) return;
      this.report({ status: "buffering", error: null });
    });
    el.addEventListener("stalled", () => {
      if (this.destroyed || index !== this.activeIndex || !this.wantPlaying) return;
      this.report({ status: "buffering", error: null });
    });
    el.addEventListener("pause", () => {
      if (this.destroyed || index !== this.activeIndex || this.wantPlaying) return;
      this.report({ status: "idle", error: null });
    });
    el.addEventListener("error", () => {
      if (this.destroyed || index !== this.activeIndex || !this.wantPlaying) return;
      this.handleFailure();
    });
    el.addEventListener("ended", () => {
      if (this.destroyed || index !== this.activeIndex) return;
      // A live radio stream is not supposed to end; if one does, the error
      // handler above is the right response, not a "finished" callback.
      const trackId = this.preview?.trackId;
      if (!this.preview) return;
      this.wantPlaying = false;
      this.report({ status: "idle", error: null });
      this.options.onPreviewEnded?.(trackId ?? 0);
    });
  }

  private armStableTimer(): void {
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => {
      this.retries = 0; // a long healthy stretch resets the backoff
    }, STABLE_PLAYBACK_MS);
  }

  private report(partial: Partial<EngineStatus>): void {
    this.options.onStatus({
      status: partial.status ?? "idle",
      error: partial.error ?? null,
      bitrateKbps: partial.bitrateKbps ?? null,
    });
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /* ------------------------------------------------------------- loading */

  /** Loads (and, when `play` is set, starts) a station, crossfading if needed. */
  async select(station: Station, play: boolean, bitrate: number | null): Promise<void> {
    const changed = this.station?.prefix !== station.prefix;
    this.station = station;
    this.bitrate = bitrate;
    this.wantPlaying = play;
    // Anything that selects a station is by definition going back to the live
    // stream, so drop a loaded preview.
    this.preview = null;

    if (!changed && !play) {
      this.pause();
      return;
    }

    await this.loadInto(this.idle, station, bitrate);
    if (this.destroyed) return;
    await this.swapIn(play);
  }

  /**
   * Plays a track's preview clip in place of the live stream.
   *
   * This is what makes a row in the on-air log audible: the stream itself
   * cannot be rewound, so clicking an older track loads its ~30s excerpt
   * instead. `goLive` puts the radio back.
   */
  async playPreview(trackId: number, upstream: string, play: boolean): Promise<void> {
    // Nothing to play a clip over: there is no station to hand back to either.
    if (!this.station) return;

    const changed = this.preview?.trackId !== trackId;
    this.preview = { trackId, upstream };
    this.wantPlaying = play;

    if (!changed && !play) {
      this.pause();
      return;
    }

    const token = ++this.loadToken;
    const url = await this.options.resolvePreviewUrl(upstream);
    // The user may have clicked something else while the URL was resolving.
    if (this.destroyed || token !== this.loadToken) return;
    if (this.preview?.trackId !== trackId) return;

    this.loadUrlInto(this.idle, url);
    if (this.destroyed || this.preview?.trackId !== trackId) return;
    await this.swapIn(play);
  }

  /** Drops the preview and resumes the station's live stream. */
  async resumeLive(): Promise<void> {
    if (!this.preview) return;
    this.preview = null;
    const station = this.station;
    if (!station) return;
    await this.select(station, this.wantPlaying, this.bitrate);
  }

  /** Id of the track whose preview is loaded, or null while the radio is live. */
  get previewTrackId(): number | null {
    return this.preview ? this.preview.trackId : null;
  }

  /**
   * Makes the freshly loaded idle element the active one, crossfading from
   * whatever was playing before.
   */
  private async swapIn(play: boolean): Promise<void> {
    const outgoing = this.active;
    const wasPlaying = !outgoing.paused && outgoing.currentSrc !== "";
    this.activeIndex = this.activeIndex === 0 ? 1 : 0;
    const incoming = this.active;

    this.applyGain(incoming, this.masterMuted ? 0 : this.masterVolume);
    this.report({ status: "connecting", error: null });

    if (!play) {
      this.teardownElement(outgoing);
      this.report({ status: "idle", error: null });
      return;
    }

    try {
      await incoming.play();
    } catch (err) {
      // Autoplay can be refused until the user interacts with the page.
      this.report({ status: "error", error: describeError(err) });
      return;
    }
    if (this.crossfadeMs > 0 && wasPlaying) {
      void ramp(outgoing, outgoing.volume, 0, this.crossfadeMs).then(() => {
        this.teardownElement(outgoing);
      });
      void ramp(incoming, 0, this.masterMuted ? 0 : this.masterVolume, this.crossfadeMs);
    } else {
      this.teardownElement(outgoing);
    }
  }

  private async loadInto(el: HTMLAudioElement, station: Station, bitrate: number | null): Promise<void> {
    this.teardownElement(el);
    const token = ++this.loadToken;
    const url = await this.options.resolveUrl(station, bitrate);
    if (this.destroyed || token !== this.loadToken) return;
    this.usingHls = false;
    this.loadUrlInto(el, url);
  }

  /** Points a media element at `url` and warms the connection. */
  private loadUrlInto(el: HTMLAudioElement, url: string): void {
    this.teardownElement(el);
    el.src = url;
    el.load();
    // Warm the connection early so the first play is not gated on DNS/TLS.
    el.preload = "auto";
    void el.play().then(
      () => {
        if (!el.paused && this.destroyed) el.pause();
      },
      () => {
        /* the real play() below reports any genuine failure */
      },
    );
  }

  private teardownElement(el: HTMLAudioElement): void {
    this.hls?.destroy();
    this.hls = null;
    el.pause();
    el.removeAttribute("src");
    el.load();
  }

  /* ------------------------------------------------------------ transport */

  async play(): Promise<void> {
    if (!this.station) return;
    this.wantPlaying = true;
    if (!this.active.currentSrc) {
      await this.select(this.station, true, this.bitrate);
      return;
    }
    this.applyGain(this.active, this.masterMuted ? 0 : this.masterVolume);
    try {
      await this.active.play();
    } catch (err) {
      this.handleFailure(describeError(err));
    }
  }

  pause(): void {
    this.wantPlaying = false;
    this.clearRetry();
    this.active.pause();
    this.report({ status: "idle", error: null });
  }

  async toggle(): Promise<void> {
    if (this.wantPlaying) this.pause();
    else await this.play();
  }

  stop(): void {
    this.wantPlaying = false;
    this.clearRetry();
    for (const el of this.els) this.teardownElement(el);
    this.station = null;
    this.preview = null;
    this.report({ status: "idle", error: null });
  }

  /* --------------------------------------------------------------- audio */

  private applyGain(el: HTMLAudioElement, volume: number): void {
    el.volume = Math.max(0, Math.min(1, volume));
    el.muted = false; // gain is already folded into volume
  }

  setVolume(volume: number, muted: boolean): void {
    this.masterVolume = Math.max(0, Math.min(1, volume));
    this.masterMuted = muted;
    const target = this.masterMuted ? 0 : this.masterVolume;
    for (const el of this.els) {
      if (el === this.active && this.wantPlaying) this.applyGain(el, target);
      else this.applyGain(el, 0);
    }
  }

  setCrossfade(ms: number): void {
    this.crossfadeMs = Math.max(0, ms);
  }

  get position(): number | null {
    const el = this.active;
    return el.currentSrc ? el.currentTime : null;
  }

  get isPlaying(): boolean {
    return this.wantPlaying && !this.active.paused;
  }

  /* -------------------------------------------------------------- retry */

  private handleFailure(reason?: string): void {
    this.clearRetry();
    if (this.destroyed || !this.wantPlaying || !this.station) return;

    // A preview is a finite file, so there is no stream to reconnect to and no
    // HLS rendition to fall back to. Report and stop instead of retrying.
    if (this.preview) {
      this.wantPlaying = false;
      this.report({ status: "error", error: reason ?? "Не удалось загрузить фрагмент трека" });
      return;
    }

    // Progressive stream gave up: try the HLS rendition once.
    if (this.options.enableHlsFallback !== false && !this.usingHls && this.station.hlsUrl) {
      this.usingHls = true;
      this.report({ status: "reconnecting", error: reason ?? null });
      this.tryHlsFallback();
      return;
    }

    this.retries += 1;
    if (this.retries > 8) {
      this.report({ status: "error", error: "Не удалось подключиться к каналу" });
      return;
    }
    const delay = Math.min(MAX_BACKOFF_MS, 750 * 2 ** (this.retries - 1));
    this.report({ status: "reconnecting", error: reason ?? null });
    this.retryTimer = setTimeout(() => {
      void this.reconnect();
    }, delay);
  }

  private async reconnect(): Promise<void> {
    if (!this.station || this.destroyed) return;
    const station = this.station;
    await this.loadInto(this.active, station, this.bitrate);
    if (this.destroyed) return;
    try {
      await this.active.play();
    } catch (err) {
      this.handleFailure(describeError(err));
    }
  }

  private tryHlsFallback(): void {
    const station = this.station;
    if (!station?.hlsUrl) return;
    const el = this.active;
    this.teardownElement(el);

    if (Hls.isSupported()) {
      const hls = new Hls({
        lowLatencyMode: true,
        enableWorker: true,
        // The renditions are already tiny; keep latency low without extra buffer.
        backBufferLength: 30,
        maxBufferLength: 12,
      });
      this.hls = hls;
      hls.loadSource(station.hlsUrl);
      hls.attachMedia(el);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        void el.play().catch((err) => this.handleFailure(describeError(err)));
      });
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else this.handleFailure("HLS-поток недоступен");
      });
    } else if (el.canPlayType("application/vnd.apple.mpegurl")) {
      el.src = station.hlsUrl;
      void el.play().catch((err) => this.handleFailure(describeError(err)));
    } else {
      this.handleFailure("HLS не поддерживается");
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.clearRetry();
    if (this.stableTimer) clearTimeout(this.stableTimer);
    for (const el of this.els) this.teardownElement(el);
  }
}

function describeError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError") return "Нажмите «Play», чтобы начать воспроизведение";
    if (err.name === "AbortError") return "Воспроизведение прервано";
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return "Неизвестная ошибка воспроизведения";
}
