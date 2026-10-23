import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const source = stripTypeScriptTypes(readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, ''));
const flush = () => new Promise(resolve => setImmediate(resolve));
const checkIds = ['wsl', 'config', 'distribution', 'user', 'python', 'launcher', 'linux_config', 'repository', 'node', 'dependencies', 'web_assets'];
const environment = (extra = {}) => ({ checks: checkIds.map(id => ({ id, label: id, status: 'passed', message: '已通过', hint: '' })), repository: '/home/test/deepseek-harness', ...extra });
const base = (extra = {}) => ({ state: 'ready', phase: '已就绪', message: '正常', busy: false, managed: true, origin: 'http://127.0.0.1:3080', last_error: null, logs: [], environment: environment(), environment_checking: false, config_path: 'C:/test/config.json', ...extra });
const update = (extra = {}) => ({ current_version: '0.1.0', phase: 'idle', version: null, notes: null, downloaded: 0, total: null, message: '可检查更新', busy: false, ...extra });
const notification = (extra = {}) => ({ enabled: false, notify_when_focused: false, phase: 'disabled', message: '未启用系统通知。', ...extra });
const power = (extra = {}) => ({ enabled: true, active: false, phase: 'idle', message: '等待运行中的任务。', ...extra });
const listening = (extra = {}) => notification({ enabled: true, phase: 'listening', message: '通知检查正常', ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function mount(native, initial = base(), options = {}) {
  let savedNotification = options.initialNotification || notification();
  let savedPower = options.initialPower || power();
  const nodes = new Map(); const subscriptions = new Map(); const calls = []; const windowHandlers = new Map(); const listenCalls = []; const unlistened = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, textContent: '', dataset: {}, hidden: false, disabled: false, checked: false, open: false, scrollTop: 0, scrollHeight: 0, clientHeight: 0, handlers: {}, attributes: {}, set innerHTML(_) { throw new Error('Native data must not use HTML'); }, addEventListener(name, fn) { this.handlers[name] = fn; }, setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; if (name === 'value') delete this.value; }, focus() { this.focused = true; }, scrollIntoView() { this.scrolled = true; } });
    return nodes.get(id);
  };
  const root = { template: '', set innerHTML(template) { this.template = template; for (const match of template.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) { const item = node(match[1]); item.hidden = /\bhidden(?:\s|>)/.test(match[0]); item.disabled = /\bdisabled(?:\s|>)/.test(match[0]); } } };
  const location = { href: options.location || (options.mode === 'startup' ? 'http://127.0.0.1:1420/index.html' : 'http://127.0.0.1:1420/index.html?view=settings&section=environment') };
  const context = vm.createContext({
    appIconUrl: 'app-icon.png',
    URL, console, document: { querySelector: () => root, getElementById: id => nodes.get(id) }, window: { location, addEventListener(name, handler) { windowHandlers.set(name, handler); } },
    isTauri: () => native,
    listen: async (name, callback) => { listenCalls.push(name); if (options.listen) await options.listen(name, callback); subscriptions.set(name, callback); return () => { unlistened.push(name); subscriptions.delete(name); }; },
    invoke: async (name, args) => {
      calls.push([name, args]);
      const fallback = () => {
        if (name === 'get_snapshot' || name === 'perform_action' || name === 'set_project_directory') return initial;
        if (['get_update_snapshot', 'check_update', 'install_update'].includes(name)) return options.initialUpdate || update();
        if (name === 'get_power_snapshot') return savedPower;
        if (name === 'set_power_enabled') {
          savedPower = power({ enabled: args.enabled, phase: args.enabled ? 'idle' : 'disabled', message: args.enabled ? '等待运行中的任务。' : '未启用任务期间防休眠。' });
          return savedPower;
        }
        if (name === 'get_notification_snapshot' || name === 'test_notification') return savedNotification;
        if (name === 'set_notifications_enabled') {
          const extra = { notify_when_focused: args.notifyWhenFocused ?? savedNotification.notify_when_focused };
          savedNotification = args.enabled ? listening(extra) : notification(extra);
          return savedNotification;
        }
        if (name === 'open_settings' || name === 'return_from_settings') return;
        if (name === 'settings_page_ready') return options.readySection || new URL(location.href).searchParams.get('section') || 'environment';
        throw new Error('Unexpected command: ' + name);
      };
      return options.invoke ? options.invoke(name, args, { subscriptions, fallback }) : fallback();
    },
  });
  vm.runInContext(source, context); await flush();
  return { template: root.template, power(snapshot) { subscriptions.get('launcher-power-state')?.({ payload: snapshot }); }, node(id) { assert.ok(nodes.has(id), 'Missing DOM node: ' + id); return nodes.get(id); }, has: id => nodes.has(id), location, calls, subscriptions, listenCalls, unlistened, async change(id, checked) { const item = nodes.get(id); if (!item) return; item.checked = checked; item.handlers.change?.(); await flush(); }, notification(snapshot) { subscriptions.get('launcher-notification-state')?.({ payload: snapshot }); }, unload() { windowHandlers.get('beforeunload')?.(); }, event(snapshot) { subscriptions.get('launcher-state')?.({ payload: snapshot }); }, update(snapshot) { subscriptions.get('launcher-update-state')?.({ payload: snapshot }); }, async click(id) { nodes.get(id)?.handlers.click?.(); await flush(); } };
}

test('browser previews never invoke native commands or subscribe in either view', async () => {
  for (const mode of ['startup', 'settings']) {
    const app = await mount(false, base(), { mode });
    for (const id of ['check', 'save-repository', 'open', 'logs', 'check-update', 'install-update', 'notifications-enabled', 'notifications-when-focused', 'test-notification', 'power-enabled', 'power-refresh']) {
      if (app.has(id)) assert.equal(app.node(id).disabled, true);
      await app.click(id);
    }
    await app.change('notifications-enabled', true);
    await app.change('notifications-when-focused', true);
    await app.change('power-enabled', false);
    for (const section of ['environment', 'notifications', 'power', 'updates', 'logs']) await app.click('nav-' + section);
    assert.equal(app.calls.length, 0); assert.equal(app.listenCalls.length, 0); assert.equal(app.subscriptions.size, 0);
    if (mode === 'settings') {
      assert.equal(app.node('notifications-enabled').checked, false);
      assert.match(app.node('notification-message').textContent, /预览.*不会请求网页通知权限/);
      assert.equal(app.node('power-enabled').checked, true);
      assert.match(app.node('power-message').textContent, /预览.*不连接电源管理服务/);
      assert.match(app.node('power-active').textContent, /未提供实际休眠保护/);
      assert.equal(app.node('settings-preview').hidden, false);
    } else assert.equal(app.node('preview-note').hidden, false);
  }
});

test('stopped startup offers an explicit open retry without launching automatically in the frontend', async () => {
  const app = await mount(true, base({ state: 'stopped', managed: false }), { mode: 'startup' });
  assert.equal(app.calls.filter(([name]) => name === 'perform_action').length, 0);
  assert.equal(app.node('open').disabled, false);
  await app.click('open'); assert.equal(app.calls.at(-1)[0], 'perform_action'); assert.equal(app.calls.at(-1)[1].action, 'open');
});

test('waiting for browser authentication stays active then advances without a manual retry', async () => {
  const app = await mount(true, base({ busy: true, phase: '等待网页登录认证',
    message: '服务已启动，正在等待网页登录认证链接；就绪后将自动打开 DSH。' }), { mode: 'startup' });
  assert.equal(app.node('startup-shell').dataset.state, 'starting');
  assert.equal(app.node('stage-environment').dataset.state, 'passed');
  assert.equal(app.node('stage-service').dataset.state, 'active');
  assert.equal(app.node('stage-window').dataset.state, 'pending');
  assert.equal(app.node('error-notice').hidden, true);
  assert.equal(app.node('startup-progress').hidden, false);
  assert.equal(app.node('startup-actions').hidden, true);
  assert.match(app.node('status-message').textContent, /等待网页登录认证/);
  app.event(base({ busy: true, phase: '打开工作窗口' }));
  assert.equal(app.node('stage-service').dataset.state, 'passed');
  assert.equal(app.node('stage-window').dataset.state, 'active');
  app.event(base());
  assert.equal(app.node('startup-shell').dataset.state, 'ready');
  assert.equal(app.node('stage-window').dataset.state, 'passed');
  assert.equal(app.calls.filter(([name]) => name === 'perform_action').length, 0);
});

test('startup has no settings dashboard or standalone service controls', async () => {
  const app = await mount(true, base({ managed: false }), { mode: 'startup' });
  assert.equal(app.has('startup-shell'), true);
  for (const id of ['settings-shell', 'settings-back', 'service-card', 'start', 'stop', 'restart', 'quit', 'exit', 'repository-input', 'save-repository', 'origin', 'config-location', 'notifications-enabled', 'notification-message', 'power-enabled', 'power-refresh', 'power-active', 'power-message', 'nav-power', 'check-update', 'install-update', 'update-notes', 'logs', 'log-output', 'nav-environment']) {
    assert.equal(app.has(id), false, id); await app.click(id);
  }
  assert.equal(app.calls.filter(([name]) => name === 'perform_action').length, 0);
});

test('busy snapshots lock settings environment check, directory save and update install', async () => {
  const app = await mount(true, base({ state: 'stopped' }), { initialUpdate: update({ phase: 'available', version: '0.2.0' }) });
  app.node('repository-input').value = '/home/test/new'; app.node('repository-input').handlers.input();
  assert.equal(app.node('save-repository').disabled, false);
  app.event(base({ state: 'stopped', busy: true }));
  for (const id of ['check', 'logs', 'save-repository', 'install-update']) { assert.equal(app.node(id).disabled, true); await app.click(id); }
  assert.equal(app.calls.filter(([name]) => ['perform_action', 'set_project_directory', 'install_update'].includes(name)).length, 0);
  assert.equal(app.node('check-update').disabled, false);
});

