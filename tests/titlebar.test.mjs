import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const html = readFileSync(new URL('../titlebar.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/titlebar.css', import.meta.url), 'utf8');
const rawSource = readFileSync(new URL('../src/titlebar.ts', import.meta.url), 'utf8');
const source = stripTypeScriptTypes(rawSource.replace(/^import .*;\r?\n/gm, ''));
const flush = () => new Promise(resolve => setImmediate(resolve));
const state = (extra = {}) => ({ maximized: false, focused: true, title: 'DeepSeek Harness', ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const menuIds = ['menu-file', 'menu-settings', 'menu-help'];
const controlIds = ['window-minimize', 'window-maximize', 'window-close'];

async function mount(native, options = {}) {
  const nodes = new Map();
  const calls = []; const subscriptions = new Map(); const listenCalls = []; const unlistened = [];
  const windowHandlers = new Map(); const documentHandlers = new Map();
  const document = {
    activeElement: null,
    getElementById: id => nodes.get(id),
    addEventListener: (name, callback) => documentHandlers.set(name, callback),
  };
  // Parse the real entry's element tree so bubbling checks catch accidentally nested controls.
  const stack = [];
  for (const match of html.matchAll(/<([^>]+)>/g)) {
    const tag = match[1];
    if (tag.startsWith('!')) continue;
    if (tag.startsWith('/')) { stack.pop(); continue; }
    const attributes = Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(item => [item[1], item[2]]));
    const element = {
      id: attributes.id, attributes, parent: stack.at(-1), handlers: new Map(), disabled: false, textContent: '',
      set innerHTML(_) { throw new Error('Native state must never be interpreted as HTML'); },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, callback) { this.handlers.set(name, callback); },
      getBoundingClientRect() { return { left: options.positions?.[this.id] ?? ({ 'menu-file': 36, 'menu-settings': 82, 'menu-help': 128 }[this.id] || 0) }; },
      focus() { document.activeElement = this; },
      blur() { if (document.activeElement === this) document.activeElement = null; },
    };
    if (element.id) nodes.set(element.id, element);
    if (!/^(?:meta|link|input|br|img)\b/.test(tag) && !tag.endsWith('/')) stack.push(element);
  }
  const context = vm.createContext({
    console, document,
    window: { addEventListener: (name, callback) => windowHandlers.set(name, callback) },
    isTauri: () => native,
    listen: async (name, callback) => {
      listenCalls.push(name);
      if (options.listen) await options.listen(name, callback);
      subscriptions.set(name, callback);
      return () => { unlistened.push(name); subscriptions.delete(name); };
    },
    invoke: async (name, args) => {
      calls.push([name, JSON.parse(JSON.stringify(args))]);
      const fallback = () => {
        if (name === 'titlebar_action') return state();
        if (name === 'show_titlebar_menu') return undefined;
        throw new Error('Unexpected command: ' + name);
      };
      return options.invoke ? options.invoke(name, args, { fallback, subscriptions }) : fallback();
    },
  });
  vm.runInContext(source, context);
  await flush();
  const node = id => { assert.ok(nodes.has(id), 'Missing real HTML node: ' + id); return nodes.get(id); };
  const dispatch = (id, type, extra = {}) => {
    const target = node(id);
    const event = { target, button: 0, detail: 1, prevented: false, preventDefault() { this.prevented = true; }, ...extra };
    for (let current = target; current; current = current.parent) current.handlers.get(type)?.(event);
    return event;
  };
  return {
    node, calls, subscriptions, listenCalls, unlistened, dispatch,
    async click(id, extra) { dispatch(id, 'click', extra); await flush(); },
    key(key, extra = {}) { const event = { key, altKey: false, ctrlKey: false, metaKey: false, repeat: false, prevented: false, preventDefault() { this.prevented = true; }, ...extra }; documentHandlers.get('keydown')?.(event); return event; },
    event(snapshot) { subscriptions.get('titlebar-state')?.({ payload: snapshot }); },
    unload(type = 'beforeunload') { windowHandlers.get(type)?.(); },
    active: () => document.activeElement,
  };
}

