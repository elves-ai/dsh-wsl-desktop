import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const source = stripTypeScriptTypes(readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, ''));
const flush = () => new Promise(resolve => setImmediate(resolve));
const base = (extra = {}) => ({ state: 'ready', phase: '已就绪', message: '正常', busy: false, managed: true, origin: 'http://127.0.0.1:3080', last_error: null, logs: [], ...extra });
const update = (extra = {}) => ({ current_version: '0.1.0', phase: 'idle', version: null, notes: null, downloaded: 0, total: null, message: '可检查更新', busy: false, ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function mount(native, initial = base(), options = {}) {
  const nodes = new Map(); const subscriptions = new Map(); const calls = []; const windowHandlers = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, textContent: '', dataset: {}, hidden: false, disabled: false, open: false, scrollTop: 0, scrollHeight: 0, clientHeight: 0, handlers: {}, attributes: {}, set innerHTML(_) { throw new Error('Native data must not use HTML'); }, addEventListener(name, fn) { this.handlers[name] = fn; }, removeAttribute(name) { delete this.attributes[name]; if (name === 'value') delete this.value; }, focus() { this.focused = true; }, scrollIntoView() { this.scrolled = true; } });
    return nodes.get(id);
  };
  const root = { set innerHTML(template) { for (const match of template.matchAll(/id="([^"]+)"/g)) node(match[1]); } };
  const context = vm.createContext({
    URL, console, document: { querySelector: () => root, getElementById: id => nodes.get(id) }, window: { addEventListener(name, handler) { windowHandlers.set(name, handler); } },
    isTauri: () => native,
    listen: async (name, callback) => { if (options.listen) await options.listen(name); subscriptions.set(name, callback); return () => subscriptions.delete(name); },
    invoke: async (name, args) => {
      calls.push([name, args]);
      const fallback = () => name === 'get_snapshot' || name === 'perform_action' ? initial : options.initialUpdate || update();
      return options.invoke ? options.invoke(name, args, { subscriptions, fallback }) : fallback();
    },
  });
  vm.runInContext(source, context); await flush();
  return { node, calls, subscriptions, unload() { windowHandlers.get('beforeunload')?.(); }, event(snapshot) { subscriptions.get('launcher-state')?.({ payload: snapshot }); }, update(snapshot) { subscriptions.get('launcher-update-state')?.({ payload: snapshot }); }, async click(id) { node(id).handlers.click?.(); await flush(); } };
}

test('browser preview cannot invoke native commands or subscribe to events', async () => {
  const app = await mount(false); assert.equal(app.calls.length, 0); assert.equal(app.subscriptions.size, 0);
  for (const id of ['open', 'start', 'stop', 'restart', 'quit', 'exit', 'logs', 'check-update', 'install-update']) { assert.equal(app.node(id).disabled, true); await app.click(id); }
  assert.equal(app.calls.length, 0); assert.equal(app.node('preview-note').hidden, false);
});
test('stopped service can be started with the primary open button', async () => {
  const app = await mount(true, base({ state: 'stopped', managed: false })); assert.equal(app.node('open').disabled, false);
  await app.click('open'); assert.equal(app.calls.at(-1)[0], 'perform_action'); assert.equal(app.calls.at(-1)[1].action, 'open');
});
test('external services disable stop and restart', async () => {
  const app = await mount(true, base({ managed: false })); assert.equal(app.node('stop').disabled, true); assert.equal(app.node('restart').disabled, true);
  await app.click('stop'); await app.click('restart'); assert.equal(app.calls.filter(([name]) => name === 'perform_action').length, 0);
});
test('busy snapshots disable all actions and prevent duplicate invocation', async () => {
  const app = await mount(true); app.event(base({ busy: true }));
  for (const id of ['open', 'start', 'stop', 'restart', 'quit', 'exit', 'logs']) { assert.equal(app.node(id).disabled, true); await app.click(id); }
  assert.equal(app.calls.filter(([name]) => name === 'perform_action').length, 0);
});
test('native data stays text-only and credentials do not reach displayed diagnostics', async () => {
  const secret = 'test-secret-value'; const app = await mount(true, base({ phase: '<img onerror=bad>', message: 'token=' + secret,
    origin: 'http://user:password@127.0.0.1:3080/?token=' + secret,
    logs: ['Bearer ' + secret, '<script>bad</script> token=' + secret] }));
  assert.equal(app.node('phase').textContent, '<img onerror=bad>');
  for (const id of ['status-message', 'origin', 'log-output']) assert.ok(!app.node(id).textContent.includes(secret));
  assert.equal(app.node('origin').textContent, 'http://127.0.0.1:3080');
});
test('native startup subscribes before querying and only checks once without installing', async () => {
  const app = await mount(true, base(), { invoke(name, _args, { subscriptions, fallback }) {
    if (name === 'get_update_snapshot') {
      assert.ok(subscriptions.has('launcher-update-state'));
      assert.ok(subscriptions.has('launcher-show-updates'));
    }
    return fallback();
  } });
  assert.equal(app.calls.filter(([name]) => name === 'check_update').length, 1);
  assert.equal(app.calls.filter(([name]) => name === 'install_update').length, 0);
  assert.equal(app.node('update-current-version').textContent, '当前版本 0.1.0');
  assert.equal(app.node('install-update').hidden, true);
  await app.click('install-update');
  assert.equal(app.calls.filter(([name]) => name === 'install_update').length, 0);
  await app.click('check-update');
  assert.equal(app.calls.filter(([name]) => name === 'check_update').length, 2);
  app.unload(); assert.equal(app.subscriptions.size, 0);
});

test('existing available or busy update is not rechecked at startup', async () => {
  for (const initialUpdate of [update({ phase: 'available', version: '0.2.0' }), update({ phase: 'checking', busy: true }), update({ phase: 'downloading', busy: true })]) {
    const app = await mount(true, base(), { initialUpdate });
    assert.equal(app.calls.filter(([name]) => name === 'check_update').length, 0);
  }
});

test('available version, hostile release notes, and tray reveal remain text only', async () => {
  const notes = '<img src=x onerror=bad>\n<script>bad()</script> **not HTML**';
  const app = await mount(true, base(), { initialUpdate: update({ phase: 'available', version: '0.2.0', notes }) });
  assert.equal(app.node('install-update').hidden, false);
  assert.equal(app.node('install-update').disabled, false);
  assert.equal(app.node('update-new-version').textContent, '新版本 0.2.0');
  assert.equal(app.node('update-notes').textContent, notes);
  assert.equal(app.node('updates-panel').open, true); // Available initial query recovers a missed tray reveal.
  app.node('updates-panel').open = false;
  app.subscriptions.get('launcher-show-updates')?.({});
  assert.equal(app.node('updates-panel').open, true);
  assert.equal(app.node('update-message').focused, true);
  assert.equal(app.node('updates-panel').scrolled, true);
  assert.equal(app.calls.filter(([name]) => name === 'check_update').length, 0);
});

test('checking can coexist with service work but installation cannot', async () => {
  const checking = deferred();
  const app = await mount(true, base({ busy: true }), { initialUpdate: update({ phase: 'available', version: '0.2.0' }), invoke(name, _args, { fallback }) { return name === 'check_update' ? checking.promise : fallback(); } });
  assert.equal(app.node('install-update').disabled, true);
  assert.equal(app.node('check-update').disabled, false);
  await app.click('check-update');
  app.event(base());
  app.update(update({ phase: 'checking', busy: true }));
  assert.equal(app.node('open').disabled, false);
  assert.equal(app.node('stop').disabled, false);
  assert.equal(app.node('quit').disabled, false);
  assert.equal(app.node('check-update').disabled, true);
  await app.click('check-update');
  assert.equal(app.calls.filter(([name]) => name === 'check_update').length, 1);
  checking.resolve(update({ phase: 'up_to_date' })); await flush();
  app.update(update({ phase: 'up_to_date', message: '已经是最新版本' }));
  assert.equal(app.node('update-message').textContent, '已经是最新版本');
  assert.equal(app.node('check-update').disabled, false);
});

test('download and installation lock service and quit controls with known or unknown progress', async () => {
  const installation = deferred();
  const app = await mount(true, base(), { initialUpdate: update({ phase: 'available', version: '0.2.0' }), invoke(name, _args, { fallback }) { return name === 'install_update' ? installation.promise : fallback(); } });
  await app.click('install-update'); await app.click('install-update');
  assert.equal(app.calls.filter(([name]) => name === 'install_update').length, 1);
  for (const id of ['open', 'start', 'stop', 'restart', 'quit', 'exit']) assert.equal(app.node(id).disabled, true);
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
  assert.equal(app.node('open').disabled, true);
  assert.equal(app.node('quit').disabled, true);
  assert.equal(app.node('update-progress').value, undefined);
  assert.equal(app.node('update-progress-label').textContent, '正在安装…');
  app.update(update({ phase: 'error', version: '0.2.0', message: '安装失败，请重试' }));
  assert.equal(app.node('open').disabled, false);
  assert.equal(app.node('quit').disabled, false);
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
  assert.equal(app.node('open').disabled, false);
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

test('snapshot and startup check failures leave manual retry available', async () => {
  let checks = 0;
  const app = await mount(true, base(), { invoke(name, _args, { fallback }) {
    if (name === 'get_update_snapshot') throw new Error('read failed');
    if (name === 'check_update' && checks++ === 0) throw new Error('offline');
    return fallback();
  } });
  assert.equal(app.node('check-update').disabled, false);
  assert.match(app.node('update-message').textContent, /offline/);
  await app.click('check-update');
  assert.equal(checks, 2);
  assert.equal(app.node('update-message').dataset.error, 'false');
});

test('quit remains distinct from stop-and-exit and tray log requests expand the log panel', async () => {
  const app = await mount(true); await app.click('quit'); assert.equal(app.calls.at(-1)[1].action, 'quit');
  app.subscriptions.get('launcher-show-logs')?.({}); assert.equal(app.node('logs-panel').open, true); assert.equal(app.node('log-output').focused, true);
});