test('native settings diagnostics stay text-only and redact credentials', async () => {
  const secret = 'test-secret-value'; const app = await mount(true, base({ last_error: '<img onerror=bad> token=' + secret,
    origin: 'http://user:password@127.0.0.1:3080/?token=' + secret, config_path: 'C:/test/config.json?token=' + secret,
    logs: ['Bearer ' + secret, '<script>bad</script> token=' + secret] }));
  assert.match(app.node('error-notice').textContent, /<img onerror=bad>/);
  assert.match(app.node('log-output').textContent, /<script>bad<\/script>/);
  for (const id of ['error-notice', 'origin', 'config-location', 'log-output']) assert.ok(!app.node(id).textContent.includes(secret));
  assert.equal(app.node('origin').textContent, 'http://127.0.0.1:3080');
});

test('startup subscribes before querying and silently checks updates once without settings initialization', async () => {
  const app = await mount(true, base(), { mode: 'startup', invoke(name, _args, { subscriptions, fallback }) {
    if (name === 'get_snapshot') assert.ok(subscriptions.has('launcher-state'));
    if (name === 'get_update_snapshot') assert.ok(subscriptions.has('launcher-update-state'));
    return fallback();
  } });
  assert.equal(app.calls.filter(([name]) => name === 'check_update').length, 1);
  assert.equal(app.calls.filter(([name]) => ['install_update', 'get_notification_snapshot', 'get_power_snapshot', 'set_power_enabled', 'perform_action', 'open_settings'].includes(name)).length, 0);
  assert.equal(app.listenCalls.includes('launcher-notification-state'), false);
  assert.equal(app.listenCalls.includes('launcher-power-state'), false);
  assert.equal(app.has('check-update'), false); assert.equal(app.has('install-update'), false);
  app.update(update({ phase: 'available', version: '0.2.0' }));
  app.event(base()); await flush();
  assert.equal(app.calls.filter(([name]) => name === 'check_update').length, 1);
  assert.equal(app.has('settings-shell'), false);
  app.unload(); assert.equal(app.subscriptions.size, 0);
});

test('existing available or busy update is not rechecked at startup', async () => {
  for (const initialUpdate of [update({ phase: 'available', version: '0.2.0' }), update({ phase: 'checking', busy: true }), update({ phase: 'downloading', busy: true })]) {
    const app = await mount(true, base(), { mode: 'startup', initialUpdate });
    assert.equal(app.calls.filter(([name]) => name === 'check_update').length, 0);
  }
});

test('available updates stay text-only without auto navigating and explicit menu reveal selects updates', async () => {
  const notes = '<img src=x onerror=bad>\n<script>bad()</script> **not HTML**';
  const app = await mount(true, base(), { initialUpdate: update({ phase: 'available', version: '0.2.0', notes }) });
  assert.equal(app.node('install-update').hidden, false); assert.equal(app.node('install-update').disabled, false);
  assert.equal(app.node('update-new-version').textContent, '新版本 0.2.0'); assert.equal(app.node('update-notes').textContent, notes);
  assert.equal(app.node('settings-environment').hidden, false); assert.equal(app.node('settings-updates').hidden, true);
  app.update(update({ phase: 'available', version: '0.3.0', notes }));
  assert.equal(app.node('settings-environment').hidden, false);
  const calls = [...app.calls]; app.subscriptions.get('launcher-show-updates')?.({});
  assert.equal(app.node('settings-updates').hidden, false); assert.equal(app.node('settings-environment').hidden, true);
  assert.deepEqual(app.calls, calls); assert.equal(app.calls.filter(([name]) => name === 'check_update').length, 0);
});

test('checking can coexist with service work but installation cannot', async () => {
  const checking = deferred();
  const app = await mount(true, base({ busy: true }), { initialUpdate: update({ phase: 'available', version: '0.2.0' }), invoke(name, _args, { fallback }) { return name === 'check_update' ? checking.promise : fallback(); } });
  assert.equal(app.node('install-update').disabled, true);
  assert.equal(app.node('check-update').disabled, false);
  await app.click('check-update');
  app.event(base());
  app.update(update({ phase: 'checking', busy: true }));
  assert.equal(app.node('check').disabled, false);
  assert.equal(app.node('logs').disabled, false);
  assert.equal(app.node('check-update').disabled, true);
  await app.click('check-update');
  assert.equal(app.calls.filter(([name]) => name === 'check_update').length, 1);
  checking.resolve(update({ phase: 'up_to_date' })); await flush();
  app.update(update({ phase: 'up_to_date', message: '已经是最新版本' }));
  assert.equal(app.node('update-message').textContent, '已经是最新版本');
  assert.equal(app.node('check-update').disabled, false);
});

test('download and installation lock settings actions with known or unknown progress', async () => {
  const installation = deferred();
  const app = await mount(true, base(), { initialUpdate: update({ phase: 'available', version: '0.2.0' }), invoke(name, _args, { fallback }) { return name === 'install_update' ? installation.promise : fallback(); } });
  await app.click('install-update'); await app.click('install-update');
  assert.equal(app.calls.filter(([name]) => name === 'install_update').length, 1);
  for (const id of ['check', 'logs', 'save-repository', 'check-update', 'install-update']) assert.equal(app.node(id).disabled, true);
  app.update(update({ phase: 'downloading', busy: true, downloaded: 1024, total: 4096 }));
  assert.equal(app.node('update-progress-row').hidden, false);
  assert.equal(app.node('update-progress').value, 1024);
  assert.equal(app.node('update-progress').max, 4096);
  assert.match(app.node('update-progress-label').textContent, /^25%/);
  app.update(update({ phase: 'downloading', busy: true, downloaded: 2048, total: null }));
  assert.equal(app.node('update-progress').value, undefined);
  assert.match(app.node('update-progress-label').textContent, /2.0 KB.*总大小未知/);
  app.update(update({ phase: 'installing', busy: true }));
  installation.resolve(update()); await flush();
  assert.equal(app.node('check').disabled, true);
  assert.equal(app.node('logs').disabled, true);
  assert.equal(app.node('update-progress').value, undefined);
  assert.equal(app.node('update-progress-label').textContent, '正在安装…');
  app.update(update({ phase: 'error', version: '0.2.0', message: '安装失败，请重试' }));
  assert.equal(app.node('check').disabled, false);
  assert.equal(app.node('logs').disabled, false);
  assert.equal(app.node('check-update').disabled, false);
  assert.equal(app.node('install-update').hidden, true);
  assert.equal(app.node('install-update').disabled, true);
  assert.equal(app.node('update-message').dataset.error, 'true');
});

test('error retaining release context requires a fresh check before installation', async () => {
  const available = update({ phase: 'available', version: '0.2.0', notes: 'Release notes' });
  const app = await mount(true, base(), { initialUpdate: available });
  app.update(update({ phase: 'error', version: '0.2.0', notes: 'Release notes', message: '校验失败，请重新检查更新' }));
  assert.equal(app.node('update-new-version').textContent, '新版本 0.2.0');
  assert.equal(app.node('update-notes').textContent, 'Release notes');
  assert.equal(app.node('install-update').hidden, true);
  assert.equal(app.node('install-update').disabled, true);
  await app.click('install-update');
  assert.equal(app.calls.filter(([name]) => name === 'install_update').length, 0);
  await app.click('check-update');
  assert.equal(app.calls.filter(([name]) => name === 'check_update').length, 1);
  assert.equal(app.node('install-update').hidden, false);
  assert.equal(app.node('install-update').disabled, false);
  app.update(update({ phase: 'idle', version: '0.2.0' }));
  assert.equal(app.node('install-update').hidden, true);
  assert.equal(app.node('install-update').disabled, true);
});

test('failed IPC is retryable and native cancellation preserves an available release', async () => {
  let attempts = 0;
  const available = update({ phase: 'available', version: '0.2.0' });
  const app = await mount(true, base(), { initialUpdate: available, invoke(name, _args, { fallback }) {
    if (name === 'install_update' && attempts++ === 0) throw new Error('download failed');
    return fallback();
  } });
  await app.click('install-update');
  assert.match(app.node('update-message').textContent, /可重试.*download failed/);
  assert.equal(app.node('install-update').disabled, false);
  await app.click('install-update');
  assert.equal(app.node('install-update').disabled, false);
  assert.equal(app.node('check').disabled, false);
  assert.equal(attempts, 2);
  assert.equal(app.calls.filter(([name]) => name === 'perform_action').length, 0);
});

test('newer update events beat delayed snapshot and command replies', async () => {
  const initial = deferred(); const check = deferred();
  const app = await mount(true, base(), { invoke(name, _args, { fallback }) {
    if (name === 'get_update_snapshot') return initial.promise;
    if (name === 'check_update') return check.promise;
    return fallback();
  } });
  app.update(update({ phase: 'available', version: '0.3.0', message: 'newer event' }));
  initial.resolve(update()); await flush();
  assert.equal(app.node('update-new-version').textContent, '新版本 0.3.0');
  assert.equal(app.calls.filter(([name]) => name === 'check_update').length, 0);
  await app.click('check-update');
  app.update(update({ phase: 'available', version: '0.4.0', message: 'newest event' }));
  check.resolve(update({ phase: 'up_to_date' })); await flush();
  assert.equal(app.node('update-new-version').textContent, '新版本 0.4.0');
  assert.equal(app.node('update-message').textContent, 'newest event');
});