test('browser preview disables controls and never invokes or subscribes, even for synthetic events', async () => {
  const app = await mount(false);
  for (const id of [...menuIds, ...controlIds]) { assert.equal(app.node(id).disabled, true); await app.click(id); }
  app.dispatch('drag-area', 'mousedown'); app.dispatch('window-title', 'mousedown', { detail: 2 }); app.dispatch('window-title', 'dblclick');
  for (const key of ['f', 'S', 'h']) app.key(key, { altKey: true });
  await flush(); app.unload();
  assert.deepEqual(app.calls, []); assert.deepEqual(app.listenCalls, []);
  assert.match(app.node('window-title').textContent, /浏览器预览/);
  assert.equal(app.node('titlebar').attributes['data-native'], 'false');
  assert.match(app.node('titlebar-status').textContent, /桌面应用/);
});

test('all three menus route to native popup using their live CSS left coordinate only', async () => {
  const app = await mount(true, { positions: { 'menu-file': 37.5, 'menu-settings': 84, 'menu-help': 131.25 } });
  for (const id of menuIds) await app.click(id);
  assert.deepEqual(app.calls.filter(([name]) => name === 'show_titlebar_menu'), [
    ['show_titlebar_menu', { menu: 'file', x: 37.5 }],
    ['show_titlebar_menu', { menu: 'settings', x: 84 }],
    ['show_titlebar_menu', { menu: 'help', x: 131.25 }],
  ]);
});

test('subscribes before initial state, then safely updates title, focus, restore icon and accessible label', async () => {
  const app = await mount(true, { invoke(_name, args, { subscriptions }) {
    assert.ok(subscriptions.has('titlebar-state'));
    assert.equal(args.action, 'state');
    return state();
  } });
  assert.deepEqual(app.listenCalls, ['titlebar-state']);
  app.event(state({ maximized: true, focused: false, title: '<img src=x onerror=bad>' }));
  assert.equal(app.node('window-title').textContent, '<img src=x onerror=bad>');
  assert.equal(app.node('window-title').attributes.title, '<img src=x onerror=bad>');
  assert.equal(app.node('titlebar').attributes['data-focused'], 'false');
  assert.equal(app.node('window-maximize').attributes['data-maximized'], 'true');
  assert.equal(app.node('window-maximize').attributes['aria-label'], '还原');
  app.event(state());
  assert.equal(app.node('window-maximize').attributes['data-maximized'], 'false');
  assert.equal(app.node('window-maximize').attributes['aria-label'], '最大化');
});

test('all window buttons invoke their exact actions; closing hides the window rather than quitting', async () => {
  const app = await mount(true);
  for (const id of controlIds) await app.click(id);
  assert.deepEqual(app.calls, ['state', 'minimize', 'maximize', 'close'].map(action => ['titlebar_action', { action }]));
  assert.match(app.node('window-close').attributes['aria-label'], /隐藏/);
});

test('drag lives only in flexible blank/title region and double click never starts a second drag', async () => {
  const app = await mount(true);
  assert.equal(app.dispatch('drag-area', 'mousedown').prevented, true); await flush();
  app.dispatch('window-title', 'mousedown'); await flush();
  assert.equal(app.dispatch('drag-area', 'mousedown', { detail: 2 }).prevented, true); await flush();
  app.dispatch('drag-area', 'mousedown', { button: 2 });
  app.dispatch('drag-area', 'mousedown', { button: 2, detail: 2 });
  app.dispatch('drag-area', 'mousedown', { detail: 3 });
  // A subsequent DOM dblclick must not toggle maximize a second time, even after IPC resolves.
  app.dispatch('window-title', 'dblclick'); await flush();
  for (const id of [...menuIds, ...controlIds]) {
    app.dispatch(id, 'mousedown'); app.dispatch(id, 'mousedown', { detail: 2 }); app.dispatch(id, 'dblclick');
  }
  app.dispatch('drag-area', 'dblclick', { button: 2 }); await flush();
  assert.deepEqual(app.calls, ['state', 'drag', 'drag', 'maximize'].map(action => ['titlebar_action', { action }]));
});

