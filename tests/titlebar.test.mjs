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
const menuIds = ['app-menu'];
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
      id: attributes.id, attributes, parent: stack.at(-1), children: [], handlers: new Map(), disabled: false, textContent: '',
      set innerHTML(_) { throw new Error('Native state must never be interpreted as HTML'); },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, callback) { this.handlers.set(name, callback); },
      getBoundingClientRect() { return { left: options.positions?.[this.id] ?? (this.id === 'app-menu' ? 8 : 0) }; },
      focus() { document.activeElement = this; },
      blur() { if (document.activeElement === this) document.activeElement = null; },
    };
    element.parent?.children.push(element);
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
    const target = typeof id === 'string' ? node(id) : id;
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

test('titlebar has one accessible application-menu icon button and no legacy menu buttons', async () => {
  const app = await mount(true);
  const attributes = app.node('app-menu').attributes;
  for (const [name, value] of Object.entries({ class: 'app-icon', type: 'button', 'aria-label': '应用菜单', 'aria-haspopup': 'menu', 'aria-keyshortcuts': 'Alt+M', title: '应用菜单 (Alt+M)' })) assert.equal(attributes[name], value, name);
  assert.notEqual(attributes['aria-hidden'], 'true');
  const button = html.match(/<button\b[^>]*\bid="app-menu"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(button, 'the icon must itself be the menu button');
  assert.match(button[1], /<img src="\/app-icon\.png" width="16" height="16" alt="" \/>/);
  assert.equal((html.match(/id="app-menu"/g) || []).length, 1);
  assert.doesNotMatch(html, /id="menu-(?:file|settings|help)"|aria-keyshortcuts="Alt\+[FSH]"/);
  assert.doesNotMatch(rawSource, /menu-(?:file|settings|help)/);
});

test('browser preview disables controls and never invokes or subscribes, even for synthetic events', async () => {
  const app = await mount(false);
  for (const id of [...menuIds, ...controlIds]) { assert.equal(app.node(id).disabled, true); await app.click(id); }
  app.dispatch('drag-area', 'mousedown'); app.dispatch('window-title', 'mousedown', { detail: 2 }); app.dispatch('window-title', 'dblclick');
  for (const key of ['m', 'M', 'f', 'S', 'h']) app.key(key, { altKey: true });
  await flush(); app.unload();
  assert.deepEqual(app.calls, []); assert.deepEqual(app.listenCalls, []);
  assert.match(app.node('window-title').textContent, /浏览器预览/);
  assert.equal(app.node('titlebar').attributes['data-native'], 'false');
  assert.match(app.node('titlebar-status').textContent, /桌面应用/);
});

test('application icon routes to native popup using only its live CSS left coordinate', async () => {
  const positions = { 'app-menu': 7.5 };
  const app = await mount(true, { positions });
  await app.click('app-menu');
  positions['app-menu'] = 19.25;
  await app.click('app-menu');
  assert.deepEqual(app.calls.filter(([name]) => name === 'show_titlebar_menu'), [
    ['show_titlebar_menu', { x: 7.5 }],
    ['show_titlebar_menu', { x: 19.25 }],
  ]);
});

test('clicking the wrapped icon bubbles to the menu and never starts window dragging', async () => {
  const app = await mount(true);
  const icon = app.node('app-menu').children.find(child => child.attributes.src === '/app-icon.png');
  assert.ok(icon);
  app.dispatch(icon, 'mousedown');
  app.dispatch(icon, 'mousedown', { detail: 2 });
  app.dispatch(icon, 'dblclick');
  await flush();
  assert.deepEqual(app.calls, [['titlebar_action', { action: 'state' }]]);
  app.dispatch(icon, 'click'); await flush();
  assert.deepEqual(app.calls.at(-1), ['show_titlebar_menu', { x: 8 }]);
  assert.equal(app.calls.length, 2);
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
  app.dispatch('app-menu', 'click');
  for (const id of menuIds) { assert.equal(app.node(id).disabled, true); app.dispatch(id, 'click'); }
  app.key('M', { altKey: true });
  assert.equal(attempt, 1);
  pending.reject(new Error('secret native diagnostics <script>bad</script>')); await flush();
  assert.equal(app.node('titlebar-status').textContent, '菜单打开失败，请重试。');
  assert.equal(app.node('drag-area').attributes.title, '菜单打开失败，请重试。');
  for (const id of menuIds) assert.equal(app.node(id).disabled, false);
  await app.click('app-menu'); assert.equal(attempt, 2);
  assert.equal(app.node('titlebar-status').textContent, '');
  await app.click('app-menu', { detail: 2 }); assert.equal(attempt, 2);
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

test('only case-insensitive Alt+M opens the menu, native keyboard clicks work, Escape blurs focus', async () => {
  const app = await mount(true);
  for (const key of ['m', 'M']) { assert.equal(app.key(key, { altKey: true }).prevented, true); await flush(); }
  assert.deepEqual(app.calls.filter(([name]) => name === 'show_titlebar_menu'), [
    ['show_titlebar_menu', { x: 8 }], ['show_titlebar_menu', { x: 8 }],
  ]);
  const count = app.calls.length;
  for (const key of ['f', 'F', 's', 'S', 'h', 'H']) assert.equal(app.key(key, { altKey: true }).prevented, false);
  for (const modifiers of [{}, { altKey: true, repeat: true }, { altKey: true, ctrlKey: true }, { altKey: true, metaKey: true }]) assert.equal(app.key('m', modifiers).prevented, false);
  assert.equal(app.calls.length, count);
  await app.click('app-menu', { detail: 0 });
  assert.deepEqual(app.calls.at(-1), ['show_titlebar_menu', { x: 8 }]);
  app.node('app-menu').focus(); app.key('Escape'); assert.equal(app.active(), null);
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
  app.dispatch('drag-area', 'mousedown'); app.key('m', { altKey: true });
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
  second.dispatch('app-menu', 'click'); second.unload();
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

test('all configuration sections and controls remain in the existing settings window', () => {
  const frontend = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(frontend, /const settingsSections = \['environment', 'notifications', 'updates', 'logs'\] as const/);
  assert.doesNotMatch(frontend, /[“「]文件[”」]菜单/);
  assert.match(frontend, /托盘右键菜单/);
  const settingsTemplate = frontend.slice(frontend.indexOf('app.innerHTML = settingsView ?'), frontend.indexOf('<main class="startup"'));
  for (const [section, controls] of Object.entries({
    environment: ['repository-input', 'save-repository', 'config-location', 'check'],
    notifications: ['notifications-enabled', 'test-notification'],
    updates: ['check-update', 'install-update'],
    logs: ['logs', 'log-output'],
  })) {
    const markup = settingsTemplate.match(new RegExp('<section id="settings-' + section + '"[^>]*>([\\s\\S]*?)</section>'));
    assert.ok(markup, section + ' stays in the settings window');
    for (const id of controls) {
      assert.ok(markup[1].includes('id="' + id + '"'), id + ' stays in ' + section);
      assert.ok(!html.includes('id="' + id + '"'), id + ' is not a titlebar control');
    }
  }
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
  assert.ok(600 - 36 - 3 * 46 >= 400);
  assert.match(css, /\.window-title\s*\{[^}]*min-width: 0;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis/);
  assert.doesNotMatch(css, /\.window-title\s*\{[^}]*display: none/);
  assert.equal((html.match(/<button /g) || []).length, 4);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /https?:\/\/|<iframe|<dialog/);
  assert.doesNotMatch(rawSource, /innerHTML|@tauri-apps\/api\/(?:window|webview)/);
  assert.deepEqual(rawSource.match(/^import .*/gm), [
    "import { invoke, isTauri } from '@tauri-apps/api/core';",
    "import { listen } from '@tauri-apps/api/event';",
    "import './titlebar.css';",
  ]);
});