test('settings update snapshot and manual check failures leave explicit retry available', async () => {
  let checks = 0;
  const app = await mount(true, base(), { invoke(name, _args, { fallback }) {
    if (name === 'get_update_snapshot') throw new Error('read failed');
    if (name === 'check_update' && checks++ === 0) throw new Error('offline');
    return fallback();
  } });
  assert.equal(checks, 0); assert.equal(app.node('check-update').disabled, false);
  assert.match(app.node('update-message').textContent, /read failed/);
  await app.click('check-update'); assert.match(app.node('update-message').textContent, /offline/);
  await app.click('check-update'); assert.equal(checks, 2); assert.equal(app.node('update-message').dataset.error, 'false');
});

test('notifications default off, subscribe before reading, and change only by explicit setting', async () => {
  const app = await mount(true, base(), { invoke(name, _args, { subscriptions, fallback }) {
    if (name === 'get_notification_snapshot') assert.ok(subscriptions.has('launcher-notification-state'));
    return fallback();
  } });
  assert.equal(app.node('notifications-enabled').checked, false);
  assert.equal(app.node('notifications-enabled').disabled, false);
  assert.equal(app.node('test-notification').disabled, true);
  assert.equal(app.calls.filter(([name]) => name === 'set_notifications_enabled' || name === 'test_notification').length, 0);
  await app.click('test-notification');
  assert.equal(app.calls.filter(([name]) => name === 'test_notification').length, 0);
  await app.change('notifications-enabled', true);
  const setting = app.calls.find(([name]) => name === 'set_notifications_enabled');
  assert.equal(setting[1].enabled, true);
  assert.equal(app.node('notifications-enabled').checked, true);
  assert.equal(app.node('test-notification').disabled, false);
  assert.match(app.node('notification-message').textContent, /正在检查/);
  await app.change('notifications-enabled', false);
  assert.equal(app.calls.filter(([name]) => name === 'set_notifications_enabled').at(-1)[1].enabled, false);
  assert.equal(app.node('notifications-enabled').checked, false);
  assert.equal(app.node('test-notification').disabled, true);
  app.unload();
  assert.equal(app.subscriptions.size, 0);
  assert.equal(app.unlistened.filter(name => name === 'launcher-notification-state').length, 1);
});

test('focused notifications require opt-in and preserve preference across master toggle', async () => {
  const app = await mount(true);
  assert.equal(app.node('notifications-when-focused').checked, false);
  assert.equal(app.node('notifications-when-focused').disabled, true);
  await app.change('notifications-when-focused', true);
  assert.equal(app.node('notifications-when-focused').checked, false);
  assert.equal(app.calls.filter(([name]) => name === 'set_notifications_enabled').length, 0);
  await app.change('notifications-enabled', true);
  assert.equal(app.node('notifications-when-focused').disabled, false);
  await app.change('notifications-when-focused', true);
  const args = app.calls.filter(([name]) => name === 'set_notifications_enabled').at(-1)[1];
  assert.equal(args.enabled, true); assert.equal(args.notifyWhenFocused, true);
  assert.equal(app.node('notifications-when-focused').checked, true);
  await app.change('notifications-enabled', false);
  assert.equal(app.node('notifications-when-focused').checked, true);
  assert.equal(app.node('notifications-when-focused').disabled, true);
  await app.change('notifications-enabled', true);
  assert.equal(app.node('notifications-when-focused').checked, true);
  await app.change('notifications-when-focused', false);
  assert.equal(app.node('notifications-when-focused').checked, false);
  assert.equal(app.node('notifications-enabled').checked, true);
});

test('focused notification preference restores, rolls back on failure and retries', async () => {
  let attempts = 0;
  const app = await mount(true, base(), { initialNotification: listening({ notify_when_focused: true }), invoke(name, args, { fallback }) {
    if (name === 'set_notifications_enabled' && args.notifyWhenFocused !== undefined && attempts++ === 0) throw new Error('save failed');
    return fallback();
  } });
  assert.equal(app.node('notifications-when-focused').checked, true);
  await app.change('notifications-when-focused', false);
  assert.equal(app.node('notifications-when-focused').checked, true);
  assert.equal(app.node('notifications-when-focused').disabled, false);
  assert.match(app.node('notification-message').textContent, /可重试.*save failed/);
  await app.change('notifications-when-focused', false);
  assert.equal(app.node('notifications-when-focused').checked, false);
  assert.equal(app.node('notification-message').dataset.error, 'false');
});

test('focused notification changes share busy lock and respect newer events', async () => {
  const saving = deferred();
  const app = await mount(true, base(), { initialNotification: listening(), invoke(name, _args, { fallback }) {
    return name === 'set_notifications_enabled' ? saving.promise : fallback();
  } });
  await app.change('notifications-when-focused', true);
  for (const id of ['notifications-enabled', 'notifications-when-focused', 'test-notification']) assert.equal(app.node(id).disabled, true);
  await app.change('notifications-when-focused', false);
  await app.change('notifications-enabled', false);
  await app.click('test-notification');
  assert.equal(app.calls.filter(([name]) => name === 'set_notifications_enabled').length, 1);
  assert.equal(app.calls.filter(([name]) => name === 'test_notification').length, 0);
  app.notification(listening({ notify_when_focused: true, message: 'new policy event' }));
  saving.resolve(listening()); await flush();
  assert.equal(app.node('notifications-when-focused').checked, true);
  assert.equal(app.node('notifications-when-focused').disabled, false);
  assert.match(app.node('notification-message').textContent, /new policy event/);
});

test('notification settings and test share a busy lock without locking environment check', async () => {
  const setting = deferred(); const testing = deferred();
  const app = await mount(true, base(), { invoke(name, _args, { fallback }) {
    if (name === 'set_notifications_enabled') return setting.promise;
    if (name === 'test_notification') return testing.promise;
    return fallback();
  } });
  await app.change('notifications-enabled', true);
  assert.equal(app.node('notifications-enabled').disabled, true);
  assert.equal(app.node('test-notification').disabled, true);
  assert.equal(app.node('check').disabled, false);
  await app.change('notifications-enabled', true); await app.click('test-notification');
  assert.equal(app.calls.filter(([name]) => name === 'set_notifications_enabled').length, 1);
  assert.equal(app.calls.filter(([name]) => name === 'test_notification').length, 0);
  setting.resolve(listening()); await flush();
  await app.click('test-notification'); await app.click('test-notification');
  await app.change('notifications-enabled', false);
  assert.equal(app.calls.filter(([name]) => name === 'test_notification').length, 1);
  assert.equal(app.calls.filter(([name]) => name === 'set_notifications_enabled').length, 1);
  assert.equal(app.node('notifications-enabled').checked, true);
  testing.resolve(listening({ message: '已提交系统通知' })); await flush();
  assert.equal(app.node('test-notification').disabled, false);
  assert.match(app.node('notification-message').textContent, /已提交.*不保证显示横幅.*Windows 勿扰/);
});

test('notification phases and diagnostics remain plain redacted text', async () => {
  const app = await mount(true);
  app.notification(listening({ phase: 'connecting', message: '正在连接' }));
  assert.equal(app.node('notifications-enabled').checked, true);
  assert.equal(app.node('notifications-enabled').disabled, false); // Disabling must remain possible while connecting.
  assert.equal(app.node('test-notification').disabled, false);
  assert.match(app.node('notification-message').textContent, /连接中/);
  await app.click('test-notification');
  assert.equal(app.calls.filter(([name]) => name === 'test_notification').length, 1); // Testing is independent of the Harness connection.
  app.notification(listening({ phase: 'error', message: '<img onerror=bad> token=secret-value' }));
  assert.equal(app.node('notification-message').dataset.error, 'true');
  assert.match(app.node('notification-message').textContent, /<img onerror=bad>/);
  assert.ok(!app.node('notification-message').textContent.includes('secret-value'));
  assert.equal(app.node('test-notification').disabled, false);
  app.notification(notification());
  assert.equal(app.node('notification-message').dataset.error, 'false');
  assert.equal(app.node('notifications-enabled').checked, false);
});

test('notification read, setting, and test IPC failures can all be retried', async () => {
  let settings = 0; let tests = 0;
  const app = await mount(true, base(), { invoke(name, _args, { fallback }) {
    if (name === 'get_notification_snapshot') throw new Error('read failed');
    if (name === 'set_notifications_enabled' && settings++ === 0) throw new Error('setting failed');
    if (name === 'test_notification') {
      if (tests++ === 0) throw new Error('test failed');
      return listening();
    }
    return fallback();
  } });
  assert.match(app.node('notification-message').textContent, /可重试.*read failed/);
  assert.equal(app.node('notifications-enabled').disabled, false);
  await app.change('notifications-enabled', true);
  assert.match(app.node('notification-message').textContent, /可重试.*setting failed/);
  assert.equal(app.node('notifications-enabled').checked, false);
  await app.change('notifications-enabled', true);
  assert.equal(app.node('notifications-enabled').checked, true);
  await app.click('test-notification');
  assert.match(app.node('notification-message').textContent, /可重试.*test failed/);
  assert.equal(app.node('test-notification').disabled, false);
  await app.click('test-notification');
  assert.equal(app.node('notification-message').dataset.error, 'false');
  assert.equal(settings, 2); assert.equal(tests, 2);
});

test('notification subscription failure is retryable before any command is sent', async () => {
  let attempts = 0;
  const app = await mount(true, base(), { listen(name) {
    if (name === 'launcher-notification-state' && attempts++ === 0) throw new Error('listen failed');
  } });
  assert.match(app.node('notification-message').textContent, /可重试.*listen failed/);
  assert.equal(app.calls.filter(([name]) => name === 'get_notification_snapshot').length, 0);
  await app.change('notifications-enabled', true);
  assert.equal(attempts, 2);
  assert.equal(app.node('notifications-enabled').checked, true);
  assert.ok(app.subscriptions.has('launcher-notification-state'));
});

