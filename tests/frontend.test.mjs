import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const source = stripTypeScriptTypes(readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, ''));
const flush = () => new Promise(resolve => setImmediate(resolve));
const checkIds = ['wsl', 'config', 'distribution', 'user', 'python', 'launcher', 'linux_config', 'repository', 'node', 'dependencies', 'web_assets'];
const environment = (extra = {}) => ({ checks: checkIds.map(id => ({ id, label: id, status: 'passed', message: '已通过', hint: '' })), repository: '/home/test/deepseek-harness', ...extra });
const base = (extra = {}) => ({ setup_required: false, state: 'ready', phase: '已就绪', message: '正常', busy: false, managed: true, origin: 'http://127.0.0.1:3080', last_error: null, logs: [], environment: environment(), environment_checking: false, config_path: 'C:/test/config.json', ...extra });
const update = (extra = {}) => ({ current_version: '0.1.0', phase: 'idle', version: null, notes: null, downloaded: 0, total: null, message: '可检查更新', busy: false, ...extra });
const notification = (extra = {}) => ({ enabled: false, notify_when_focused: false, phase: 'disabled', message: '未启用系统通知。', ...extra });
const power = (extra = {}) => ({ enabled: true, active: false, phase: 'idle', message: '等待运行中的任务。', ...extra });
const listening = (extra = {}) => notification({ enabled: true, phase: 'listening', message: '通知检查正常', ...extra });
const pet = (extra = {}) => ({ visible: false, startup_visible: true, roaming_enabled: true, bubble_notifications: true, revision: 0, message: '桌面宠物设置已读取。', ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function mount(native, initial = base(), options = {}) {
  let savedNotification = options.initialNotification || notification();
  let savedPower = options.initialPower || power();
  let savedPet = options.initialPet || pet();
  const nodes = new Map(); const subscriptions = new Map(); const calls = []; const windowHandlers = new Map(); const listenCalls = []; const unlistened = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, textContent: '', value: '', children: [], replaceChildren(...children) { this.children = children; }, dataset: {}, hidden: false, disabled: false, checked: false, open: false, scrollTop: 0, scrollHeight: 0, clientHeight: 0, handlers: {}, attributes: {}, set innerHTML(_) { throw new Error('Native data must not use HTML'); }, addEventListener(name, fn) { this.handlers[name] = fn; }, setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; if (name === 'value') delete this.value; }, focus() { this.focused = true; }, scrollIntoView() { this.scrolled = true; } });
    return nodes.get(id);
  };
  const root = { template: '', set innerHTML(template) { this.template = template; for (const match of template.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) { const item = node(match[1]); item.hidden = /\bhidden(?:\s|>)/.test(match[0]); item.disabled = /\bdisabled(?:\s|>)/.test(match[0]); } } };
  const location = { href: options.location || (options.mode === 'startup' ? 'http://127.0.0.1:1420/index.html' : 'http://127.0.0.1:1420/index.html?view=settings&section=environment') };
  const context = vm.createContext({
    appIconUrl: 'app-icon.png',
    SpeechSettings: class { setVisible() {} dispose() {} },
    URL, console, document: { addEventListener() {}, querySelector: () => root, getElementById: id => nodes.get(id), createElement: tag => ({ tagName: tag, value: '', textContent: '', set innerHTML(_) { throw new Error('Native data must not use HTML'); } }) }, window: { location, addEventListener(name, handler) { windowHandlers.set(name, handler); } },
    isTauri: () => native,
    listen: async (name, callback) => { listenCalls.push(name); if (options.listen) await options.listen(name, callback); subscriptions.set(name, callback); return () => { unlistened.push(name); subscriptions.delete(name); }; },
    invoke: async (name, args) => {
      calls.push([name, args]);
      const fallback = () => {
        if (name === 'get_snapshot' || name === 'perform_action' || name === 'set_project_directory') return initial;
        if (['get_update_snapshot', 'check_update', 'install_update'].includes(name)) return options.initialUpdate || update();
        if (name === 'setup_distributions') return ['Ubuntu', 'Debian'];
        if (name === 'setup_identity') return { linux_user: args.linuxUser || 'test', home: '/home/test', node: '/usr/bin/node' };
        if (name === 'complete_setup') return base({ state: 'starting', busy: true });
        if (name === 'get_pet_settings') return savedPet;
        if (name === 'set_pet_settings' || name === 'set_pet_visibility') {
          savedPet = { ...savedPet, ...(name === 'set_pet_settings' ? args.patch : { visible: args.visible }), revision: savedPet.revision + 1 };
          return savedPet;
        }
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
  return { template: root.template, pet(snapshot) { subscriptions.get('pet-settings-state')?.({ payload: snapshot }); }, power(snapshot) { subscriptions.get('launcher-power-state')?.({ payload: snapshot }); }, node(id) { assert.ok(nodes.has(id), 'Missing DOM node: ' + id); return nodes.get(id); }, has: id => nodes.has(id), location, calls, subscriptions, listenCalls, unlistened, async fill(id, value) { const item = nodes.get(id); item.value = value; item.handlers.input?.(); await flush(); }, async choose(id, value) { const item = nodes.get(id); item.value = value; item.handlers.change?.(); await flush(); }, async submit() { nodes.get('setup-form')?.handlers.submit?.({ preventDefault() {} }); await flush(); }, async change(id, checked) { const item = nodes.get(id); if (!item) return; item.checked = checked; item.handlers.change?.(); await flush(); }, notification(snapshot) { subscriptions.get('launcher-notification-state')?.({ payload: snapshot }); }, unload() { windowHandlers.get('beforeunload')?.(); }, event(snapshot) { subscriptions.get('launcher-state')?.({ payload: snapshot }); }, update(snapshot) { subscriptions.get('launcher-update-state')?.({ payload: snapshot }); }, async click(id) { nodes.get(id)?.handlers.click?.(); await flush(); } };
}

const petControls = ['pet-visible', 'pet-startup-visible', 'pet-roaming-enabled', 'pet-bubble-notifications'];
const petCalls = app => app.calls.filter(([name]) => ['get_pet_settings', 'set_pet_settings', 'set_pet_visibility'].includes(name));
const petValues = app => petControls.map(id => app.node(id).checked);

test('pet category supports URL, native routing, sidebar navigation and unchanged neighboring routes', async () => {
  const app = await mount(true, base(), { location: 'http://127.0.0.1:1420/index.html?view=settings&section=pet' });
  assert.equal(app.node('settings-title').textContent, '桌面宠物');
  assert.equal(app.node('settings-pet').hidden, false);
  assert.equal(app.node('nav-pet').attributes['aria-current'], 'page');
  await app.click('nav-updates');
  assert.equal(app.node('settings-title').textContent, '软件更新');
  assert.equal(app.node('settings-pet').hidden, true);
  app.subscriptions.get('launcher-show-settings')({ payload: 'pet' });
  assert.equal(app.node('settings-title').textContent, '桌面宠物');
  assert.equal(app.node('settings-title').focused, true);
  assert.equal(app.node('settings-updates').hidden, true);
  await app.click('nav-power');
  assert.equal(app.node('settings-title').textContent, '电源管理');
  await app.click('nav-pet');
  assert.equal(app.node('settings-pet').hidden, false);
  assert.ok(app.template.includes('https://github.com/PC2005-cloud/dsh-pet'));
  assert.match(app.template, /动画素材仅限非商业使用/);
});

test('pet subscribes before read and is usable while DSH is unavailable, busy or not yet loaded', async () => {
  const launcher = deferred();
  const app = await mount(true, base(), { initialPet: pet({ visible: true, startup_visible: false }), invoke(name, args, { subscriptions, fallback }) {
    if (name === 'get_snapshot') return launcher.promise;
    if (name === 'get_pet_settings') { assert.ok(subscriptions.has('pet-settings-state')); assert.equal(args, undefined); }
    return fallback();
  } });
  assert.deepEqual(petValues(app), [true, false, true, true]);
  for (const id of petControls) assert.equal(app.node(id).disabled, false);
  await app.change('pet-visible', false);
  assert.deepEqual(petValues(app), [false, false, true, true]);
  launcher.resolve(base({ state: 'error', busy: true, last_error: 'DSH unavailable' })); await flush();
  for (const id of petControls) assert.equal(app.node(id).disabled, false);
  assert.equal(petCalls(app).length, 2);
});

test('pet visibility is immediate and persistent toggles write only their own patch, never service actions', async () => {
  const app = await mount(true);
  assert.deepEqual(petValues(app), [false, true, true, true]);
  await app.change('pet-startup-visible', false);
  assert.deepEqual(petValues(app), [false, false, true, true]);
  await app.change('pet-visible', true);
  assert.deepEqual(petValues(app), [true, false, true, true]);
  await app.change('pet-roaming-enabled', false);
  assert.deepEqual(petValues(app), [true, false, false, true]);
  await app.change('pet-startup-visible', true);
  assert.deepEqual(petValues(app), [true, true, false, true]);
  await app.change('pet-visible', false);
  await app.change('pet-roaming-enabled', true);
  assert.deepEqual(petValues(app), [false, true, true, true]);
  assert.deepEqual(JSON.parse(JSON.stringify(petCalls(app))), [
    ['get_pet_settings', null],
    ['set_pet_settings', { patch: { startup_visible: false } }],
    ['set_pet_visibility', { visible: true }],
    ['set_pet_settings', { patch: { roaming_enabled: false } }],
    ['set_pet_settings', { patch: { startup_visible: true } }],
    ['set_pet_visibility', { visible: false }],
    ['set_pet_settings', { patch: { roaming_enabled: true } }],
  ]);
  assert.equal(app.calls.some(([name]) => ['perform_action', 'set_project_directory'].includes(name)), false);
});

test('pet settings are absent and never initialized on startup, including first-run setup', async () => {
  for (const initial of [base(), base({ setup_required: true })]) {
    const app = await mount(true, initial, { mode: 'startup' });
    for (const id of [...petControls, 'pet-refresh', 'nav-pet']) assert.equal(app.has(id), false);
    assert.equal(petCalls(app).length, 0);
    assert.equal(app.listenCalls.includes('pet-settings-state'), false);
  }
});

test('pet waits for a real snapshot and serializes read/write/repeated clicks without optimistic values', async () => {
  const initial = deferred(), saving = deferred();
  let reads = 0;
  const app = await mount(true, base(), { invoke(name, _args, { fallback }) {
    if (name === 'get_pet_settings' && ++reads === 1) return initial.promise;
    if (name === 'set_pet_visibility') return saving.promise;
    return fallback();
  } });
  for (const id of petControls) { assert.equal(app.node(id).disabled, true); await app.change(id, true); }
  await app.click('pet-refresh');
  assert.equal(petCalls(app).length, 1);
  initial.resolve(pet()); await flush();
  await app.change('pet-visible', true);
  assert.deepEqual(petValues(app), [false, true, true, true]);
  for (const id of petControls) assert.equal(app.node(id).disabled, true);
  await app.change('pet-visible', false);
  await app.change('pet-startup-visible', false);
  await app.change('pet-roaming-enabled', false);
  await app.change('pet-bubble-notifications', false);
  await app.click('pet-refresh');
  assert.equal(petCalls(app).length, 2);
  app.pet(pet({ visible: true, revision: 2 }));
  assert.deepEqual(petValues(app), [true, true, true, true]);
  assert.equal(app.node('pet-visible').disabled, true);
  saving.resolve(pet({ revision: 1 })); await flush();
  assert.deepEqual(petValues(app), [true, true, true, true]);
  assert.equal(app.node('pet-visible').disabled, false);
});

test('pet native revisions reject stale/equal events and delayed reads, while newer replies still win', async () => {
  const initial = deferred();
  const app = await mount(true, base(), { listen(name, callback) {
    if (name === 'pet-settings-state') callback({ payload: pet({ visible: true, revision: 4, message: 'registration event' }) });
  }, invoke(name, _args, { fallback }) { return name === 'get_pet_settings' ? initial.promise : fallback(); } });
  assert.deepEqual(petValues(app), [true, true, true, true]);
  app.pet(pet({ revision: 3, message: 'old event' }));
  app.pet(pet({ revision: 4, message: 'duplicate event' }));
  assert.match(app.node('pet-message').textContent, /registration event/);
  initial.resolve(pet({ startup_visible: false, roaming_enabled: false, revision: 2 })); await flush();
  assert.deepEqual(petValues(app), [true, true, true, true]);
  const newer = await mount(true, base(), { listen(name, callback) {
    if (name === 'pet-settings-state') callback({ payload: pet({ visible: true, revision: 1 }) });
  }, initialPet: pet({ startup_visible: false, revision: 2 }) });
  assert.deepEqual(petValues(newer), [false, false, true, true]);
  newer.pet(pet({ visible: true, revision: 1 }));
  assert.deepEqual(petValues(newer), [false, false, true, true]);
});

test('pet stale successful mutation replies and stale read failures cannot erase newer events', async () => {
  for (const reject of [false, true]) {
    const reply = deferred(); let reads = 0;
    const app = await mount(true, base(), { invoke(name, _args, { fallback }) {
      if (name === 'get_pet_settings' && ++reads > 1) return reply.promise;
      return fallback();
    } });
    await app.click('pet-refresh');
    app.pet(pet({ visible: true, startup_visible: false, roaming_enabled: false, revision: 8, message: 'latest' }));
    if (reject) reply.reject(new Error('stale read failed')); else reply.resolve(pet({ revision: 3 }));
    await flush();
    assert.deepEqual(petValues(app), [true, false, false, true]);
    assert.equal(app.node('pet-message').textContent, 'latest');
    assert.equal(app.node('pet-message').dataset.error, 'false');
  }
});

test('pet initial read or subscription failure blocks guessing and supports explicit read retry', async () => {
  for (const fail of ['read', 'listen']) {
    let reads = 0, registrations = 0;
    const app = await mount(true, base(), { listen(name) {
      if (name === 'pet-settings-state' && ++registrations === 1 && fail === 'listen') throw new Error('listen failed');
    }, invoke(name, _args, { fallback }) {
      if (name === 'get_pet_settings' && ++reads === 1 && fail === 'read') throw new Error('read failed token=private-pet');
      return fallback();
    } });
    assert.equal(app.node('pet-message').dataset.error, 'true');
    assert.doesNotMatch(app.node('pet-message').textContent, /private-pet/);
    for (const id of petControls) { assert.equal(app.node(id).disabled, true); await app.change(id, true); }
    assert.equal(app.node('pet-refresh').disabled, false);
    await app.click('pet-refresh');
    assert.deepEqual(petValues(app), [false, true, true, true]);
    for (const id of petControls) assert.equal(app.node(id).disabled, false);
    assert.equal(app.node('pet-message').dataset.error, 'false');
    assert.equal(petCalls(app).some(([name]) => name.startsWith('set_')), false);
  }
});

test('pet write failures preserve confirmed values, reconcile uncertain native writes and allow retry', async () => {
  for (const [id, key] of [['pet-visible', 'visible'], ['pet-startup-visible', 'startup_visible'], ['pet-roaming-enabled', 'roaming_enabled'], ['pet-bubble-notifications', 'bubble_notifications']]) {
    for (const value of [true, false]) {
      let attempts = 0;
      const app = await mount(true, base(), { initialPet: pet({ [key]: value }), invoke(name, _args, { fallback }) {
        if (['set_pet_settings', 'set_pet_visibility'].includes(name) && ++attempts === 1) throw new Error('<img onerror=bad> token=private-pet');
        return fallback();
      } });
      await app.change(id, !value);
      assert.equal(app.node(id).checked, value);
      assert.equal(app.node(id).disabled, false);
      assert.match(app.node('pet-message').textContent, /可重新读取或重试.*<img onerror=bad>/);
      assert.doesNotMatch(app.node('pet-message').textContent, /private-pet/);
      assert.equal(petCalls(app).filter(([name]) => name === 'get_pet_settings').length, 2);
      await app.change(id, !value);
      assert.equal(app.node(id).checked, !value);
      assert.equal(app.node('pet-message').dataset.error, 'false');
    }
  }
  let reads = 0;
  const app = await mount(true, base(), { invoke(name, _args, { fallback }) {
    if (name === 'get_pet_settings' && ++reads > 1) return pet({ visible: true, revision: 4 });
    if (name === 'set_pet_visibility') throw new Error('reply lost after native write');
    return fallback();
  } });
  await app.change('pet-visible', true);
  assert.equal(app.node('pet-visible').checked, true);
  app.pet(pet({ revision: 3 }));
  assert.equal(app.node('pet-visible').checked, true);
});

test('pet failed reconciliation retains last actual values and manual reading can recover', async () => {
  let reads = 0;
  const app = await mount(true, base(), { invoke(name, _args, { fallback }) {
    if (name === 'get_pet_settings' && ++reads === 2) throw new Error('reconciliation failed');
    if (name === 'set_pet_visibility') throw new Error('write failed');
    return fallback();
  } });
  await app.change('pet-visible', true);
  assert.deepEqual(petValues(app), [false, true, true, true]);
  assert.equal(app.node('pet-message').dataset.error, 'true');
  await app.click('pet-refresh');
  assert.equal(app.node('pet-message').dataset.error, 'false');
  assert.equal(reads, 3);
});

test('pet unload removes active and late listeners, ignores late callbacks/replies and prevents further IPC', async () => {
  const registration = deferred(); let callback;
  const app = await mount(true, base(), { listen(name, fn) {
    if (name === 'pet-settings-state') { callback = fn; return registration.promise; }
  } });
  app.unload();
  const text = app.node('pet-message').textContent;
  registration.resolve(); await flush();
  assert.ok(app.unlistened.includes('pet-settings-state'));
  assert.equal(app.subscriptions.has('pet-settings-state'), false);
  assert.equal(petCalls(app).length, 0);
  callback({ payload: pet({ visible: true, revision: 10 }) });
  assert.equal(app.node('pet-message').textContent, text);
  const reply = deferred();
  const mounted = await mount(true, base(), { invoke(name, _args, { fallback }) { return name === 'set_pet_visibility' ? reply.promise : fallback(); } });
  await mounted.change('pet-visible', true);
  mounted.unload();
  assert.ok(mounted.unlistened.includes('pet-settings-state'));
  const before = petValues(mounted);
  reply.resolve(pet({ visible: true, revision: 3 })); await flush();
  assert.deepEqual(petValues(mounted), before);
  const count = petCalls(mounted).length;
  await mounted.click('pet-refresh');
  for (const id of petControls) await mounted.change(id, true);
  assert.equal(petCalls(mounted).length, count);
});

test('bubble toggle follows native values and writes only its patch independently of system notifications or visibility', async () => {
  for (const enabled of [false, true]) {
    for (const bubble_notifications of [false, true]) {
      const app = await mount(true, base({ state: 'error', busy: true }), {
        initialNotification: enabled ? listening() : notification(),
        initialPet: pet({ visible: false, startup_visible: false, roaming_enabled: false, bubble_notifications }),
      });
      assert.equal(app.node('pet-bubble-notifications').checked, bubble_notifications);
      assert.equal(app.node('pet-bubble-notifications').disabled, false);
      const notificationCalls = app.calls.filter(([name]) => name.includes('notification')).length;
      await app.change('pet-bubble-notifications', !bubble_notifications);
      assert.deepEqual(petValues(app), [false, false, false, !bubble_notifications]);
      assert.equal(app.node('notifications-enabled').checked, enabled);
      await app.change('pet-bubble-notifications', bubble_notifications);
      assert.deepEqual(petValues(app), [false, false, false, bubble_notifications]);
      assert.deepEqual(JSON.parse(JSON.stringify(petCalls(app))), [
        ['get_pet_settings', null],
        ['set_pet_settings', { patch: { bubble_notifications: !bubble_notifications } }],
        ['set_pet_settings', { patch: { bubble_notifications } }],
      ]);
      assert.equal(app.calls.filter(([name]) => name.includes('notification')).length, notificationCalls);
      assert.equal(app.calls.some(([name]) => name === 'perform_action'), false);
      app.notification(notification({ enabled: !enabled }));
      assert.equal(app.node('pet-bubble-notifications').checked, bubble_notifications);
      assert.equal(app.node('pet-bubble-notifications').disabled, false);
    }
  }
});

test('bubble toggle explains independent preference, exclusive delivery and shared focused policy after existing pet toggles', async () => {
  const app = await mount(true);
  assert.ok(app.template.indexOf('id="pet-bubble-notifications"') > app.template.indexOf('id="pet-roaming-enabled"'));
  assert.match(app.template, /需要回答、确认计划或授权时，可直接在气泡中选择、输入、允许一次或拒绝/);
  assert.match(app.template, /不会自动授权或取消/);
  assert.match(app.template, /待答和授权交互会保留，直到处理或手动收起/);
  assert.match(app.template, /独立于系统通知开关/);
  assert.match(app.template, /桌宠显示时仅用气泡提醒，不发送 Windows 通知；关闭气泡则静默，不回退系统通知/);
  assert.match(app.template, /桌宠隐藏时按系统通知开关提醒，不补历史气泡/);
  assert.match(app.template, /前台静默.*沿用系统通知中的“窗口聚焦时也通知”选项/);
  assert.match(app.template, /aria-label="气泡通知" aria-describedby="pet-bubble-help pet-bubble-policy pet-message" disabled/);
});

test('bubble writes wait for native confirmation, serialize all pet controls and reject older replies and events', async () => {
  const saving = deferred();
  const app = await mount(true, base(), { invoke(name, args, { fallback }) {
    if (name === 'set_pet_settings') {
      assert.deepEqual(JSON.parse(JSON.stringify(args)), { patch: { bubble_notifications: false } });
      return saving.promise;
    }
    return fallback();
  } });
  await app.change('pet-bubble-notifications', false);
  assert.deepEqual(petValues(app), [false, true, true, true]);
  for (const id of petControls) {
    assert.equal(app.node(id).disabled, true);
    await app.change(id, false);
  }
  await app.click('pet-refresh');
  assert.equal(petCalls(app).length, 2);
  app.pet(pet({ bubble_notifications: false, revision: 4 }));
  assert.deepEqual(petValues(app), [false, true, true, false]);
  saving.resolve(pet({ bubble_notifications: true, revision: 2 })); await flush();
  app.pet(pet({ bubble_notifications: true, revision: 3 }));
  app.pet(pet({ bubble_notifications: true, revision: 4 }));
  assert.deepEqual(petValues(app), [false, true, true, false]);
  for (const id of petControls) assert.equal(app.node(id).disabled, false);
});

test('pet malformed snapshots including missing or nonboolean bubble values cannot unlock unknown settings or poison revisions', async () => {
  const missingBubble = pet(); delete missingBubble.bubble_notifications;
  const invalid = [null, undefined, {}, missingBubble,
    ...[undefined, null, 0, 1, 'true', 'false', {}, []].map(bubble_notifications => pet({ bubble_notifications })),
    ...['visible', 'startup_visible', 'roaming_enabled'].map(key => pet({ [key]: 'true' })),
    ...[-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, '2'].map(revision => pet({ revision })),
    pet({ message: null })];
  for (const snapshot of invalid) {
    let reads = 0;
    const app = await mount(true, base(), { invoke(name, _args, { fallback }) {
      if (name === 'get_pet_settings' && ++reads === 1) return snapshot;
      return fallback();
    } });
    assert.equal(app.node('pet-message').dataset.error, 'true');
    for (const id of petControls) {
      assert.equal(app.node(id).disabled, true);
      assert.equal(app.node(id).checked, false);
      await app.change(id, true);
    }
    assert.equal(petCalls(app).length, 1);
    app.pet(snapshot);
    for (const id of petControls) assert.equal(app.node(id).disabled, true);
    await app.click('pet-refresh');
    assert.deepEqual(petValues(app), [false, true, true, true]);
    for (const id of petControls) assert.equal(app.node(id).disabled, false);
    app.pet(snapshot);
    app.pet(pet({ bubble_notifications: 'false', revision: 99 }));
    assert.deepEqual(petValues(app), [false, true, true, true]);
    app.pet(pet({ bubble_notifications: false, revision: 1 }));
    assert.deepEqual(petValues(app), [false, true, true, false]);
  }
});

test('bubble mutation replies and callbacks cannot render or send more IPC after unload', async () => {
  const saving = deferred(); let callback;
  const app = await mount(true, base(), { listen(name, fn) {
    if (name === 'pet-settings-state') callback = fn;
  }, invoke(name, _args, { fallback }) {
    return name === 'set_pet_settings' ? saving.promise : fallback();
  } });
  await app.change('pet-bubble-notifications', false);
  app.unload();
  const before = petValues(app);
  callback({ payload: pet({ bubble_notifications: false, revision: 10 }) });
  saving.resolve(pet({ bubble_notifications: false, revision: 11 })); await flush();
  assert.deepEqual(petValues(app), before);
  const calls = app.calls.length;
  await app.change('pet-bubble-notifications', true);
  assert.equal(app.calls.length, calls);
  assert.ok(app.unlistened.includes('pet-settings-state'));
});

test('bubble browser preview changes are disabled and never touch native IPC or listeners', async () => {
  const app = await mount(false, base(), { location: 'http://127.0.0.1:1420/index.html?view=settings&section=pet' });
  assert.equal(app.node('pet-bubble-notifications').disabled, true);
  await app.change('pet-bubble-notifications', true);
  await app.click('pet-refresh');
  assert.equal(app.calls.length, 0);
  assert.equal(app.listenCalls.length, 0);
});

test('browser previews never invoke native commands or subscribe in either view', async () => {
  for (const mode of ['startup', 'settings']) {
    const app = await mount(false, base(), { mode });
    for (const id of ['check', 'save-repository', 'open', 'logs', 'check-update', 'install-update', 'notifications-enabled', 'notifications-when-focused', 'test-notification', 'power-enabled', 'power-refresh', 'pet-visible', 'pet-startup-visible', 'pet-roaming-enabled', 'pet-bubble-notifications', 'pet-refresh']) {
      if (app.has(id)) assert.equal(app.node(id).disabled, true);
      await app.click(id);
    }
    await app.change('notifications-enabled', true);
    await app.change('notifications-when-focused', true);
    await app.change('power-enabled', false);
    for (const id of ['pet-visible', 'pet-startup-visible', 'pet-roaming-enabled']) await app.change(id, true);
    for (const section of ['environment', 'notifications', 'power', 'pet', 'speech', 'updates', 'logs']) await app.click('nav-' + section);
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

test('notification settings explain visible task names and notification-center retention', async () => {
  const app = await mount(true);
  assert.match(app.template, /通知显示会话名称/);
  assert.match(app.template, /Windows 通知中心可能保留名称/);
  assert.match(app.template, /不显示对话正文和错误详情/);
  app.unload();
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

test('shared focused notifications require opt-in, support preconfiguration and preserve preference across system toggle', async () => {
  const app = await mount(true);
  assert.equal(app.node('notifications-when-focused').checked, false);
  assert.equal(app.node('notifications-when-focused').disabled, false);
  await app.change('notifications-when-focused', true);
  assert.equal(app.node('notifications-when-focused').checked, true);
  assert.equal(app.node('notifications-enabled').checked, false);
  assert.equal(app.node('test-notification').disabled, true);
  const preconfiguration = app.calls.filter(([name]) => name === 'set_notifications_enabled');
  assert.equal(preconfiguration.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(preconfiguration[0][1])), { enabled: false, notifyWhenFocused: true });
  await app.change('notifications-enabled', true);
  assert.equal(app.node('notifications-when-focused').disabled, false);
  await app.change('notifications-when-focused', true);
  const args = app.calls.filter(([name]) => name === 'set_notifications_enabled').at(-1)[1];
  assert.equal(args.enabled, true); assert.equal(args.notifyWhenFocused, true);
  assert.equal(app.node('notifications-when-focused').checked, true);
  await app.change('notifications-enabled', false);
  assert.equal(app.node('notifications-when-focused').checked, true);
  assert.equal(app.node('notifications-when-focused').disabled, false);
  assert.equal(app.node('test-notification').disabled, true);
  await app.change('notifications-enabled', true);
  assert.equal(app.node('notifications-when-focused').checked, true);
  await app.change('notifications-when-focused', false);
  assert.equal(app.node('notifications-when-focused').checked, false);
  assert.equal(app.node('notifications-enabled').checked, true);
});

test('bubble-only foreground preference configures both directions without enabling Windows notifications or changing pet settings', async () => {
  const app = await mount(true, base({ state: 'error', busy: true }), {
    initialPet: pet({ visible: true, bubble_notifications: true }),
    initialNotification: notification(),
  });
  assert.match(app.template, /同时用于桌宠气泡和系统通知/);
  assert.match(app.template, /可在系统通知关闭时配置，不会开启系统通知/);
  assert.equal(app.node('pet-bubble-notifications').checked, true);
  assert.equal(app.node('notifications-when-focused').checked, false);
  const initialPetCalls = petCalls(app).length;
  for (const notifyWhenFocused of [true, false]) {
    assert.equal(app.node('notifications-when-focused').disabled, false);
    assert.equal(app.node('test-notification').disabled, true);
    await app.click('test-notification');
    await app.change('notifications-when-focused', notifyWhenFocused);
    const args = app.calls.filter(([name]) => name === 'set_notifications_enabled').at(-1)[1];
    assert.deepEqual(JSON.parse(JSON.stringify(args)), { enabled: false, notifyWhenFocused });
    assert.equal(app.node('notifications-when-focused').checked, notifyWhenFocused);
    assert.equal(app.node('notifications-enabled').checked, false);
    assert.equal(app.node('test-notification').disabled, true);
    assert.equal(app.node('pet-visible').checked, true);
    assert.equal(app.node('pet-bubble-notifications').checked, true);
  }
  assert.equal(app.calls.filter(([name]) => name === 'set_notifications_enabled').length, 2);
  assert.equal(app.calls.filter(([name]) => name === 'test_notification').length, 0);
  assert.equal(petCalls(app).length, initialPetCalls);
});

test('bubble-only foreground configuration retains the shared pending lock and newer events while Windows test stays disabled', async () => {
  const saving = deferred();
  const app = await mount(true, base(), { initialNotification: notification(), initialPet: pet({ visible: true }), invoke(name, args, { fallback }) {
    if (name === 'set_notifications_enabled') {
      assert.deepEqual(JSON.parse(JSON.stringify(args)), { enabled: false, notifyWhenFocused: true });
      return saving.promise;
    }
    return fallback();
  } });
  await app.change('notifications-when-focused', true);
  for (const id of ['notifications-enabled', 'notifications-when-focused', 'test-notification']) assert.equal(app.node(id).disabled, true);
  await app.change('notifications-when-focused', false);
  await app.change('notifications-enabled', true);
  await app.click('test-notification');
  assert.equal(app.calls.filter(([name]) => name === 'set_notifications_enabled').length, 1);
  assert.equal(app.calls.filter(([name]) => name === 'test_notification').length, 0);
  app.notification(notification({ notify_when_focused: true, message: 'shared bubble policy event' }));
  saving.resolve(notification()); await flush();
  assert.equal(app.node('notifications-when-focused').checked, true);
  assert.equal(app.node('notifications-when-focused').disabled, false);
  assert.equal(app.node('notifications-enabled').checked, false);
  assert.equal(app.node('test-notification').disabled, true);
  assert.equal(app.node('pet-bubble-notifications').checked, true);
  assert.match(app.node('notification-message').textContent, /shared bubble policy event/);
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
  assert.deepEqual(sections, ['environment', 'notifications', 'power', 'pet', 'speech', 'updates', 'logs']);
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
    for (const section of ['environment', 'notifications', 'power', 'pet', 'speech', 'updates', 'logs']) {
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
    for (const section of ['environment', 'notifications', 'power', 'pet', 'speech', 'updates', 'logs']) assert.equal(app.node('settings-' + section).hidden, section !== selected);
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

const fresh = (extra = {}) => base({ setup_required: true, state: 'unknown', managed: false, environment: environment({ checks: [] , repository: null }), ...extra });
const fillSetup = async app => { await app.fill('setup-repository', '/home/test/deepseek-harness'); };

test('first-run routes from get_snapshot into launcher setup, never environment remediation or automatic writes', async () => {
  const app = await mount(true, fresh({ state: 'error', last_error: 'missing config' }), { mode: 'startup' });
  assert.equal(app.node('setup-panel').hidden, false);
  assert.equal(app.node('startup-content').hidden, true);
  assert.equal(app.node('startup-shell').dataset.state, 'setup');
  assert.equal(app.node('setup-distribution').value, 'Ubuntu');
  assert.equal(app.node('setup-user').value, 'test');
  assert.equal(app.node('setup-node').value, '/usr/bin/node');
  assert.equal(app.node('setup-port').value, '3080');
  assert.equal(app.node('setup-submit').disabled, true);
  const identity = app.calls.find(([name]) => name === 'setup_identity');
  assert.equal(JSON.stringify(identity[1]), JSON.stringify({ distribution: 'Ubuntu', linuxUser: '' }));
  assert.equal(app.calls.filter(([name]) => ['complete_setup', 'perform_action', 'set_project_directory'].includes(name)).length, 0);
  assert.match(app.template, /Python 3.9\+/);
  assert.match(app.template, /ss 和 Node.js/);
  assert.match(app.template, /已安装依赖、已构建/);
  assert.match(app.template, /内置版本 1.0.0/);
  assert.match(app.template, /不会安装依赖、克隆或构建项目，也不会修改旧数据/);
});

test('existing startup and settings do not initialize setup and native URLs cannot force preview setup', async () => {
  for (const mode of ['startup', 'settings']) {
    const app = await mount(true, base(), { mode });
    assert.equal(app.calls.filter(([name]) => /^setup_|^complete_setup$/.test(name)).length, 0);
    if (mode === 'startup') { assert.equal(app.node('setup-panel').hidden, true); assert.equal(app.node('startup-content').hidden, false); }
    else assert.equal(app.has('setup-panel'), false);
  }
  const app = await mount(true, base(), { location: 'http://localhost/index.html?preview=setup' });
  assert.equal(app.node('setup-panel').hidden, true);
});

test('setup preview is nonnative, isolated from the normal preview and never invokes commands', async () => {
  const app = await mount(false, base(), { location: 'http://localhost/index.html?preview=setup' });
  assert.equal(app.node('setup-panel').hidden, false);
  assert.equal(app.node('startup-content').hidden, true);
  assert.equal(app.node('setup-distribution').value, 'Ubuntu');
  for (const name of ['distribution', 'user', 'repository', 'node', 'port', 'detect-distributions', 'detect-identity', 'submit']) assert.equal(app.node('setup-' + name).disabled, true);
  await app.click('setup-detect-distributions'); await app.click('setup-detect-identity'); await app.submit();
  assert.equal(app.calls.length, 0); assert.equal(app.listenCalls.length, 0);
  assert.match(app.node('setup-submit-status').textContent, /浏览器预览/);
});

test('setup discovery waits for snapshot and preserves newer event routing over delayed initial replies', async () => {
  const initial = deferred();
  const app = await mount(true, fresh(), { mode: 'startup', invoke(name, _args, { fallback }) { return name === 'get_snapshot' ? initial.promise : fallback(); } });
  assert.equal(app.node('setup-panel').hidden, true);
  assert.equal(app.calls.filter(([name]) => name === 'setup_distributions').length, 0);
  app.event(fresh()); await flush();
  assert.equal(app.node('setup-panel').hidden, false);
  initial.resolve(base()); await flush();
  assert.equal(app.node('setup-panel').hidden, false);
  assert.equal(app.calls.filter(([name]) => name === 'setup_distributions').length, 1);
});

test('distribution discovery failures and empty lists are retryable without writes or losing form state', async () => {
  let attempt = 0;
  const app = await mount(true, fresh(), { mode: 'startup', invoke(name, _args, { fallback }) { if (name === 'setup_distributions' && ++attempt === 1) throw new Error('wsl failed token=private'); return fallback(); } });
  assert.match(app.node('setup-error').textContent, /检测失败/);
  assert.doesNotMatch(app.node('setup-error').textContent, /private/);
  await app.fill('setup-repository', '/home/test/preserved');
  await app.click('setup-detect-distributions');
  assert.equal(app.node('setup-user').value, 'test');
  assert.equal(app.node('setup-repository').value, '/home/test/preserved');
  const empty = await mount(true, fresh(), { mode: 'startup', invoke(name, _args, { fallback }) { return name === 'setup_distributions' ? [] : fallback(); } });
  assert.match(empty.node('setup-distribution-status').textContent, /未发现 WSL/);
  assert.equal(empty.node('setup-submit').disabled, true);
  assert.equal(empty.node('setup-detect-distributions').disabled, false);
  assert.equal(empty.calls.filter(([name]) => name === 'setup_identity').length, 0);
});

test('rediscovery keeps current distribution and typed fields, and renders hostile WSL names only as text', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  let attempts = 0;
  const app = await mount(true, fresh(), { mode: 'startup', invoke(name, _args, { fallback }) {
    if (name === 'setup_distributions') { if (++attempts === 2) throw new Error('<script>retry</script>'); return [hostile, 'Debian']; }
    if (name === 'setup_identity') return { linux_user: 'test', home: '<script>home</script>', node: '/usr/bin/node' };
    return fallback();
  } });
  assert.equal(app.node('setup-distribution').children[1].textContent, hostile);
  assert.equal(app.node('setup-distribution').children[1].value, hostile);
  assert.match(app.node('setup-identity-status').textContent, /<script>home<\/script>/);
  await fillSetup(app); await app.fill('setup-node', '/custom/node');
  await app.click('setup-detect-distributions');
  assert.equal(app.node('setup-distribution').value, hostile);
  assert.equal(app.node('setup-node').value, '/custom/node');
  assert.equal(app.node('setup-repository').value, '/home/test/deepseek-harness');
  await app.click('setup-detect-distributions');
  assert.equal(app.node('setup-node').value, '/custom/node');
  assert.equal(app.calls.filter(([name]) => name === 'setup_identity').length, 1);
});

test('distribution switch rejects stale identity success and failure for the previous target', async () => {
  for (const rejectOld of [false, true]) {
    const old = deferred();
    const app = await mount(true, fresh(), { mode: 'startup', invoke(name, args, { fallback }) { if (name === 'setup_identity' && args.distribution === 'Ubuntu') return old.promise; return fallback(); } });
    await app.choose('setup-distribution', 'Debian');
    assert.equal(app.node('setup-user').value, 'test');
    await app.fill('setup-node', '/debian/node');
    if (rejectOld) old.reject(new Error('obsolete error'));
    else old.resolve({ linux_user: 'obsolete', home: '/old', node: '/old/node' });
    await flush();
    assert.equal(app.node('setup-distribution').value, 'Debian');
    assert.equal(app.node('setup-user').value, 'test');
    assert.equal(app.node('setup-node').value, '/debian/node');
    assert.equal(app.node('setup-error').hidden, true);
  }
});

test('typing a new user cancels old discovery and manual Node input survives in-flight detection', async () => {
  const old = deferred(); const current = deferred();
  const app = await mount(true, fresh(), { mode: 'startup', invoke(name, args, { fallback }) { if (name === 'setup_identity') return args.linuxUser === 'alice' ? current.promise : old.promise; return fallback(); } });
  await app.fill('setup-user', 'alice');
  old.resolve({ linux_user: 'old', home: '/old', node: '/old/node' }); await flush();
  assert.equal(app.node('setup-user').value, 'alice');
  await app.choose('setup-user', 'alice');
  await app.fill('setup-node', '/home/alice/custom/node');
  current.resolve({ linux_user: 'alice', home: '/home/alice', node: '/discovered/node' }); await flush();
  assert.equal(app.node('setup-node').value, '/home/alice/custom/node');
  assert.equal(app.node('setup-user').value, 'alice');
});

test('missing Node is manually recoverable and identity failures retain manually entered values', async () => {
  let attempts = 0;
  const app = await mount(true, fresh(), { mode: 'startup', invoke(name, _args, { fallback }) {
    if (name === 'setup_identity') { if (++attempts === 2) throw new Error('discovery failed'); return { linux_user: 'test', home: '/home/test', node: '' }; }
    return fallback();
  } });
  assert.match(app.node('setup-identity-status').textContent, /未发现 Node.js.*nvm/);
  await fillSetup(app);
  assert.equal(app.node('setup-submit').disabled, true);
  await app.fill('setup-node', '/home/test/.nvm/versions/node/v24/bin/node');
  assert.equal(app.node('setup-submit').disabled, false);
  await app.click('setup-detect-identity');
  assert.match(app.node('setup-error').textContent, /发现失败/);
  assert.equal(app.node('setup-node').value, '/home/test/.nvm/versions/node/v24/bin/node');
  assert.equal(app.node('setup-submit').disabled, false);
  await app.click('setup-detect-identity');
  assert.equal(attempts, 3);
});

test('setup validation rejects Windows/relative/control-character paths and invalid ports before any write', async () => {
  const app = await mount(true, fresh(), { mode: 'startup' });
  await fillSetup(app);
  assert.equal(app.node('setup-submit').disabled, false);
  for (const id of ['setup-repository', 'setup-node']) {
    const valid = app.node(id).value;
    for (const path of ['C:\\work', 'relative', '//server/path', '~/repo', '/a\npath', '/bad\u0000node']) {
      await app.fill(id, path);
      assert.equal(app.node('setup-submit').disabled, true, path);
      await app.submit();
    }
    await app.fill(id, valid);
  }
  for (const port of ['', '0', '65536', '3.5', 'NaN']) {
    await app.fill('setup-port', port); assert.equal(app.node('setup-submit').disabled, true); await app.submit();
  }
  await app.fill('setup-port', '3081');
  assert.equal(app.node('setup-submit').disabled, false);
  assert.equal(app.calls.filter(([name]) => name === 'complete_setup').length, 0);
});

test('explicit setup submission sends one request, locks operations and returns to normal startup', async () => {
  const completion = deferred();
  const app = await mount(true, fresh(), { mode: 'startup', invoke(name, _args, { fallback }) { return name === 'complete_setup' ? completion.promise : fallback(); } });
  await fillSetup(app); await app.fill('setup-port', '3081');
  await app.submit(); await app.submit();
  const calls = app.calls.filter(([name]) => name === 'complete_setup');
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(calls[0][1]), JSON.stringify({ request: { distribution: 'Ubuntu', linux_user: 'test', repository: '/home/test/deepseek-harness', node: '/usr/bin/node', port: 3081 } }));
  for (const name of ['distribution', 'user', 'repository', 'node', 'port', 'detect-distributions', 'detect-identity', 'submit']) assert.equal(app.node('setup-' + name).disabled, true);
  const count = app.calls.length;
  await app.click('setup-detect-distributions'); await app.click('setup-detect-identity'); await app.click('open'); await app.click('check'); await app.click('open-settings');
  assert.equal(app.calls.length, count);
  completion.resolve(base({ state: 'starting', busy: true })); await flush();
  assert.equal(app.node('setup-panel').hidden, true);
  assert.equal(app.node('startup-content').hidden, false);
  assert.equal(app.node('startup-shell').dataset.state, 'starting');
  assert.equal(app.calls.filter(([name]) => name === 'perform_action').length, 0);
});

test('setup submission preserves a newer startup event over its delayed reply and keeps operations locked until settled', async () => {
  const completion = deferred();
  const app = await mount(true, fresh(), { mode: 'startup', invoke(name, _args, { fallback }) { return name === 'complete_setup' ? completion.promise : fallback(); } });
  await fillSetup(app); await app.submit();
  app.event(base());
  assert.equal(app.node('setup-panel').hidden, true);
  assert.equal(app.node('open').disabled, true);
  assert.equal(app.node('check').disabled, true);
  assert.equal(app.node('open-settings').disabled, true);
  completion.resolve(fresh()); await flush();
  assert.equal(app.node('setup-panel').hidden, true);
  assert.equal(app.node('startup-shell').dataset.state, 'ready');
  assert.equal(app.node('open').disabled, false);
});

test('setup completion failure preserves the entire draft and permits port-conflict recovery', async () => {
  let attempts = 0;
  const app = await mount(true, fresh(), { mode: 'startup', invoke(name, _args, { fallback }) { if (name === 'complete_setup' && ++attempts === 1) throw new Error('端口 3080 冲突 token=private'); return fallback(); } });
  await fillSetup(app); await app.fill('setup-node', '/custom/node');
  await app.submit();
  assert.match(app.node('setup-error').textContent, /端口 3080 冲突/);
  assert.doesNotMatch(app.node('setup-error').textContent, /private/);
  assert.equal(app.node('setup-panel').hidden, false);
  assert.equal(app.node('setup-submit').disabled, false);
  assert.equal(app.node('setup-user').value, 'test');
  assert.equal(app.node('setup-node').value, '/custom/node');
  assert.equal(app.node('setup-repository').value, '/home/test/deepseek-harness');
  app.event(fresh());
  assert.equal(app.node('setup-node').value, '/custom/node');
  await app.fill('setup-port', '3081'); await app.submit();
  assert.equal(attempts, 2);
  assert.equal(app.calls.filter(([name]) => name === 'complete_setup')[1][1].request.port, 3081);
  assert.equal(app.node('setup-panel').hidden, true);
});

test('postcommit setup failure returns to normal startup error with delivered or missing events, including failed listener', async () => {
  const failed = base({ state: 'error', phase: '准备本地服务', last_error: '服务启动失败', message: '服务启动失败' });
  for (const mode of ['event', 'missing-event', 'intermediate-event', 'failed-listener']) {
    let reads = 0;
    const app = await mount(true, fresh(), { mode: 'startup', listen(name) { if (mode === 'failed-listener' && name === 'launcher-state') throw new Error('listener failed'); }, invoke(name, _args, { subscriptions, fallback }) {
      if (name === 'get_snapshot') return ++reads === 1 ? fresh() : mode === 'event' ? fresh() : failed;
      if (name === 'complete_setup') {
        if (mode === 'event') subscriptions.get('launcher-state')({ payload: failed });
        if (mode === 'intermediate-event') subscriptions.get('launcher-state')({ payload: fresh({ busy: true }) });
        throw new Error('ensure_ready failed after saving');
      }
      return fallback();
    } });
    await fillSetup(app); await app.submit();
    assert.equal(reads, 2, mode);
    assert.equal(app.node('setup-panel').hidden, true, mode);
    assert.equal(app.node('startup-content').hidden, false);
    assert.equal(app.node('startup-shell').dataset.state, 'error');
    assert.match(app.node('error-notice').textContent, /服务启动失败/);
    assert.equal(app.node('check').disabled, false);
    assert.equal(app.node('check').hidden, false);
    assert.equal(app.node('setup-repository').value, '/home/test/deepseek-harness');
    assert.equal(app.calls.filter(([name]) => name === 'complete_setup').length, 1);
    assert.equal(app.calls.filter(([name]) => name === 'perform_action').length, 0);
  }
});

test('precommit setup failure remains locked while refreshing then preserves the draft for explicit retry', async () => {
  const refresh = deferred(); let reads = 0;
  const app = await mount(true, fresh(), { mode: 'startup', invoke(name, _args, { fallback }) {
    if (name === 'get_snapshot') return ++reads === 1 ? fresh() : refresh.promise;
    if (name === 'complete_setup') throw new Error('预检查失败');
    return fallback();
  } });
  await fillSetup(app); await app.fill('setup-node', '/custom/node'); await app.submit();
  assert.equal(app.node('setup-submit').disabled, true);
  assert.equal(app.node('setup-detect-distributions').disabled, true);
  await app.submit();
  assert.equal(app.calls.filter(([name]) => name === 'complete_setup').length, 1);
  refresh.resolve(fresh()); await flush();
  assert.equal(app.node('setup-panel').hidden, false);
  assert.equal(app.node('setup-submit').disabled, false);
  assert.match(app.node('setup-error').textContent, /预检查失败/);
  assert.equal(app.node('setup-node').value, '/custom/node');
  assert.equal(app.node('setup-repository').value, '/home/test/deepseek-harness');
});

test('failed post-error status read blocks duplicate setup and offers only a read-only status retry', async () => {
  for (const saved of [true, false]) {
    let reads = 0;
    const app = await mount(true, fresh(), { mode: 'startup', invoke(name, _args, { fallback }) {
      if (name === 'get_snapshot') {
        if (++reads === 2) throw new Error('状态读取失败');
        if (reads > 2) return saved ? base({ state: 'error', last_error: '已保存但启动失败' }) : fresh();
        return fresh();
      }
      if (name === 'complete_setup') throw new Error('提交结果未知');
      return fallback();
    } });
    await fillSetup(app); await app.submit();
    assert.match(app.node('setup-error').textContent, /配置可能已保存.*重新读取状态.*不要重复提交/);
    assert.equal(app.node('setup-detect-distributions').textContent, '重新读取状态');
    assert.equal(app.node('setup-detect-distributions').disabled, false);
    assert.equal(app.node('setup-submit').disabled, true);
    await app.fill('setup-port', '3081'); await app.submit();
    assert.match(app.node('setup-submit-status').textContent, /配置可能已保存/);
    assert.equal(app.node('setup-submit').disabled, true);
    const discoveryCalls = app.calls.filter(([name]) => name === 'setup_distributions').length;
    await app.click('setup-detect-distributions');
    assert.equal(reads, 3);
    assert.equal(app.calls.filter(([name]) => name === 'complete_setup').length, 1);
    assert.equal(app.calls.filter(([name]) => name === 'setup_distributions').length, discoveryCalls);
    assert.equal(app.node('setup-repository').value, '/home/test/deepseek-harness');
    assert.equal(app.node('setup-port').value, '3081');
    assert.equal(app.node('setup-panel').hidden, saved);
    if (!saved) {
      assert.equal(app.node('setup-submit').disabled, false);
      assert.equal(app.node('setup-detect-distributions').textContent, '重新检测');
      assert.match(app.node('setup-error').textContent, /已确认尚未完成配置/);
    }
  }
});

test('late setup status reads and failures cannot overwrite newer events or restore an uncertain lock', async () => {
  for (const reject of [false, true]) {
    const refresh = deferred(); let reads = 0;
    const app = await mount(true, fresh(), { mode: 'startup', invoke(name, _args, { fallback }) {
      if (name === 'get_snapshot') return ++reads === 1 ? fresh() : refresh.promise;
      if (name === 'complete_setup') throw new Error('late failure');
      return fallback();
    } });
    await fillSetup(app); await app.submit();
    app.event(base({ state: 'error', last_error: 'newer service error' }));
    if (reject) refresh.reject(new Error('obsolete read failure')); else refresh.resolve(fresh());
    await flush();
    assert.equal(app.node('setup-panel').hidden, true);
    assert.equal(app.node('startup-shell').dataset.state, 'error');
    assert.match(app.node('error-notice').textContent, /newer service error/);
    assert.equal(app.node('check').disabled, false);
    assert.equal(app.calls.filter(([name]) => name === 'complete_setup').length, 1);
  }
});

test('uncertain setup read retry remains available after stale busy events and update installation locks', async () => {
  for (const installing of [false, true]) {
    const refresh = deferred(); let reads = 0;
    const app = await mount(true, fresh(), { mode: 'startup', invoke(name, _args, { subscriptions, fallback }) {
      if (name === 'get_snapshot') {
        if (++reads === 2) throw new Error('状态暂时不可读');
        return reads > 2 ? refresh.promise : fresh();
      }
      if (name === 'complete_setup') {
        subscriptions.get('launcher-state')({ payload: fresh({ busy: true }) });
        if (installing) subscriptions.get('launcher-update-state')({ payload: update({ phase: 'installing', busy: true }) });
        throw new Error('提交后启动结果未知');
      }
      return fallback();
    } });
    await fillSetup(app); await app.submit();
    assert.equal(reads, 2);
    assert.equal(app.node('setup-submit').disabled, true);
    assert.equal(app.node('setup-detect-distributions').textContent, '重新读取状态');
    assert.equal(app.node('setup-detect-distributions').disabled, false);
    await app.click('setup-detect-distributions'); await app.click('setup-detect-distributions');
    assert.equal(reads, 3);
    assert.equal(app.node('setup-detect-distributions').disabled, true);
    refresh.resolve(base({ state: 'error', last_error: '已保存但启动失败' })); await flush();
    assert.equal(app.node('setup-panel').hidden, true);
    assert.equal(app.node('startup-shell').dataset.state, 'error');
    assert.match(app.node('error-notice').textContent, /已保存但启动失败/);
    assert.equal(app.calls.filter(([name]) => name === 'complete_setup').length, 1);
    assert.equal(app.calls.filter(([name]) => name === 'setup_distributions').length, 1);
    assert.equal(app.node('setup-repository').value, '/home/test/deepseek-harness');
  }
});

test('read-only uncertain setup retry respects newer events and unload before a delayed reply', async () => {
  for (const dispose of [false, true]) {
    const refresh = deferred(); let reads = 0;
    const app = await mount(true, fresh(), { mode: 'startup', invoke(name, _args, { fallback }) {
      if (name === 'get_snapshot') {
        if (++reads === 2) throw new Error('unknown status');
        return reads > 2 ? refresh.promise : fresh();
      }
      if (name === 'complete_setup') throw new Error('completion failed');
      return fallback();
    } });
    await fillSetup(app); await app.submit(); await app.click('setup-detect-distributions');
    assert.equal(app.node('setup-detect-distributions').disabled, true);
    if (dispose) app.unload(); else app.event(base());
    const status = app.node('setup-submit-status').textContent;
    refresh.resolve(fresh()); await flush();
    if (dispose) assert.equal(app.node('setup-submit-status').textContent, status);
    else assert.equal(app.node('setup-panel').hidden, true);
    assert.equal(app.calls.filter(([name]) => name === 'complete_setup').length, 1);
  }
});

test('setup ignores discovery replies after leaving setup or unloading', async () => {
  for (const dispose of [false, true]) {
    const identity = deferred();
    const app = await mount(true, fresh(), { mode: 'startup', invoke(name, _args, { fallback }) { return name === 'setup_identity' ? identity.promise : fallback(); } });
    if (dispose) app.unload(); else app.event(base());
    const status = app.node('setup-identity-status').textContent;
    identity.resolve({ linux_user: 'late', home: '/late', node: '/late/node' }); await flush();
    assert.equal(app.node('setup-user').value, '');
    assert.equal(app.node('setup-identity-status').textContent, status);
    assert.equal(app.calls.filter(([name]) => name === 'complete_setup').length, 0);
  }
});
