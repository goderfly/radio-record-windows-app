import { useEffect } from "react";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { StationGrid, CatalogErrorBanner } from "./components/StationGrid";
import { NowPlayingBar } from "./components/NowPlayingBar";
import { ExpandedPlayer } from "./components/ExpandedPlayer";
import { HistoryPanel } from "./components/HistoryPanel";
import { SettingsDialog } from "./components/SettingsDialog";
import { Toasts } from "./components/Toasts";
import { useStore } from "./state/store";

export function App(): JSX.Element {
  const init = useStore((s) => s.init);
  const view = useStore((s) => s.view);
  const togglePlay = useStore((s) => s.togglePlay);
  const nextStation = useStore((s) => s.nextStation);
  const prevTrack = useStore((s) => s.prevTrack);
  const nextTrack = useStore((s) => s.nextTrack);
  const setQuery = useStore((s) => s.setQuery);
  const setExpanded = useStore((s) => s.setExpanded);

  useEffect(() => {
    void init();
  }, [init]);

  // Keyboard shortcuts that only matter while the app is focused.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;

      if (event.key === "/" && !typing) {
        event.preventDefault();
        document.querySelector<HTMLInputElement>(".search input")?.focus();
        return;
      }
      if (event.key === "Escape" && typing) {
        setQuery("");
        (target as HTMLInputElement).blur();
        return;
      }
      if (event.key === " " && !typing) {
        event.preventDefault();
        void togglePlay();
        return;
      }
      // Plain arrows walk the channel's on-air log; Alt+arrows hop channels.
      if (!event.altKey && (event.key === "ArrowRight" || event.key === "ArrowLeft") && !typing) {
        event.preventDefault();
        if (event.key === "ArrowLeft") void prevTrack();
        else void nextTrack();
        return;
      }
      if (event.key === "ArrowRight" && event.altKey && !typing) {
        event.preventDefault();
        void nextStation(1);
        return;
      }
      if (event.key === "ArrowLeft" && event.altKey && !typing) {
        event.preventDefault();
        void nextStation(-1);
        return;
      }
      if (event.key === "F" && !typing && event.shiftKey) {
        event.preventDefault();
        setExpanded(!useStore.getState().expandedPlayer);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, nextStation, prevTrack, nextTrack, setQuery, setExpanded]);

  // Keep the system theme in sync while `theme === "system"`.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      if (useStore.getState().settings?.theme === "system") {
        document.documentElement.dataset.theme = mq.matches ? "light" : "dark";
      }
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return (
    <div className="app">
      <TitleBar />
      <div className="app__body">
        <Sidebar />
        {view === "history" ? <HistoryView /> : <StationGrid footer={<HistoryPanel />} />}
      </div>
      <NowPlayingBar />
      <ExpandedPlayer />
      <SettingsDialog />
      <Toasts />
      <CatalogErrorBanner />
    </div>
  );
}

/** Dedicated full-height history view. */
function HistoryView(): JSX.Element {
  return (
    <div className="app__main">
      <div className="app__content">
        <HistoryPanel />
      </div>
    </div>
  );
}
