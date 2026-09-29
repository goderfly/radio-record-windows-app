import http from "node:http";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { findStation } from "./radiorecord-api";
import type { StationSource, StreamStatusEvent } from "@shared/types";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export type { StreamStatusEvent };

interface Upstream {
  req: http.ClientRequest;
  res: IncomingMessage;
}

export interface StreamProxy {
  /** Port the proxy is listening on. */
  port: number;
  close(): Promise<void>;
}

/**
 * Picks the stream that best matches the requested bitrate.
 * `bitrate <= 0` means "auto", which resolves to the highest available stream.
 */
export function pickSource(sources: StationSource[], bitrate: number): StationSource | null {
  if (!sources.length) return null;
  if (bitrate <= 0) return sources[sources.length - 1];
  let best = sources[0];
  let bestDelta = Math.abs(sources[0].bitrate - bitrate);
  for (const s of sources) {
    const delta = Math.abs(s.bitrate - bitrate);
    // Prefer a stream at or above the target over one below it.
    const score = delta - (s.bitrate >= bitrate ? 0.5 : 0);
    if (score < bestDelta) {
      best = s;
      bestDelta = score;
    }
  }
  return best;
}

/**
 * Hosts the preview endpoint is willing to fetch from.
 *
 * The renderer hands us an arbitrary URL for this, so without an allowlist the
 * loopback proxy would be a general-purpose open relay. Preview clips are only
 * ever served from Apple's audio CDN.
 */
const PREVIEW_HOSTS = new Set([
  "audio-ssl.itunes.apple.com",
  "audio-ssl.itunes.com",
  "is1-ssl.mzstatic.com",
  "is2-ssl.mzstatic.com",
  "is3-ssl.mzstatic.com",
  "is4-ssl.mzstatic.com",
  "is5-ssl.mzstatic.com",
]);

/**
 * A loopback HTTP server that re-serves the upstream Icecast AAC stream.
 *
 * The renderer cannot fetch radiorecord.ru directly (no CORS headers) and the
 * upstream URL is `.aacp`, which Chromium will not load from a remote origin.
 * Proxying through main also gives us one place to implement reconnect logic.
 */