test('notification events during listener registration beat the initial read', async () => {
  const app = await mount(true, base(), { listen(name, callback) {
    if (name === 'launcher-notification-state') callback({ payload: listening({ message: 'early event' }) });
  } });
  assert.equal(app.node('notifications-enabled').checked, true);
  assert.match(app.node('notification-message').textContent, /early event/);
});

test('newer notification events beat delayed read, setting, test replies and failures', async () => {
  const initial = deferred(); const setting = deferred(); const testing = deferred();
  const app = await mount(true, base(), { invoke(name, _args, { fallback }) {
    if (name === 'get_notification_snapshot') return initial.promise;
    if (name === 'set_notifications_enabled') return setting.promise;
    if (name === 'test_notification') return testing.promise;
    return fallback();
  } });
  app.notification(listening({ message: 'read event' }));
  initial.resolve(notification()); await flush();
  assert.equal(app.node('notifications-enabled').checked, true);
  assert.match(app.node('notification-message').textContent, /read event/);
  await app.change('notifications-enabled', false);
  app.notification(listening({ message: 'setting event' }));
  setting.resolve(notification()); await flush();
  assert.equal(app.node('notifications-enabled').checked, true);
  assert.match(app.node('notification-message').textContent, /setting event/);
  await app.click('test-notification');
  app.notification(notification({ message: 'latest disabled event' }));
  testing.reject(new Error('stale test error')); await flush();
  assert.equal(app.node('notifications-enabled').checked, false);
  assert.equal(app.node('notification-message').dataset.error, 'false');
  assert.match(app.node('notification-message').textContent, /latest disabled event/);
});

test('late successful notification test replies cannot overwrite newer event state', async () => {
  const testing = deferred();
  const app = await mount(true, base(), { initialNotification: listening(), invoke(name, _args, { fallback }) {
    return name === 'test_notification' ? testing.promise : fallback();
  } });
  await app.click('test-notification');
  app.notification(notification({ message: 'turned off elsewhere' }));
  testing.resolve(listening({ message: 'old test success' })); await flush();
  assert.equal(app.node('notifications-enabled').checked, false);
  assert.match(app.node('notification-message').textContent, /turned off elsewhere/);
});

test('unload cleans notification listeners even when registration resolves late', async () => {
  const registration = deferred();
  const app = await mount(true, base(), { listen(name) {
    if (name === 'launcher-notification-state') return registration.promise;
  } });
  app.unload(); registration.resolve(); await flush();
  assert.equal(app.subscriptions.has('launcher-notification-state'), false);
  assert.equal(app.unlistened.filter(name => name === 'launcher-notification-state').length, 1);
  assert.equal(app.calls.filter(([name]) => name === 'get_notification_snapshot').length, 0);
  await app.change('notifications-enabled', true);
  assert.equal(app.calls.filter(([name]) => name === 'set_notifications_enabled').length, 0);
});


test('power defaults enabled, subscribes before read, and provides the protection boundaries', async () => {
  const app = await mount(true, base(), { invoke(name, args, { subscriptions, fallback }) {
    if (name === 'get_power_snapshot') { assert.ok(subscriptions.has('launcher-power-state')); assert.equal(args, undefined); }
    return fallback();
  } });
  assert.equal(app.node('power-enabled').checked, true);
  assert.equal(app.node('power-enabled').disabled, false);
  assert.equal(app.node('power-active').dataset.active, 'false');
  assert.match(app.node('power-active').textContent, /当前未在/);
  assert.match(app.node('power-message').textContent, /等待任务.*等待运行中的任务/);
  assert.equal(app.calls.filter(([name]) => name === 'get_power_snapshot').length, 1);
  assert.equal(app.calls.filter(([name]) => name === 'set_power_enabled').length, 0);
  assert.match(app.template, /默认启用.*仅防止系统自动休眠.*屏幕仍可熄灭/);
  assert.match(app.template, /托盘后继续保护.*退出启动器后不再保护.*不阻止手动睡眠或合盖休眠/);
  const sections = [...app.template.matchAll(/id="nav-([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(sections, ['environment', 'notifications', 'power', 'updates', 'logs']);
  await app.click('nav-power');
  assert.equal(app.node('settings-title').textContent, '电源管理');
  assert.match(app.node('settings-description').textContent, /系统自动休眠保护/);
});

test('power restores a disabled setting and writes only enabled on explicit toggles', async () => {
  const app = await mount(true, base(), { initialPower: power({ enabled: false, phase: 'disabled' }) });
  assert.equal(app.node('power-enabled').checked, false);
  await app.change('power-enabled', true);
  await app.change('power-enabled', false);
  const requests = app.calls.filter(([name]) => name === 'set_power_enabled');
  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(requests.map(([, args]) => args))), [{ enabled: true }, { enabled: false }]);
  assert.equal(app.node('power-enabled').checked, false);
  assert.equal(app.node('notifications-enabled').checked, false);
  assert.equal(app.calls.filter(([name]) => name === 'set_notifications_enabled').length, 0);
});

test('power phases and actual active protection are distinct, plain text and redacted', async () => {
  const app = await mount(true);
  for (const [phase, label] of [['disabled', '未启用'], ['connecting', '连接中'], ['idle', '等待任务'], ['active', '保护中'], ['error', '电源管理异常']]) {
    // An error may still retain an existing protection request: active is authoritative.
    const active = phase === 'active' || phase === 'error';
    app.power(power({ enabled: phase !== 'disabled', active, phase, message: '<img onerror=bad> token=private-power Bearer private-bearer' }));
    assert.equal(app.node('power-message').dataset.phase, phase);
    assert.equal(app.node('power-message').dataset.error, String(phase === 'error'));
    assert.match(app.node('power-message').textContent, new RegExp(label));
    assert.match(app.node('power-message').textContent, /<img onerror=bad>/);
    assert.doesNotMatch(app.node('power-message').textContent, /private-power|private-bearer/);
    assert.equal(app.node('power-active').dataset.active, String(active));
    assert.equal(app.node('power-active').textContent, active ? '当前正在防止系统自动休眠' : '当前未在防止系统自动休眠');
    assert.equal(app.node('power-enabled').disabled, false);
  }
});

test('power saving failure rolls back either toggle direction and permits retry', async () => {
  for (const enabled of [true, false]) {
    let attempts = 0;
    const app = await mount(true, base(), { initialPower: power({ enabled, phase: enabled ? 'idle' : 'disabled' }), invoke(name, _args, { fallback }) {
      if (name === 'set_power_enabled' && attempts++ === 0) throw new Error('<script>save failed</script> token=private-power');
      return fallback();
    } });
    await app.change('power-enabled', !enabled);
    assert.equal(app.node('power-enabled').checked, enabled);
    assert.equal(app.node('power-enabled').disabled, false);
    assert.equal(app.node('power-message').dataset.error, 'true');
    assert.match(app.node('power-message').textContent, /保存失败.*可重试.*<script>save failed/);
    assert.doesNotMatch(app.node('power-message').textContent, /private-power/);
    await app.change('power-enabled', !enabled);
    assert.equal(app.node('power-enabled').checked, !enabled);
    assert.equal(app.node('power-message').dataset.error, 'false');
  }
});

test('power read must succeed before a toggle can write the default setting', async () => {
  const initial = deferred();
  const app = await mount(true, base(), { invoke(name, _args, { fallback }) { return name === 'get_power_snapshot' ? initial.promise : fallback(); } });
  assert.equal(app.node('power-enabled').checked, true);
  assert.equal(app.node('power-enabled').disabled, true);
  assert.equal(app.node('power-active').dataset.active, 'unknown');
  await app.change('power-enabled', false);
  assert.equal(app.node('power-enabled').checked, true);
  assert.equal(app.calls.filter(([name]) => name === 'set_power_enabled').length, 0);
  initial.reject(new Error('read failed token=private-power')); await flush();
  assert.equal(app.node('power-enabled').disabled, true);
  assert.equal(app.node('power-message').dataset.error, 'true');
  assert.match(app.node('power-message').textContent, /无法读取电源设置.*重试检测.*read failed/);
  assert.doesNotMatch(app.node('power-message').textContent, /private-power/);
  await app.change('power-enabled', false);
  assert.equal(app.calls.filter(([name]) => name === 'set_power_enabled').length, 0);
  // A later authoritative event recovers the setting without writing a guessed default.
  app.power(power({ enabled: false, phase: 'disabled', message: 'recovered' }));
  assert.equal(app.node('power-enabled').disabled, false);
  assert.equal(app.node('power-enabled').checked, false);
  assert.equal(app.node('power-message').dataset.error, 'false');
});

test('notification and power operations, errors and busy locks are independent', async () => {
  const saving = deferred(); const notifying = deferred();
  const app = await mount(true, base({ busy: true }), { invoke(name, _args, { fallback }) {
    if (name === 'set_power_enabled') return saving.promise;
    if (name === 'set_notifications_enabled') return notifying.promise;
    return fallback();
  } });
  await app.change('power-enabled', false);
  assert.equal(app.node('power-enabled').disabled, true);
  assert.equal(app.node('notifications-enabled').disabled, false);
  await app.change('power-enabled', true);
  assert.equal(app.calls.filter(([name]) => name === 'set_power_enabled').length, 1);
  await app.change('notifications-enabled', true);
  assert.equal(app.node('notifications-enabled').disabled, true);
  saving.resolve(power({ enabled: false, phase: 'disabled' })); await flush();
  assert.equal(app.node('power-enabled').checked, false);
  assert.equal(app.node('power-enabled').disabled, false);
  notifying.reject(new Error('notification failure')); await flush();
  assert.equal(app.node('notification-message').dataset.error, 'true');
  assert.equal(app.node('power-message').dataset.error, 'false');
  app.notification(listening());
  assert.equal(app.node('power-enabled').checked, false);
  app.power(power());
  assert.equal(app.node('notifications-enabled').checked, true);
});

