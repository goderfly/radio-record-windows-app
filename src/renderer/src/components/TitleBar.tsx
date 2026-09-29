import { useEffect, useRef } from "react";
import { Minus, Square, Copy, X } from "lucide-react";
import { useStore } from "../state/store";
import { RecordMark } from "./RecordMark";

export function TitleBar(): JSX.Element {
  const station = useStore((s) => s.station);
  const track = useStore((s) => s.track);
  const maximized = useStore((s) => s.maximized);

  const context = track
    ? `${track.artist} — ${track.song}`
    : station
      ? station.tooltip || station.title
      : "Радиостанции Record Dance Radio";

  return (
    <header className="titlebar">
      <div className="titlebar__brand">
        <RecordMark className="titlebar__logo" />
        <span>RECORD</span>
      </div>

      <span className="titlebar__sep" aria-hidden="true" />

      <div className="titlebar__context" title={context}>
        {station ? `${station.title} · ${context}` : "Выберите канал, чтобы начать слушать"}
      </div>

      <div className="titlebar__controls">
        <button
          className="win-btn"
          onClick={() => window.recordMini.window.minimize()}
          aria-label="Свернуть"
          title="Свернуть"
        >
          <Minus size={15} />
        </button>
        <button
          className="win-btn"
          onClick={() => window.recordMini.window.toggleMaximize()}
          aria-label={maximized ? "Восстановить" : "Развернуть"}
          title={maximized ? "Восстановить" : "Развернуть"}
        >
          {maximized ? <Copy size={13} /> : <Square size={12} />}
        </button>
        <button
          className="win-btn win-btn--close"
          onClick={() => window.recordMini.window.close()}
          aria-label="Закрыть"
          title="Закрыть (сворачивается в трей)"
        >
          <X size={15} />
        </button>
      </div>
    </header>
  );
}

/** Small hook shared by menus: closes on outside click and Escape. */
export function useDismiss(
  open: boolean,
  close: () => void,
  ref: React.RefObject<HTMLElement>,
): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) closeRef.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeRef.current();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, ref]);
}
