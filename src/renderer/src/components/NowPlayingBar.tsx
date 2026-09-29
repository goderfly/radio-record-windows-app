import { useRef, useState, useEffect } from "react";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  Maximize2,
  Heart,
  Gauge,
  Timer,
  Loader2,
  Check,
} from "lucide-react";
import type { QualityPreference } from "@shared/types";
import { useStore, useFavorites } from "../state/store";
import { formatAirTime } from "../lib/format";
import { useDismiss } from "./TitleBar";
import { ChannelLogo } from "./ChannelLogo";

const QUALITY_LABEL: Record<QualityPreference, string> = {
  auto: "Авто (макс.)",
  high: "Высокое",
  medium: "Среднее",
  low: "Низкое",
};

const SLEEP_OPTIONS = [15, 30, 45, 60, 90, 120];

export function NowPlayingBar(): JSX.Element {
  const station = useStore((s) => s.station);
  const track = useStore((s) => s.track);
  const status = useStore((s) => s.status);
  const error = useStore((s) => s.error);
  const signalKbps = useStore((s) => s.signalKbps);
  const favorites = useFavorites();
  const togglePlay = useStore((s) => s.togglePlay);
  const history = useStore((s) => s.history);
  const trackCursor = useStore((s) => s.trackCursor);
  const previewTrackId = useStore((s) => s.previewTrackId);
  const prevTrack = useStore((s) => s.prevTrack);
  const nextTrack = useStore((s) => s.nextTrack);
  const goLive = useStore((s) => s.goLive);
  const toggleFavorite = useStore((s) => s.toggleFavorite);
  const setExpanded = useStore((s) => s.setExpanded);

  const busy = status === "connecting" || status === "buffering" || status === "reconnecting";
  const playing = status === "playing";
  // A log entry is heard through its ~30s excerpt rather than the stream, so
  // the "back to live" affordance has to say which of the two is loaded.
  const onExcerpt = previewTrackId !== null;

  return (
    <footer className="nowbar" aria-label="Плеер">
      <button
        className="nowbar__art"
        onClick={() => station && setExpanded(true)}
        aria-label="Открыть подробности"
        disabled={!station}
      >
        <ChannelLogo svg={station?.logoSvg} banner={station?.image} />
        <span className="nowbar__art-expand">
          <Maximize2 size={18} />
        </span>
      </button>

      <div className="nowbar__meta">
        <div className="nowbar__title" title={station?.title}>
          {station ? (
            <>
              {playing || busy ? (
                <span className={`eq${playing ? "" : " eq--paused"}`} aria-hidden="true">
                  <span />
                  <span />
                  <span />
                  <span />
                </span>
              ) : null}
              <span className="truncate">{station.title}</span>
            </>
          ) : (
            <span className="truncate muted">Канал не выбран</span>
          )}
        </div>
        <div className="nowbar__sub">
          {track ? (
            <>
              {trackCursor > 0 ? (
                <span className="dot-archive" aria-hidden="true" />
              ) : (
                <span className="dot-live" aria-hidden="true" />
              )}
              <a
                className="truncate"
                href={track.shareUrl ?? "https://radiorecord.ru"}
                onClick={(e) => {
                  e.preventDefault();
                  void window.recordMini.system.openExternal(track.shareUrl ?? "https://radiorecord.ru");
                }}
                title="Открыть трек на radiorecord.ru"
              >
                {track.artist}
                {track.song ? ` — ${track.song}` : ""}
              </a>
            </>
          ) : error ? (
            <span className="truncate" style={{ color: "var(--status-error)" }}>
              {error}
            </span>
          ) : station ? (
            <span className="truncate">{station.tooltip}</span>
          ) : (
            <span className="truncate muted">Выберите канал из списка</span>
          )}
        </div>
      </div>

      <div className="transport">
        <button
          className="icon-btn"
          onClick={() => void prevTrack()}
          disabled={!station || trackCursor >= history.length - 1}
          aria-label="Предыдущая песня в эфире"
          title="Предыдущая песня, которая играла на канале"
        >
          <SkipBack size={19} fill="currentColor" />
        </button>
        <button
          className="transport__play"
          onClick={() => void togglePlay()}
          aria-label={playing ? "Пауза" : "Воспроизвести"}
          title={playing ? "Пауза" : "Слушать"}
        >
          {busy ? (
            <Loader2 size={22} className="spin" />
          ) : playing ? (
            <Pause size={22} fill="currentColor" />
          ) : (
            <Play size={22} fill="currentColor" />
          )}
        </button>
        <button
          className="icon-btn"
          onClick={() => void nextTrack()}
          disabled={!station || trackCursor === 0}
          aria-label="Следующая песня в эфире"
          title={trackCursor === 0 ? "Это то, что играет сейчас" : "Вернуться к текущей песне"}
        >
          <SkipForward size={19} fill="currentColor" />
        </button>
        {station ? (
          <button
            className={`icon-btn${favorites.includes(station.prefix) ? " icon-btn--active" : ""}`}
            onClick={() => void toggleFavorite(station.prefix)}
            aria-label="В избранное"
            aria-pressed={favorites.includes(station.prefix)}
          >
            <Heart
              size={18}
              fill={favorites.includes(station.prefix) ? "currentColor" : "none"}
            />
          </button>
        ) : null}
      </div>

      <div className="nowbar__center">
        <div className="nowbar__time">
          {trackCursor > 0 ? (
            <button
              className="live-chip"
              onClick={() => void goLive()}
              title="Вернуться к тому, что играет прямо сейчас"
            >
              {onExcerpt ? "Фрагмент — в эфир" : "В эфире — вернуться"}
            </button>
          ) : (
            <span>{track?.airTimeLabel ? formatAirTime(track.airTimeLabel) : "--:--"}</span>
          )}
          {/* A clip is a file, not a stream: there is no throughput to show. */}
          <SignalIndicator kbps={signalKbps} status={status} hidden={onExcerpt} />
          {status === "reconnecting" ? (
            <span className="muted">· переподключение…</span>
          ) : null}
          {status === "error" ? (
            <span style={{ color: "var(--status-error)" }}>· ошибка</span>
          ) : null}
        </div>
      </div>

      <div className="nowbar__right">
        <SleepTimerMenu />
        <QualityMenu />
        <VolumeControl />
      </div>
    </footer>
  );
}