test('power events during registration and delayed reads beat initial responses and failures', async () => {
  for (const rejectRead of [false, true]) {
    const initial = deferred();
    const app = await mount(true, base(), { listen(name, callback) {
      if (name === 'launcher-power-state') callback({ payload: power({ enabled: false, phase: 'disabled', message: 'early power event' }) });
    }, invoke(name, _args, { fallback }) { return name === 'get_power_snapshot' ? initial.promise : fallback(); } });
    assert.equal(app.node('power-enabled').checked, false);
    assert.match(app.node('power-message').textContent, /early power event/);
    app.power(power({ active: true, phase: 'active', message: 'latest power event' }));
    assert.match(app.node('power-message').textContent, /latest power event/);
    if (rejectRead) initial.reject(new Error('stale power read failure')); else initial.resolve(power({ enabled: false, phase: 'disabled' }));
    await flush();
    assert.equal(app.node('power-enabled').checked, true);
    assert.equal(app.node('power-enabled').disabled, false);
    assert.equal(app.node('power-active').dataset.active, 'true');
    assert.match(app.node('power-message').textContent, /latest power event/);
    assert.equal(app.node('power-message').dataset.error, 'false');
  }
});

test('power event received inside listen wins even without subsequent events', async () => {
  const app = await mount(true, base(), { listen(name, callback) {
    if (name === 'launcher-power-state') callback({ payload: power({ enabled: false, phase: 'disabled', message: 'registration event' }) });
  } });
  assert.equal(app.node('power-enabled').checked, false);
  assert.match(app.node('power-message').textContent, /registration event/);
});

test('power events beat delayed setting replies and failures', async () => {
  for (const rejectSave of [false, true]) {
    const saving = deferred();
    const app = await mount(true, base(), { invoke(name, _args, { fallback }) { return name === 'set_power_enabled' ? saving.promise : fallback(); } });
    await app.change('power-enabled', false);
    app.power(power({ active: true, phase: 'active', message: 'new protection event' }));
    if (rejectSave) saving.reject(new Error('stale power save failure')); else saving.resolve(power({ enabled: false, phase: 'disabled' }));
    await flush();
    assert.equal(app.node('power-enabled').checked, true);
    assert.equal(app.node('power-enabled').disabled, false);
    assert.equal(app.node('power-active').dataset.active, 'true');
    assert.match(app.node('power-message').textContent, /new protection event/);
    assert.equal(app.node('power-message').dataset.error, 'false');
  }
});

test('power listener failure blocks reads and writes but not notifications', async () => {
  const app = await mount(true, base(), { listen(name) { if (name === 'launcher-power-state') throw new Error('listen failed token=private-power'); } });
  assert.equal(app.calls.filter(([name]) => name === 'get_power_snapshot').length, 0);
  assert.equal(app.node('power-enabled').disabled, true);
  assert.match(app.node('power-message').textContent, /无法监听电源状态.*重试检测.*listen failed/);
  assert.doesNotMatch(app.node('power-message').textContent, /private-power/);
  await app.change('power-enabled', false);
  assert.equal(app.calls.filter(([name]) => name === 'set_power_enabled').length, 0);
  await app.change('notifications-enabled', true);
  assert.equal(app.node('notifications-enabled').checked, true);
  assert.equal(app.node('power-enabled').disabled, true);
  app.unload();
  assert.equal(app.subscriptions.size, 0);
});

test('power retry resubscribes after listener failure and restores the saved setting', async () => {
  let attempts = 0;
  const app = await mount(true, base(), { initialPower: power({ enabled: false, phase: 'disabled', message: 'saved setting recovered' }), listen(name) {
    if (name === 'launcher-power-state' && attempts++ === 0) throw new Error('listen failed');
  } });
  assert.equal(app.node('power-enabled').disabled, true);
  assert.equal(app.node('power-refresh').disabled, false);
  await app.click('power-refresh');
  assert.equal(attempts, 2);
  assert.ok(app.subscriptions.has('launcher-power-state'));
  assert.equal(app.node('power-enabled').disabled, false);
  assert.equal(app.node('power-enabled').checked, false);
  assert.equal(app.node('power-message').dataset.error, 'false');
  assert.match(app.node('power-message').textContent, /saved setting recovered/);
  assert.equal(app.calls.filter(([name]) => name === 'get_power_snapshot').length, 1);
  assert.equal(app.calls.filter(([name]) => name === 'set_power_enabled').length, 0);
  app.unload();
  assert.equal(app.unlistened.filter(name => name === 'launcher-power-state').length, 1);
});

test('power retry rereads after initial read failure without duplicating its listener', async () => {
  let attempts = 0; const retry = deferred();
  const app = await mount(true, base(), { invoke(name, _args, { fallback }) {
    if (name === 'get_power_snapshot') {
      if (attempts++ === 0) throw new Error('read failed');
      return retry.promise;
    }
    return fallback();
  } });
  assert.equal(app.node('power-enabled').disabled, true);
  assert.equal(app.node('power-refresh').disabled, false);
  await app.click('power-refresh');
  assert.equal(app.node('power-refresh').disabled, true);
  assert.equal(app.node('power-enabled').disabled, true);
  await app.click('power-refresh');
  await app.change('power-enabled', false);
  assert.equal(attempts, 2);
  assert.equal(app.calls.filter(([name]) => name === 'set_power_enabled').length, 0);
  retry.resolve(power({ enabled: false, phase: 'disabled', message: 'read recovered' })); await flush();
  assert.equal(app.node('power-refresh').disabled, false);
  assert.equal(app.node('power-enabled').disabled, false);
  assert.equal(app.node('power-enabled').checked, false);
  assert.equal(app.node('power-message').dataset.error, 'false');
  assert.match(app.node('power-message').textContent, /read recovered/);
  assert.equal(app.listenCalls.filter(name => name === 'launcher-power-state').length, 1);
  app.unload();
  await app.click('power-refresh');
  assert.equal(app.node('power-refresh').disabled, true);
  assert.equal(attempts, 2);
});

test('power unload cleans registered and late listeners and ignores callbacks after disposal', async () => {
  const registration = deferred(); let lateCallback;
  const app = await mount(true, base(), { listen(name, callback) {
    if (name === 'launcher-power-state') { lateCallback = callback; return registration.promise; }
  } });
  app.unload(); registration.resolve(); await flush();
  assert.equal(app.subscriptions.has('launcher-power-state'), false);
  assert.equal(app.unlistened.filter(name => name === 'launcher-power-state').length, 1);
  assert.equal(app.calls.filter(([name]) => name === 'get_power_snapshot').length, 0);
  const message = app.node('power-message').textContent;
  lateCallback({ payload: power({ active: true, phase: 'active', message: 'unloaded event' }) });
  await app.change('power-enabled', false);
  assert.equal(app.node('power-message').textContent, message);
  assert.equal(app.calls.filter(([name]) => name === 'set_power_enabled').length, 0);
  const registered = await mount(true);
  registered.unload();
  assert.equal(registered.subscriptions.size, 0);
  assert.equal(registered.unlistened.filter(name => name === 'launcher-power-state').length, 1);
});

test('power replies and errors do not render after unload', async () => {
  for (const command of ['get_power_snapshot', 'set_power_enabled']) for (const failure of [false, true]) {
    const pending = deferred();
    const app = await mount(true, base(), { invoke(name, _args, { fallback }) { return name === command ? pending.promise : fallback(); } });
    if (command === 'set_power_enabled') await app.change('power-enabled', false);
    app.unload();
    const message = app.node('power-message').textContent;
    const checked = app.node('power-enabled').checked;
    if (failure) pending.reject(new Error('unloaded power error')); else pending.resolve(power({ enabled: false, phase: 'disabled', message: 'unloaded reply' }));
    await flush();
    assert.equal(app.node('power-message').textContent, message);
    assert.equal(app.node('power-enabled').checked, checked);
    assert.equal(app.unlistened.filter(name => name === 'launcher-power-state').length, 1);
  }
});

test('pending startup shows three stages and cannot launch service work', async () => {
  const checks = environment().checks.map(item => ({ ...item, status: 'pending' }));
  const app = await mount(true, base({ state: 'unknown', busy: true, environment_checking: true, environment: environment({ checks }) }), { mode: 'startup' });
  assert.equal(app.node('stage-environment').dataset.state, 'active');
  for (const stage of ['service', 'window']) assert.equal(app.node('stage-' + stage).dataset.state, 'pending');
  assert.equal(app.node('startup-progress').hidden, false); assert.equal(app.node('startup-actions').hidden, true);
  assert.equal(app.node('environment-summary').textContent, '检测中');
  for (const id of ['check', 'open']) { assert.equal(app.node(id).disabled, true); await app.click(id); }
  assert.equal(app.calls.filter(([name]) => name === 'perform_action').length, 0);
});

test('startup errors show actionable redacted hints, retry, and fixed environment settings entry', async () => {
  const checks = environment().checks.map(item => ({ ...item, status: item.id === 'wsl' ? 'error' : item.id === 'config' ? 'passed' : 'skipped', message: item.id === 'wsl' ? '<script>未检测到 WSL</script> token=private-value' : '前置条件未满足', hint: item.id === 'wsl' ? '请手动安装 WSL 后重新检测。Bearer private-value' : '' }));
  const opening = deferred();
  const app = await mount(true, base({ state: 'error', managed: false, environment: environment({ checks }) }), { mode: 'startup', invoke(name, _args, { fallback }) { return name === 'open_settings' ? opening.promise : fallback(); } });
  assert.equal(app.node('error-notice').hidden, false); assert.match(app.node('error-notice').textContent, /手动安装/);
  assert.match(app.node('error-notice').textContent, /<script>/); assert.ok(!app.node('error-notice').textContent.includes('private-value'));
  assert.equal(app.node('check-wsl').dataset.status, 'error'); assert.equal(app.node('check-repository').dataset.status, 'skipped');
  assert.equal(app.node('environment-summary').textContent, '1 项需处理');
  assert.equal(app.node('open').hidden, true); assert.equal(app.node('open').disabled, true);
  assert.equal(app.node('check').disabled, false); await app.click('check');
  assert.equal(app.calls.at(-1)[1].action, 'check');
  await app.click('open-settings'); await app.click('open-settings');
  const requests = app.calls.filter(([name]) => name === 'open_settings');
  assert.equal(requests.length, 1); assert.equal(requests[0][1].section, 'environment');
  assert.equal(app.node('open-settings').disabled, true);
  opening.resolve(); await flush(); assert.equal(app.node('open-settings').disabled, false);
});

