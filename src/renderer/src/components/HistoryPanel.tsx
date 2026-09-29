import type { KeyboardEvent } from "react";
import { ListMusic, Loader2, History } from "lucide-react";
import { useStore } from "../state/store";
import { formatRelative, plural } from "../lib/format";
import { Cover } from "./Cover";
import { YandexMusicIcon } from "./YandexMusicIcon";

/** Play history for the current channel, shown under the station grid. */
export function HistoryPanel(): JSX.Element | null {
  const station = useStore((s) => s.station);
  const history = useStore((s) => s.history);
  const loading = useStore((s) => s.historyLoading);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const track = useStore((s) => s.track);
  const previewTrackId = useStore((s) => s.previewTrackId);
  const jumpToTrack = useStore((s) => s.jumpToTrack);

  // The row is a button, so Space must not reach the window-level shortcut.
  const onRowKeyDown = (index: number) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    e.stopPropagation();
    void jumpToTrack(index);
  };

  if (!station) return null;

  return (
    <section className="panel" aria-labelledby="history-title">
      <div className="panel__head">
        <ListMusic size={18} />
        <h2 className="panel__title" id="history-title">
          История эфира
        </h2>
        <span className="panel__count">
          {station.title} · {history.length} {plural(history.length, "трек", "трека", "треков")}
        </span>
        <div className="grow" />
        {history.length > 0 ? (
          <button className="btn" onClick={() => setView(view === "history" ? "channels" : "history")}>
            {view === "history" ? "Скрыть" : "Показать отдельным разделом"}
          </button>
        ) : null}
      </div>

      {loading && history.length === 0 ? (
        <p className="muted row" style={{ fontSize: "var(--fs-sm)" }}>
          <Loader2 size={14} className="spin" /> Загружаем историю канала…
        </p>
      ) : history.length === 0 ? (
        <p className="muted" style={{ fontSize: "var(--fs-sm)" }}>
          История пока недоступна — канал только что запущен или нет связи.
        </p>
      ) : (
        <div className="track-list">
          {history.map((item, index) => (
            <div
              key={item.id}
              className={`track${track?.id === item.id ? " track--current" : ""}`}
              role="button"
              tabIndex={0}
              title={
                index === 0
                  ? "Сейчас в эфире"
                  : item.previewUrl
                    ? "Послушать фрагмент этой песни"
                    : "Показать эту песню в плеере"
              }
              onClick={() => void jumpToTrack(index)}
              onKeyDown={onRowKeyDown(index)}
            >
              <div className="track__art">
                <Cover src={item.image} lazy iconSize={16} />
              </div>
              <div className="track__meta">
                <span className="track__title">{item.song || item.artist}</span>
                <span className="track__artist">{item.artist}</span>
              </div>
              {index === 0 ? (
                <span className="chip">Сейчас</span>
              ) : previewTrackId === item.id ? (
                <span className="chip chip--live">Фрагмент</span>
              ) : null}
              <span className="track__time">{formatRelative(item.airTime)}</span>
              <div className="track__links">
                {item.yandexUrl ? (
                  <button
                    className="icon-btn icon-btn--sm"
                    title="Открыть в Яндекс Музыке"
                    aria-label={`Открыть ${item.song || item.artist} в Яндекс Музыке`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void window.recordMini.system.openExternal(item.yandexUrl);
                    }}
                  >
                    <YandexMusicIcon />
                  </button>
                ) : null}
                {item.shareUrl ? (
                  <button
                    className="icon-btn icon-btn--sm"
                    title="Открыть на radiorecord.ru"
                    aria-label="Открыть трек на radiorecord.ru"
                    onClick={(e) => {
                      e.stopPropagation();
                      void window.recordMini.system.openExternal(item.shareUrl!);
                    }}
                  >
                    <History size={14} />
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
