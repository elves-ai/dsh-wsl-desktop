import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { iconSizes, renderIcon, createIco } from '../scripts/icon-assets.mjs';
import { renderAsset } from '../scripts/installer-assets.mjs';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const binary = path => readFileSync(new URL(path, root));
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function pngInfo(png) {
  assert.ok(png.length >= 33, 'PNG includes an IHDR chunk');
  assert.deepEqual(png.subarray(0, 8), pngSignature);
  assert.equal(png.readUInt32BE(8), 13);
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  assert.equal(png[24], 8, 'Eight-bit channels');
  assert.equal(png[25], 6, 'RGBA preserves transparency');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

// Decode through the existing renderer rather than introducing a PNG dependency.
function decodePng(png) {
  const { width, height } = pngInfo(png);
  return new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image width="${width}" height="${height}" href="data:image/png;base64,${png.toString('base64')}"/></svg>`, {
    font: { loadSystemFonts: false },
  }).render();
}

function pixelCount({ width, height, pixels }, predicate, region = [0, 0, width, height]) {
  const [left, top, regionWidth, regionHeight] = region;
  assert.ok(left >= 0 && top >= 0 && left + regionWidth <= width && top + regionHeight <= height);
  let count = 0;
  for (let y = top; y < top + regionHeight; y++) {
    for (let x = left; x < left + regionWidth; x++) {
      const offset = (y * width + x) * 4;
      if (predicate(pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3])) count++;
    }
  }
  return count;
}

// Excludes the installer's dark blue background, but allows antialiased logo edges.
const isBlue = (red, green, blue, alpha) => alpha >= 160 && blue >= 140 && blue - red >= 35 && blue - green >= 10;

function assertRoundedTransparency(image) {
  const { width, height, pixels } = image;
  assert.equal(pixels.length, width * height * 4);
  for (const [x, y] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]) {
    assert.equal(pixels[(y * width + x) * 4 + 3], 0, `Transparent corner at ${x},${y}`);
  }
  const inset = Math.ceil(width / 4);
  const body = [inset, inset, width - 2 * inset, height - 2 * inset];
  const opaque = pixelCount(image, (_r, _g, _b, alpha) => alpha === 255, body);
  assert.ok(opaque >= body[2] * body[3] * 0.95, 'The central body remains opaque');
}

test('canonical application PNG is square RGBA with transparent rounded corners', () => {
  const png = binary('app-icon.png');
  const { width, height } = pngInfo(png);
  assert.equal(width, height);
  assert.ok(width >= 256, 'Canonical source supports the largest Windows icon');
  assertRoundedTransparency(decodePng(png));
});

test('Windows icon sizes include all approved taskbar, tray and high-DPI resolutions', () => {
  assert.deepEqual(iconSizes, sizes);
});

for (const size of sizes) {
  test(`${size}px icon is reproducible RGBA and retains blue in the lower composition`, () => {
    const image = renderIcon(size);
    assert.equal(image.width, size);
    assert.equal(image.height, size);
    assertRoundedTransparency(image);
    const png = Buffer.from(image.asPng());
    assert.deepEqual(pngInfo(png), { width: size, height: size });
    assert.deepEqual(png, Buffer.from(renderIcon(size).asPng()));
    const decoded = decodePng(png);
    assertRoundedTransparency(decoded);
    const top = Math.floor(size * 0.6);
    // Check color survival, not tiny Windows/arrows/Linux pattern recognition.
    assert.ok(pixelCount(decoded, isBlue, [0, top, size, size - top]) >= 1, 'Lower blue detail must survive downsampling');
  });
}

test('committed Tauri PNG assets exactly reproduce the canonical source rendering', () => {
  for (const [name, size] of [['32x32.png', 32], ['128x128.png', 128], ['128x128@2x.png', 256]]) {
    const png = binary(`src-tauri/icons/${name}`);
    assert.deepEqual(pngInfo(png), { width: size, height: size });
    assert.deepEqual(png, Buffer.from(renderIcon(size).asPng()), `Regenerate ${name} from app-icon.png`);
    assertRoundedTransparency(decodePng(png));
  }
});

test('Windows ICO has complete 32-bit entries, contiguous offsets and matching PNG payloads', () => {
  const ico = binary('src-tauri/icons/icon.ico');
  assert.deepEqual(ico, Buffer.from(createIco()), 'Committed ICO is reproducible');
  assert.deepEqual(Buffer.from(createIco()), Buffer.from(createIco()), 'Repeated ICO generation is deterministic');
  assert.equal(ico.readUInt16LE(0), 0, 'Reserved header');
  assert.equal(ico.readUInt16LE(2), 1, 'Windows icon, not cursor');
  assert.equal(ico.readUInt16LE(4), sizes.length);
  let nextOffset = 6 + sizes.length * 16;
  for (const [index, size] of sizes.entries()) {
    const entry = 6 + index * 16;
    assert.equal(ico[entry], size === 256 ? 0 : size, '256px width is encoded as zero');
    assert.equal(ico[entry + 1], size === 256 ? 0 : size, '256px height is encoded as zero');
    assert.equal(ico[entry + 2], 0, 'True-color entry has no palette');
    assert.equal(ico[entry + 3], 0, 'Reserved entry byte');
    assert.equal(ico.readUInt16LE(entry + 4), 1, 'One color plane');
    assert.equal(ico.readUInt16LE(entry + 6), 32, '32-bit RGBA icon');
    const length = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    assert.equal(offset, nextOffset, 'Payloads do not overlap or leave gaps');
    assert.ok(length > 0 && offset + length <= ico.length, 'Payload stays within the file');
    const payload = ico.subarray(offset, offset + length);
    assert.deepEqual(pngInfo(payload), { width: size, height: size });
    assert.deepEqual(payload, Buffer.from(renderIcon(size).asPng()), `${size}px ICO payload matches PNG rendering`);
    nextOffset += length;
  }
  assert.equal(nextOffset, ico.length, 'No trailing or unreferenced ICO bytes');
});

test('frontend and Windows staging reference the same canonical application icon', () => {
  const main = read('src/main.ts');
  assert.match(main, /import\s+appIconUrl\s+from\s+['"]\.\.\/app-icon\.png['"]/);
  assert.match(main, /<img\b[^>]*\bsrc=["']\$\{appIconUrl\}["']/);
  assert.match(read('titlebar.html'), /<img\b[^>]*\bsrc=["']\/app-icon\.png["']/);
  assert.match(read('index.html'), /<link\b[^>]*\bhref=["']\/app-icon\.png["']/);
  const rootFiles = read('scripts/Build-Windows.ps1').match(/\$rootFiles\s*=\s*@\(([\s\S]*?)\)/);
  assert.ok(rootFiles, 'Windows build declares staged root files');
  assert.match(rootFiles[1], /['"]app-icon\.png['"]/);
  const { bundle } = JSON.parse(read('src-tauri/tauri.conf.json'));
  for (const path of ['icons/icon.ico', 'icons/32x32.png', 'icons/128x128.png', 'icons/128x128@2x.png']) {
    assert.ok(bundle.icon.includes(path), `${path} is bundled`);
  }
  assert.equal(bundle.windows.nsis.installerIcon, 'icons/icon.ico');
  assert.equal(bundle.windows.nsis.uninstallerIcon, 'icons/icon.ico');
});

for (const [name, region] of [['header', [92, 4, 49, 49]], ['sidebar', [22, 26, 88, 88]]]) {
  test(`installer ${name} resolves and visibly renders the shared application PNG`, () => {
    assert.match(read(`src-tauri/installer/${name}.svg`), /<image\b[^>]*\bhref=["']\.\.\/\.\.\/app-icon\.png["']/);
    // An unresolved SVG image may silently disappear: checking href alone misses that.
    const blue = pixelCount(renderAsset(name), isBlue, region);
    assert.ok(blue >= Math.ceil(region[2] * region[3] * 0.005), `${name} logo region must contain rendered bright blue pixels (got ${blue})`);
  });
}
