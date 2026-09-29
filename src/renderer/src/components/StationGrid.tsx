import { useEffect, useMemo, useState } from "react";
import { Search, X, RefreshCw, Radio, Heart, AlertTriangle } from "lucide-react";
import { useStore, visibleStations, sortStations, type SortId } from "../state/store";
import { plural } from "../lib/format";
import { StationCard } from "./StationCard";

const VIEW_TITLES = {
  channels: "Каналы",
  favorites: "Избранное",
  recent: "Недавние",
  history: "История эфира",
} as const;

export function StationGrid({ footer }: { footer?: React.ReactNode }): JSX.Element {
  const stations = useStore((s) => s.stations);
  const view = useStore((s) => s.view);
  const query = useStore((s) => s.query);
  const setQuery = useStore((s) => s.setQuery);
  const genreFilter = useStore((s) => s.genreFilter);
  const sort = useStore((s) => s.sort);
  const setSort = useStore((s) => s.setSort);
  const genres = useStore((s) => s.genres);
  const settings = useStore((s) => s.settings);
  const catalogState = useStore((s) => s.catalogState);
  const refreshCatalog = useStore((s) => s.refreshCatalog);
  const [refreshing, setRefreshing] = useState(false);

  const filtered = useMemo(
    () => sortStations(visibleStations({ stations, view, query, genreFilter, settings }), sort),
    [stations, view, query, genreFilter, sort, settings],
  );

  const activeGenre = genres.find((g) => g.id === genreFilter) ?? null;
  const title = activeGenre ? activeGenre.name : VIEW_TITLES[view];

  // Any of these can collapse the list to far fewer cards than the scroller's
  // current offset, which would leave the view parked past the last one.
  useEffect(() => {
    document.getElementById("scroller")?.scrollTo({ top: 0, behavior: "smooth" });
  }, [view, query, genreFilter]);

  const onRefresh = async () => {
    setRefreshing(true);
    await refreshCatalog();
    setTimeout(() => setRefreshing(false), 400);
  };

  return (
    <div className="app__main">
      <div className="toolbar">
        <div className="toolbar__heading">
          <h1 className="toolbar__title">{title}</h1>
          <p className="toolbar__subtitle">
            {catalogState === "loading"
              ? "Загружаем каталог каналов…"
              : `${filtered.length} ${plural(filtered.length, "канал", "канала", "каналов")}`}
            {activeGenre ? " · фильтр по жанру" : ""}
          </p>
        </div>

        <div className="toolbar__spacer" />

        {view === "channels" ? (
          <div className="segmented" role="group" aria-label="Сортировка">
            {(
              [
                ["site", "С сайта"],
                ["title", "По алфавиту"],
                ["genre", "По жанру"],
              ] as Array<[SortId, string]>
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setSort(id)}
                aria-pressed={sort === id}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}

        <div className="search">
          <span className="search__icon">
            <Search size={15} />
          </span>
          <input
            type="search"
            value={query}
            placeholder="Поиск канала или жанра…"
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Поиск"
            spellCheck={false}
          />
          {query ? (
            <button
              className="icon-btn icon-btn--sm search__clear"
              onClick={() => setQuery("")}
              aria-label="Очистить поиск"
            >
              <X size={14} />
            </button>
          ) : null}
        </div>

        <button
          className="icon-btn"
          onClick={() => void onRefresh()}
          aria-label="Обновить список каналов"
          title="Обновить список каналов"
        >
          <RefreshCw size={16} className={refreshing ? "spin" : undefined} />
        </button>
      </div>

      <div className="app__content" id="scroller">
        {filtered.length === 0 ? (
          <EmptyState view={view} query={query} />
        ) : (
          <>
            <div className="grid">
              {filtered.map((station) => (
                <StationCard key={station.prefix} station={station} />
              ))}
            </div>
            {footer}
          </>
        )}
      </div>
    </div>
  );
}

function EmptyState({ view, query }: { view: string; query: string }): JSX.Element {
  if (query) {
    return (
      <div className="empty">
        <span className="empty__icon">
          <Search size={26} />
        </span>
        <h2 className="empty__title">Ничего не найдено</h2>
        <p className="empty__text">
          По запросу «{query}» каналов не найдено. Попробуйте другое название или жанр.
        </p>
      </div>
    );
  }

  const message: Record<string, string> = {
    favorites: "Отметьте каналы сердечком, чтобы они появились здесь и были доступны из трея.",
    recent: "Здесь появятся каналы, которые вы недавно слушали.",
    history: "Включите любой канал — его история эфира появится здесь.",
  };

  const icon = view === "favorites" ? <Heart size={26} /> : <Radio size={26} />;

  return (
    <div className="empty">
      <span className="empty__icon">{icon}</span>
      <h2 className="empty__title">Пока пусто</h2>
      <p className="empty__text">{message[view] ?? "Выберите канал из списка слева."}</p>
    </div>
  );
}

export function CatalogErrorBanner(): JSX.Element | null {
  const catalogError = useStore((s) => s.catalogError);
  const stations = useStore((s) => s.stations);
  if (!catalogError || stations.length > 0) return null;
  return (
    <div className="toasts">
      <div className="toast toast--error">
        <AlertTriangle size={15} />
        Не удалось загрузить каталог: {catalogError}
      </div>
    </div>
  );
}
