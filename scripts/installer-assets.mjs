import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Resvg } from '@resvg/resvg-js';

// NSIS expects an opaque, uncompressed Windows bitmap, not a renamed PNG.
export function toBitmap({ width, height, pixels }) {
  const stride = Math.ceil(width * 3 / 4) * 4;
  const data = Buffer.alloc(54 + stride * height);
  data.write('BM');
  data.writeUInt32LE(data.length, 2);
  data.writeUInt32LE(54, 10);
  data.writeUInt32LE(40, 14);
  data.writeInt32LE(width, 18);
  data.writeInt32LE(height, 22);
  data.writeUInt16LE(1, 26);
  data.writeUInt16LE(24, 28);
  data.writeUInt32LE(stride * height, 34);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = 54 + (height - 1 - y) * stride + x * 3;
      if (pixels[src + 3] !== 255) throw new Error('Installer artwork must be opaque');
      data[dst] = pixels[src + 2];
      data[dst + 1] = pixels[src + 1];
      data[dst + 2] = pixels[src];
    }
  }
  return data;
}

export function renderAsset(name) {
  const source = new URL(`../src-tauri/installer/${name}.svg`, import.meta.url);
  return new Resvg(readFileSync(source), { font: { loadSystemFonts: false } }).render();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  for (const name of ['sidebar', 'header']) {
    writeFileSync(new URL(`../src-tauri/installer/${name}.bmp`, import.meta.url), toBitmap(renderAsset(name)));
    console.log(`Generated ${name}.bmp`);
  }
}
