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
  assert.deepEqual([...capability.permissions].sort(), ['allow-get-snapshot', 'allow-perform-action', 'allow-set-project-directory', 'allow-get-update-snapshot', 'allow-check-update', 'allow-install-update', 'allow-get-notification-snapshot', 'allow-set-notifications-enabled', 'allow-test-notification', 'core:event:allow-listen', 'core:event:allow-unlisten'].sort());
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

test('notification commands stay local, fixed-purpose and independent of DSH IPC', () => {
  const source = read('src-tauri/src/desktop_notifications.rs');
  const capability = JSON.parse(read('src-tauri/capabilities/launcher.json'));
  assert.ok(!capability.permissions.some(permission => permission.startsWith('notification:')));
  for (const command of ['get_notification_snapshot', 'set_notifications_enabled', 'test_notification']) {
    const declaration = source.slice(source.indexOf('fn ' + command + '('));
    const body = declaration.slice(declaration.indexOf(') ->'));
    assert.ok(body.slice(body.indexOf('{') + 1).trimStart().startsWith('assert_local(&window)?;'));
    const params = declaration.slice(0, declaration.indexOf(') ->'));
    for (const name of ['title:', 'body:', 'url:', 'path:', 'cookie:', 'token:', 'session_id:']) assert.ok(!params.includes(name));
    assert.ok(read('src-tauri/build.rs').includes('\"' + command + '\"'));
    assert.ok(read('src-tauri/src/desktop.rs').includes('notifications::' + command));
  }
  assert.ok(source.includes('cookies_for_url'));
  assert.ok(source.includes('Sha256::digest(authority.as_bytes())'));
  assert.ok(source.includes('cookie.name() == name'));
  assert.ok(source.includes('NoticeKind::Completed'));
  assert.ok(source.includes('NoticeKind::Failed'));
  assert.ok(source.includes('foreground(&app)'));
  assert.ok(!source.includes('initialization_script'));
  assert.ok(!source.includes('get_webview_window("dsh").emit'));
});

test('startup checks gate service launch and missing environments are never overwritten by monitor probes', () => {
  const source = read('src-tauri/src/desktop.rs');
  const ensure = source.slice(source.indexOf('fn ensure_ready('), source.indexOf('fn stop_service('));
  assert.ok(ensure.indexOf('check_environment(app, controller)?') < ensure.indexOf('backend.invoke("probe")'));
  assert.ok(ensure.indexOf('check_environment(app, controller)?') < ensure.indexOf('backend.start()'));
  assert.ok(source.includes('dispatch(app.handle(), "open")'));
  assert.ok(source.includes('!snapshot.environment.passed()'));
  const check = source.slice(source.indexOf('fn check_environment('), source.indexOf('fn ensure_ready('));
  assert.ok(check.includes('reload_config(controller)'));
  assert.ok(check.includes('if !passed'));
  const save = source.slice(source.indexOf('async fn set_project_directory('), source.indexOf('fn show_launcher('));
  assert.ok(save.includes('assert_local(&window)?;'));
  assert.ok(save.includes('compare_exchange(false, true'));
  assert.ok(save.includes('environment::save_repository'));
  assert.ok(save.includes('ensure_ready(&app, &controller, true)'));
  assert.doesNotMatch(save, /stop_service|backend[.](stop|start)/);
  assert.ok(read('src-tauri/build.rs').includes('"set_project_directory"'));
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
