// Génère les icônes de l'app : deux points reliés par un trait, sur une tuile graphite.
// node scripts/make-icons.mjs → apps/desktop/resources/{icon.png, icon.ico, tray.png, tray@2x.png}
// Rendu sans dépendance : distances signées, suréchantillonnage 4×4, encodeur PNG et ICO maison.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(import.meta.dirname, '..', 'apps', 'desktop', 'resources');
const TILE = [0x1c, 0x1c, 0x1f];
const INK = [0xed, 0xed, 0xed];

/** Couverture (0 à 1) du symbole et de la tuile au point (x, y), en unités de 0 à 1. */
function shapes(x, y) {
  // Tuile : carré arrondi.
  const r = 0.22;
  const qx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
  const qy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
  const tile = Math.hypot(qx, qy) <= r;
  // Deux points et le trait qui les relie.
  const dot = 0.125;
  const left = Math.hypot(x - 0.3, y - 0.5) <= dot;
  const right = Math.hypot(x - 0.7, y - 0.5) <= dot;
  const link = x >= 0.3 && x <= 0.7 && Math.abs(y - 0.5) <= 0.035;
  return { tile, ink: left || right || link };
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let tile = 0;
      let ink = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const s = shapes((i + (sx + 0.5) / ss) / size, (j + (sy + 0.5) / ss) / size);
          if (s.tile) tile++;
          if (s.tile && s.ink) ink++;
        }
      }
      const n = ss * ss;
      const a = tile / n;
      const k = tile ? ink / tile : 0;
      const o = (j * size + i) * 4;
      for (let c = 0; c < 3; c++) px[o + c] = Math.round(TILE[c] * (1 - k) + INK[c] * k);
      px[o + 3] = Math.round(a * 255);
    }
  }
  return px;
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size) {
  const px = render(size);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8 bits par canal
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
/** ICO avec des images PNG (pris en charge depuis Windows Vista). */
function ico(sizes) {
  const images = sizes.map(png);
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((s, i) => {
    const e = 6 + i * 16;
    header[e] = s >= 256 ? 0 : s;
    header[e + 1] = s >= 256 ? 0 : s;
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(images[i].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  return Buffer.concat([header, ...images]);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'icon.png'), png(512));
writeFileSync(join(OUT, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256]));
writeFileSync(join(OUT, 'tray.png'), png(16));
writeFileSync(join(OUT, 'tray@2x.png'), png(32));
console.log('icônes écrites dans', OUT);
