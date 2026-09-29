/**
 * Numerically inspects the generated icons: decodes the PNGs and reports the
 * opaque bounding box, the mark's position, contrast and coverage.
 *
 * Screenshots cannot be eyeballed from here, so this stands in for a visual
 * check: it catches a blank plate, a mark that overflows or drifts off-centre,
 * and a tray glyph too thin to read at 16px.
 *
 *   node tools/check-icons.mjs [name.png ...]
 */
import { inflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RES = join(dirname(fileURLToPath(import.meta.url)), "..", "resources");

function decodePng(buf) {
  let p = 8; // signature
  let ihdr = null;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      ihdr = {
        w: data.readUInt32BE(0),
        h: data.readUInt32BE(4),
        depth: data[8],
        color: data[9],
        interlace: data[12],
      };
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  if (!ihdr) throw new Error("no IHDR");
  if (ihdr.depth !== 8) throw new Error(`unsupported bit depth ${ihdr.depth}`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.color];
  if (!channels) throw new Error(`unsupported colour type ${ihdr.color}`);
  if (ihdr.interlace) throw new Error("interlaced PNG");

  const raw = inflateSync(Buffer.concat(idat));
  const stride = ihdr.w * channels;
  const out = Buffer.alloc(stride * ihdr.h);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < ihdr.h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    prev = cur;
  }
  return { ...ihdr, channels, data: out };
}

/** Relative luminance per WCAG. */
const lum = (r, g, b) => {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => {
  const la = lum(...a);
  const lb = lum(...b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
};

let failures = 0;
const check = (ok, label, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(44)} ${detail}`);
};

const names =
  process.argv.slice(2).length
    ? process.argv.slice(2)
    : [
        "icon.png",
        "icon-256.png",
        "icon-128.png",
        "icon-64.png",
        "tray.png",
        "tray@2x.png",
        "tray-playing.png",
        "tray-playing@2x.png",
      ];

for (const name of names) {
  const img = decodePng(readFileSync(join(RES, name)));
  const { w, h, channels, data } = img;
  const at = (x, y) => {
    const i = (y * w + x) * channels;
    return [data[i], data[i + 1], data[i + 2], channels === 4 ? data[i + 3] : 255];
  };
  const plate = name.startsWith("icon");

  // Plate icons: the mark is the white artwork on the gradient.
  // Tray icons: the glyph is every opaque pixel, since the background is clear.
  const isMark = (x, y) => {
    const [r, g, b, a] = at(x, y);
    if (a < 16) return false;
    return plate ? lum(r, g, b) > 0.6 : true;
  };

  let minX = w, minY = h, maxX = -1, maxY = -1, n = 0, sumX = 0, sumY = 0;
  let opaque = 0;
  const hues = new Set();
  const plateInside = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = at(x, y);
      if (a >= 16) opaque += 1;
      hues.add(`${r >> 4},${g >> 4},${b >> 4}`);
      if (isMark(x, y)) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        n += 1;
        sumX += x;
        sumY += y;
      }
    }
  }

  // Contrast is only meaningful where the mark actually sits: sample the plate
  // inside the mark's own box. Pixels near the rounded corners fade to
  // transparent and would otherwise report a bogus worst case.
  if (plate && plateInside.length === 0 && maxX >= 0) {
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const [r, g, b, a] = at(x, y);
        if (a >= 250) plateInside.push([r, g, b]);
      }
    }
  }

  if (maxX < 0) {
    check(false, `${name}: has any artwork`, "nothing was drawn");
    continue;
  }

  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const cx = sumX / n / w;
  const cy = sumY / n / h;
  const markShare = n / (w * h);
  const corners = [at(0, 0)[3], at(w - 1, 0)[3], at(0, h - 1)[3], at(w - 1, h - 1)[3]];
  const cornersClear = corners.every((a) => a < 16);
  const coverage = opaque / (w * h);

  // Contrast between the mark and the plate it sits on. The plate colour is
  // taken as the median of the samples: a worst-case scan would pick up the
  // antialiased rim of the mark itself, which is white by definition.
  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[s.length >> 1];
  };
  const plateRgb =
    plate && plateInside.length
      ? [0, 1, 2].map((c) => median(plateInside.map((p) => p[c])))
      : null;
  const plateContrast = plateRgb ? ratio([255, 255, 255], plateRgb) : 0;

  console.log(
    `${name.padEnd(20)} ${w}x${h}  mark ${bw}x${bh} @(${minX},${minY})  centroid ${cx.toFixed(3)},${cy.toFixed(3)}  ` +
      `mark ${(markShare * 100).toFixed(1)}% of canvas  opaque ${(coverage * 100).toFixed(1)}%  ` +
      `colours ${hues.size}` +
      (plateRgb ? `  plate rgb(${plateRgb.join(",")})  mark/plate contrast ${plateContrast.toFixed(2)}` : ""),
  );

  check(
    Math.abs(cx - 0.5) < 0.03 && Math.abs(cy - 0.5) < 0.03,
    `${name}: artwork is centred`,
    `centroid ${cx.toFixed(3)},${cy.toFixed(3)}`,
  );
  check(maxX < w && maxY < h, `${name}: artwork fits the canvas`, `ends at ${maxX},${maxY} of ${w - 1},${h - 1}`);

  if (plate) {
    check(coverage > 0.6 && coverage < 0.995, `${name}: squircle plate fills the canvas`, `${(coverage * 100).toFixed(1)}% opaque`);
    check(cornersClear, `${name}: corners are cut away`, cornersClear ? "yes" : `alpha ${corners.join(",")}`);
    check(hues.size >= 12, `${name}: brand gradient is drawn`, `${hues.size} colour buckets`);
    check(markShare > 0.02, `${name}: mark is present and visible`, `${(markShare * 100).toFixed(1)}% of canvas`);
    check(plateContrast >= 3, `${name}: mark reads against the plate`, `contrast ${plateContrast.toFixed(2)} (WCAG graphic needs 3)`);
  } else {
    check(cornersClear, `${name}: transparent background`, cornersClear ? "yes" : `alpha ${corners.join(",")}`);
    check(bh >= h * 0.15, `${name}: glyph is tall enough to read`, `height ${bh}/${h}`);
    check(minX <= 1 && maxX >= w - 2, `${name}: glyph uses the full width`, `x ${minX}..${maxX} of ${w}`);
    check(n === opaque, `${name}: glyph is the only ink`, `${n} ink pixels of ${opaque} opaque`);
  }
}

console.log(failures ? `\n${failures} failed` : "\nall icon checks passed");
process.exit(failures ? 1 : 0);
