import { Radio, Heart, Clock, ListMusic, Settings as SettingsIcon, PanelLeftClose, PanelLeft } from "lucide-react";
import { useStore, useFavorites, useRecents, type ViewId } from "../state/store";

const NAV: Array<{ id: ViewId; label: string; icon: typeof Radio }> = [
  { id: "channels", label: "Каналы", icon: Radio },
  { id: "favorites", label: "Избранное", icon: Heart },
  { id: "recent", label: "Недавние", icon: Clock },
  { id: "history", label: "История эфира", icon: ListMusic },
];

export function Sidebar(): JSX.Element {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const genres = useStore((s) => s.genres);
  const stations = useStore((s) => s.stations);
  const genreFilter = useStore((s) => s.genreFilter);
  const setGenreFilter = useStore((s) => s.setGenreFilter);
  const favorites = useFavorites();
  const recents = useRecents();
  const historyCount = useStore((s) => s.history.length);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const toggleSidebar = useStore((s) => s.toggleSidebar);

  const counts: Record<ViewId, number> = {
    channels: stations.length,
    favorites: favorites.length,
    recent: recents.length,
    history: historyCount,
  };

  const genreCounts = new Map<number, number>();
  for (const s of stations) {
    for (const g of s.genres) genreCounts.set(g.id, (genreCounts.get(g.id) ?? 0) + 1);
  }

  return (
    <aside className={`sidebar${sidebarOpen ? "" : " sidebar--collapsed"}`} aria-label="Навигация">
      <nav className="sidebar__nav">
        {NAV.map((item) => {
          const Icon = item.icon;
          const active = view === item.id && genreFilter === null;
          return (
            <button
              key={item.id}
              className={`nav-item${active ? " nav-item--active" : ""}`}
              onClick={() => {
                setView(item.id);
                setGenreFilter(null);
              }}
              aria-current={active ? "page" : undefined}
            >
              <Icon size={17} strokeWidth={2} />
              <span className="nav-item__label">{item.label}</span>
              <span className="nav-item__count">{counts[item.id]}</span>
            </button>
          );
        })}
      </nav>

      <div className="sidebar__section">Жанры</div>
      <div className="sidebar__genres">
        {genres.length === 0 ? (
          <p className="muted" style={{ padding: "0 12px", fontSize: "var(--fs-xs)" }}>
            Загрузка каталога…
          </p>
        ) : (
          genres.map((genre) => {
            const active = genreFilter === genre.id;
            return (
              <button
                key={genre.id}
                className={`genre-row${active ? " genre-row--active" : ""}`}
                onClick={() => setGenreFilter(active ? null : genre.id)}
                aria-pressed={active}
              >
                <span className="genre-row__dot" aria-hidden="true" />
                <span className="genre-row__name">{genre.name}</span>
                <span className="genre-row__count">{genreCounts.get(genre.id) ?? 0}</span>
              </button>
            );
          })
        )}
      </div>

      <div className="sidebar__footer">
        <button className="btn" onClick={() => setSettingsOpen(true)}>
          <SettingsIcon size={15} />
          Настройки
        </button>
        <button
          className="icon-btn icon-btn--sm"
          onClick={toggleSidebar}
          aria-label={sidebarOpen ? "Свернуть меню" : "Развернуть меню"}
          title={sidebarOpen ? "Свернуть меню" : "Развернуть меню"}
        >
          {sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeft size={15} />}
        </button>
      </div>
    </aside>
  );
}
