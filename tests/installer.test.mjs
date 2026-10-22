import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { renderAsset, toBitmap } from '../scripts/installer-assets.mjs';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const config = JSON.parse(read('src-tauri/tauri.conf.json'));
const nsis = config.bundle.windows.nsis;

test('installer and uninstaller default to Simplified Chinese without an extra language dialog', () => {
  assert.deepEqual(nsis.languages, ['SimpChinese']);
  assert.equal(nsis.displayLanguageSelector, false);
  assert.equal(nsis.template, undefined, 'Keep the maintained Tauri installer template');
  assert.equal(config.plugins.updater.windows.installMode, 'passive');
  assert.equal(config.bundle.windows.webviewInstallMode.type, 'downloadBootstrapper');
  assert.equal(config.bundle.licenseFile, '../LICENSE');
  for (const key of ['installerIcon', 'uninstallerIcon', 'installerHooks']) {
    assert.ok(existsSync(new URL('src-tauri/' + nsis[key], root)));
  }
});

test('installer artwork is reproducible, opaque 24-bit BMP at NSIS native dimensions', () => {
  for (const [name, key, width, height] of [
    ['sidebar', 'sidebarImage', 164, 314],
    ['header', 'headerImage', 150, 57],
  ]) {
    const bitmap = readFileSync(new URL('src-tauri/' + nsis[key], root));
    assert.equal(bitmap.toString('ascii', 0, 2), 'BM');
    assert.equal(bitmap.readUInt32LE(2), bitmap.length);
    assert.equal(bitmap.readUInt32LE(10), 54);
    assert.equal(bitmap.readInt32LE(18), width);
    assert.equal(bitmap.readInt32LE(22), height);
    assert.equal(bitmap.readUInt16LE(28), 24);
    assert.equal(bitmap.readUInt32LE(30), 0, 'No unsupported bitmap compression');
    assert.deepEqual(bitmap, toBitmap(renderAsset(name)), 'Regenerate artwork with npm run installer:assets');
  }
});

test('bitmap encoding preserves BGR, bottom-up rows and four-byte row alignment', () => {
  const bmp = toBitmap({ width: 1, height: 2, pixels: Uint8Array.from([255, 0, 0, 255, 0, 0, 255, 255]) });
  assert.deepEqual([...bmp.subarray(54)], [255, 0, 0, 0, 0, 0, 255, 0]);
  assert.throws(() => toBitmap({ width: 1, height: 1, pixels: Uint8Array.from([0, 0, 0, 0]) }), /opaque/);
});

test('appearance changes remain declarative and do not override install or update operations', () => {
  const appearance = read('src-tauri/' + nsis.installerHooks);
  assert.match(appearance, /SetFont "Microsoft YaHei UI" 9/);
  assert.match(appearance, /欢迎安装/);
  assert.match(appearance, /安装完成/);
  assert.match(appearance, /不会安装或升级 WSL 中的 DSH/);
  assert.doesNotMatch(appearance, /^\s*(?:Function|Section|!macro NSIS_HOOK_|Exec|Delete|RMDir)\b/m);
  assert.doesNotMatch(appearance, /!define MUI_(?:PAGE_CUSTOMFUNCTION_PRE|FINISHPAGE_SHOWREADME_TEXT|FINISHPAGE_RUN_FUNCTION)\b/);
  assert.match(read('scripts/Build-Windows.ps1'), /'src-tauri\/installer'/);
});
