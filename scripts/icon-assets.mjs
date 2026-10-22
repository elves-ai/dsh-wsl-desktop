import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Resvg } from '@resvg/resvg-js';

export const iconSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const source = readFileSync(new URL('../app-icon.png', import.meta.url)).toString('base64');
const cache = new Map();

export function renderIcon(size) {
  if (!Number.isSafeInteger(size) || size < 1 || size > 4096) {
    throw new RangeError('Icon size must be an integer between 1 and 4096');
  }
  if (!cache.has(size)) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><image width="${size}" height="${size}" href="data:image/png;base64,${source}"/></svg>`;
    cache.set(size, new Resvg(svg).render());
  }
  return cache.get(size);
}

// Windows ICO directory with a lossless 32-bit RGBA PNG at each display scale.
export function createIco() {
  const images = iconSizes.map(size => renderIcon(size).asPng());
  const directory = Buffer.alloc(6 + 16 * images.length);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(images.length, 4);
  let offset = directory.length;
  images.forEach((image, index) => {
    const entry = 6 + index * 16;
    directory[entry] = directory[entry + 1] = iconSizes[index] % 256;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(image.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  });
  return Buffer.concat([directory, ...images]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  for (const [name, size] of [['32x32.png', 32], ['128x128.png', 128], ['128x128@2x.png', 256]]) {
    writeFileSync(new URL(`../src-tauri/icons/${name}`, import.meta.url), renderIcon(size).asPng());
  }
  writeFileSync(new URL('../src-tauri/icons/icon.ico', import.meta.url), createIco());
  console.log('Generated desktop PNGs and Windows ICO from app-icon.png');
}
