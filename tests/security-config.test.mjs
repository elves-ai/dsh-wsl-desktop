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
  assert.deepEqual([...capability.permissions].sort(), ['allow-get-snapshot', 'allow-perform-action', 'allow-get-update-snapshot', 'allow-check-update', 'allow-install-update', 'core:event:allow-listen', 'core:event:allow-unlisten'].sort());
  assert.ok(config.app.security.csp.includes("object-src 'none'"));
});
test('destructive actions require guarded PID adapter and native default-no confirmation', () => {
  const desktop = read('src-tauri/src/desktop.rs'); const backend = read('src-tauri/src/backend.rs');
  assert.match(desktop, /MB_DEFBUTTON2/); assert.match(desktop, /backend\.stop\(expected_pid\)/);
  assert.match(backend, /include_str!\("\.\.\/helpers\/guarded_stop\.py"\)/);
  assert.ok(!desktop.includes('invoke("stop")'));
  assert.match(desktop, /window\.label\(\) != "launcher"/);
});

test('updater uses only the project HTTPS stable feed and version-bound signatures', () => {
  const config = JSON.parse(read('src-tauri/tauri.conf.json'));
  const updater = config.plugins.updater;
  assert.deepEqual(updater.endpoints, ['https://github.com/elves-ai/dsh-wsl-desktop/releases/latest/download/latest.json']);
  assert.equal(updater.requireSignedVersion, true);
  assert.equal(updater.windows.installMode, 'passive');
  assert.equal(config.bundle.createUpdaterArtifacts, true);
  for (const field of ['dangerousInsecureTransportProtocol', 'dangerousAcceptInvalidCerts', 'dangerousAcceptInvalidHostnames', 'allowDowngrades']) assert.ok(!updater[field]);
  const keyLines = Buffer.from(updater.pubkey, 'base64').toString('utf8').trim().split('\n');
  assert.match(keyLines[0], /^untrusted comment: minisign public key:/);
  assert.equal(Buffer.from(keyLines[1], 'base64').length, 42);
  assert.ok(!JSON.parse(read('src-tauri/capabilities/launcher.json')).permissions.some(permission => permission.startsWith('updater:')));
  assert.ok(!config.app.security.csp.includes('github.com'), 'frontend does not fetch update URLs');
});

test('every updater command enforces the trusted native window before doing work', () => {
  const source = read('src-tauri/src/desktop_updates.rs');
  for (const command of ['get_update_snapshot', 'check_update', 'install_update']) {
    const declaration = source.slice(source.indexOf('fn ' + command + '('));
    assert.match(declaration, /^[\s\S]*?Result<UpdateSnapshot, String> \{\s*assert_local\(&window\)\?;/);
    const params = declaration.slice(0, declaration.indexOf(') ->'));
    assert.doesNotMatch(params, /url:|signature:|version:|path:|args:/, 'frontend cannot choose an installer or trust key');
  }
  assert.match(source, /https_only\(true\)/);
  assert.match(source, /MB_DEFBUTTON2/);
  assert.ok(source.indexOf('confirm_install(&version)') < source.indexOf('.download('));
  assert.ok(source.indexOf('.download(') < source.indexOf('package.install(bytes)'));
  assert.doesNotMatch(source, /backend\.(?:stop|start)\(|stop_service\(/);
});

test('native update serializes with service/tray operations and preserves retry on installer rejection', () => {
  const source = read('src-tauri/src/desktop_updates.rs');
  assert.match(source, /state\.gate\.enter\(\)/);
  assert.match(source, /ServiceLease::enter\(&app\)\?/);
  assert.match(source, /compare_exchange\(false, true/);
  assert.match(source, /impl Drop for ServiceLease[\s\S]*?busy.store\(false/);
  assert.match(source, /data\.package = None/);
  assert.match(source, /on_before_exit\(\|\| \{\}\)/);
  assert.doesNotMatch(source, /cleanup_before_exit\(/);
});

test('local builds explicitly avoid production updater signing secrets', () => {
  const local = JSON.parse(read('src-tauri/tauri.local-build.conf.json'));
  assert.deepEqual(local, { bundle: { createUpdaterArtifacts: false } });
  const script = read('scripts/Build-Windows.ps1');
  assert.match(script, /--config src-tauri\/tauri.local-build.conf.json/);
  for (const contents of [read('.gitignore'), '.tools/\r\nnode_modules/\r\n', '.tools/\nnode_modules/\n']) {
    assert.ok(contents.split(/\r?\n/).includes('.tools/'));
  }
});
