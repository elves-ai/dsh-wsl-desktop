import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
test('only trusted launcher window receives narrowly scoped IPC capabilities', () => {
  const config = JSON.parse(read('src-tauri/tauri.conf.json'));
  const capability = JSON.parse(read('src-tauri/capabilities/launcher.json'));
  assert.deepEqual(config.app.security.capabilities, ['launcher']);
  assert.deepEqual(capability.windows, ['launcher']);
  assert.equal(capability.local, true); assert.equal(capability.remote, undefined);
  assert.deepEqual([...capability.permissions].sort(), ['allow-get-snapshot', 'allow-perform-action', 'core:event:allow-listen', 'core:event:allow-unlisten'].sort());
  assert.ok(config.app.security.csp.includes("object-src 'none'"));
});
test('destructive actions require guarded PID adapter and native default-no confirmation', () => {
  const desktop = read('src-tauri/src/desktop.rs'); const backend = read('src-tauri/src/backend.rs');
  assert.match(desktop, /MB_DEFBUTTON2/); assert.match(desktop, /backend\.stop\(expected_pid\)/);
  assert.match(backend, /include_str!\("\.\.\/helpers\/guarded_stop\.py"\)/);
  assert.ok(!desktop.includes('invoke("stop")'));
  assert.match(desktop, /window\.label\(\) != "launcher"/);
});
