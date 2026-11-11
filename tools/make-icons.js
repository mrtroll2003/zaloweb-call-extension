'use strict';
// Draws the extension icons (blue rounded tile with a white phone handset)
// into extension/icons/*.png. No dependencies: tiny SVG-path rasterizer with
// 8x8 supersampling and a minimal PNG writer.
// The handset is the Material Design "call" icon path (Apache License 2.0).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PHONE =
  'M20.01 15.38c-1.23 0-2.42-.2-3.53-.56-.35-.12-.74-.03-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83' +
  'l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99' +
  ' 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z';

// --- SVG path -> polygons (supports M m L l H h V v C c Z z) ---
function pathToPolys(d) {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/g);
  let i = 0;
  let cmd = null;
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  const polys = [];
  let cur = null;
  const num = () => parseFloat(tokens[i++]);
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    switch (cmd) {
      case 'M':
      case 'm': {
        const nx = num();
        const ny = num();
        x = cmd === 'm' ? x + nx : nx;
        y = cmd === 'm' ? y + ny : ny;
        sx = x;
        sy = y;
        cur = [[x, y]];
        polys.push(cur);
        cmd = cmd === 'm' ? 'l' : 'L';
        break;
      }
      case 'L':
      case 'l': {
        const nx = num();
        const ny = num();
        x = cmd === 'l' ? x + nx : nx;
        y = cmd === 'l' ? y + ny : ny;
        cur.push([x, y]);
        break;
      }
      case 'H':
      case 'h':
        x = cmd === 'h' ? x + num() : num();
        cur.push([x, y]);
        break;
      case 'V':
      case 'v':
        y = cmd === 'v' ? y + num() : num();
        cur.push([x, y]);
        break;
      case 'C':
      case 'c': {
        const rel = cmd === 'c';
        const p = [num(), num(), num(), num(), num(), num()];
        const [x1, y1, x2, y2, x3, y3] = rel ? [x + p[0], y + p[1], x + p[2], y + p[3], x + p[4], y + p[5]] : p;
        for (let s = 1; s <= 16; s++) {
          const t = s / 16;
          const u = 1 - t;
          cur.push([
            u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
            u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
          ]);
        }
        x = x3;
        y = y3;
        break;
      }
      case 'Z':
      case 'z':
        x = sx;
        y = sy;
        cur.push([x, y]);
        break;
      default:
        throw new Error(`unsupported path command ${cmd}`);
    }
  }
  return polys;
}

function insidePolys(polys, px, py) {
  let wind = 0;
  for (const poly of polys) {
    for (let k = 0; k < poly.length - 1; k++) {
      const [x0, y0] = poly[k];
      const [x1, y1] = poly[k + 1];
      if (y0 <= py) {
        if (y1 > py && (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0) > 0) wind++;
      } else if (y1 <= py && (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0) < 0) wind--;
    }
  }
  return wind !== 0;
}

function insideRoundRect(px, py, size, r) {
  const cx = Math.min(Math.max(px, r), size - r);
  const cy = Math.min(Math.max(py, r), size - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

function render(size) {
  const polys = pathToPolys(PHONE);
  const SS = 8;
  const rgba = Buffer.alloc(size * size * 4);
  const glyph = size * 0.62; // handset box (24 units) scaled to 62% of the tile
  const off = (size - glyph) / 2;
  const radius = size * 0.22;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;
          if (!insideRoundRect(x, y, size, radius)) continue;
          bg++;
          const gx = ((x - off) / glyph) * 24;
          const gy = ((y - off) / glyph) * 24;
          if (gx >= 0 && gy >= 0 && gx <= 24 && gy <= 24 && insidePolys(polys, gx, gy)) fg++;
        }
      }
      const n = SS * SS;
      const a = bg / n;
      const f = bg ? fg / bg : 0;
      // vertical gradient #1a8cff -> #0062e6
      const t = py / Math.max(1, size - 1);
      const br = 0x1a + (0x00 - 0x1a) * t;
      const bgG = 0x8c + (0x62 - 0x8c) * t;
      const bb = 0xff + (0xe6 - 0xff) * t;
      const o = (py * size + px) * 4;
      rgba[o] = Math.round(br + (255 - br) * f);
      rgba[o + 1] = Math.round(bgG + (255 - bgG) * f);
      rgba[o + 2] = Math.round(bb + (255 - bb) * f);
      rgba[o + 3] = Math.round(a * 255);
    }
  }
  return encodePng(size, size, rgba);
}

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = Array.from({ length: 256 }, (_, n) => {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'extension', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, render(size));
  console.log('wrote', file);
}
