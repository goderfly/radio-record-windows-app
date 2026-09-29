import type { QualityPreference, Station } from "@shared/types";

/** Maps the user's quality preference onto a concrete upstream bitrate. */
export function resolveBitrate(preference: QualityPreference, station: Station): number | null {
  const available = station.sources.map((s) => s.bitrate);
  if (!available.length) return null;
  const highest = Math.max(...available);
  const lowest = Math.min(...available);

  switch (preference) {
    case "high":
      return highest;
    case "medium":
      // Aim for the middle rung; fall back to whatever sits closest.
      return closest(available, (highest + lowest) / 2);
    case "low":
      return lowest;
    case "auto":
    default:
      return null; // 0 => proxy picks the highest available
  }
}

function closest(values: number[], target: number): number {
  return values.reduce((best, v) => (Math.abs(v - target) < Math.abs(best - target) ? v : best), values[0]);
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "--:--";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** "5 минут назад" style relative time, used for play history. */
export function formatRelative(unixSeconds: number): string {
  if (!unixSeconds) return "—";
  const delta = Math.floor(Date.now() / 1000) - unixSeconds;
  if (delta < 60) return "только что";
  if (delta < 3600) return `${Math.floor(delta / 60)} мин назад`;
  if (delta < 86400) return `${Math.floor(delta / 3600)} ч назад`;
  const days = Math.floor(delta / 86400);
  return days === 1 ? "вчера" : `${days} дн назад`;
}

/** Broadcast clock label from the API, e.g. "20:53:16" -> "20:53". */
export function formatAirTime(label: string | null): string {
  if (!label) return "";
  return label.length >= 5 ? label.slice(0, 5) : label;
}

export function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
