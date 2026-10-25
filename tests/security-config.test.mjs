import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
test('only trusted local content and titlebar views receive narrowly scoped IPC capabilities', () => {
  const config = JSON.parse(read('src-tauri/tauri.conf.json'));
  const capability = JSON.parse(read('src-tauri/capabilities/launcher.json'));
  assert.deepEqual([...config.app.security.capabilities].sort(), ['assistant', 'launcher', 'pet-interactions', 'pet-motion', 'pet-notifications', 'pet-settings', 'pet-speech', 'settings-navigation', 'speech-preferences', 'speech-settings', 'titlebar']);
  assert.deepEqual(capability.webviews, ['launcher', 'launcher-settings', 'dsh-settings']);
  assert.equal(capability.windows, undefined);
  const titlebar = JSON.parse(read('src-tauri/capabilities/titlebar.json'));
  assert.deepEqual(titlebar.webviews, ['launcher-titlebar', 'dsh-titlebar']);
  assert.equal(titlebar.windows, undefined);
  assert.equal(titlebar.local, true); assert.equal(titlebar.remote, undefined);
  assert.deepEqual([...titlebar.permissions].sort(), ['core:event:allow-listen', 'core:event:allow-unlisten', 'allow-titlebar-action', 'allow-open-titlebar-settings', 'allow-open-titlebar-updates', 'allow-get-titlebar-update-state', 'allow-get-titlebar-pet-state', 'allow-toggle-titlebar-pet'].sort());
  assert.equal(capability.local, true); assert.equal(capability.remote, undefined);
  assert.deepEqual([...capability.permissions].sort(), ['allow-get-snapshot', 'allow-open-settings', 'allow-perform-action', 'allow-set-project-directory', 'allow-pick-settings-path', 'allow-setup-distributions', 'allow-setup-identity', 'allow-complete-setup', 'allow-get-update-snapshot', 'allow-check-update', 'allow-install-update', 'allow-get-notification-snapshot', 'allow-set-notifications-enabled', 'allow-test-notification', 'allow-get-power-snapshot', 'allow-set-power-enabled', 'core:event:allow-listen', 'core:event:allow-unlisten'].sort());
  const navigation = JSON.parse(read('src-tauri/capabilities/settings-navigation.json'));
  assert.deepEqual(navigation.webviews, ['launcher-settings', 'dsh-settings']);
  assert.equal(navigation.local, true); assert.equal(navigation.remote, undefined); assert.equal(navigation.windows, undefined);
  assert.deepEqual([...navigation.permissions].sort(), ['allow-return-from-settings', 'allow-settings-page-ready']);
  assert.ok(config.app.security.csp.includes("object-src 'none'"));
});
test('titlebar settings opens its own verified parent directly and removes all popup machinery while tray stays unchanged', () => {
  const desktop = read('src-tauri/src/desktop.rs');
  const titlebar = read('src-tauri/src/desktop_titlebar.rs');
  assert.doesNotMatch(titlebar, /\bmenu::|MenuItem|\bMenus\b|application_menu|show_titlebar_menu|popup_at/);
  assert.doesNotMatch(desktop, /titlebar::Menus|application_menu|show_titlebar_menu|"(?:launcher|dsh)\.(?:settings|logs)"/);
  const declaration = titlebar.slice(titlebar.indexOf('fn open_titlebar_settings('), titlebar.indexOf('pub(super) fn content_geometry('));
  assert.ok(declaration.startsWith('fn open_titlebar_settings('));
  const params = declaration.slice(0, declaration.indexOf(') ->'));
  assert.match(params, /view:\s*Webview/);
  assert.doesNotMatch(params, /(?:url|host|label|path|section|window|x):/);
  const body = declaration.slice(declaration.indexOf(') ->'));
  assert.match(body, /let window = assert_titlebar\(&view\)\?;/);
  assert.ok(body.indexOf('assert_titlebar(&view)?') < body.indexOf('spawn_blocking'));
  assert.match(body, /spawn_blocking/);
  assert.match(body, /settings_page::show_in\(&window,\s*"environment"\)/);
  assert.doesNotMatch(body, /show_settings\(|perform_action|ensure_ready\(|open_dsh\(|[.]navigate\(|[.]destroy\(|[.]eval\(/);
  const tray = desktop.slice(desktop.indexOf('let open = MenuItem::with_id'), desktop.indexOf('TrayIconBuilder::with_id'));
  const trayIds = [...tray.matchAll(/MenuItem::with_id\(\s*app,\s*"([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(trayIds, ['open', 'assistant', 'logs', 'updates', 'start', 'stop', 'restart', 'quit', 'exit']);
  assert.match(tray, /&open,\s*&assistant,\s*&control,\s*&update,\s*&start,\s*&stop,\s*&restart,\s*&quit,\s*&exit/);
  assert.match(desktop, /TrayIconBuilder::with_id\("dsh-tray"\)[\s\S]*?\.menu\(&menu\)/);
  assert.equal((desktop.match(/\.on_menu_event\(/g) || []).length, 1, 'tray actions dispatch once');
  assert.ok(desktop.includes('handle_menu_action(app, event.id.as_ref())'));
  assert.equal((desktop.match(/\.decorations\(false\)/g) || []).length, 2, 'settings creates no top-level window');
  assert.equal((desktop.match(/titlebar::attach\(&/g) || []).length, 2);
  assert.doesNotMatch(desktop, /initialization_script/);
  const handler = desktop.slice(desktop.indexOf('fn handle_menu_action('), desktop.indexOf('pub fn run()'));
  for (const action of ['open', 'logs', 'start', 'stop', 'restart', 'quit', 'exit']) assert.ok(handler.includes('"' + action + '" => dispatch(app, "' + action + '")'));
  assert.ok(handler.includes('updates::show_updates(&app)'));
  assert.ok(handler.includes('updates::check(&app, &state).await'));
  assert.doesNotMatch(handler, /settings_page::show_in|"settings"\s*\||"environment"\s*\||"notifications"\s*=>/);
  assert.doesNotMatch(handler, /show_launcher|launcher-show-settings|install_update|set_notifications_enabled|set_project_directory|backend\./);
});

test('titlebar commands validate the calling view, local document and its own parent window', () => {
  const titlebar = read('src-tauri/src/desktop_titlebar.rs');
  for (const pair of ['("launcher-titlebar", "launcher")', '("dsh-titlebar", "dsh")']) assert.ok(titlebar.includes(pair));
  assert.ok(titlebar.includes('url.path() == "/titlebar.html"'));
  assert.ok(titlebar.includes('url.query().is_none()'));
  assert.ok(titlebar.includes('url.fragment().is_none()'));
  assert.ok(titlebar.includes('url.port() == Some(1420)'));
  assert.equal((titlebar.match(/assert_titlebar\(&view\)\?;/g) || []).length, 6);
  assert.doesNotMatch(titlebar, /x[.]is_finite|popup_at|show_titlebar_menu/);
  assert.ok(titlebar.includes('Action::Close => window.close()'));
  assert.ok(titlebar.includes('Action::Drag => window.start_dragging()'));
  assert.ok(titlebar.includes('EventTarget::webview('));
  assert.doesNotMatch(titlebar, /perform_action|install_update|backend\.|eval\(|initialization_script/);
  assert.doesNotMatch(read('src-tauri/build.rs'), /show_titlebar_menu/);
  for (const command of ['titlebar_action', 'open_titlebar_settings', 'open_titlebar_updates', 'get_titlebar_update_state', 'get_titlebar_pet_state', 'toggle_titlebar_pet']) {
    assert.ok(read('src-tauri/build.rs').includes('"' + command + '"'));
    assert.ok(read('src-tauri/src/desktop.rs').includes('titlebar::' + command));
  }
});

test('titlebar update navigation and availability getter remain own-parent fixed-purpose commands', () => {
  const titlebar = read('src-tauri/src/desktop_titlebar.rs');
  const extract = name => {
    const start = titlebar.indexOf('fn ' + name + '('); assert.ok(start >= 0, name);
    const tail = titlebar.slice(start); const next = tail.indexOf('#[tauri::command]');
    return next < 0 ? tail.slice(0, tail.indexOf('pub(super) fn content_geometry(')) : tail.slice(0, next);
  };
  const open = extract('open_titlebar_updates');
  const params = open.slice(0, open.indexOf(') ->'));
  assert.match(params, /view:\s*Webview/); assert.doesNotMatch(params, /(?:url|host|label|path|section|window|state|x):/);
  const body = open.slice(open.indexOf(') ->'));
  assert.match(body, /let window = assert_titlebar\(&view\)\?;/);
  assert.ok(body.indexOf('assert_titlebar(&view)?') < body.indexOf('spawn_blocking'));
  assert.match(body, /settings_page::show_in\(&window,\s*"updates"\)/);
  assert.doesNotMatch(body, /show_updates\(|show_settings\(|check\(|check_update|install_update|perform_action|ensure_ready\(|open_dsh\(|[.]navigate\(|[.]destroy\(|[.]eval\(/);
  const getter = extract('get_titlebar_update_state');
  const getterParams = getter.slice(0, getter.indexOf(') ->'));
  assert.match(getterParams, /view:\s*Webview/); assert.match(getterParams, /State<'_,[^>]*Arc<[^>]*Updates/);
  assert.doesNotMatch(getterParams, /(?:url|host|label|path|section|window|version|args):/);
  assert.match(getter, /Result<[^>]*UpdateNotice, String>/);
  assert.ok(getter.indexOf('assert_titlebar(&view)?') < getter.indexOf('state.titlebar_notice()'));
  assert.match(getter, /Ok\(state[.]titlebar_notice\(\)\)/);
  assert.doesNotMatch(getter, /check_update|install_update|perform_action|get_update_snapshot|[.]check\(|[.]download\(|[.]install\(|show_in\(|show_settings\(|backend[.]/);
  const titlebarCapability = JSON.parse(read('src-tauri/capabilities/titlebar.json'));
  for (const command of ['open_titlebar_updates', 'get_titlebar_update_state']) {
    const permission = 'allow-' + command.replaceAll('_', '-');
    assert.ok(titlebarCapability.permissions.includes(permission));
    for (const other of ['launcher', 'settings-navigation']) assert.equal(JSON.parse(read('src-tauri/capabilities/' + other + '.json')).permissions.includes(permission), false);
  }
});

test('titlebars receive only a boolean update projection while full updater state stays in trusted content', () => {
  const source = read('src-tauri/src/desktop_updates.rs');
  const fields = source.match(/struct UpdateNotice\s*\{([^}]+)\}/)[1];
  assert.match(fields, /^\s*(?:pub(?:\([^)]*\))?\s+)?available:\s*bool,?\s*$/);
  assert.doesNotMatch(fields, /version|notes|url|signature|package|download|phase|message/);
  const getter = source.slice(source.indexOf('fn titlebar_notice('), source.indexOf('fn change('));
  assert.match(getter, /UpdateNotice\s*\{\s*available:\s*self[.]snapshot\(\)[.]version[.]is_some\(\),?\s*\}/);
  assert.doesNotMatch(getter, /check_update|install_update|[.]check\(|[.]download\(|[.]install\(|show_settings\(/);
  const change = source.slice(source.indexOf('fn change('), source.indexOf('fn fail('));
  const unlock = change.indexOf('};'); const firstEmit = change.indexOf('app.emit_to(');
  assert.ok(unlock >= 0 && firstEmit > unlock, 'data lock must be released before emitting to any view');
  assert.match(change, /let snapshot =\s*\{[\s\S]*?self[.]data[.]lock\(\)[\s\S]*?data[.]snapshot[.]clone\(\)\s*\};/);
  const content = change.slice(change.indexOf('for label in ["launcher", "launcher-settings", "dsh-settings"]'), change.indexOf('let notice ='));
  assert.match(content, /"launcher-update-state",\s*&snapshot/); assert.doesNotMatch(content, /titlebar/);
  assert.match(change, /let notice = UpdateNotice\s*\{\s*available:\s*snapshot[.]version[.]is_some\(\),?\s*\};/);
  const badge = change.slice(change.indexOf('for label in ["launcher-titlebar", "dsh-titlebar"]'));
  assert.match(badge, /EventTarget::webview\(label\),\s*"titlebar-update-state",\s*&notice/);
  assert.doesNotMatch(badge, /&snapshot|launcher-update-state|version|notes|signature|url/);
  const frontend = read('src/titlebar.ts');
  assert.doesNotMatch(frontend, /['"](?:check_update|install_update|get_update_snapshot|perform_action)['"]|['"]launcher-update-state['"]/);
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
  assert.ok(read('src-tauri/src/protocol.rs').includes('backend_error(Some("managed_auth_unavailable"))'));
  // A failed startup must remain actionable, not turn into a false ready splash on the next timer.
  assert.ok(desktop.includes('snapshot.state != "ready" || !snapshot.environment.passed()'));
  const monitor = desktop.slice(desktop.indexOf('let monitor_app ='), desktop.indexOf('.on_window_event('));
  assert.ok(monitor.indexOf('let current = controller.snapshot()') > monitor.indexOf('compare_exchange(false, true'));
  assert.ok(monitor.includes('current.last_error.is_some()'));
  const perform = desktop.slice(desktop.indexOf('fn perform('), desktop.indexOf('fn dispatch('));
  const failurePath = perform.slice(perform.indexOf('if let Err(error) = result'));
  assert.ok(failurePath.indexOf('controller.failure(app, &error, true)') < failurePath.indexOf('controller.busy.store(false'));
  // Authentication shares the original startup budget; never a separate 3s grace.
  const startup = desktop.slice(desktop.indexOf('fn ensure_ready('), desktop.indexOf('fn stop_service('));
  assert.ok(startup.includes('Duration::from_secs(backend.config.startup_timeout_seconds)'));
  assert.ok(startup.includes('wait_for_launch_authentication(&reply, status, Instant::now(), deadline)?'));
  assert.doesNotMatch(startup, /authentication_deadline|get_or_insert_with/);
  const waiting = startup.slice(startup.indexOf('if wait_for_launch_authentication'), startup.indexOf('controller.phase(app, "打开工作窗口"'));
  assert.ok(waiting.includes('等待网页登录认证'));
  assert.ok(waiting.includes('continue;'));
  assert.doesNotMatch(waiting, /backend[.](start|stop)\(/);
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
  assert.ok(native.includes('需要你回答'));
  const delivery = native.slice(native.indexOf('fn deliver('), native.indexOf('pub(super) fn start('));
  for (const guard of ['foreground(app)', '!settings.should_notify(is_foreground)', 'notify_when_focused: data.snapshot.notify_when_focused', 'data.epoch != epoch', 'controller.exiting.load', 'controller.snapshot().state != "ready"']) assert.ok(delivery.includes(guard));
  const transport = read('src-tauri/src/notification_transport.rs');
  assert.ok(!transport.includes('$events'));
  assert.ok(!transport.includes('userQuestions/answer'));
  assert.ok(!transport.includes('session/follow'));
});

test('all task notification kinds add matching session identity without new RPC or snapshot exposure', () => {
  const native = read('src-tauri/src/desktop_notifications.rs');
  const worker = native.slice(native.indexOf('pub(super) fn start('));
  const waiting = worker.slice(worker.indexOf('for notice in waiting'), worker.indexOf('let requests = tracker.scan'));
  const results = worker.slice(worker.indexOf('if let Some(notice) = notice'));
  assert.match(waiting, /task_notice_body\(\s*&list,\s*&notice.session_id,/);
  assert.match(waiting, /"需要你回答",\s*&body,\s*&task_notice_title/);
  assert.match(results, /task_notice_body\(&list, &notice.session_id, body\)/);
  assert.match(results, /deliver\(\s*&app,\s*&controller,\s*&state,\s*epoch,\s*channels,\s*target,\s*title,\s*&body,\s*&task_notice_title\(&list, &notice.session_id\),\s*kind,\s*&key,?\s*\)/);
  assert.equal((native.match(/task_notice_body\(/g) || []).length, 2);
  assert.equal((native.match(/task_notice_title\(&list, &notice.session_id\)/g) || []).length, 2);
  assert.ok(native.includes('kind, task_title, "", key'));
  assert.doesNotMatch(native, /DSH · (?:本轮执行|需要你回答)/);
  assert.doesNotMatch(native, /snapshot[.](?:title|body|task)|emit_to[\s\S]{0,120}&body/);
});

test('notification clicks capture a same-origin session target without scripts or native page permissions', () => {
  const native = read('src-tauri/src/desktop_notifications.rs');
  const open = native.slice(native.indexOf('fn open_notified_session('), native.indexOf('pub(super) fn stop('));
  for (const guard of ['controller.exiting.load', 'controller.snapshot().state != "ready"',
    'target.origin() != origin.origin()', 'current.origin() != origin.origin()']) assert.ok(open.includes(guard), guard);
  assert.ok(open.includes('destination.set_fragment(target.fragment())'));
  assert.ok(open.includes('current.path() == "/"'));
  assert.ok(open.includes('settings_page::restore_in(&window)?'));
  assert.ok(open.includes('view.navigate(destination)'));
  assert.ok(open.includes('super::show_dsh(app)'));
  assert.doesNotMatch(open, /eval\(|initialization_script|ensure_ready\(|dispatch\(|open_dsh\(|open::|WindowBuilder|WebviewBuilder/);
  assert.ok(native.includes('state.toasts.show(&app_id, title, body, move ||'));
  assert.ok(native.includes('open_notified_session(&click_app, &target)'));
  const worker = native.slice(native.indexOf('pub(super) fn start('));
  assert.equal((worker.match(/notification_session_url\(/g) || []).length, 2);
  assert.equal((worker.match(/CLICK_SEQUENCE.fetch_add/g) || []).length, 2);
});

test('clickable Windows toasts retain native handles, escape text and clean up without callback locks', () => {
  const source = read('src-tauri/src/desktop_toasts.rs');
  assert.match(source, /const LIMIT: usize = 128/);
  assert.match(source, /native: ToastNotification/);
  assert.match(source, /activated: Option<i64>/);
  assert.ok(source.includes('CreateTextNode(&HSTRING::from(value))'));
  assert.ok(source.includes('<audio silent="true"/>'));
  assert.doesNotMatch(source, /ms-winsoundevent:|SystemNotification|SND_ALIAS/);
  const acknowledged = source.slice(source.indexOf('match result.recv_timeout(timeout)'), source.indexOf('pub(super) fn shutdown'));
  assert.match(acknowledged, /Ok\(result\) => \{\s*result\?;\s*play_notification_sound\(\)/);
  assert.equal((acknowledged.match(/play_notification_sound\(\)/g) || []).length, 1);
  assert.doesNotMatch(acknowledged.slice(acknowledged.indexOf('Err(_) =>')), /play_notification_sound/);
  assert.ok(source.includes('ToastDismissalReason::TimedOut'));
  assert.ok(source.includes('sender.send(Event::Clicked(id))'));
  assert.ok(source.includes('sender.send(Event::Closed(id))'));
  assert.ok(source.includes('entries.len() >= LIMIT'));
  assert.ok(source.indexOf('entries.push_back(entry)') < source.indexOf('entry.notifier.Show(&entry.native)'));
  for (const cleanup of ['RemoveActivated', 'RemoveDismissed', 'RemoveFailed', 'self.notifier.Hide', 'RemoveGroupedTagWithId']) assert.ok(source.includes(cleanup));
  assert.ok(source.includes('for click in click_queue'));
  assert.ok(source.includes('clicks.send(click)'));
  assert.ok(source.includes('canceled.store(true, Ordering::SeqCst)'));
  assert.ok(source.includes('Instant::now() >= deadline'));
  assert.ok(source.includes('abandoned || replied.is_err()'));
  assert.doesNotMatch(source, /thread::spawn\(click\)/);
  assert.doesNotMatch(source, /History\(\).*Clear|launch=|activationType="protocol"|args\.Arguments|\.eval\(|Mutex/);
  assert.ok(read('src-tauri/src/desktop.rs').includes('notifications::stop(app)'));
});

test('focus policy saves before updating memory and does not reset notification generations', () => {
  const source = read('src-tauri/src/desktop_notifications.rs');
  const setter = source.slice(source.indexOf('pub(super) async fn set_notifications_enabled('), source.indexOf('pub(super) async fn test_notification('));
  assert.ok(setter.includes('notify_when_focused: Option<bool>'));
  assert.ok(setter.includes('.unwrap_or(data.snapshot.notify_when_focused)'));
  assert.ok(setter.indexOf('settings.save(&state.directory)?') < setter.indexOf('data.snapshot.notify_when_focused = settings.notify_when_focused'));
  assert.match(setter, /if data.snapshot.enabled != enabled \{\s*data.epoch = data.epoch.wrapping_add\(1\)/);
  assert.equal((setter.match(/data.epoch =/g) || []).length, 1);
  assert.ok(source.includes('notify_when_focused: settings.notify_when_focused'));
  assert.ok(source.includes('listening_message(data.snapshot.notify_when_focused)'));
});

test('test notifications submit a silent card before the same embedded bowl sound', () => {
  const source = read('src-tauri/src/desktop_notifications.rs');
  const send = source.slice(source.indexOf('fn send('), source.indexOf('fn now_ms('));
  assert.doesNotMatch(send, /[.]sound\(|PlaySound|SoundPlayer|Notification[.]Looping/);
  assert.match(send, /[.]show\(\)[\s\S]*[.]map_err\([\s\S]*\?;\s*super::toasts::play_notification_sound\(\)/);
  assert.equal((send.match(/play_notification_sound\(\)/g) || []).length, 1);
});

test('visible-pet notifications choose sound-only after shared guards without creating a toast', () => {
  const native = read('src-tauri/src/desktop_notifications.rs');
  const delivery = native.slice(native.indexOf('fn deliver('), native.indexOf('// Match the existing plugin'));
  assert.ok(delivery.includes('channels.system_delivery(state.gate(app), is_foreground, notify_when_focused)'));
  for (const guard of ['!settings.should_notify(is_foreground)', 'data.epoch != epoch', 'controller.exiting.load', 'controller.snapshot().state != "ready"']) {
    assert.ok(delivery.includes(guard) && delivery.indexOf(guard) < delivery.indexOf('match delivery'), guard);
  }
  const soundBranch = delivery.slice(delivery.indexOf('SystemDelivery::SoundOnly =>'), delivery.indexOf('SystemDelivery::Toast =>'));
  assert.match(soundBranch, /super::toasts::play_notification_sound[(][)]/);
  assert.doesNotMatch(soundBranch, /[.]show[(]|send[(]|open_notified_session|notification[(]/);
  assert.equal((delivery.match(/play_notification_sound[(][)]/g) || []).length, 1);
  assert.match(delivery.slice(delivery.indexOf('SystemDelivery::Toast =>')), /state[.]toasts[.]show/);
  const source = read('src-tauri/src/desktop_toasts.rs');
  const sound = source.slice(source.indexOf('pub(super) fn play_notification_sound('), source.indexOf('type Click'));
  for (const token of ['PlaySoundW', 'NOTIFICATION_SOUND.0.as_ptr().cast()', 'SND_MEMORY', 'SND_ASYNC', 'SND_NODEFAULT', 'SND_SYSTEM']) assert.ok(sound.includes(token), token);
  assert.match(source, /#\[repr\(C, align\(4\)\)\]/);
  assert.match(source, /static NOTIFICATION_SOUND:/);
  assert.ok(source.includes('include_bytes!("assets/notification-basin.wav")'));
  assert.doesNotMatch(sound, /SystemNotification|SND_ALIAS|SND_FILENAME|ToastNotification|ToastNotifier|[.]Show[(]|[.]show[(]|Webview|Command::|thread::spawn/);
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

test('power commands are local fixed-purpose settings with no remote power-control IPC', () => {
  const source = read('src-tauri/src/desktop_power.rs');
  const capability = JSON.parse(read('src-tauri/capabilities/launcher.json'));
  for (const command of ['get_power_snapshot', 'set_power_enabled']) {
    const declaration = source.slice(source.indexOf('fn ' + command + '('));
    const body = declaration.slice(declaration.indexOf(') ->'));
    assert.ok(body.slice(body.indexOf('{') + 1).trimStart().startsWith('assert_local(&window)?;'));
    const params = declaration.slice(0, declaration.indexOf(') ->'));
    assert.doesNotMatch(params, /(?:url|path|cookie|token|session_id|flags|command):/);
    assert.ok(read('src-tauri/build.rs').includes('"' + command + '"'));
    assert.ok(read('src-tauri/src/desktop.rs').includes('power::' + command));
    assert.ok(capability.permissions.includes('allow-' + command.replaceAll('_', '-')));
  }
  assert.ok(read('src-tauri/src/desktop.rs').includes('"notifications" | "power" | "pet" | "speech" | "updates"'));
  assert.ok(read('src-tauri/src/desktop_settings.rs').includes('"power" => "power"'));
});

test('power monitoring is independent, list-only and keeps thread-scoped requests off the UI thread', () => {
  const source = read('src-tauri/src/desktop_power.rs');
  const worker = source.slice(source.indexOf('pub(super) fn start('), source.indexOf('#[cfg(test)]'));
  assert.match(worker, /thread::spawn[\s\S]*PowerGuard::new\(NativeInhibitor::default\(\)\)/);
  assert.ok(worker.includes('running_tasks(&rpc.list()?)'));
  assert.ok(worker.includes('notifications::client(&app, &backend.config.origin())?'));
  assert.doesNotMatch(source, /NotificationSettings|notify_when_focused|rpc[.]page|[.]eval\(|initialization_script/);
  assert.ok(source.includes('data.epoch != epoch'));
  assert.ok(source.includes('required && data.snapshot.enabled'));
  assert.ok(worker.includes('controller.exiting.load'));
  assert.ok(worker.includes('drop(guard)'));
  assert.ok(source.includes('state.wake.notify_all()'));
  const core = read('src-tauri/src/power.rs');
  assert.match(core, /SetThreadExecutionState/);
  assert.match(core, /ES_SYSTEM_REQUIRED/);
  assert.doesNotMatch(core, /ES_DISPLAY_REQUIRED|ES_AWAYMODE_REQUIRED|PowerSetActiveScheme|SetSuspendState/);
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

test('trusted content IPC validates each fixed child-parent pair and exact local path and query', () => {
  const desktop = read('src-tauri/src/desktop.rs');
  const content = desktop.slice(desktop.indexOf('fn local_content('), desktop.indexOf('fn assert_local('));
  for (const guard of ['url.port().is_none()', 'cfg!(debug_assertions)', 'url.host_str() == Some("127.0.0.1")', 'url.port() == Some(1420)', '!url.username().is_empty()', 'url.password().is_some()', 'url.fragment().is_some()', 'matches!(url.path(), "/" | "/index.html")', '"launcher" => url.query().is_none()', 'pairs.len() == 2', 'key.as_ref() == "view" && value.as_ref() == "settings"', 'key.as_ref() == "section" && settings_section(value.as_ref())', '_ => false']) assert.ok(content.includes(guard), guard);
  for (const label of ['launcher-settings', 'dsh-settings']) assert.ok(content.includes('"' + label + '"'));
  const local = desktop.slice(desktop.indexOf('fn assert_local('), desktop.indexOf('#[tauri::command]', desktop.indexOf('fn assert_local(')));
  assert.ok(local.includes('(window.label(), window.window().label())'));
  for (const pair of ['("launcher", "launcher")', '("launcher-settings", "launcher")', '("dsh-settings", "dsh")']) assert.ok(local.includes(pair), pair);
  assert.ok(local.includes('!local_content(&url, window.label())'));
  assert.doesNotMatch(local, /\("dsh",\s*"dsh"\)|\("launcher-settings",\s*"dsh"\)|\("dsh-settings",\s*"launcher"\)|titlebar/);
  for (const command of ['open_settings', 'get_snapshot', 'perform_action', 'set_project_directory']) {
    const declaration = desktop.slice(desktop.indexOf('fn ' + command + '('));
    const body = declaration.slice(declaration.indexOf(') ->'));
    assert.ok(body.slice(body.indexOf('{') + 1).trimStart().startsWith('assert_local(&window)?;'), command);
  }
});

test('settings navigation reuses local children in the existing parent without replacing the remote workspace', () => {
  const desktop = read('src-tauri/src/desktop.rs');
  const settings = read('src-tauri/src/desktop_settings.rs');
  assert.ok(settings.includes('"launcher" => Some("launcher-settings")'));
  assert.ok(settings.includes('"dsh" => Some("dsh-settings")'));
  assert.match(settings, /_ => None/);
  assert.ok(settings.includes('if !settings_section(section)'));
  assert.ok(settings.includes('NAVIGATION.lock()'));
  assert.match(settings, /AtomicU8/); assert.match(settings, /Ordering::SeqCst/);
  assert.ok(settings.includes('app.get_webview(page_label)'));
  assert.ok(settings.includes('page.window().label() != window.label()'));
  assert.ok(settings.includes('window.add_child('));
  assert.ok(settings.includes('index.html?view=settings&section={}'));
  assert.match(settings, /format!\(\s*"index.html\?view=settings&section=\{\}",\s*state.section/);
  assert.ok(settings.includes('local_content(target, page_label)'));
  assert.ok(settings.includes('tauri::webview::NewWindowResponse::Deny'));
  assert.ok(settings.includes('"launcher-show-settings"'));
  assert.doesNotMatch(settings, /WindowBuilder|[.]navigate\(|[.]destroy\(|[.]reparent\(|[.]eval\(|ensure_ready\(|open_dsh\(|initialization_script/);
  assert.doesNotMatch(desktop, /WindowBuilder::new\(app, "settings"\)|get_window\("settings"\)|SETTINGS_WINDOW/);
  const guard = settings.slice(settings.indexOf('fn assert_page('), settings.indexOf('fn reveal('));
  assert.ok(guard.includes('assert_local(view)?;'));
  assert.ok(guard.includes('label(window.label()) != Some(view.label())'));
  for (const command of ['return_from_settings', 'settings_page_ready']) {
    const declaration = settings.slice(settings.indexOf('fn ' + command + '('));
    assert.ok(declaration.startsWith('fn ' + command + '('), command);
    const params = declaration.slice(0, declaration.indexOf(') ->'));
    assert.match(params, /view:\s*Webview/);
    assert.doesNotMatch(params, /(?:url|host|label|path|section|window):/);
    const body = declaration.slice(declaration.indexOf(') ->'));
    assert.ok(body.slice(body.indexOf('{') + 1).trimStart().startsWith('let window = assert_page(&view)?;'), command + ' first validates its own trusted settings child');
    assert.ok(read('src-tauri/build.rs').includes('"' + command + '"'));
    assert.ok(desktop.includes('settings_page::' + command));
  }
  const back = settings.slice(settings.indexOf('fn return_from_settings('));
  assert.ok(back.includes('restore_in(&window)?'));
  const restore = settings.slice(settings.indexOf('fn restore_in('), settings.indexOf('fn return_from_settings('));
  assert.ok(restore.includes('NAVIGATION.lock()'));
  assert.ok(restore.includes('content.show()')); assert.ok(restore.includes('page.hide()'));
  assert.ok(restore.indexOf('content.show()') < restore.indexOf('page.hide()'), 'restore source before hiding settings');
  assert.ok(restore.includes('content.set_focus()'));
  assert.ok(restore.includes('ACTIVE.fetch_and(!bit(window.label())'));
  assert.ok(restore.includes('REQUESTED.fetch_and(!bit(window.label())'));
  assert.doesNotMatch(restore, /[.]navigate\(|open_dsh\(|ensure_ready\(|perform\(/);
  assert.doesNotMatch(back, /[.]navigate\(|open_dsh\(|ensure_ready\(|perform\(/);
  const ready = settings.slice(settings.indexOf('fn settings_page_ready('), settings.indexOf('fn return_from_settings('));
  assert.ok(ready.includes('state.ready = true'));
  assert.ok(ready.includes('REQUESTED.load(Ordering::SeqCst) & bit(window.label()) != 0'));
  assert.ok(ready.includes('reveal(&window, &view)'));
  assert.ok(ready.includes('REQUESTED.fetch_and(!bit(window.label())'));
  assert.ok(ready.includes('return Err(error)'));
  assert.ok(ready.includes('Ok(state.section.to_owned())'));
  const reveal = settings.slice(settings.indexOf('fn reveal('), settings.indexOf('fn show_in('));
  assert.ok(reveal.includes('if result.is_err()'));
  assert.ok(reveal.includes('content.show()'));
  assert.ok(reveal.includes('page.hide()'));
  assert.doesNotMatch(reveal, /window[.]show\(|[.]unminimize\(|[.]destroy\(|[.]navigate\(/);
  const open = desktop.slice(desktop.indexOf('async fn open_settings('), desktop.indexOf('fn get_snapshot('));
  assert.ok(open.includes('window.window()'));
  assert.ok(open.includes('settings_page::show_in('));
  assert.ok(read('src-tauri/build.rs').includes('"open_settings"'));
  assert.ok(desktop.includes('            open_settings,'));
});

test('all trusted settings children receive snapshots and foreground notifications follow the visible workspace route', () => {
  for (const path of ['src-tauri/src/desktop.rs', 'src-tauri/src/desktop_updates.rs', 'src-tauri/src/desktop_notifications.rs']) {
    const source = read(path);
    assert.ok(source.includes('["launcher", "launcher-settings", "dsh-settings"]'), path);
    assert.doesNotMatch(source, /EventTarget::webview\("settings"\)/);
  }
  const notifications = read('src-tauri/src/desktop_notifications.rs');
  const foreground = notifications.slice(notifications.indexOf('fn foreground('), notifications.indexOf('fn listening_message('));
  assert.ok(foreground.includes('settings_page::is_active("dsh")'));
  assert.ok(foreground.includes('window.is_visible()'));
  assert.ok(foreground.includes('window.is_minimized()'));
  assert.ok(foreground.includes('window.is_focused()'));
  assert.doesNotMatch(foreground, /epoch|reset\(|navigate\(|hide\(/);
});

test('tray-only service controls remain native, guarded and distinct from settings navigation', () => {
  const desktop = read('src-tauri/src/desktop.rs'); const titlebar = read('src-tauri/src/desktop_titlebar.rs');
  const tray = desktop.slice(desktop.indexOf('let menu = Menu::with_items'), desktop.indexOf('TrayIconBuilder::with_id'));
  for (const action of ['open', 'start', 'stop', 'restart', 'quit', 'exit']) {
    assert.ok(tray.includes('&' + action), action);
    assert.ok(!titlebar.includes('"' + action + '"'), action + ' is tray-only');
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
  const navigation = JSON.parse(read('src-tauri/capabilities/settings-navigation.json'));
  for (const capability of [launcher, titlebar, navigation]) {
    assert.equal(capability.webviews.includes('dsh'), false); assert.equal(capability.remote, undefined); assert.equal(capability.windows, undefined);
    assert.equal(capability.webviews.some(label => label.includes('*')), false);
  }
  assert.equal(launcher.webviews.some(label => label.endsWith('-titlebar')), false);
  for (const permission of titlebar.permissions) assert.ok(!/allow-(?:get-snapshot|perform-action|open-settings|check-update|install-update|set-project-directory|set-notifications-enabled|setup-distributions|setup-identity|complete-setup)/.test(permission));
  const desktop = read('src-tauri/src/desktop.rs');
  const remote = desktop.slice(desktop.indexOf('fn open_dsh('), desktop.indexOf('fn fit_window('));
  assert.ok(remote.includes('WebviewBuilder::new("dsh", WebviewUrl::External(url))'));
  assert.ok(remote.includes('target.origin() == nav_origin.origin()'));
  assert.doesNotMatch(remote, /initialization_script|[.]eval\(/);
});

test('first-run commands validate local callers before blocking and publish setup only on explicit completion', () => {
  const source = read('src-tauri/src/desktop_setup.rs');
  const desktop = read('src-tauri/src/desktop.rs');
  const build = read('src-tauri/build.rs');
  const capability = JSON.parse(read('src-tauri/capabilities/launcher.json'));
  for (const command of ['setup_distributions', 'setup_identity', 'complete_setup']) {
    const start = source.indexOf('async fn ' + command + '(');
    assert.ok(start >= 0);
    const tail = source.slice(start);
    const next = tail.indexOf('#[tauri::command]');
    const body = next < 0 ? tail : tail.slice(0, next);
    assert.ok(body.indexOf('assert_local(&window)?') < body.indexOf('spawn_blocking'));
    assert.ok(body.includes('assert_local(&window)?'));
    assert.ok(build.includes('"' + command + '"'));
    assert.ok(desktop.includes('first_run::' + command));
    assert.ok(capability.permissions.includes('allow-' + command.replaceAll('_', '-')));
  }
  const discovery = source.slice(0, source.indexOf('struct SetupLease'));
  assert.doesNotMatch(discovery, /setup::complete\(|ensure_ready\(|save_new\(|stop_service\(/);
  const completion = source.slice(source.indexOf('async fn complete_setup('));
  assert.ok(completion.includes('compare_exchange(false, true'));
  assert.ok(completion.indexOf('setup::complete(') < completion.indexOf('ensure_ready('));
  assert.doesNotMatch(completion, /stop_service|[.]stop\(|[.]run\(/);
  assert.match(source, /impl Drop for SetupLease/);
  const ensure = desktop.slice(desktop.indexOf('fn ensure_ready('), desktop.indexOf('fn stop_service('));
  assert.ok(ensure.indexOf('config::needs_setup(') < ensure.indexOf('check_environment(app, controller)?'));
  assert.ok(ensure.includes('s.setup_required = true'));
});
