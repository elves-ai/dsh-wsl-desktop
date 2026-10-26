import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('project paths retain native read-only pickers', () => {
  const source = read('src/main.ts');
  for (const id of ['repository-input', 'setup-repository', 'setup-node']) {
    const input = source.match(new RegExp('<input id="' + id + '"[^>]*>'))?.[0];
    assert.ok(input, id); assert.match(input, /readonly/); assert.match(input, /aria-readonly="true"/);
  }

});

test('one native picker command is registered only for local trusted launcher/settings views', () => {
  const name = 'pick_settings_path', permission = 'allow-pick-settings-path';
  assert.ok(read('src-tauri/build.rs').includes('"' + name + '"'));
  assert.ok(read('src-tauri/src/desktop.rs').includes('path_picker::' + name));
  assert.doesNotMatch(read('src-tauri/build.rs') + read('src-tauri/src/desktop.rs'), /browse_speech_path/);
  const granted = [];
  for (const file of readdirSync(new URL('../src-tauri/capabilities/', import.meta.url)).filter(p => p.endsWith('.json'))) {
    const cap = JSON.parse(read('src-tauri/capabilities/' + file));
    assert.ok(!cap.permissions.includes('allow-browse-speech-path'));
    if (!cap.permissions.includes(permission)) continue;
    assert.equal(cap.local, true); assert.equal(cap.remote, undefined);
    granted.push(...cap.webviews);
  }
  assert.deepEqual(granted.sort(), ['dsh-settings', 'launcher', 'launcher-settings']);
});

test('Windows picker is actual COM with strict scope, hidden files and cancellation, not shell or web browsing', () => {
  const native = read('src-tauri/src/desktop_path_picker.rs');
  for (const token of ['IFileOpenDialog', 'CoInitializeEx', 'COINIT_APARTMENTTHREADED', 'CoUninitialize', 'FOS_PICKFOLDERS', 'FOS_FILEMUSTEXIST', 'FOS_FORCEFILESYSTEM', 'FOS_FORCESHOWHIDDEN', 'FOS_DONTADDTORECENT', 'dialog.SetFolder', 'dialog.Show', 'SIGDN_FILESYSPATH', 'CoTaskMemFree', 'ERROR_CANCELLED', 'return Ok(None)', 'from_unc(distro', 'OPEN.compare_exchange', 'settings_page::assert_active_page', 'controller.snapshot().setup_required', 'crate::setup::distributions', 'view.label() != "launcher"', 'distribution.is_some()']) assert.ok(native.replace(/\s+/g, '').includes(token.replace(/\s+/g, '')), token);
  assert.doesNotMatch(native, /std::process|Command::new|save_config|\.execute\(|\.eval\(|\.navigate\(/);
  assert.match(native, /use crate::settings_path::PathKind/);
  const kinds = read('src-tauri/src/settings_path.rs').match(/enum PathKind\s*\{([^}]+)\}/)?.[1];
  assert.ok(kinds, 'native picker uses the shared typed IPC kinds');
  assert.deepEqual(kinds.split(',').map(s => s.trim()).filter(Boolean), ['Repository', 'SetupRepository', 'SetupNode']);
  assert.doesNotMatch(native, /PythonPath|选择 WSL Python/);
  assert.ok(!read('src-tauri/Cargo.toml').includes('rfd'));
});