test('pending menu blocks repeated clicks and shortcuts, failure stays static and permits retry', async () => {
  const pending = deferred(); let attempt = 0;
  const app = await mount(true, { invoke(name, _args, { fallback }) {
    if (name !== 'show_titlebar_menu') return fallback();
    return ++attempt === 1 ? pending.promise : undefined;
  } });
  app.dispatch('menu-file', 'click');
  for (const id of menuIds) { assert.equal(app.node(id).disabled, true); app.dispatch(id, 'click'); }
  app.key('h', { altKey: true });
  assert.equal(attempt, 1);
  pending.reject(new Error('secret native diagnostics <script>bad</script>')); await flush();
  assert.equal(app.node('titlebar-status').textContent, '菜单打开失败，请重试。');
  assert.equal(app.node('drag-area').attributes.title, '菜单打开失败，请重试。');
  for (const id of menuIds) assert.equal(app.node(id).disabled, false);
  await app.click('menu-file'); assert.equal(attempt, 2);
  assert.equal(app.node('titlebar-status').textContent, '');
  await app.click('menu-file', { detail: 2 }); assert.equal(attempt, 2);
});

test('pending window action prevents duplicate invocation and errors allow retry', async () => {
  const pending = deferred(); let attempt = 0;
  const app = await mount(true, { invoke(name, args, { fallback }) {
    if (name === 'titlebar_action' && args.action === 'maximize') return ++attempt === 1 ? pending.promise : state({ maximized: true });
    return fallback();
  } });
  app.dispatch('window-maximize', 'click'); app.dispatch('window-maximize', 'click');
  app.dispatch('drag-area', 'mousedown', { detail: 2 }); assert.equal(attempt, 1);
  pending.reject(new Error('do not expose this')); await flush();
  assert.equal(app.node('titlebar-status').textContent, '窗口操作失败，请重试。');
  await app.click('window-maximize'); assert.equal(attempt, 2);
  assert.equal(app.node('window-maximize').attributes['aria-label'], '还原');
});

test('Alt+F/S/H opens menus, native button keyboard clicks work, Escape blurs focus', async () => {
  const app = await mount(true);
  for (const key of ['f', 'S', 'h']) { assert.equal(app.key(key, { altKey: true }).prevented, true); await flush(); }
  assert.deepEqual(app.calls.filter(([name]) => name === 'show_titlebar_menu').map(([, args]) => args.menu), ['file', 'settings', 'help']);
  const count = app.calls.length;
  for (const modifiers of [{}, { altKey: true, repeat: true }, { altKey: true, ctrlKey: true }, { altKey: true, metaKey: true }]) app.key('f', modifiers);
  assert.equal(app.calls.length, count);
  await app.click('menu-file', { detail: 0 });
  assert.equal(app.calls.at(-1)[1].menu, 'file');
  app.node('menu-help').focus(); app.key('Escape'); assert.equal(app.active(), null);
});

test('unload cleans subscription once and no subsequent actions or events update the view', async () => {
  const app = await mount(true);
  const callback = app.subscriptions.get('titlebar-state');
  const title = app.node('window-title').textContent;
  app.unload(); app.unload('pagehide');
  assert.deepEqual(app.unlistened, ['titlebar-state']);
  assert.equal(app.subscriptions.size, 0);
  const count = app.calls.length;
  for (const id of [...menuIds, ...controlIds]) await app.click(id);
  app.dispatch('drag-area', 'mousedown'); app.key('f', { altKey: true });
  callback({ payload: state({ title: 'late title' }) });
  assert.equal(app.calls.length, count); assert.equal(app.node('window-title').textContent, title);
});

test('late listener registration after unload is immediately cleaned without querying state', async () => {
  const pending = deferred();
  const app = await mount(true, { listen: () => pending.promise });
  app.unload(); pending.resolve(); await flush();
  assert.deepEqual(app.unlistened, ['titlebar-state']);
  assert.equal(app.subscriptions.size, 0); assert.deepEqual(app.calls, []);
});

