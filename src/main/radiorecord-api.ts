import type { AirplayTrack, Genre, Station, StationSource } from "@shared/types";
import bundledCatalog from "../data/catalog.json";

export const SITE = "https://radiorecord.ru";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const JSON_HEADERS = { "user-agent": UA, accept: "application/json" };

/* ------------------------------------------------------------------ fetch */

/** radiorecord.ru resets the connection occasionally, so every call retries. */
async function fetchJson<T>(url: string, retries = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, { headers: JSON_HEADERS, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (err) {
      lastError = err;
      if (attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/* -------------------------------------------------------------- normalizing */

interface RawGenre {
  id: number;
  name: string;
  detail_picture?: string | null;
}

interface RawStation {
  id: number;
  prefix: string;
  title: string;
  short_title?: string | null;
  tooltip?: string | null;
  stream_64?: string | null;
  stream_128?: string | null;
  stream_320?: string | null;
  stream_hls?: string | null;
  genre?: RawGenre[] | null;
  bg_image?: string | null;
  bg_image_mobile?: string | null;
  svg_fill?: string | null;
  svg_outline?: string | null;
  shareUrl?: string | null;
  detail_page_url?: string | null;
  mark?: string | null;
}

/**
 * The API's `stream_64` / `stream_128` / `stream_320` labels are legacy and do not
 * match reality — `stream_64` really points at a 32 kbps file. The only reliable
 * source of truth is the number in the filename, so we re-derive it there.
 */
export function bitrateFromUrl(url: string): number {
  const m = /(\d{2,3})\.(?:aacp?|mp3|ogg|mp4)$/i.exec(url);
  return m ? Number(m[1]) : 64;
}

/**
 * The API still returns some `http://` asset URLs. Mixed content is blocked by
 * the renderer's CSP, and the site serves everything over TLS anyway, so upgrade
 * them at the boundary instead of widening `img-src` to include `http:`.
 */
function httpsUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.startsWith("http://") ? `https://${url.slice(7)}` : url;
}

/**
 * Yandex Music link for a track.
 *
 * The on-air API only knows about iTunes, so there is no catalogue id to deep
 * link with. Their public search endpoint takes a free-text query and is the
 * only stable way in: opening it hands off to the desktop client when Yandex
 * Music is installed, and to the site otherwise.
 */
function yandexMusicUrl(artist: string, song: string): string {
  const query = [artist, song].filter(Boolean).join(" ").trim();
  return `https://music.yandex.ru/search?text=${encodeURIComponent(query)}`;
}

/**
 * The API ships each channel logo twice: `svg_fill` (solid) and `svg_outline`.
 * Both are 200x200 inline markup whose paths are painted `fill="white"`, so they
 * are designed to sit on a dark plate. Anything else is rejected so a malformed
 * payload can never inject markup or remote references into the renderer.
 */
function sanitiseLogo(svg: string | null | undefined): string | null {
  if (!svg || !svg.includes("<svg")) return null;
  if (/<script|<foreignObject|\son\w+\s*=|javascript:|data:text\/html/i.test(svg)) return null;
  return svg;
}

function normaliseStation(raw: RawStation): Station {
  const sources: StationSource[] = [];
  const seen = new Set<string>();
  for (const raw0 of [raw.stream_64, raw.stream_128, raw.stream_320]) {
    const url = httpsUrl(raw0);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({ url, bitrate: bitrateFromUrl(url) });
  }
  sources.sort((a, b) => a.bitrate - b.bitrate);

  const genres: Genre[] = (raw.genre ?? []).map((g) => ({
    id: g.id,
    name: g.name,
    detailPicture: httpsUrl(g.detail_picture),
  }));

  return {
    id: raw.id,
    prefix: raw.prefix,
    title: raw.title,
    shortTitle: raw.short_title || raw.title,
    tooltip: raw.tooltip || "",
    genres,
    logoSvg: sanitiseLogo(raw.svg_fill) ?? sanitiseLogo(raw.svg_outline),
    image: httpsUrl(raw.bg_image || raw.bg_image_mobile) ?? "",
    pageUrl: httpsUrl(raw.shareUrl) ?? `${SITE}${raw.detail_page_url ?? `/station/${raw.prefix}`}`,
    sources,
    hlsUrl: httpsUrl(raw.stream_hls),
    adult: typeof raw.mark === "string" && raw.mark.includes("18+"),
  };
}

/* ----------------------------------------------------------------- catalog */

let cache: Station[] | null = null;

export async function loadStations(): Promise<Station[]> {
  if (cache) return cache;

  // The bundled snapshot keeps the UI instant and usable without a network.
  const bundled = bundledCatalog as Station[];
  if (Array.isArray(bundled) && bundled.length) {
    cache = bundled;
    return cache;
  }

  try {
    cache = await fetchStations();
  } catch (err) {
    console.error("[catalog] live fetch failed and no snapshot is bundled:", err);
    cache = [];
  }
  return cache;
}

export async function fetchStations(): Promise<Station[]> {
  const json = await fetchJson<{ result?: { stations?: RawStation[] } }>(`${SITE}/api/stations/`);
  const stations = (json.result?.stations ?? []).map(normaliseStation);
  stations.sort((a, b) => a.title.localeCompare(b.title, "ru"));
  cache = stations;
  return stations;
}

export async function findStation(prefix: string): Promise<Station | undefined> {
  const all = await loadStations();
  return all.find((s) => s.prefix === prefix);
}

/* ------------------------------------------------------------- on-air info */

interface RawTrack {
  id: number;
  artist?: string | null;
  song?: string | null;
  image100?: string | null;
  image200?: string | null;
  image600?: string | null;
  time?: number | null;
  time_formatted?: string | null;
  shareUrl?: string | null;
  /** ~30s AAC-in-M4A preview; present for the vast majority of tracks. */
  listenUrl?: string | null;
}

/**
 * The first element is the track currently on air; the rest is the station's
 * play history. This is the same endpoint the website's player uses.
 */
export async function fetchHistory(stationId: number, limit = 60): Promise<AirplayTrack[]> {
  const url = `${SITE}/api/station/history/?id=${stationId}&full=true`;
  const json = await fetchJson<{ result?: { history?: RawTrack[] } }>(url, 2);
  const history = json.result?.history ?? [];
  return history.slice(0, limit).map((t) => ({
    id: t.id,
    artist: t.artist || "Неизвестный исполнитель",
    song: t.song || "",
    image: httpsUrl(t.image600 || t.image200 || t.image100),
    airTime: typeof t.time === "number" ? t.time : 0,
    airTimeLabel: t.time_formatted ?? null,
    shareUrl: httpsUrl(t.shareUrl) ?? `${SITE}/track/${t.id}/`,
    yandexUrl: yandexMusicUrl(t.artist || "", t.song || ""),
    previewUrl: httpsUrl(t.listenUrl),
  }));
}
