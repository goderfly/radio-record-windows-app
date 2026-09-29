/**
 * Quick PNG sanity check: decodes the image and reports how much of it is
 * actually content.
 *
 * A screenshot that is all background colour still passes every size and
 * format check, so the only way to know it shows the app is to look at the
 * pixels: count distinct colours, and the share that is not the modal colour.
 *
 *   node tools/inspect-png.mjs <file.png> [...]
 */
import { readFileSync, readdirSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { join } from "node:path";

/** PNG colour type -> samples per pixel. Only the types Chromium emits. */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function readChunks(buf) {
  let off = 8; // skip the signature
  const chunks = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    chunks.push({ type, data: buf.subarray(off + 8, off + 8 + len) });
    off += 12 + len; // length + type + payload + crc
  }
  return chunks;
}

/** Reverses the per-scanline PNG filters, in place over the whole image. */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0; // left
      const b = prev ? prev[x] : 0; // up
      const c = prev && x >= bpp ? prev[x - bpp] : 0; // up-left
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error(`unknown filter ${filter} on row ${y}`);
      }
      cur[x] = v & 0xff;
    }
  }
  return out;
}

function inspect(file) {
  const buf = readFileSync(file);
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === "IHDR")?.data;
  if (!ihdr) throw new Error(`${file}: no IHDR`);

  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const depth = ihdr[8];
  const colorType = ihdr[9];
  const bpp = (CHANNELS[colorType] ?? 3) * (depth / 8);
  if (depth !== 8) throw new Error(`${file}: only 8-bit depth supported, got ${depth}`);

  const idat = Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data));
  const px = unfilter(inflateSync(idat), width, height, bpp);

  // Quantise to 5 bits per channel: enough to tell "one flat colour" from
  // "a rendered interface" without letting sensor noise inflate the count.
  const counts = new Map();
  const step = bpp >= 3 ? bpp : 3;
  for (let i = 0; i + 2 < px.length; i += step) {
    const key = (px[i] >> 3) << 10 | (px[i + 1] >> 3) << 5 | px[i + 2] >> 3;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const total = Math.max(1, Math.floor(px.length / step));
  const sorted = [...counts.values()].sort((a, b) => b - a);
  const dominant = sorted[0] / total;
  const top20 = sorted.slice(0, 20).reduce((a, b) => a + b, 0) / total;

  // Average luminance, to tell a dark UI from a light one.
  let lum = 0;
  let n = 0;
  for (let i = 0; i + 2 < px.length; i += step) {
    lum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    n++;
  }

  return {
    file: file.replace(/^.*[\\/]/, ""),
    size: `${width}x${height}`,
    kb: Math.round(buf.length / 1024),
    distinctColors: counts.size,
    dominantShare: `${(dominant * 100).toFixed(1)}%`,
    top20Share: `${(top20 * 100).toFixed(1)}%`,
    avgLuminance: Math.round(lum / n),
    verdict:
      counts.size < 200 ? "FLAT - almost certainly blank" : top20 > 0.995 ? "FLAT - one colour dominates" : "has content",
  };
}

/**
 * Expands a shell glob into a sorted file list.
 *
 * Done here rather than left to the shell because PowerShell passes a wildcard
 * through to a native command verbatim, so `node inspect-png.mjs docs\*.png`
 * arrives as one literal path and dies on ENOENT.
 */
function expand(pattern) {
  const star = Math.max(pattern.lastIndexOf("*"), pattern.lastIndexOf("?"));
  if (star < 0) return [pattern];
  // Everything before the first wildcard is the directory to list. It is used
  // as-is rather than run through dirname(): dirname("docs") is ".", since a
  // path with no separator has the working directory as its parent, so the
  // search would silently run against the repo root instead of docs/.
  const dir = pattern.slice(0, star).replace(/[\\/]+$/, "") || ".";
  const rx = new RegExp(
    `^${pattern
      .slice(star)
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
    "i",
  );
  return readdirSync(dir || ".")
    .filter((n) => rx.test(n))
    .sort()
    .map((n) => join(dir, n));
}

let bad = 0;
const files = process.argv.slice(2).flatMap(expand);
if (files.length === 0) {
  console.error("no files matched");
  process.exit(1);
}
for (const f of files) {
  try {
    console.log(inspect(f));
  } catch (err) {
    bad += 1;
    console.log({ file: f, verdict: `UNREADABLE - ${err.message}` });
  }
}
process.exit(bad ? 1 : 0);
