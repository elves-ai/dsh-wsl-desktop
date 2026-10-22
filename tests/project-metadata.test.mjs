import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('project metadata consistently declares the user-selected MIT license', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
  assert.equal(pkg.license, 'MIT'); assert.equal(lock.packages[''].license, 'MIT');
  assert.equal(pkg.author, 'Evan Yang');
  assert.match(read('src-tauri/Cargo.toml'), /^license = "MIT"$/m);
  assert.equal(tauri.bundle.license, 'MIT'); assert.equal(tauri.bundle.publisher, 'Evan Yang');
  const license = new URL(tauri.bundle.licenseFile, new URL('../src-tauri/', import.meta.url));
  assert.ok(existsSync(license)); assert.match(readFileSync(license, 'utf8'), /Copyright \(c\) 2026 Evan Yang/);
  assert.match(readFileSync(license, 'utf8'), /Permission is hereby granted, free of charge/);
});
test('application documentation preserves unsigned status and privacy boundaries', () => {
  assert.match(read('CODE_SIGNING.md'), /Current status: unsigned/);
  assert.match(read('CODE_SIGNING.md'), /not a statement that current downloads are signed/);
  assert.match(read('DOWNLOADS.md'), /Current downloads are unsigned/);
  assert.match(read('PRIVACY.md'), /not a privacy policy for DeepSeek Harness/);
  assert.match(read('PRIVACY.md'), /Automatic data cleanup during uninstallation has not been verified/);
  const readme = read('README.md');
  for (const path of ['LICENSE', 'PRIVACY.md', 'CODE_SIGNING.md', 'DOWNLOADS.md']) assert.ok(readme.includes('(<'+path+'>)'));
});
