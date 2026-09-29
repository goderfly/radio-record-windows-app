import { protocol, net } from "electron";
import { join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const APP_SCHEME = "app";
export const APP_HOST = "record-mini";

/**
 * The renderer is served from a custom standard scheme rather than `file://`.
 *
 * Under `file://` every document has an opaque origin, so `'self'` in a CSP
 * matches nothing and the page silently refuses to run its own scripts. A
 * registered standard scheme gives the renderer a real, stable origin, which
 * makes the strict Content-Security-Policy below actually enforceable.
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // React's style system is fine with inline styles, and the API returns no HTML.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data: blob:",
  // Playback comes from the loopback stream proxy, artwork from the site.
  "media-src 'self' http://127.0.0.1:* blob:",
  "connect-src 'self' http://127.0.0.1:*",
  "font-src 'self' data:",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export function serveRendererFrom(rootDir: string): void {
  const root = normalize(rootDir);

  protocol.handle(APP_SCHEME, async (request) => {
    let pathname: string;
    try {
      const url = new URL(request.url);
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response("bad request", { status: 400 });
    }

    if (pathname === "/" || pathname === "") pathname = "/index.html";

    const target = normalize(join(root, pathname));
    // Path traversal guard: the resolved file must stay inside the served root.
    if (target !== root && !target.startsWith(root.endsWith(sep) ? root : root + sep)) {
      return new Response("forbidden", { status: 403 });
    }

    try {
      const response = await net.fetch(pathToFileURL(target).toString());
      const headers = new Headers(response.headers);
      headers.set("content-security-policy", CSP);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}

export function rendererEntryUrl(): string {
  return `${APP_SCHEME}://${APP_HOST}/index.html`;
}