/* ------------------------------------------------------------- volume */

function VolumeControl(): JSX.Element {
  const volume = useStore((s) => s.settings?.volume ?? 0.8);
  const muted = useStore((s) => s.settings?.muted ?? false);
  const setVolume = useStore((s) => s.setVolume);
  const toggleMute = useStore((s) => s.toggleMute);

  const percent = muted ? 0 : Math.round(volume * 100);

  return (
    <div className="row">
      <button
        className="icon-btn"
        onClick={() => void toggleMute()}
        aria-label={muted ? "Включить звук" : "Выключить звук"}
        title={muted ? "Включить звук" : "Выключить звук"}
      >
        {muted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
      </button>
      <div className="slider">
        <div className="slider__track">
          <div className="slider__fill" style={{ width: `${percent}%` }} />
        </div>
        <input
          type="range"
          min={0}
          max={100}
          value={percent}
          onChange={(e) => void setVolume(Number(e.target.value) / 100)}
          aria-label="Громкость"
          title={`Громкость ${percent}%`}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ quality */

function QualityMenu(): JSX.Element {
  const quality = useStore((s) => s.settings?.quality ?? "auto");
  const setQuality = useStore((s) => s.setQuality);
  const station = useStore((s) => s.station);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);

  const available = station?.sources.map((s) => s.bitrate) ?? [];

  return (
    <div className="menu-anchor" ref={ref}>
      <button
        className="icon-btn"
        onClick={() => setOpen((v) => !v)}
        aria-label="Качество потока"
        title={`Качество потока: ${QUALITY_LABEL[quality]}`}
        aria-expanded={open}
      >
        <Gauge size={18} />
      </button>
      {open ? (
        <div className="menu" role="menu">
          <div className="menu__label">Качество потока</div>
          {(Object.keys(QUALITY_LABEL) as QualityPreference[]).map((id) => (
            <button
              key={id}
              className={`menu__item${quality === id ? " menu__item--active" : ""}`}
              role="menuitemradio"
              aria-checked={quality === id}
              onClick={() => {
                void setQuality(id);
                setOpen(false);
              }}
            >
              {QUALITY_LABEL[id]}
              {quality === id ? <Check size={14} className="menu__check" /> : null}
            </button>
          ))}
          {available.length ? (
            <>
              <div className="menu__sep" />
              <div className="menu__label">
                Доступно: {available.sort((a, b) => a - b).join(" / ")} кбит/с
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------- sleep timer */

function SleepTimerMenu(): JSX.Element {
  const endsAt = useStore((s) => s.sleepTimerEndsAt);
  const startSleepTimer = useStore((s) => s.startSleepTimer);
  const cancelSleepTimer = useStore((s) => s.cancelSleepTimer);
  const [open, setOpen] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);

  useEffect(() => {
    if (!endsAt) {
      setRemaining(0);
      return;
    }
    const tick = () => setRemaining(Math.max(0, Math.ceil((endsAt - Date.now()) / 60000)));
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, [endsAt]);

  return (
    <div className="menu-anchor" ref={ref}>
      <button
        className={`icon-btn${endsAt ? " icon-btn--active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-label="Таймер сна"
        title={endsAt ? `Таймер сна: ещё ${remaining} мин` : "Таймер сна"}
        aria-expanded={open}
      >
        <Timer size={18} />
      </button>
      {open ? (
        <div className="menu" role="menu">
          <div className="menu__label">Таймер сна</div>
          {SLEEP_OPTIONS.map((minutes) => (
            <button
              key={minutes}
              className="menu__item"
              role="menuitem"
              onClick={() => {
                startSleepTimer(minutes);
                setOpen(false);
              }}
            >
              Через {minutes} мин
            </button>
          ))}
          {endsAt ? (
            <>
              <div className="menu__sep" />
              <button
                className="menu__item"
                role="menuitem"
                onClick={() => {
                  cancelSleepTimer();
                  setOpen(false);
                }}
              >
                Выключить таймер
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------- signal */

function SignalIndicator({
  kbps,
  status,
  hidden,
}: {
  kbps: number | null;
  status: string;
  hidden?: boolean;
}): JSX.Element {
  const level =
    status !== "playing" || !kbps ? "none" : kbps >= 60 ? "good" : "weak";
  const label =
    status !== "playing" ? "нет сигнала" : kbps ? `сигнал ${kbps} кбит/с` : "сигнал";
  if (hidden) return <></>;
  return (
    <span className={`nowbar__signal nowbar__signal--${level}`} title={label} aria-label={label}>
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}
