/**
 * Generate placeholder PWA icons (icon-192.png, icon-512.png, icon-maskable.png)
 * into public/ using ONLY built-in Node.js modules — no native C++ deps.
 *
 * Run: npm run icons
 *
 * Replace the generated PNGs with real artwork before going live.
 */

import { deflateSync }     from 'zlib';
import { writeFileSync }   from 'fs';
import { join, dirname }   from 'path';
import { fileURLToPath }   from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC    = join(__dirname, '..', 'public');

// ── Minimal pure-JS PNG encoder ───────────────────────────────────────────────

function uint32be(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

// Pre-computed CRC32 table
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const payload   = Buffer.concat([typeBytes, data]);
  return Buffer.concat([uint32be(data.length), payload, uint32be(crc32(payload))]);
}

/**
 * Create a solid-color PNG.
 * @param {number} size  — pixel width/height
 * @param {number} r,g,b — fill colour (0–255)
 */
function solidPng(size, r, g, b) {
  const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR: width height bitDepth colorType(2=RGB) compression filter interlace
  const ihdr = Buffer.concat([
    uint32be(size), uint32be(size),
    Buffer.from([8, 2, 0, 0, 0]),
  ]);

  // Raw image data: one filter byte (0=None) + RGB pixels per row
  const row = Buffer.alloc(1 + size * 3);
  row[0] = 0;
  for (let x = 0; x < size; x++) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw        = Buffer.concat(Array.from({ length: size }, () => row));
  const compressed = deflateSync(raw);

  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Brand colour: #6b8aed → (107, 138, 237)
const [R, G, B] = [107, 138, 237];

writeFileSync(join(PUBLIC, 'icon-192.png'),      solidPng(192, R, G, B));
writeFileSync(join(PUBLIC, 'icon-512.png'),      solidPng(512, R, G, B));
writeFileSync(join(PUBLIC, 'icon-maskable.png'), solidPng(512, R, G, B));

console.log('✅ Icons written to public/');
console.log('   icon-192.png (192×192), icon-512.png (512×512), icon-maskable.png (512×512)');
console.log('   All solid #6b8aed — replace with real artwork before going live.');
