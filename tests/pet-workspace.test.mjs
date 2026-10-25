import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const source = read('src/pet-workspace.ts');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { PetWorkspace, isWorkspaceSnapshot } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const state = (extra = {}) => ({ status: 'ready', distribution: 'Ubuntu', path: '/home/test/工作 space', message: '工作目录（只读）', ...extra });
class Node extends EventTarget {
  constructor() { super(); this.value = ''; this.textContent = ''; this.disabled = false; this.dataset = {}; this.attributes = {}; }
  setAttribute(key, value) { this.attributes[key] = value; }
}
function fixture({ native = true, invoke = () => state() } = {}) {
  const root = new Node(), nodes = new Map(), calls = [];
  let markup = '';
  Object.defineProperty(root, 'innerHTML', { set(html) { markup = html; for (const m of html.matchAll(/id="(pet-workspace-[^"]+)"/g)) nodes.set(m[1], new Node()); } });
  root.querySelector = selector => nodes.get(selector.slice(1));
  const workspace = new PetWorkspace(root, native, { async invoke(...args) { calls.push(args); return invoke(...args); } });
  return { workspace, root, calls, get markup() { return markup; }, node: id => nodes.get('pet-workspace-' + id), click(id) { nodes.get('pet-workspace-' + id).dispatchEvent(new Event('click')); }, show() { workspace.setVisible(true); }, hide() { workspace.setVisible(false); } };
}
test('readonly path, accurate history copy, preview and hidden controls have no side effects', async () => {
  for (const native of [false, true]) {
    const f = fixture({ native });
    assert.match(f.markup, /id="pet-workspace-path"[^>]+readonly aria-readonly="true"/);
    assert.match(f.markup, /真实对话历史仍由 DSH 保存/);
    assert.doesNotMatch(source, /pick_settings_path|assistant_action|set_pet_workspace|session_create|localStorage/);
    f.click('open'); f.click('refresh'); await tick(); assert.equal(f.calls.length, 0);
    if (!native) { f.show(); f.click('open'); f.click('refresh'); await tick(); assert.equal(f.calls.length, 0); assert.match(f.node('message').textContent, /浏览器预览/); }
    f.workspace.dispose();
  }
});
test('loading is fail closed; refresh, retained re-entry and reopen use current binding without arguments', async () => {
  let path = '/home/test/first'; const f = fixture({ invoke: () => state({ path }) });
  f.show(); assert.equal(f.node('open').disabled, true); await tick();
  assert.equal(f.node('path').value, path); assert.equal(f.node('open').disabled, false);
  path = '/home/test/second'; f.click('refresh'); assert.equal(f.node('path').value, ''); await tick(); assert.equal(f.node('path').value, path);
  path = '/home/test/third'; f.show(); await tick(); assert.equal(f.node('path').value, path);
  path = '/home/test/fourth'; f.hide(); f.show(); await tick(); assert.equal(f.node('path').value, path);
  f.node('path').value = 'C:/forged'; f.click('open'); await tick();
  assert.deepEqual(f.calls.at(-1), ['open_pet_workspace']); assert.equal(f.node('path').value, path);
  assert.ok(f.calls.every(args => args.length === 1)); assert.match(f.node('message').textContent, /已请求/); f.workspace.dispose();
});
test('unbound, invalid, missing, inaccessible and changed backend cannot open', async () => {
  for (const status of ['unbound', 'invalid', 'missing', 'unavailable', 'backend_changed']) {
    const f = fixture({ invoke: () => state({ status, ...(['unbound', 'invalid'].includes(status) ? { path: null, distribution: null } : {}) }) });
    f.show(); await tick(); assert.equal(f.node('open').disabled, true); f.click('open'); await tick();
    assert.deepEqual(f.calls, [['get_pet_workspace']]); assert.equal(f.node('refresh').disabled, false); f.workspace.dispose();
  }
});
test('malformed replies fail closed and can be refreshed safely', async () => {
  for (const invalid of [null, {}, state({ status: 'unknown' }), state({ path: null }), state({ path: 'C:/host' }), state({ path: '//server/share' }), state({ path: '/bad\npath' }), state({ distribution: null }), state({ status: 'unbound' }), state({ message: 'x'.repeat(1001) })]) {
    assert.equal(isWorkspaceSnapshot(invalid), false);
    let reply = invalid; const f = fixture({ invoke: () => reply }); f.show(); await tick();
    assert.equal(f.node('open').disabled, true); assert.match(f.node('message').textContent, /无法读取/);
    reply = state(); f.click('refresh'); await tick(); assert.equal(f.node('open').disabled, false); f.workspace.dispose();
  }
});
test('failed read or open clears stale state and requires explicit refresh', async () => {
  let fail = true; const f = fixture({ invoke: command => { if (fail) throw 'WSL 不可用'; return state(); } });
  f.show(); await tick(); assert.match(f.node('message').textContent, /无法读取.*WSL 不可用/); assert.equal(f.node('open').disabled, true);
  fail = false; f.click('refresh'); await tick(); fail = true; f.click('open'); await tick();
  assert.match(f.node('message').textContent, /打开目录未完成/); assert.equal(f.node('path').value, ''); assert.equal(f.node('open').disabled, true);
  const count = f.calls.length; f.click('open'); await tick(); assert.equal(f.calls.length, count);
  fail = false; f.click('refresh'); await tick(); assert.equal(f.node('open').disabled, false); f.workspace.dispose();
});
test('pending actions deduplicate and late replies cannot overwrite re-entry or disposal', async () => {
  const old = deferred(); let n = 0; const f = fixture({ invoke: () => ++n === 1 ? old.promise : state({ path: '/new' }) });
  f.show(); f.click('refresh'); f.click('open'); assert.equal(f.calls.length, 1);
  f.hide(); f.show(); await tick(); old.resolve(state({ path: '/old' })); await tick(); assert.equal(f.node('path').value, '/new');
  const open = deferred(); const g = fixture({ invoke: command => command === 'open_pet_workspace' ? open.promise : state() });
  g.show(); await tick(); g.click('open'); g.click('open'); assert.equal(g.calls.length, 2);
  g.workspace.dispose(); const before = g.node('message').textContent; open.resolve(state({ path: '/late' })); await tick(); assert.equal(g.node('message').textContent, before); assert.equal(g.node('open').disabled, true); f.workspace.dispose();
});
test('late failures and nonready open responses never claim success or revive old state', async () => {
  const old = deferred(); let n = 0; const f = fixture({ invoke: () => ++n === 1 ? old.promise : state({ path: '/new' }) });
  f.show(); f.hide(); f.show(); await tick(); old.reject('stale failure'); await tick();
  assert.equal(f.node('path').value, '/new'); assert.doesNotMatch(f.node('message').textContent, /stale/);
  const g = fixture({ invoke: command => state(command === 'open_pet_workspace' ? { status: 'missing', message: '目录不存在' } : {}) });
  g.show(); await tick(); g.click('open'); await tick(); assert.equal(g.node('message').textContent, '目录不存在'); assert.equal(g.node('open').disabled, true);
  f.workspace.dispose(); g.workspace.dispose();
});
test('native values render only as plain text or input value', async () => {
  const f = fixture({ invoke: () => state({ path: '/home/<img src=x>', distribution: '<b>Ubuntu</b>', message: '<script>alert(1)</script>' }) });
  f.show(); await tick(); assert.equal(f.node('path').value, '/home/<img src=x>'); assert.equal(f.node('distribution').textContent, '<b>Ubuntu</b>'); assert.equal(f.node('message').textContent, '<script>alert(1)</script>'); f.workspace.dispose();
});
test('native commands have settings-only grants, guard both calls and accept no client path', () => {
  const native = read('src-tauri/src/desktop_pet_workspace.rs');
  for (const name of ['get_pet_workspace', 'open_pet_workspace']) {
    assert.ok(read('src-tauri/build.rs').includes('"' + name + '"'));
    assert.ok(read('src-tauri/src/desktop.rs').includes('pet_workspace::' + name));
    const granted = [];
    for (const file of readdirSync(new URL('../src-tauri/capabilities/', import.meta.url)).filter(f => f.endsWith('.json'))) {
      const cap = JSON.parse(read('src-tauri/capabilities/' + file));
      if (!cap.permissions.includes('allow-' + name.replaceAll('_', '-'))) continue;
      assert.equal(cap.local, true); assert.equal(cap.remote, undefined); granted.push(...cap.webviews);
    }
    assert.deepEqual(granted.sort(), ['dsh-settings', 'launcher-settings']);
    const args = native.slice(native.indexOf('async fn ' + name)).split(') ->')[0];
    assert.doesNotMatch(args, /path:|distribution:|request:|String/);
  }
  assert.equal(native.split('assert_settings(&view)?;').length - 1, 2);
  assert.match(native, /controller.backend.lock/); assert.match(native, /with_workspace_binding/); assert.match(native, /open::that_detached/);
  for (const forbidden of ['prepare_directory', 'create_dir', 'session_create', '.chat(', 'Command::new', 'assistant_action']) assert.ok(!native.includes(forbidden));
  const guard = read('src-tauri/src/desktop_pet_settings.rs'); assert.ok(guard.includes('assert_local(view)?')); assert.ok(guard.includes('"launcher-settings" | "dsh-settings"'));
});
