// Draws the app icon (a white calendar on blue) as PNGs for phones and
// browsers: node scripts/make-icons.js
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BLUE = [37, 87, 214];
const WHITE = [255, 255, 255];

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Pixel colour at (x, y) in a unit square: full-bleed blue (maskable-safe) with a calendar in the middle. */
function pixel(u, v) {
  const inside = (x0, y0, x1, y1) => u >= x0 && u < x1 && v >= y0 && v < y1;
  // Calendar body with a header band and a 3x2 grid of day cells.
  if (inside(0.27, 0.30, 0.73, 0.74)) {
    if (inside(0.27, 0.30, 0.73, 0.40)) return WHITE;
    const cells = [0.32, 0.46, 0.60].flatMap((x) => [0.47, 0.60].map((y) => [x, y]));
    if (cells.some(([x, y]) => inside(x, y, x + 0.08, y + 0.08))) return BLUE;
    return WHITE;
  }
  // Two rings on top.
  if (inside(0.36, 0.25, 0.41, 0.33) || inside(0.59, 0.25, 0.64, 0.33)) return WHITE;
  return BLUE;
}

function png(size) {
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = pixel((x + 0.5) / size, (y + 0.5) / size);
      row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(out, { recursive: true });
for (const size of [180, 192, 512]) fs.writeFileSync(path.join(out, `icon-${size}.png`), png(size));
console.log('icons written to', out);