test('all checks passing complete startup stages with no extra frontend launch invoke', async () => {
  const app = await mount(true, base(), { mode: 'startup' });
  for (const stage of ['environment', 'service', 'window']) assert.equal(app.node('stage-' + stage).dataset.state, 'passed');
  assert.equal(app.node('environment-summary').textContent, '全部通过'); assert.equal(app.node('startup-progress').hidden, true);
  assert.equal(app.node('status-title').textContent, 'DSH 已就绪');
  for (let i = 0; i < 3; i++) app.event(base());
  assert.equal(app.calls.filter(([name]) => name === 'perform_action').length, 0);
});

test('owned starting service shows sanitized backend progress rather than an environment placeholder', async () => {
  const app = await mount(true, base({ state: 'starting', phase: '启动服务', busy: true, managed: true,
    message: '<script>正在等待已有服务就绪</script> token=private-progress Bearer private-progress' }), { mode: 'startup' });
  assert.equal(app.node('stage-environment').dataset.state, 'passed');
  assert.equal(app.node('stage-service').dataset.state, 'active');
  assert.equal(app.node('stage-window').dataset.state, 'pending');
  assert.equal(app.node('status-title').textContent, '正在连接本地服务');
  assert.ok(app.node('status-message').textContent.startsWith('<script>正在等待已有服务就绪</script>'));
  assert.ok(!app.node('status-message').textContent.includes('private-progress'));
  assert.equal(app.node('startup-progress').hidden, false);
  assert.equal(app.node('startup-actions').hidden, true);
  assert.equal(app.calls.filter(([name]) => name === 'perform_action').length, 0);
});

test('ready busy service stays in connection stage until actual window loading', async () => {
  const app = await mount(true, base({ phase: '检查本机连接', busy: true, message: '服务已就绪，正在确认 Windows 可以访问。' }), { mode: 'startup' });
  assert.equal(app.node('stage-environment').dataset.state, 'passed');
  assert.equal(app.node('stage-service').dataset.state, 'active');
  assert.equal(app.node('stage-window').dataset.state, 'pending');
  assert.equal(app.node('status-message').textContent, '服务已就绪，正在确认 Windows 可以访问。');
  assert.equal(app.node('startup-progress').hidden, false);
  app.event(base({ phase: '打开工作窗口', busy: true, message: '正在加载 DSH 工作窗口。' }));
  assert.equal(app.node('stage-service').dataset.state, 'passed');
  assert.equal(app.node('stage-window').dataset.state, 'active');
  assert.equal(app.node('status-title').textContent, '正在打开工作空间');
  assert.equal(app.node('status-message').textContent, '正在加载 DSH 工作窗口。');
  assert.equal(app.node('startup-progress').hidden, false);
});

test('service and authentication failures after environment passes remain actionable despite stale checking', async () => {
  for (const phase of ['启动服务', '检查本机连接', '操作未完成']) {
    const app = await mount(true, base({ state: 'error', phase, environment_checking: true,
      last_error: '服务认证不可用，请检查服务日志后重试。 token=private-error' }), { mode: 'startup' });
    assert.equal(app.node('startup-shell').dataset.state, 'error');
    assert.equal(app.node('stage-environment').dataset.state, 'passed');
    assert.equal(app.node('stage-service').dataset.state, 'error');
    assert.equal(app.node('stage-window').dataset.state, 'pending');
    assert.equal(app.node('environment-summary').textContent, '全部通过');
    assert.equal(app.node('error-notice').hidden, false);
    assert.match(app.node('error-notice').textContent, /检查服务日志后重试/);
    assert.ok(!app.node('error-notice').textContent.includes('private-error'));
    assert.equal(app.node('startup-progress').hidden, true);
    assert.equal(app.node('startup-actions').hidden, false);
    assert.equal(app.node('check').disabled, false);
    assert.equal(app.node('open-settings').hidden, false);
  }
});

test('idle last_error is not hidden by stale checking or a nonerror service state', async () => {
  const app = await mount(true, base({ environment_checking: true, last_error: '停止未完成，请稍后重试。' }), { mode: 'startup' });
  assert.equal(app.node('startup-shell').dataset.state, 'error');
  assert.equal(app.node('error-notice').hidden, false);
  assert.match(app.node('error-notice').textContent, /停止未完成/);
  assert.equal(app.node('startup-progress').hidden, true);
  assert.equal(app.node('check').disabled, false);
});

test('window loading failure marks window instead of service or environment', async () => {
  const app = await mount(true, base({ phase: '打开工作窗口', busy: true }), { mode: 'startup' });
  app.event(base({ state: 'error', phase: '打开工作窗口', last_error: '无法创建工作窗口，请重试。' }));
  assert.equal(app.node('stage-environment').dataset.state, 'passed');
  assert.equal(app.node('stage-service').dataset.state, 'passed');
  assert.equal(app.node('stage-window').dataset.state, 'error');
  assert.equal(app.node('error-notice').hidden, false);
  assert.equal(app.node('startup-progress').hidden, true);
  // A later connection attempt must not retain an old window failure stage.
  app.event(base({ state: 'starting', phase: '启动服务', busy: true }));
  app.event(base({ state: 'error', phase: '操作未完成', last_error: '服务启动失败' }));
  assert.equal(app.node('stage-service').dataset.state, 'error');
  assert.equal(app.node('stage-window').dataset.state, 'pending');
});

test('stop progress uses sanitized backend message and stopped idle does not pretend to connect', async () => {
  const app = await mount(true, base({ phase: '停止服务', busy: true,
    message: '正在请求 DSH 正常退出，不会强制结束进程。 password=private-stop' }), { mode: 'startup' });
  assert.equal(app.node('status-title').textContent, '正在停止服务');
  assert.match(app.node('status-message').textContent, /正常退出/);
  assert.ok(!app.node('status-message').textContent.includes('private-stop'));
  assert.equal(app.node('stage-service').dataset.state, 'active');
  assert.equal(app.node('stage-window').dataset.state, 'pending');
  app.event(base({ state: 'stopped', phase: '服务已停止', managed: false, environment_checking: true }));
  assert.equal(app.node('startup-shell').dataset.state, 'stopped');
  assert.equal(app.node('status-title').textContent, '工作空间已停止');
  assert.equal(app.node('stage-environment').dataset.state, 'passed');
  assert.equal(app.node('stage-service').dataset.state, 'pending');
  assert.equal(app.node('stage-window').dataset.state, 'pending');
  assert.equal(app.node('startup-progress').hidden, true);
  assert.equal(app.node('startup-actions').hidden, false);
  assert.equal(app.node('open').hidden, false);
  assert.equal(app.node('open').disabled, false);
});

test('settings ownership follows managed during starting and error without inferring external launch', async () => {
  const app = await mount(true, base({ state: 'starting', busy: true, managed: true }));
  assert.equal(app.node('ownership').textContent, '由启动器管理');
  app.event(base({ state: 'error', managed: true, last_error: '认证链接不可用' }));
  assert.equal(app.node('ownership').textContent, '由启动器管理');
  app.event(base({ managed: false }));
  assert.equal(app.node('ownership').textContent, '未验证归属');
  assert.match(app.node('ownership-hint').textContent, /尚未验证/);
  assert.doesNotMatch(app.node('ownership').textContent + app.node('ownership-hint').textContent, /外部/);
});

test('settings has only check and logs service actions and navigation never invokes IPC', async () => {
  const app = await mount(true, base({ state: 'stopped', managed: false }));
  assert.equal(app.has('settings-shell'), true);
  for (const id of ['startup-shell', 'service-card', 'open', 'open-settings', 'start', 'stop', 'restart', 'quit', 'exit', 'environment-panel', 'updates-panel', 'show-environment']) assert.equal(app.has(id), false, id);
  const calls = [...app.calls];
  for (const selected of ['environment', 'notifications', 'power', 'updates', 'logs', 'environment']) {
    await app.click('nav-' + selected);
    for (const section of ['environment', 'notifications', 'power', 'updates', 'logs']) {
      assert.equal(app.node('settings-' + section).hidden, section !== selected);
      assert.equal(app.node('nav-' + section).attributes['aria-current'], section === selected ? 'page' : 'false');
    }
    assert.deepEqual(app.calls, calls);
  }
  assert.equal(app.calls.filter(([name]) => name === 'check_update').length, 0);
  await app.click('check'); assert.equal(app.calls.at(-1)[1].action, 'check');
  await app.click('logs'); assert.equal(app.calls.at(-1)[1].action, 'logs');
});

test('settings URLs select fixed tabs and invalid sections fall back to environment', async () => {
  for (const requested of ['environment', 'notifications', 'power', 'updates', 'logs', 'invalid']) {
    const app = await mount(true, base(), { location: 'http://127.0.0.1:1420/index.html?view=settings&section=' + requested });
    assert.equal(app.node('settings-' + (requested === 'invalid' ? 'environment' : requested)).hidden, false);
    assert.equal(app.calls.filter(([name]) => name === 'check_update').length, 0);
  }
});

