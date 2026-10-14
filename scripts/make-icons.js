import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const name = Buffer.from(type);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, checksum]);
}

function png(size) {
  const rows = [];
  const margin = Math.max(1, Math.round(size * 0.12));
  const barTop = Math.round(size * 0.4);
  const barBottom = Math.round(size * 0.62);
  const barLeft = Math.round(size * 0.22);
  const barRight = Math.round(size * 0.78);
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x += 1) {
      const offset = 1 + x * 4;
      const inside = x >= margin && x < size - margin && y >= margin && y < size - margin;
      const bar = x >= barLeft && x < barRight && y >= barTop && y < barBottom;
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      if (inside) {
        red = 0x1f;
        green = 0x23;
        blue = 0x28;
        alpha = 255;
      }
      if (bar) {
        red = 0xfa;
        green = 0xcc;
        blue = 0x15;
        alpha = 255;
      }
      row[offset] = red;
      row[offset + 1] = green;
      row[offset + 2] = blue;
      row[offset + 3] = alpha;
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'icons');
fs.mkdirSync(directory, { recursive: true });
for (const size of [16, 48, 128]) {
  fs.writeFileSync(path.join(directory, `icon${size}.png`), png(size));
}
