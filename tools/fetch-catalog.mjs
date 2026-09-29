/**
 * Refreshes the bundled station snapshot (src/data/catalog.json) from the public
 * radiorecord.ru API, so the app renders instantly and works offline.
 *
 *   node tools/fetch-catalog.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src", "data", "catalog.json");
const SITE = "https://radiorecord.ru";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function fetchJson(url, retries = 4) {
  let last;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      last = err;
      if (attempt < retries - 1) await new Promise((r) => setTimeout(r, 600 * 2 ** attempt));
    }
  }
  throw last;
}

/** The API labels streams stream_64/128/320, but the files are really 32/64/96. */
function bitrateFromUrl(url) {
  const m = /(\d{2,3})\.(?:aacp?|mp3|ogg|mp4)$/i.exec(url);
  return m ? Number(m[1]) : 64;
}

/** Mirrors the main-process sanitiser; keeps hostile markup out of the bundle. */
function sanitiseLogo(svg) {
  if (!svg || !svg.includes("<svg")) return null;
  if (/<script|<foreignObject|\son\w+\s*=|javascript:|data:text\/html/i.test(svg)) return null;
  return svg;
}

/** The API still returns some http:// asset URLs. */
function httpsUrl(url) {
  if (!url) return null;
  return url.startsWith("http://") ? `https://${url.slice(7)}` : url;
}

const json = await fetchJson(`${SITE}/api/stations/`);
const raw = json?.result?.stations;
if (!Array.isArray(raw) || !raw.length) throw new Error("unexpected /api/stations/ payload");

const seenIds = new Set();
const stations = raw
  .filter((s) => {
    if (seenIds.has(s.id)) return false;
    seenIds.add(s.id);
    return true;
  })
  .map((s) => {
    const sources = [];
    const seen = new Set();
    for (const url of [s.stream_64, s.stream_128, s.stream_320]) {
      if (!url || seen.has(url)) continue;
      seen.add(url);
      sources.push({ url, bitrate: bitrateFromUrl(url) });
    }
    sources.sort((a, b) => a.bitrate - b.bitrate);
    return {
      id: s.id,
      prefix: s.prefix,
      title: s.title,
      shortTitle: s.short_title || s.title,
      tooltip: s.tooltip || "",
      genres: (s.genre ?? []).map((g) => ({
        id: g.id,
        name: g.name,
        detailPicture: httpsUrl(g.detail_picture),
      })),
      logoSvg: sanitiseLogo(s.svg_fill) ?? sanitiseLogo(s.svg_outline),
      image: httpsUrl(s.bg_image || s.bg_image_mobile) ?? "",
      pageUrl: httpsUrl(s.shareUrl) ?? `${SITE}${s.detail_page_url ?? `/station/${s.prefix}`}`,
      sources: sources.map((x) => ({ ...x, url: httpsUrl(x.url) })),
      hlsUrl: httpsUrl(s.stream_hls),
      adult: typeof s.mark === "string" && s.mark.includes("18+"),
    };
  })
  .sort((a, b) => a.title.localeCompare(b.title, "ru"));

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(stations, null, 2) + "\n", "utf8");

const bitrates = [...new Set(stations.flatMap((s) => s.sources.map((x) => x.bitrate)))].sort((a, b) => a - b);
console.log(`stations: ${stations.length}`);
console.log(`bitrates: ${bitrates.join(", ")}`);
console.log(`adult-marked: ${stations.filter((s) => s.adult).length}`);
console.log(`with logo: ${stations.filter((s) => s.logoSvg).length}`);
console.log(`without hls: ${stations.filter((s) => !s.hlsUrl).length}`);
console.log(`-> ${OUT}`);
