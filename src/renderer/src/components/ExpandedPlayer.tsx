import { useEffect } from "react";
import { X, Heart, Pause, Play, ExternalLink, Share2, Disc3, Loader2 } from "lucide-react";
import { useStore, useFavorites } from "../state/store";
import { formatAirTime, formatRelative } from "../lib/format";
import { ChannelLogo } from "./ChannelLogo";

export function ExpandedPlayer(): JSX.Element | null {
  const open = useStore((s) => s.expandedPlayer);
  const setExpanded = useStore((s) => s.setExpanded);
  const station = useStore((s) => s.station);
  const track = useStore((s) => s.track);
  const status = useStore((s) => s.status);
  const signalKbps = useStore((s) => s.signalKbps);
  const favorites = useFavorites();
  const togglePlay = useStore((s) => s.togglePlay);
  const toggleFavorite = useStore((s) => s.toggleFavorite);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
      if (e.code === "Space" && !isTypingTarget(e.target)) {
        e.preventDefault();
        void togglePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setExpanded, togglePlay]);

  if (!open || !station) return null;

  const busy = status === "connecting" || status === "buffering" || status === "reconnecting";
  const playing = status === "playing";
  const isFavorite = favorites.includes(station.prefix);

  return (
    <div
      className="expanded"
      role="dialog"
      aria-modal="true"
      aria-label={`Сейчас играет: ${station.title}`}
      onClick={() => setExpanded(false)}
    >
      <button
        className="icon-btn expanded__close"
        onClick={(e) => {
          e.stopPropagation();
          setExpanded(false);
        }}
        aria-label="Закрыть"
      >
        <X size={20} />
      </button>

      <div className="expanded__inner" onClick={(e) => e.stopPropagation()}>
        <div className="expanded__art">
          <ChannelLogo svg={station.logoSvg} banner={station.image} iconSize={64} />
        </div>

        <div className="expanded__info">
          <div className="expanded__kicker">
            <span className="dot-live" aria-hidden="true" />
            {playing ? "В эфире" : busy ? "Подключение" : "Пауза"} · {station.title}
          </div>

          <h2 className="expanded__title">
            {track ? track.song || track.artist : station.title}
          </h2>
          <p className="expanded__artist">{track ? track.artist : station.tooltip}</p>

          <div className="expanded__facts">
            {track?.airTimeLabel ? (
              <span className="chip">
                <Disc3 size={12} /> В эфире с {formatAirTime(track.airTimeLabel)}
              </span>
            ) : null}
            {track?.airTime ? (
              <span className="chip chip--genre">{formatRelative(track.airTime)}</span>
            ) : null}
            {signalKbps ? (
              <span className="chip chip--genre">{signalKbps} кбит/с</span>
            ) : null}
            {station.genres.map((g) => (
              <span key={g.id} className="chip chip--genre">
                {g.name}
              </span>
            ))}
          </div>

          <div className="expanded__actions">
            <button className="transport__play" onClick={() => void togglePlay()} aria-label={playing ? "Пауза" : "Играть"}>
              {busy ? (
                <Loader2 size={22} className="spin" />
              ) : playing ? (
                <Pause size={22} fill="currentColor" />
              ) : (
                <Play size={22} fill="currentColor" />
              )}
            </button>

            <button
              className={`btn btn--outline${isFavorite ? " icon-btn--active" : ""}`}
              onClick={() => void toggleFavorite(station.prefix)}
            >
              <Heart size={16} fill={isFavorite ? "currentColor" : "none"} />
              {isFavorite ? "В избранном" : "В избранное"}
            </button>

            {track?.shareUrl ? (
              <button
                className="btn btn--outline"
                onClick={() => void window.recordMini.system.openExternal(track.shareUrl!)}
              >
                <ExternalLink size={16} />
                Трек на сайте
              </button>
            ) : null}

            <button
              className="btn btn--outline"
              onClick={() => void window.recordMini.system.openExternal(station.pageUrl)}
            >
              <Share2 size={16} />
              Страница канала
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true
  );
}
