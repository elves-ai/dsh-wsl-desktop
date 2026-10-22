import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
test('only trusted local content and titlebar views receive narrowly scoped IPC capabilities', () => {
  const config = JSON.parse(read('src-tauri/tauri.conf.json'));
  const capability = JSON.parse(read('src-tauri/capabilities/launcher.json'));
  assert.deepEqual(config.app.security.capabilities, ['launcher', 'titlebar']);
  assert.deepEqual(capability.webviews, ['launcher', 'settings']);
  assert.equal(capability.windows, undefined);
  const titlebar = JSON.parse(read('src-tauri/capabilities/titlebar.json'));
  assert.deepEqual(titlebar.webviews, ['launcher-titlebar', 'settings-titlebar', 'dsh-titlebar']);
  assert.equal(titlebar.windows, undefined);
  assert.equal(titlebar.local, true); assert.equal(titlebar.remote, undefined);
  assert.deepEqual([...titlebar.permissions].sort(), ['core:event:allow-listen', 'core:event:allow-unlisten', 'allow-titlebar-action', 'allow-show-titlebar-menu'].sort());
  assert.equal(capability.local, true); assert.equal(capability.remote, undefined);
  assert.deepEqual([...capability.permissions].sort(), ['allow-get-snapshot', 'allow-open-settings', 'allow-perform-action', 'allow-set-project-directory', 'allow-get-update-snapshot', 'allow-check-update', 'allow-install-update', 'allow-get-notification-snapshot', 'allow-set-notifications-enabled', 'allow-test-notification', 'core:event:allow-listen', 'core:event:allow-unlisten'].sort());
  assert.ok(config.app.security.csp.includes("object-src 'none'"));
});
test('titlebar popup menus preserve guarded actions without a second native menu row', () => {
  const desktop = read('src-tauri/src/desktop.rs');
  const titlebar = read('src-tauri/src/desktop_titlebar.rs');
  for (const label of ['打开 DSH', '诊断日志…', '运行环境与项目目录…', '系统通知设置…', '检查启动器更新…']) assert.ok(titlebar.includes(label));
  for (const menu of ['file', 'settings', 'help']) assert.ok(titlebar.includes('let ' + menu + ' = Menu::with_items'));
  assert.ok(titlebar.includes('menu.popup_at(window, LogicalPosition::new(x, HEIGHT))'));
  assert.equal((desktop.match(/\.on_menu_event\(/g) || []).length, 1, 'popup and tray must not dispatch twice');
  assert.ok(desktop.includes('handle_menu_action(app, event.id.as_ref())'));
  assert.equal((desktop.match(/\.decorations\(false\)/g) || []).length, 3);
  assert.equal((desktop.match(/titlebar::attach\(&/g) || []).length, 3);
  assert.doesNotMatch(desktop, /\.menu\(application_menu\)|initialization_script/);
  const handler = desktop.slice(desktop.indexOf('fn handle_menu_action('), desktop.indexOf('pub fn run()'));
  for (const action of ['open', 'logs', 'start', 'stop', 'restart', 'quit', 'exit']) assert.ok(handler.includes('"' + action + '" => dispatch(app, "' + action + '")'));
  assert.ok(handler.includes('updates::show_updates(&app)'));
  assert.ok(handler.includes('updates::check(&app, &state).await'));
  assert.ok(handler.includes('show_settings(&app, &section)'));
  assert.doesNotMatch(handler, /show_launcher|launcher-show-settings/);
  assert.doesNotMatch(handler, /install_update|set_notifications_enabled|set_project_directory|backend\./);
});

test('titlebar commands validate the calling view, local document and its own parent window', () => {
  const titlebar = read('src-tauri/src/desktop_titlebar.rs');
  for (const pair of ['("launcher-titlebar", "launcher")', '("settings-titlebar", "settings")', '("dsh-titlebar", "dsh")']) assert.ok(titlebar.includes(pair));
  assert.ok(titlebar.includes('url.path() == "/titlebar.html"'));
  assert.ok(titlebar.includes('url.query().is_none()'));
  assert.ok(titlebar.includes('url.fragment().is_none()'));
  assert.ok(titlebar.includes('url.port() == Some(1420)'));
  assert.equal((titlebar.match(/let window = assert_titlebar\(&view\)\?;/g) || []).length, 2);
  assert.ok(titlebar.includes('x.is_finite()'));
  assert.ok(titlebar.includes('Action::Close => window.close()'));
  assert.ok(titlebar.includes('Action::Drag => window.start_dragging()'));
  assert.ok(titlebar.includes('EventTarget::webview('));
  assert.doesNotMatch(titlebar, /perform_action|install_update|backend\.|eval\(|initialization_script/);
  for (const command of ['titlebar_action', 'show_titlebar_menu']) {
    assert.ok(read('src-tauri/build.rs').includes('"' + command + '"'));
    assert.ok(read('src-tauri/src/desktop.rs').includes('titlebar::' + command));
  }
});

test('split-view lifecycle keeps DSH authentication in its original remote content view', () => {
  const desktop = read('src-tauri/src/desktop.rs');
  const notifications = read('src-tauri/src/desktop_notifications.rs');
  const updates = read('src-tauri/src/desktop_updates.rs');
  for (const source of [desktop, notifications, updates]) assert.doesNotMatch(source, /get_webview_window|WebviewWindow/);
  assert.ok(desktop.includes('app.get_webview("dsh")'));
  assert.ok(desktop.includes('app.get_window("launcher")'));
  assert.ok(notifications.includes('.get_webview("dsh")'));
  assert.ok(notifications.includes('app.get_window("dsh")'));
  const titlebar = read('src-tauri/src/desktop_titlebar.rs');
  assert.ok(titlebar.includes('window.scale_factor()?'));
  assert.ok(titlebar.includes('size.height.saturating_sub(top)'));
  assert.ok(titlebar.includes('WindowEvent::ScaleFactorChanged'));
  assert.ok(titlebar.includes('content.set_bounds('));
  assert.ok(titlebar.includes('titlebar.set_bounds('));
});

test('both bundled HTML entries are built and staged for Windows packaging', () => {
  assert.ok(read('vite.config.ts').includes("titlebar: 'titlebar.html'"));
  assert.ok(read('scripts/Build-Windows.ps1').includes("'titlebar.html'"));
  assert.ok(read('titlebar.html').includes('/src/titlebar.ts'));
});

test('destructive actions require guarded PID adapter and native default-no confirmation', () => {
  const desktop = read('src-tauri/src/desktop.rs'); const backend = read('src-tauri/src/backend.rs');
  assert.match(desktop, /MB_DEFBUTTON2/); assert.match(desktop, /backend\.stop\(expected_pid\)/);
  assert.match(backend, /include_str!\("\.\.\/helpers\/guarded_stop\.py"\)/);
  assert.ok(!desktop.includes('invoke("stop")'));
  assert.match(desktop, /\(window\.label\(\), window\.window\(\)\.label\(\)\)/);
});

test('verified ownership is independent of browser authentication for probing and stopping', () => {
  const desktop = read('src-tauri/src/desktop.rs');
  const backend = read('src-tauri/src/backend.rs');
  const stop = desktop.slice(desktop.indexOf('fn stop_service('), desktop.indexOf('fn open_external('));
  assert.ok(stop.includes('validated_stop_pid(&reply)?'));
  assert.doesNotMatch(stop, /reply[.]authenticated|validated_launch_url/);
  assert.match(backend, /self[.]adapter_command\(&\[\s*"--probe"/);
  assert.ok(desktop.includes('&& reply.managed'));
  assert.ok(desktop.includes('backend_error(Some("managed_auth_unavailable"))'));
  // A failed startup must remain actionable, not turn into a false ready splash on the next timer.
  assert.ok(desktop.includes('snapshot.state != "ready" || !snapshot.environment.passed()'));
  const monitor = desktop.slice(desktop.indexOf('let monitor_app ='), desktop.indexOf('.on_window_event('));
  assert.ok(monitor.indexOf('let current = controller.snapshot()') > monitor.indexOf('compare_exchange(false, true'));
  assert.ok(monitor.includes('current.last_error.is_some()'));
  const perform = desktop.slice(desktop.indexOf('fn perform('), desktop.indexOf('fn dispatch('));
  const failurePath = perform.slice(perform.indexOf('if let Err(error) = result'));
  assert.ok(failurePath.indexOf('controller.failure(app, &error, true)') < failurePath.indexOf('controller.busy.store(false'));
  assert.ok(desktop.includes('authentication_deadline.get_or_insert_with'));
  assert.ok(desktop.includes('Duration::from_secs(3)).min(deadline)'));
  const failure = desktop.slice(desktop.indexOf('fn failure('), desktop.indexOf('fn backend('));
  assert.ok(failure.includes('s.environment_checking = false'));
  assert.ok(!failure.includes('s.phase = "操作未完成"'));
  const updates = read('src-tauri/src/desktop_updates.rs');
  const lease = updates.slice(updates.indexOf('impl ServiceLease'), updates.indexOf('fn confirm_install('));
  const normalizedLease = lease.replace(/\s+/g, '');
  assert.ok(normalizedLease.indexOf('controller.installation.lock()') < normalizedLease.indexOf('controller.exiting.load'));
  assert.ok(lease.includes('*installing = true'));
  assert.ok(normalizedLease.includes('installation.lock()'));
});

test('detached WSL startup preserves the Linux supervisor and bounds initial handoff', () => {
  const backend = read('src-tauri/src/backend.rs');
  const desktop = read('src-tauri/src/desktop.rs');
  const start = backend.slice(backend.indexOf('pub fn start('), backend.indexOf('fn capture('));
  assert.ok(start.includes('include_str!("../helpers/detached_run.py")'));
  assert.ok(start.includes('0x00000008 | 0x00000200'));
  const wrapper = read('src-tauri/helpers/detached_run.py');
  for (const guard of ['signal.signal(signal.SIGHUP, signal.SIG_IGN)', 'start_new_session=True', 'close_fds=True', 'shell=False', 'stdin=subprocess.DEVNULL', 'stdout=subprocess.DEVNULL', 'stderr=subprocess.DEVNULL']) assert.ok(wrapper.includes(guard), guard);
  assert.ok(desktop.includes('"stopped" if started =>'));
  assert.ok(desktop.includes('Instant::now() >= bootstrap_deadline'));
  assert.ok(desktop.includes('bootstrap_deadline = (Instant::now() + Duration::from_secs(3)).min(deadline)'));
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

test('pending-question reminders share safe delivery and only read existing session state', () => {
  const native = read('src-tauri/src/desktop_notifications.rs');
  assert.ok(native.includes('AttentionTracker::new()'));
  assert.ok(native.includes('attention.poll(&list'));
  assert.ok(native.includes('rpc.page(session_id, cursor)'));
  assert.ok(native.includes('DSH · 需要你回答'));
  const delivery = native.slice(native.indexOf('fn deliver('), native.indexOf('pub(super) fn start('));
  for (const guard of ['foreground(app)', '!data.snapshot.enabled', 'data.epoch != epoch', 'controller.exiting.load', 'controller.snapshot().state != "ready"']) assert.ok(delivery.includes(guard));
  const transport = read('src-tauri/src/notification_transport.rs');
  assert.ok(!transport.includes('$events'));
  assert.ok(!transport.includes('userQuestions/answer'));
  assert.ok(!transport.includes('session/follow'));
});

test('native notifications explicitly request the Windows default sound', () => {
  const source = read('src-tauri/src/desktop_notifications.rs');
  const send = source.slice(source.indexOf('fn send('), source.indexOf('fn now_ms('));
  assert.ok(send.includes('.sound("Default")'));
  assert.ok(send.indexOf('.sound("Default")') < send.indexOf('.show()'));
  assert.doesNotMatch(send, /PlaySound|SoundPlayer|Notification[.]Looping/);
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
  assert.ok(source.includes('foreground(app)'));
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

test('trusted content IPC validates same-parent identity and exact local path and query', () => {
  const desktop = read('src-tauri/src/desktop.rs');
  const content = desktop.slice(desktop.indexOf('fn local_content('), desktop.indexOf('fn assert_local('));
  for (const guard of ['url.port().is_none()', 'cfg!(debug_assertions)', 'url.host_str() == Some("127.0.0.1")', 'url.port() == Some(1420)', '!url.username().is_empty()', 'url.password().is_some()', 'url.fragment().is_some()', 'matches!(url.path(), "/" | "/index.html")', '"launcher" => url.query().is_none()', 'pairs.len() == 2', 'key.as_ref() == "view" && value.as_ref() == "settings"', 'key.as_ref() == "section" && settings_section(value.as_ref())', '_ => false']) assert.ok(content.includes(guard), guard);
  const local = desktop.slice(desktop.indexOf('fn assert_local('), desktop.indexOf('#[tauri::command]', desktop.indexOf('fn assert_local(')));
  assert.ok(local.includes('(window.label(), window.window().label())'));
  assert.ok(local.includes('("launcher", "launcher") | ("settings", "settings")'));
  assert.ok(local.includes('!local_content(&url, window.label())'));
  assert.doesNotMatch(local, /"dsh"|titlebar/);
  for (const command of ['open_settings', 'get_snapshot', 'perform_action', 'set_project_directory']) {
    const declaration = desktop.slice(desktop.indexOf('fn ' + command + '('));
    const body = declaration.slice(declaration.indexOf(') ->'));
    assert.ok(body.slice(body.indexOf('{') + 1).trimStart().startsWith('assert_local(&window)?;'), command);
  }
});

test('settings is a separate reusable trusted webview with isolated titlebar and fixed section routing', () => {
  const desktop = read('src-tauri/src/desktop.rs');
  const settings = desktop.slice(desktop.indexOf('pub fn show_settings('), desktop.indexOf('fn activate('));
  assert.ok(settings.includes('if !settings_section(section)'));
  assert.ok(settings.includes('SETTINGS_WINDOW.lock()'));
  assert.ok(settings.includes('app.get_window("settings")'));
  assert.ok(settings.includes('WindowBuilder::new(app, "settings")'));
  assert.ok(settings.includes('EventTarget::webview("settings")'));
  assert.ok(settings.includes('"launcher-show-settings"'));
  assert.ok(settings.includes('index.html?view=settings&section={section}'));
  assert.ok(settings.includes('.on_navigation(|target| local_content(target, "settings"))'));
  assert.ok(settings.includes('tauri::webview::NewWindowResponse::Deny'));
  assert.ok(settings.includes('titlebar::attach(&window)'));
  assert.doesNotMatch(settings, /[.]navigate\(|show_launcher|ensure_ready|perform\(|initialization_script/);
  assert.ok(read('src-tauri/build.rs').includes('"open_settings"'));
  assert.ok(desktop.includes('            open_settings,'));
});

test('File and tray service controls remain native, guarded and distinct from settings navigation', () => {
  const desktop = read('src-tauri/src/desktop.rs'); const titlebar = read('src-tauri/src/desktop_titlebar.rs');
  const file = titlebar.slice(titlebar.indexOf('let file = Menu::with_items'), titlebar.indexOf('let environment ='));
  const tray = desktop.slice(desktop.indexOf('let menu = Menu::with_items'), desktop.indexOf('TrayIconBuilder::with_id'));
  for (const action of ['open', 'start', 'stop', 'restart', 'quit', 'exit']) {
    assert.ok(file.includes('&' + action), action); assert.ok(tray.includes('&' + action), action);
  }
  const perform = desktop.slice(desktop.indexOf('fn perform('), desktop.indexOf('fn dispatch('));
  assert.ok(perform.includes('["stop", "restart", "exit"].contains(&action) && !confirm(action)'));
  assert.ok(perform.includes('compare_exchange(false, true'));
  const quit = perform.slice(perform.indexOf('if action == "quit"'), perform.indexOf('if controller.exiting.load', perform.indexOf('if action == "quit"')));
  assert.ok(quit.includes('app.exit(0)')); assert.doesNotMatch(quit, /stop_service|backend[.]stop/);
  assert.ok(perform.indexOf('if action == "quit"') < perform.indexOf('compare_exchange(false, true'));
  assert.match(quit, /controller\s*[.]installation\s*[.]lock\(\)/);
  assert.ok(quit.includes('controller.exiting.store(true'));
  const exit = perform.slice(perform.indexOf('"exit" =>'), perform.indexOf('_ => unreachable!()'));
  assert.ok(exit.indexOf('stop_service(app, controller)?') < exit.indexOf('app.exit(0)'));
  assert.ok(perform.includes('show_settings(app, "logs")?'));
});

test('silent available update checks publish state but never open or focus settings', () => {
  const source = read('src-tauri/src/desktop_updates.rs');
  const check = source.slice(source.indexOf('pub(super) async fn check('), source.indexOf('pub(super) fn show_updates('));
  assert.ok(check.includes('data.snapshot.phase = "available".into()'));
  assert.doesNotMatch(check, /show_updates\(|show_settings\(|[.]show\(|[.]set_focus\(|launcher-show-updates/);
  const reveal = source.slice(source.indexOf('pub(super) fn show_updates('), source.indexOf('struct ServiceLease'));
  assert.ok(reveal.includes('show_settings(app, "updates")'));
});

test('remote DSH and titlebars never inherit service or settings IPC', () => {
  const launcher = JSON.parse(read('src-tauri/capabilities/launcher.json'));
  const titlebar = JSON.parse(read('src-tauri/capabilities/titlebar.json'));
  for (const capability of [launcher, titlebar]) {
    assert.equal(capability.webviews.includes('dsh'), false); assert.equal(capability.remote, undefined); assert.equal(capability.windows, undefined);
    assert.equal(capability.webviews.some(label => label.includes('*')), false);
  }
  assert.equal(launcher.webviews.some(label => label.endsWith('-titlebar')), false);
  for (const permission of titlebar.permissions) assert.ok(!/allow-(?:get-snapshot|perform-action|open-settings|check-update|install-update|set-project-directory|set-notifications-enabled)/.test(permission));
  const desktop = read('src-tauri/src/desktop.rs');
  const remote = desktop.slice(desktop.indexOf('fn open_dsh('), desktop.indexOf('fn fit_window('));
  assert.ok(remote.includes('WebviewBuilder::new("dsh", WebviewUrl::External(url))'));
  assert.ok(remote.includes('target.origin() == nav_origin.origin()'));
  assert.doesNotMatch(remote, /initialization_script|[.]eval\(/);
});
