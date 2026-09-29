import { useEffect, useState } from "react";
import { X, RotateCcw, ExternalLink, Keyboard } from "lucide-react";
import type { ThemeMode } from "@shared/types";
import { useStore, applyTheme } from "../state/store";

export function SettingsDialog(): JSX.Element | null {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const settings = useStore((s) => s.settings);
  const patchSettings = useStore((s) => s.patchSettings);
  const setQuality = useStore((s) => s.setQuality);
  const setTheme = useStore((s) => s.setTheme);
  const setCrossfade = useStore((s) => s.setCrossfade);
  const catalogState = useStore((s) => s.catalogState);
  const stations = useStore((s) => s.stations);
  const refreshCatalog = useStore((s) => s.refreshCatalog);
  const pushToast = useStore((s) => s.pushToast);
  const [version, setVersion] = useState("");

  useEffect(() => {
    if (!open) return;
    void window.recordMini.system.getVersion().then(setVersion);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open || !settings) return null;

  const onReset = async () => {
    const next = await window.recordMini.settings.reset();
    useStore.setState({ settings: next });
    applyTheme(next.theme);
    pushToast("Настройки сброшены", "success");
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Настройки" onClick={() => setOpen(false)}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog__head">
          <h2 className="dialog__title">Настройки</h2>
          <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Закрыть">
            <X size={18} />
          </button>
        </div>

        <div className="dialog__body">
          <Section title="Воспроизведение">
            <Setting
              label="Качество потока"
              hint="Авто выбирает самый высокий доступный битрейт канала."
            >
              <div className="segmented">
                {(["auto", "low", "medium", "high"] as const).map((id) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={settings.quality === id}
                    onClick={() => void setQuality(id)}
                  >
                    {id === "auto" ? "Авто" : id === "low" ? "Низк." : id === "medium" ? "Сред." : "Выс."}
                  </button>
                ))}
              </div>
            </Setting>

            <Setting label="Плавный переход" hint="Длительность кроссфейда при смене канала.">
              <div className="row">
                <div className="slider" style={{ width: 140 }}>
                  <div className="slider__track">
                    <div
                      className="slider__fill"
                      style={{ width: `${(settings.crossfadeMs / 2000) * 100}%` }}
                    />
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={2000}
                    step={100}
                    value={settings.crossfadeMs}
                    onChange={(e) => void setCrossfade(Number(e.target.value))}
                    aria-label="Длительность кроссфейда"
                  />
                </div>
                <span className="muted tnum" style={{ minWidth: 52, fontSize: "var(--fs-xs)" }}>
                  {settings.crossfadeMs === 0 ? "выкл" : `${settings.crossfadeMs} мс`}
                </span>
              </div>
            </Setting>

            <Setting label="Уведомления о смене трека" hint="Всплывающее уведомление, когда в эфире новый трек.">
              <Switch
                checked={settings.notificationsOnTrackChange}
                onChange={(v) => void patchSettings({ notificationsOnTrackChange: v })}
                label="Уведомления о смене трека"
              />
            </Setting>
          </Section>

          <Section title="Интерфейс">
            <Setting label="Тема оформления">
              <div className="segmented">
                {(["dark", "light", "system"] as ThemeMode[]).map((id) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={settings.theme === id}
                    onClick={() => void setTheme(id)}
                  >
                    {id === "dark" ? "Тёмная" : id === "light" ? "Светлая" : "Системная"}
                  </button>
                ))}
              </div>
            </Setting>
          </Section>

          <Section title="Система">
            <Setting label="Значок в трее" hint="Плеер сворачивается в трей вместо закрытия.">
              <Switch
                checked={settings.showTray}
                onChange={(v) => void patchSettings({ showTray: v })}
                label="Значок в трее"
              />
            </Setting>
            <Setting label="Сворачивать в трей при закрытии">
              <Switch
                checked={settings.closeToTray}
                onChange={(v) => void patchSettings({ closeToTray: v })}
                label="Сворачивать в трей"
              />
            </Setting>
            <Setting label="Запускать вместе с системой">
              <Switch
                checked={settings.launchOnStartup}
                onChange={(v) => void patchSettings({ launchOnStartup: v })}
                label="Автозапуск"
              />
            </Setting>
            <Setting label="Запускаться свёрнутым" hint="Открывать сразу в трее, без окна.">
              <Switch
                checked={settings.startMinimized}
                onChange={(v) => void patchSettings({ startMinimized: v })}
                label="Запускаться свёрнутым"
              />
            </Setting>
            <Setting label="Глобальные горячие клавиши" hint="Работают, когда окно свёрнуто или в фоне.">
              <Switch
                checked={settings.globalShortcutsEnabled}
                onChange={(v) => void patchSettings({ globalShortcutsEnabled: v })}
                label="Глобальные горячие клавиши"
              />
            </Setting>
          </Section>

          <Section title="Горячие клавиши">
            <ShortcutList />
            <Setting label="Системные медиаклавиши" hint="Мультимедийные клавиши работают всегда.">
              <span className="row" style={{ gap: 4 }}>
                <kbd>Play</kbd>
                <kbd>Pause</kbd>
                <kbd>Next</kbd>
                <kbd>Prev</kbd>
                <kbd>Vol ±</kbd>
              </span>
            </Setting>
          </Section>

          <Section title="Каталог каналов">
            <Setting
              label="Источник данных"
              hint={`radiorecord.ru · ${stations.length} каналов · ${
                catalogState === "ready" ? "актуальный список" : "встроенный снимок"
              }`}
            >
              <button className="btn btn--outline" onClick={() => void refreshCatalog()}>
                Обновить
              </button>
            </Setting>
          </Section>

          <Section title="О приложении">
            <Setting label="Record Mini" hint={`Версия ${version || "1.0.0"} · данные: radiorecord.ru`}>
              <button
                className="btn btn--outline"
                onClick={() => void window.recordMini.system.openExternal("https://radiorecord.ru")}
              >
                <ExternalLink size={15} />
                Сайт
              </button>
            </Setting>
            <Setting label="Сбросить настройки" hint="Вернуть все параметры к значениям по умолчанию.">
              <button className="btn btn--outline" onClick={() => void onReset()}>
                <RotateCcw size={15} />
                Сбросить
              </button>
            </Setting>
          </Section>
        </div>

        <div className="dialog__foot">
          <span className="muted row" style={{ fontSize: "var(--fs-xs)" }}>
            <Keyboard size={13} />
            Esc — закрыть
          </span>
          <button className="btn btn--accent" onClick={() => setOpen(false)}>
            Готово
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ marginBottom: "var(--sp-5)" }}>
      <div className="sidebar__section" style={{ paddingLeft: 0 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Setting({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="setting">
      <div className="setting__text">
        <div className="setting__label">{label}</div>
        {hint ? <div className="setting__hint">{hint}</div> : null}
      </div>
      <div className="setting__control">{children}</div>
    </div>
  );
}

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch${checked ? " switch--on" : ""}`}
      onClick={() => onChange(!checked)}
    />
  );
}

const SHORTCUT_LABELS: Array<[string, string]> = [
  ["playPause", "Play / пауза"],
  ["nextChannel", "Следующий канал"],
  ["prevChannel", "Предыдущий канал"],
  ["toggleWindow", "Показать / скрыть окно"],
];

function ShortcutList(): JSX.Element {
  const shortcuts = useStore((s) => s.settings?.globalShortcuts);
  if (!shortcuts) return <></>;
  return (
    <div className="setting" style={{ display: "block" }}>
      <div className="setting__keys">
        {SHORTCUT_LABELS.map(([key, label]) => (
          <div className="key-row" key={key}>
            <span className="key-row__label">{label}</span>
            <kbd>{shortcuts[key] ?? "—"}</kbd>
          </div>
        ))}
      </div>
    </div>
  );
}
