/**
 * Renders the app icons from the Record brand mark (resources/record-mark.svg).
 *
 * The mark is vector artwork, so it is rasterised by Chromium — the renderer
 * that will actually display it — rather than approximated by a hand-rolled
 * shape model. That keeps every size crisp and identical to the site's logo.
 *
 *   npm run icons        (runs under Electron)
 */
import { app, BrowserWindow } from "electron";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RES = join(ROOT, "resources");
const MARK = join(RES, "record-mark.svg");

/**
 * Brand gradient from the site's own CSS:
 * `linear-gradient(100deg, #ff4e10 42.63%, #e8a700 100%)`.
 * Direction is (0.6437, 0.7654) over the unit square, spanning 0..1.4091.
 *
 * The solid stop is pushed past the site's 42.63%. On a wide page banner the
 * amber only ever shows in a corner, but a square icon has its middle at
 * t = 0.5 — right where the mark sits — and white on mid-gradient orange
 * measures 2.98:1, just under the 3:1 WCAG floor for graphics. Holding the
 * orange to 62% keeps the mark on #ff4e10 (3.31:1) and still sweeps amber
 * into the bottom-right corner, which is what the site looks like anyway.
 */
const GRAD = { dx: 0.6437, dy: 0.7654, span: 1.4091, solid: 0.62, from: "#ff4e10", to: "#e8a700" };
const CORNER = 0.225; // squircle corner radius, as a fraction of the icon

/**
 * Wraps the mark in a square canvas, optionally on the brand plate.
 *
 * @param width fraction of the canvas the mark should span; the mark is about
 *              3.4:1, so its height follows from that.
 */
function compose({ size, plate, ink, width, mark, bbox }) {
  const k = (size * width) / bbox.w;
  const tx = (size - bbox.w * k) / 2;
  const ty = (size - bbox.h * k) / 2;
  // The gradient line must reach t=1 at the far corner, so it is scaled by the
  // same span the original renderer used rather than by the unit direction.
  const gx = GRAD.dx * GRAD.span * size;
  const gy = GRAD.dy * GRAD.span * size;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs><linearGradient id="brand" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${gx.toFixed(3)}" y2="${gy.toFixed(3)}">
    <stop offset="${GRAD.solid * 100}%" stop-color="${GRAD.from}"/>
    <stop offset="100%" stop-color="${GRAD.to}"/>
  </linearGradient></defs>
  ${plate ? `<rect width="${size}" height="${size}" rx="${(size * CORNER).toFixed(2)}" ry="${(size * CORNER).toFixed(2)}" fill="url(#brand)"/>` : ""}
  <g transform="translate(${(tx - bbox.x * k).toFixed(3)} ${(ty - bbox.y * k).toFixed(3)}) scale(${k.toFixed(6)})" fill="${ink}">${mark}</g>
</svg>`;
}

/** Pulls just the `<path>` out of the mark file. */
function readMarkPath() {
  const src = readFileSync(MARK, "utf8");
  const path = /<path\b[\s\S]*?\/>/.exec(src);
  if (!path) throw new Error(`no <path> found in ${MARK}`);
  // The mark paints itself `currentColor`; let the caller decide the ink instead.
  return path[0].replace(/\sfill="[^"]*"/, "");
}

const log = (...a) => console.log(...a);

app.disableHardwareAcceleration();

app.whenReady()
  .then(async () => {
    log("app ready");
    const win = new BrowserWindow({ show: false, width: 800, height: 600 });
    await win.loadURL("data:text/html,<meta charset=utf-8><body></body>");
    log("page loaded");

    const mark = readMarkPath();

    // Measure the mark once: SVG path geometry is the only honest source for its
    // bounds, and everything downstream scales from this box.
    const bbox = await win.webContents.executeJavaScript(`(() => {
      const host = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      host.setAttribute('viewBox', '0 0 300 93');
      host.innerHTML = ${JSON.stringify(mark)};
      document.body.appendChild(host);
      const b = host.querySelector('path').getBBox();
      host.remove();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    })()`);
    log(
      `mark bbox ${bbox.w.toFixed(1)}x${bbox.h.toFixed(1)} at (${bbox.x.toFixed(1)}, ${bbox.y.toFixed(1)}) — ${(bbox.w / bbox.h).toFixed(2)}:1`,
    );

    const render = async (size, opts) => {
      const url = await win.webContents.executeJavaScript(`(() => {
        const svg = ${JSON.stringify(compose({ size, mark, bbox, ...opts }))};
        return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      })()`);
      const png = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = ${size};
          c.height = ${size};
          c.getContext('2d').drawImage(img, 0, 0);
          resolve(c.toDataURL('image/png'));
        };
        img.onerror = () => reject(new Error('svg failed to load'));
        img.src = ${JSON.stringify(url)};
      })`);
      return png;
    };

    // The mark is ~3.4:1, so it is sized by width and centred vertically. Tray
    // glyphs go full-bleed because Windows draws them very small.
    const targets = [
      ["icon.png", 512, { plate: true, ink: "#ffffff", width: 0.8 }],
      ["icon-256.png", 256, { plate: true, ink: "#ffffff", width: 0.8 }],
      ["icon-128.png", 128, { plate: true, ink: "#ffffff", width: 0.8 }],
      ["icon-64.png", 64, { plate: true, ink: "#ffffff", width: 0.8 }],
      // Tray icons follow the Windows convention: monochrome glyph, no plate.
      ["tray.png", 32, { plate: false, ink: "#a8a8a8", width: 1 }],
      ["tray@2x.png", 64, { plate: false, ink: "#a8a8a8", width: 1 }],
      ["tray-playing.png", 32, { plate: false, ink: "#ffffff", width: 1 }],
      ["tray-playing@2x.png", 64, { plate: false, ink: "#ffffff", width: 1 }],
    ];

    mkdirSync(RES, { recursive: true });
    for (const [name, size, opts] of targets) {
      const dataUrl = await render(size, opts);
      const buf = Buffer.from(String(dataUrl).split(",")[1], "base64");
      writeFileSync(join(RES, name), buf);
      log(`${name.padEnd(20)} ${size}x${size}  ${(buf.length / 1024).toFixed(1)} KB`);
    }

    log("icons written to resources/");
    app.exit(0);
  })
  .catch((err) => {
    console.error("icon generation failed:", err);
    app.exit(1);
  });

// Never hang a build waiting on a window.
setTimeout(() => {
  console.error("icon generation timed out");
  app.exit(1);
}, 60_000).unref?.();
