import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const source = stripTypeScriptTypes(readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, ''));
const flush = () => new Promise(resolve => setImmediate(resolve));
const base = (extra = {}) => ({ state: 'ready', phase: '已就绪', message: '正常', busy: false, managed: true, origin: 'http://127.0.0.1:3080', last_error: null, logs: [], ...extra });
async function mount(native, initial = base()) {
  const nodes = new Map(); const subscriptions = new Map(); const calls = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, textContent: '', dataset: {}, hidden: false, disabled: false, open: false, scrollTop: 0, scrollHeight: 0, clientHeight: 0, handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; }, focus() { this.focused = true; } });
    return nodes.get(id);
  };
  const root = { set innerHTML(template) { for (const match of template.matchAll(/id="([^"]+)"/g)) node(match[1]); } };
  const context = vm.createContext({
    URL, console, document: { querySelector: () => root, getElementById: id => nodes.get(id) }, window: { addEventListener() {} },
    isTauri: () => native,
    listen: async (name, callback) => { subscriptions.set(name, callback); return () => subscriptions.delete(name); },
    invoke: async (name, args) => { calls.push([name, args]); return initial; },
  });
  vm.runInContext(source, context); await flush();
  return { node, calls, subscriptions, event(snapshot) { subscriptions.get('launcher-state')?.({ payload: snapshot }); }, async click(id) { node(id).handlers.click?.(); await flush(); } };
}

test('browser preview cannot invoke native commands or subscribe to events', async () => {
  const app = await mount(false); assert.equal(app.calls.length, 0); assert.equal(app.subscriptions.size, 0);
  for (const id of ['open', 'start', 'stop', 'restart', 'quit', 'exit', 'logs']) { assert.equal(app.node(id).disabled, true); await app.click(id); }
  assert.equal(app.calls.length, 0); assert.equal(app.node('preview-note').hidden, false);
});
test('stopped service can be started with the primary open button', async () => {
  const app = await mount(true, base({ state: 'stopped', managed: false })); assert.equal(app.node('open').disabled, false);
  await app.click('open'); assert.equal(app.calls.at(-1)[0], 'perform_action'); assert.equal(app.calls.at(-1)[1].action, 'open');
});
test('external services disable stop and restart', async () => {
  const app = await mount(true, base({ managed: false })); assert.equal(app.node('stop').disabled, true); assert.equal(app.node('restart').disabled, true);
  await app.click('stop'); await app.click('restart'); assert.equal(app.calls.length, 1);
});
test('busy snapshots disable all actions and prevent duplicate invocation', async () => {
  const app = await mount(true); app.event(base({ busy: true }));
  for (const id of ['open', 'start', 'stop', 'restart', 'quit', 'exit', 'logs']) { assert.equal(app.node(id).disabled, true); await app.click(id); }
  assert.equal(app.calls.length, 1);
});
test('native data stays text-only and credentials do not reach displayed diagnostics', async () => {
  const secret = 'test-secret-value'; const app = await mount(true, base({ phase: '<img onerror=bad>', message: 'token=' + secret,
    origin: 'http://user:password@127.0.0.1:3080/?token=' + secret,
    logs: ['Bearer ' + secret, '<script>bad</script> token=' + secret] }));
  assert.equal(app.node('phase').textContent, '<img onerror=bad>');
  for (const id of ['status-message', 'origin', 'log-output']) assert.ok(!app.node(id).textContent.includes(secret));
  assert.equal(app.node('origin').textContent, 'http://127.0.0.1:3080');
});
test('quit remains distinct from stop-and-exit and tray log requests expand the log panel', async () => {
  const app = await mount(true); await app.click('quit'); assert.equal(app.calls.at(-1)[1].action, 'quit');
  app.subscriptions.get('launcher-show-logs')?.({}); assert.equal(app.node('logs-panel').open, true); assert.equal(app.node('log-output').focused, true);
});