test('menu events route settings tabs without IPC even when the environment fails', async () => {
  const app = await mount(true, base({ state: 'error', last_error: 'WSL unavailable', environment: environment({ checks: [] }) }), { initialNotification: listening() });
  const calls = [...app.calls];
  const show = app.subscriptions.get('launcher-show-settings'); assert.equal(typeof show, 'function');
  for (const selected of ['notifications', 'power', 'environment', 'updates', 'logs', 'notifications']) {
    show({ payload: selected }); await flush();
    assert.equal(app.node('settings-' + selected).hidden, false); assert.equal(app.node('settings-title').focused, true);
    for (const section of ['environment', 'notifications', 'power', 'updates', 'logs']) assert.equal(app.node('settings-' + section).hidden, section !== selected);
    assert.equal(app.node('notifications-enabled').checked, true); assert.equal(app.node('notifications-enabled').disabled, false);
    assert.deepEqual(app.calls, calls);
  }
  show({ payload: 'not-a-tab' }); assert.equal(app.node('settings-notifications').hidden, false);
  app.subscriptions.get('launcher-show-logs')?.({}); assert.equal(app.node('settings-logs').hidden, false);
  assert.deepEqual(app.calls, calls);
});

test('notification settings initialize independently when the service snapshot request fails', async () => {
  const app = await mount(true, base(), { initialNotification: listening(), invoke(name, _args, { fallback }) {
    if (name === 'get_snapshot') throw new Error('environment read failed');
    return fallback();
  } });
  app.subscriptions.get('launcher-show-settings')?.({ payload: 'notifications' });
  assert.equal(app.node('settings-notifications').hidden, false); assert.equal(app.node('notifications-enabled').checked, true);
  assert.equal(app.node('test-notification').disabled, false);
  await app.click('test-notification'); assert.equal(app.calls.at(-1)[0], 'test_notification');
});

test('dirty repository survives snapshots and repeated navigation', async () => {
  const app = await mount(true, base({ state: 'stopped', managed: false }));
  const draft = '/home/test/unsaved DSH checkout';
  app.node('repository-input').value = draft; app.node('repository-input').handlers.input();
  const calls = [...app.calls];
  for (const section of ['notifications', 'logs', 'environment']) {
    await app.click('nav-' + section);
    app.event(base({ state: 'stopped', environment: environment({ repository: '/home/test/other' }) }));
    app.subscriptions.get('launcher-show-settings')?.({ payload: 'environment' });
    assert.equal(app.node('repository-input').value, draft); assert.equal(app.node('save-repository').disabled, false);
  }
  assert.deepEqual(app.calls, calls);
});

test('manual directory validates WSL paths and saves only after explicit action', async () => {
  const app = await mount(true, base({ state: 'stopped', managed: false }));
  for (const invalid of ['C:/projects/dsh', '//network/dsh', '/home/test/line\nbreak', '/home/' + 'x'.repeat(4096)]) {
    app.node('repository-input').value = invalid; app.node('repository-input').handlers.input();
    assert.equal(app.node('save-repository').disabled, true); await app.click('save-repository');
  }
  assert.equal(app.calls.filter(([name]) => name === 'set_project_directory').length, 0);
  app.node('repository-input').value = ' /home/test/DSH with spaces '; app.node('repository-input').handlers.input();
  assert.equal(app.node('save-repository').disabled, false); await app.click('save-repository');
  assert.equal(app.calls.at(-1)[0], 'set_project_directory'); assert.equal(app.calls.at(-1)[1].repository, '/home/test/DSH with spaces');
});

test('directory save serializes settings actions and explicit failures preserve input', async () => {
  const saving = deferred();
  const app = await mount(true, base({ state: 'stopped', managed: false }), { initialUpdate: update({ phase: 'available', version: '0.2.0' }), invoke(name, _args, { fallback }) { return name === 'set_project_directory' ? saving.promise : fallback(); } });
  app.node('repository-input').value = '/home/test/missing'; app.node('repository-input').handlers.input();
  await app.click('save-repository');
  for (const id of ['save-repository', 'check', 'logs', 'install-update']) { assert.equal(app.node(id).disabled, true); await app.click(id); }
  assert.equal(app.calls.filter(([name]) => name === 'set_project_directory').length, 1);
  assert.equal(app.calls.filter(([name]) => ['perform_action', 'install_update'].includes(name)).length, 0);
  saving.reject(new Error('未找到有效的 DSH 项目')); await flush();
  assert.equal(app.node('repository-input').value, '/home/test/missing'); assert.equal(app.node('save-repository').disabled, false);
  assert.match(app.node('error-notice').textContent, /未找到有效的 DSH 项目/);
});

test('newer service events beat delayed initial and check replies', async () => {
  const initial = deferred(); const checking = deferred();
  const app = await mount(true, base(), { mode: 'startup', invoke(name, _args, { fallback }) {
    if (name === 'get_snapshot') return initial.promise;
    if (name === 'perform_action') return checking.promise;
    return fallback();
  } });
  const checks = environment().checks.map(item => item.id === 'repository' ? { ...item, status: 'error', message: '<script>bad</script> token=private-value', hint: 'Bearer private-value' } : item);
  const failure = base({ state: 'error', environment: environment({ checks }) });
  app.event(failure); initial.resolve(base()); await flush();
  assert.equal(app.node('check-repository').dataset.status, 'error');
  await app.click('check'); app.event(failure); checking.resolve(base()); await flush();
  assert.equal(app.node('check-repository').dataset.status, 'error'); assert.match(app.node('error-notice').textContent, /<script>/);
  for (const id of ['error-notice', 'check-repository-message', 'check-repository-hint']) assert.ok(!app.node(id).textContent.includes('private-value'));
});

test('newer service events beat delayed successful directory saves', async () => {
  const saving = deferred();
  const app = await mount(true, base({ state: 'stopped', managed: false }), { invoke(name, _args, { fallback }) { return name === 'set_project_directory' ? saving.promise : fallback(); } });
  app.node('repository-input').value = '/home/test/new'; app.node('repository-input').handlers.input(); await app.click('save-repository');
  app.event(base({ state: 'error', last_error: 'latest event', environment: environment({ repository: '/home/test/event-wins' }) }));
  saving.resolve(base({ state: 'stopped', environment: environment({ repository: '/home/test/stale-reply' }) })); await flush();
  assert.equal(app.node('repository-input').value, '/home/test/event-wins'); assert.equal(app.node('error-notice').textContent, 'latest event');
});

test('unload releases settings and update navigation listeners', async () => {
  const app = await mount(true); const calls = [...app.calls]; app.unload(); await flush();
  assert.equal(app.subscriptions.size, 0);
  for (const event of ['launcher-state', 'launcher-show-settings', 'launcher-show-logs', 'launcher-update-state', 'launcher-show-updates', 'launcher-notification-state', 'launcher-power-state']) assert.equal(app.unlistened.filter(name => name === event).length, 1);
  assert.deepEqual(app.calls, calls);
});

test('startup silent check failures do not interrupt readiness or initialize settings', async () => {
  const app = await mount(true, base(), { mode: 'startup', invoke(name, _args, { fallback }) { if (name === 'check_update') throw new Error('offline'); return fallback(); } });
  assert.equal(app.node('status-title').textContent, 'DSH 已就绪'); assert.equal(app.node('error-notice').hidden, true);
  assert.equal(app.calls.filter(([name]) => name === 'check_update').length, 1);
  assert.equal(app.calls.filter(([name]) => ['open_settings', 'get_notification_snapshot', 'perform_action'].includes(name)).length, 0);
});

test('retry hides the previous startup error and restores checking progress until completion', async () => {
  const retry = deferred();
  const checks = environment().checks.map(item => ({ ...item, status: item.id === 'repository' ? 'error' : 'passed', hint: '设置项目目录' }));
  const app = await mount(true, base({ state: 'error', last_error: 'old error', environment: environment({ checks }) }), { mode: 'startup', invoke(name, _args, { fallback }) { return name === 'perform_action' ? retry.promise : fallback(); } });
  assert.equal(app.node('error-notice').hidden, false);
  await app.click('check'); await app.click('check');
  assert.equal(app.node('error-notice').hidden, true); assert.equal(app.node('startup-progress').hidden, false);
  assert.equal(app.node('startup-actions').hidden, true); assert.equal(app.node('stage-environment').dataset.state, 'active');
  assert.equal(app.node('check').disabled, true); assert.equal(app.calls.filter(([name]) => name === 'perform_action').length, 1);
  app.event(base({ state: 'error', busy: true, environment_checking: true, environment: environment({ checks: checks.map(item => ({ ...item, status: 'pending' })) }) }));
  assert.equal(app.node('error-notice').hidden, true); assert.equal(app.node('environment-summary').textContent, '检测中');
  app.event(base()); retry.resolve(base()); await flush();
  assert.equal(app.node('status-title').textContent, 'DSH 已就绪'); assert.equal(app.node('startup-progress').hidden, true);
});

test('failed startup snapshot read exposes a retryable error rather than endless progress', async () => {
  const app = await mount(true, base(), { mode: 'startup', invoke(name, _args, { fallback }) { if (name === 'get_snapshot') throw new Error('snapshot unavailable'); return fallback(); } });
  assert.equal(app.node('error-notice').hidden, false); assert.match(app.node('error-notice').textContent, /snapshot unavailable/);
  assert.equal(app.node('startup-progress').hidden, true); assert.equal(app.node('startup-actions').hidden, false);
  assert.equal(app.node('check').disabled, false); assert.equal(app.node('open-settings').hidden, false);
});

