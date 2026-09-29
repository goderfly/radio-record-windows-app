import type { KeyboardEvent } from "react";
import { Heart, Play, Pause } from "lucide-react";
import type { Station } from "@shared/types";
import { useStore, useFavorites } from "../state/store";
import { ChannelLogo } from "./ChannelLogo";

export function StationCard({ station }: { station: Station }): JSX.Element {
  const current = useStore((s) => s.station);
  const isCurrent = current?.prefix === station.prefix;
  const isPlaying = useStore((s) => isCurrent && s.status === "playing");
  const favorites = useFavorites();
  const isFavorite = favorites.includes(station.prefix);
  const playStation = useStore((s) => s.playStation);
  const togglePlay = useStore((s) => s.togglePlay);
  const toggleFavorite = useStore((s) => s.toggleFavorite);
  const genreFilter = useStore((s) => s.genreFilter);
  const setGenreFilter = useStore((s) => s.setGenreFilter);

  const onPlay = () => {
    if (isCurrent && (isPlaying || useStore.getState().status === "buffering")) void togglePlay();
    else void playStation(station);
  };

  // The whole tile is the click target. Space/Enter must not also reach the
  // window-level shortcut in App.tsx, which would toggle playback a second time.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    e.stopPropagation();
    onPlay();
  };

  const action = isCurrent && isPlaying ? `Пауза — ${station.title}` : `Слушать ${station.title}`;

  return (
    <article
      className={`card${isCurrent ? " card--active" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={action}
      onClick={onPlay}
      onKeyDown={onKeyDown}
    >
      <div className="card__art">
        <ChannelLogo svg={station.logoSvg} banner={station.image} lazy iconSize={32} />

        {station.adult ? (
          <span className="badge badge--adult card__badge" title="Контент 18+">
            18+
          </span>
        ) : null}

        <button
          className={`card__fav${isFavorite ? " card__fav--on" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            void toggleFavorite(station.prefix);
          }}
          aria-label={isFavorite ? "Убрать из избранного" : "В избранное"}
          aria-pressed={isFavorite}
        >
          <Heart size={15} fill={isFavorite ? "currentColor" : "none"} />
        </button>

        {/* Decorative: the tile itself handles activation. */}
        <div className="card__overlay" aria-hidden="true">
          <span className="card__play">
            {isCurrent && isPlaying ? (
              <Pause size={20} fill="currentColor" />
            ) : (
              <Play size={20} fill="currentColor" />
            )}
          </span>
        </div>
      </div>

      <div className="card__body">
        <div className="card__title" title={station.title}>
          {isCurrent ? (
            <span className={`eq${isPlaying ? "" : " eq--paused"}`} aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </span>
          ) : null}
          <span className="truncate">{station.title}</span>
        </div>
        <p className="card__desc">{station.tooltip}</p>
        <div className="card__genres">
          {station.genres.slice(0, 2).map((g) => {
            // The chip doubles as a filter toggle, so it must not fall through to
            // the tile's play handler — on the click and on Enter/Space, which the
            // button would otherwise also hand up to the card.
            const active = genreFilter === g.id;
            return (
              <button
                key={g.id}
                type="button"
                className={`chip chip--genre${active ? " chip--active" : ""}`}
                aria-pressed={active}
                title={`Показать каналы жанра «${g.name}»`}
                onClick={(e) => {
                  e.stopPropagation();
                  setGenreFilter(active ? null : g.id);
                }}
                onKeyDown={(e) => e.stopPropagation()}
              >
                {g.name}
              </button>
            );
          })}
        </div>
      </div>
    </article>
  );
}