export function createStreamProxy(onEvent: (e: StreamStatusEvent) => void): Promise<StreamProxy> {
  const openUpstreams = new Set<Upstream>();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/stream") {
      void handleStream(url, req, res).catch((err) => {
        onEvent({ status: "error", error: String(err instanceof Error ? err.message : err) });
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        res.end("upstream failure");
      });
      return;
    }
    if (url.pathname === "/preview") {
      void handlePreview(url, req, res).catch(() => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        res.end("preview failure");
      });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  /**
   * Streams a track's ~30s preview clip.
   *
   * Unlike the live path this is a plain finite file, so it is a straight pipe:
   * range requests are forwarded and the upstream status/headers are passed
   * through, which is what lets Chromium seek inside the clip. No reconnect
   * logic and no status events — a preview failing is not a stream failure.
   */
  function handlePreview(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    return new Promise((resolve) => {
      const raw = url.searchParams.get("u") ?? "";
      let target: URL;
      try {
        target = new URL(raw);
      } catch {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("bad url");
        resolve();
        return;
      }
      if (target.protocol !== "https:" || !PREVIEW_HOSTS.has(target.hostname)) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("host not allowed");
        resolve();
        return;
      }

      const headers: Record<string, string> = { "user-agent": UA, accept: "audio/*;q=0.9,*/*;q=0.8" };
      const range = req.headers.range;
      if (typeof range === "string" && range.length > 0) headers["range"] = range;

      const up = https.request(target, { headers, timeout: 20000 }, (upRes) => {
        const out: Record<string, string | number> = {
          "content-type": upRes.headers["content-type"] ?? "audio/mp4",
          "cache-control": "no-store",
          "accept-ranges": "bytes",
          "access-control-allow-origin": "*",
        };
        if (upRes.statusCode) out["status"] = upRes.statusCode;
        if (typeof upRes.headers["content-length"] === "string") {
          out["content-length"] = upRes.headers["content-length"];
        }
        if (typeof upRes.headers["content-range"] === "string") {
          out["content-range"] = upRes.headers["content-range"];
        }
        res.writeHead(upRes.statusCode ?? 200, out);
        upRes.pipe(res);
        upRes.on("end", () => resolve());
        upRes.on("error", () => {
          if (!res.writableEnded) res.end();
          resolve();
        });
      });

      up.on("timeout", () => up.destroy(new Error("preview timeout")));
      up.on("error", () => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        if (!res.writableEnded) res.end("preview upstream failure");
        resolve();
      });
      req.on("close", () => up.destroy());
      up.end();
    });
  }

  async function handleStream(
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const prefix = url.searchParams.get("s") ?? "";
    const bitrate = Number(url.searchParams.get("b") ?? "0") || 0;

    const station = await findStation(prefix);
    if (!station) {
      onEvent({ status: "error", error: `Неизвестный канал: ${prefix}` });
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("unknown station");
      return;
    }
    const source = pickSource(station.sources, bitrate);
    if (!source) {
      onEvent({ status: "error", error: `У канала «${station.title}» нет доступных потоков` });
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("no sources");
      return;
    }

    onEvent({ status: "connecting", error: null, bitrateKbps: source.bitrate });

    let committed = false;
    let bytes = 0;
    let windowStart = Date.now();
    let measuredBps = 0;

    const startUpstream = (): Promise<Upstream> =>
      new Promise((resolve, reject) => {
        const up = https.request(
          source.url,
          {
            headers: {
              "user-agent": UA,
              accept: "audio/aac,audio/*;q=0.9,*/*;q=0.8",
              // Ask Icecast not to interleave ICY metadata blocks: Chromium's AAC
              // decoder would choke on them.
              "icy-metadata": "0",
              connection: "close",
            },
            timeout: 20000,
          },
          (upRes) => {
            if (upRes.statusCode && upRes.statusCode >= 400) {
              reject(new Error(`upstream HTTP ${upRes.statusCode}`));
              upRes.destroy();
              return;
            }
            resolve({ req: up, res: upRes });
          },
        );
        up.on("timeout", () => up.destroy(new Error("upstream timeout")));
        up.on("error", reject);
        up.end();
      });

    // Retry while nothing has been written yet — the client sees one seamless
    // request. Once bytes are on the wire we let it fail and the renderer retries.
    let up: Upstream | null = null;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        up = await startUpstream();
        lastError = null;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        onEvent({ status: "reconnecting", error: lastError.message });
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
    if (!up) throw lastError ?? new Error("upstream unreachable");

    const handle = { req: up.req, res: up.res };
    openUpstreams.add(handle);

    const teardown = () => {
      openUpstreams.delete(handle);
      if (!res.writableEnded) res.end();
    };
    req.on("close", teardown);
    req.on("error", teardown);

    up.res.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      const now = Date.now();
      const span = now - windowStart;
      if (span >= 2000) {
        measuredBps = Math.round((bytes * 8) / span);
        windowStart = now;
        bytes = 0;
      }
      if (!committed) {
        committed = true;
        res.writeHead(200, {
          "content-type": "audio/aac",
          "cache-control": "no-store, no-cache, must-revalidate",
          "connection": "close",
          "access-control-allow-origin": "*",
        });
        onEvent({ status: "playing", error: null, bitrateKbps: source.bitrate });
      }
      if (!res.writableEnded) res.write(chunk);
    });

    up.res.on("end", () => {
      openUpstreams.delete(handle);
      onEvent({ status: "reconnecting", error: "Поток прерван" });
      if (!res.writableEnded) res.end();
    });

    up.res.on("error", (err) => {
      openUpstreams.delete(handle);
      onEvent({ status: committed ? "reconnecting" : "error", error: err.message });
      if (!res.writableEnded) res.end();
    });

    up.res.on("close", () => {
      openUpstreams.delete(handle);
      if (!res.writableEnded) res.end();
    });

    // Report the measured throughput so the UI can show a live signal/quality hint.
    const meter = setInterval(() => {
      if (committed && measuredBps > 0) {
        onEvent({ status: "playing", error: null, bitrateKbps: Math.round(measuredBps / 1000) });
      }
    }, 3000);
    const stopMeter = () => clearInterval(meter);
    up.res.on("end", stopMeter);
    up.res.on("close", stopMeter);
    up.res.on("error", stopMeter);
    req.on("close", stopMeter);
  }

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to bind stream proxy"));
        return;
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            for (const h of openUpstreams) h.req.destroy();
            openUpstreams.clear();
            server.close(() => done());
          }),
      });
    });
  });
}