test('late state response cannot overwrite a newer event and pending completions do not touch unloaded UI', async () => {
  const pending = deferred();
  const app = await mount(true, { invoke: () => pending.promise });
  app.event(state({ title: 'newer event', maximized: true }));
  pending.resolve(state({ title: 'stale snapshot' })); await flush();
  assert.equal(app.node('window-title').textContent, 'newer event');
  assert.equal(app.node('window-maximize').attributes['aria-label'], '还原');
  const late = deferred();
  const second = await mount(true, { invoke(name, _args, { fallback }) { return name === 'show_titlebar_menu' ? late.promise : fallback(); } });
  second.dispatch('menu-file', 'click'); second.unload();
  late.reject(new Error('late error')); await flush();
  assert.equal(second.node('titlebar-status').textContent, '');
});

test('subscription and initial state failures do not produce unhandled errors or expose diagnostics', async () => {
  const app = await mount(true, { listen: async () => { throw new Error('private'); } });
  assert.equal(app.node('titlebar-status').textContent, '窗口状态订阅失败，请重新打开窗口。');
  await app.click('window-minimize');
  assert.equal(app.node('titlebar-status').textContent, '');
  const broken = await mount(true, { invoke() { throw new Error('private'); } });
  assert.equal(broken.node('titlebar-status').textContent, '窗口操作失败，请重试。');
  broken.unload(); assert.deepEqual(broken.unlistened, ['titlebar-state']);
});

test('titlebar uses a compact icon and keeps native geometry aligned with CSS height', () => {
  const nativeSource = readFileSync(new URL('../src-tauri/src/desktop_titlebar.rs', import.meta.url), 'utf8');
  const height = Number(css.match(/--titlebar-height: (\d+)px/)[1]);
  assert.equal(height, 32);
  assert.equal(Number(nativeSource.match(/const HEIGHT: f64 = ([\d.]+);/)[1]), height);
  assert.match(css, /\.app-icon img\s*\{[^}]*width: 16px;[^}]*height: 16px/);
  assert.match(html, /<img src="\/app-icon\.png" width="16" height="16" alt="" \/>/);
  assert.match(css, /button\s*\{[^}]*height: calc\(var\(--titlebar-height\) - 1px\)/);
  assert.match(nativeSource, /LogicalPosition::new\(x, HEIGHT\)/);
  assert.match(nativeSource, /LogicalSize::new\(width, HEIGHT\)/);
  assert.match(nativeSource, /let top = \(HEIGHT \* window\.scale_factor\(\)\?\)\.round\(\) as u32/);
});

test('entry remains local, single-line 32px, with fixed 46px controls and ample 600px drag space', () => {
  assert.match(css, /--titlebar-height: 32px/);
  assert.match(css, /html, body[^}]*height: var\(--titlebar-height\)[^}]*overflow: hidden/);
  assert.match(css, /\.window-control\s*\{[^}]*width: 46px;[^}]*flex: 0 0 46px/);
  assert.match(css, /\.drag-area\s*\{[^}]*flex: 1 1 0;[^}]*min-width: 80px/);
  assert.ok(600 - 36 - 3 * 46 - 3 * 46 >= 200);
  assert.match(css, /\.window-title\s*\{[^}]*min-width: 0;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis/);
  assert.doesNotMatch(css, /\.window-title\s*\{[^}]*display: none/);
  assert.equal((html.match(/<button /g) || []).length, 6);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /https?:\/\/|<iframe|<dialog/);
  assert.doesNotMatch(rawSource, /innerHTML|@tauri-apps\/api\/(?:window|webview)/);
  assert.deepEqual(rawSource.match(/^import .*/gm), [
    "import { invoke, isTauri } from '@tauri-apps/api/core';",
    "import { listen } from '@tauri-apps/api/event';",
    "import './titlebar.css';",
  ]);
});
