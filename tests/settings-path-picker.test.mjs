import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('all settings and onboarding paths are read-only and have explicit native pick actions', () => {
  for (const [file, ids] of [['src/main.ts', ['repository-input', 'setup-repository', 'setup-node']], ['src/speech-settings.ts', ['speech-model_dir', 'speech-python_path', 'speech-native_lib']]]) {
    const source = read(file);
    for (const id of ids) {
      const input = source.match(new RegExp('<input id="' + id + '"[^>]*>'))?.[0];
      assert.ok(input, id); assert.match(input, /readonly/); assert.match(input, /aria-readonly="true"/);
    }
  }
  const resource = read('src/speech-resources.ts');
  assert.doesNotMatch(resource, /browse_speech_path|speech-resource-(?:path|go|parent|browser|entries)/);
  assert.ok(resource.includes("invoke<unknown>('pick_settings_path'"));
  assert.ok(resource.includes('speech-resource-python'));
  assert.doesNotMatch(resource + read('src/speech-settings.ts'), /暂不支持 NVIDIA CUDA|当前语音后端仅实现 AMD ROCm/);
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
  for (const token of ['IFileOpenDialog', 'CoInitializeEx', 'COINIT_APARTMENTTHREADED', 'CoUninitialize', 'FOS_PICKFOLDERS', 'FOS_FILEMUSTEXIST', 'FOS_FORCEFILESYSTEM', 'FOS_FORCESHOWHIDDEN', 'FOS_DONTADDTORECENT', 'dialog.SetFolder', 'dialog.Show', 'SIGDN_FILESYSPATH', 'CoTaskMemFree', 'ERROR_CANCELLED', 'return Ok(None)', 'from_unc(distro', 'OPEN.compare_exchange', 'speech_settings::assert_page', 'controller.snapshot().setup_required', 'crate::setup::distributions', 'view.label() != "launcher"', 'distribution.is_some()']) assert.ok(native.replace(/\s+/g, '').includes(token.replace(/\s+/g, '')), token);
  assert.doesNotMatch(native, /std::process|Command::new|save_config|\.execute\(|\.eval\(|\.navigate\(/);
  const kinds = native.match(/enum PathKind\s*\{([^}]+)\}/)?.[1];
  assert.deepEqual(kinds.split(',').map(s => s.trim()).filter(Boolean), ['Repository', 'ModelDir', 'PythonPath', 'NativeLib', 'SetupRepository', 'SetupNode']);
  assert.ok(!read('src-tauri/Cargo.toml').includes('rfd'));
});