test('settings Back has an icon and visible accessible text outside the brand hidden on narrow layouts', async () => {
  const app = await mount(false);
  assert.equal(app.has('settings-back'), true);
  assert.equal(app.node('settings-back').hidden, false);
  assert.equal(app.node('settings-back').disabled, false);
  const raw = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(raw, /<aside class="settings-sidebar"><button class="settings-back" id="settings-back" type="button" aria-label="返回"><svg[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg><span>返回<\/span><\/button><div class="settings-brand">/);
  assert.match(css, /\.settings-back \{[^}]*display: flex;[^}]*min-height: 36px/);
  assert.match(css, /@media \(max-width: 450px\) \{ \.settings-back \{ margin-bottom: 12px; \}/);
  assert.doesNotMatch(css, /\.settings-back[^{}]*\{[^}]*display: none/);
});

test('native Back invokes only the fixed no-argument return command and preserves dirty settings', async () => {
  const app = await mount(true, base({ state: 'stopped', managed: false }), { initialNotification: listening({ notify_when_focused: true }) });
  const draft = '/home/test/unsaved settings draft';
  app.node('repository-input').value = draft; app.node('repository-input').handlers.input();
  await app.click('nav-notifications');
  const calls = app.calls.length;
  await app.click('settings-back');
  assert.equal(app.calls.length, calls + 1);
  assert.equal(app.calls.at(-1)[0], 'return_from_settings');
  assert.equal(app.calls.at(-1)[1], undefined);
  assert.equal(app.node('repository-input').value, draft);
  assert.equal(app.node('settings-notifications').hidden, false);
  assert.equal(app.node('notifications-enabled').checked, true);
  assert.equal(app.node('notifications-when-focused').checked, true);
  app.event(base({ state: 'stopped', environment: environment({ repository: '/home/test/new snapshot' }) }));
  await app.click('nav-environment');
  assert.equal(app.node('repository-input').value, draft);
  assert.equal(app.node('save-repository').disabled, false);
  assert.equal(app.calls.slice(calls).filter(([name]) => /perform_action|set_project_directory|set_notifications_enabled|install_update/.test(name)).length, 0);
});

test('Back remains independent of service and update locks and serializes repeated requests', async () => {
  const returning = deferred();
  const app = await mount(true, base({ busy: true }), { initialUpdate: update({ phase: 'installing', busy: true }), invoke(name, _args, { fallback }) { return name === 'return_from_settings' ? returning.promise : fallback(); } });
  assert.equal(app.node('check').disabled, true);
  assert.equal(app.node('settings-back').disabled, false);
  await app.click('settings-back'); await app.click('settings-back');
  assert.equal(app.node('settings-back').disabled, true);
  app.event(base({ busy: true })); app.update(update({ phase: 'downloading', busy: true }));
  assert.equal(app.node('settings-back').disabled, true);
  assert.equal(app.calls.filter(([name]) => name === 'return_from_settings').length, 1);
  returning.resolve(); await flush();
  assert.equal(app.node('settings-back').disabled, false);
});

test('Back failure is static retryable Chinese and cannot discard an unsaved directory', async () => {
  let attempts = 0;
  const app = await mount(true, base({ state: 'stopped', managed: false }), { invoke(name, _args, { fallback }) { if (name === 'return_from_settings' && ++attempts === 1) throw new Error('<script>private diagnostics token=secret</script>'); return fallback(); } });
  const draft = '/home/test/do not save on back';
  app.node('repository-input').value = draft; app.node('repository-input').handlers.input();
  await app.click('settings-back');
  assert.equal(app.node('error-notice').hidden, false);
  assert.equal(app.node('error-notice').textContent, '返回未完成，请重试。');
  assert.equal(app.node('settings-back').disabled, false);
  assert.equal(app.node('repository-input').value, draft);
  assert.equal(app.node('save-repository').disabled, false);
  await app.click('settings-back');
  assert.equal(attempts, 2);
  assert.equal(app.node('error-notice').hidden, true);
  assert.equal(app.node('repository-input').value, draft);
  assert.equal(app.calls.filter(([name]) => name === 'set_project_directory').length, 0);
});

test('unloaded settings ignores Back and late return failures without touching UI', async () => {
  for (const native of [true, false]) {
    const app = await mount(native);
    const calls = app.calls.length;
    app.unload(); await app.click('settings-back');
    assert.equal(app.calls.length, calls);
    assert.equal(app.location.search, undefined);
  }
  const returning = deferred();
  const app = await mount(true, base(), { invoke(name, _args, { fallback }) { return name === 'return_from_settings' ? returning.promise : fallback(); } });
  await app.click('settings-back'); app.unload();
  const error = app.node('error-notice').textContent;
  returning.reject(new Error('late private error')); await flush();
  assert.equal(app.node('error-notice').textContent, error);
  assert.equal(app.node('settings-back').disabled, true);
  const count = app.calls.length;
  await app.click('settings-back'); assert.equal(app.calls.length, count);
});

test('browser Back drops all return targets using only a fixed local startup fallback', async () => {
  for (const target of ['https://evil.example/steal', '//evil.example/path', 'javascript:alert(1)', 'dsh', 'launcher']) {
    const app = await mount(false, base(), { location: 'http://127.0.0.1:1420/index.html?view=settings&section=environment&return=' + encodeURIComponent(target) + '&returnUrl=' + encodeURIComponent(target) + '&window=' + encodeURIComponent(target) });
    await app.click('settings-back');
    assert.equal(app.location.search, '');
    assert.equal(new URL(app.location.href).origin, 'http://127.0.0.1:1420');
    assert.equal(app.calls.length, 0); assert.equal(app.listenCalls.length, 0);
  }
  assert.doesNotMatch(source, /history[.]back|parameters[.]get\(['"]return/);
  const startup = await mount(false, base(), { mode: 'startup' });
  await startup.click('open-settings');
  assert.equal(startup.location.search, '?view=settings&section=environment');
});

test('settings ready handshake runs only natively after all initialization subscriptions settle', async () => {
  const registration = deferred();
  const app = await mount(true, base(), { readySection: 'notifications', listen(name) { return name === 'launcher-show-settings' ? registration.promise : undefined; }, invoke(name, args, { subscriptions, fallback }) {
    if (name === 'settings_page_ready') {
      assert.equal(args, undefined);
      for (const event of ['launcher-state', 'launcher-show-settings', 'launcher-show-logs', 'launcher-update-state', 'launcher-show-updates', 'launcher-notification-state', 'launcher-power-state']) assert.ok(subscriptions.has(event), event);
    }
    return fallback();
  } });
  assert.equal(app.calls.filter(([name]) => name === 'settings_page_ready').length, 0);
  registration.resolve(); await flush();
  assert.equal(app.calls.filter(([name]) => name === 'settings_page_ready').length, 1);
  assert.equal(app.node('settings-notifications').hidden, false);
  for (const [native, mode] of [[false, 'settings'], [false, 'startup'], [true, 'startup']]) {
    const other = await mount(native, base(), { mode });
    assert.equal(other.calls.filter(([name]) => name === 'settings_page_ready').length, 0);
  }
});

test('settings readiness waits for delayed power initialization and selects the power category', async () => {
  const registration = deferred(); const snapshot = deferred();
  const app = await mount(true, base(), { readySection: 'power', listen(name) { return name === 'launcher-power-state' ? registration.promise : undefined; }, invoke(name, _args, { fallback }) { return name === 'get_power_snapshot' ? snapshot.promise : fallback(); } });
  assert.equal(app.calls.filter(([name]) => name === 'settings_page_ready').length, 0);
  assert.equal(app.calls.filter(([name]) => name === 'get_power_snapshot').length, 0);
  registration.resolve(); await flush();
  assert.equal(app.calls.filter(([name]) => name === 'get_power_snapshot').length, 1);
  assert.equal(app.calls.filter(([name]) => name === 'settings_page_ready').length, 0);
  snapshot.resolve(power()); await flush();
  assert.equal(app.calls.filter(([name]) => name === 'settings_page_ready').length, 1);
  assert.equal(app.node('settings-power').hidden, false);
  assert.equal(app.node('settings-title').textContent, '电源管理');
});

test('newer settings navigation beats a pending readiness reply', async () => {
  const ready = deferred();
  const app = await mount(true, base(), { invoke(name, _args, { fallback }) { return name === 'settings_page_ready' ? ready.promise : fallback(); } });
  app.subscriptions.get('launcher-show-settings')({ payload: 'logs' });
  ready.resolve('notifications'); await flush();
  assert.equal(app.node('settings-logs').hidden, false);
  assert.equal(app.node('settings-notifications').hidden, true);
});

test('readiness failure is static and cannot trigger service work, while unloaded initialization never signals ready', async () => {
  const app = await mount(true, base(), { invoke(name, _args, { fallback }) { if (name === 'settings_page_ready') throw new Error('private native readiness token=secret'); return fallback(); } });
  assert.equal(app.node('error-notice').textContent, '设置页面准备失败，请重试打开设置。');
  assert.equal(app.node('error-notice').hidden, false);
  assert.equal(app.calls.filter(([name]) => ['perform_action', 'set_project_directory', 'install_update', 'return_from_settings'].includes(name)).length, 0);
  const registration = deferred();
  const late = await mount(true, base(), { listen(name) { return name === 'launcher-show-settings' ? registration.promise : undefined; } });
  late.unload(); registration.resolve(); await flush();
  assert.equal(late.calls.filter(([name]) => name === 'settings_page_ready').length, 0);
  const ready = deferred();
  const pending = await mount(true, base(), { invoke(name, _args, { fallback }) { return name === 'settings_page_ready' ? ready.promise : fallback(); } });
  pending.unload();
  const error = pending.node('error-notice').textContent;
  ready.reject(new Error('late readiness error')); await flush();
  assert.equal(pending.node('error-notice').textContent, error);
});
