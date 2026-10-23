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
const settingsIds = ['titlebar-settings', 'titlebar-updates'];
const updateNotice = (available = false) => ({ available });
const windowCalls = app => app.calls.filter(([name]) => name === 'titlebar_action');
const eventNames = ['titlebar-state', 'titlebar-update-state'];
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
      id: attributes.id, attributes, parent: stack.at(-1), children: [], handlers: new Map(), disabled: false, hidden: /\bhidden(?:\s|$)/.test(tag), textContent: '',
      set innerHTML(_) { throw new Error('Native state must never be interpreted as HTML'); },
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; },
      addEventListener(name, callback) { this.handlers.set(name, callback); },
      getBoundingClientRect() { throw new Error('Direct settings navigation needs no popup geometry'); },
      focus() { document.activeElement = this; },
      blur() { if (document.activeElement === this) document.activeElement = null; },
    };
    element.dataset = new Proxy({}, { set(_target, key, value) { element.attributes['data-' + String(key).replace(/[A-Z]/g, letter => '-' + letter.toLowerCase())] = value; return true; }, get(_target, key) { return element.attributes['data-' + String(key).replace(/[A-Z]/g, letter => '-' + letter.toLowerCase())]; } });
    element.parent?.children.push(element);
    if (element.id) nodes.set(element.id, element);
    if (!/^(?:meta|link|input|br|img)\b/.test(tag) && !tag.endsWith('/')) stack.push(element);
  }
  const location = { href: options.href || 'http://127.0.0.1:1420/titlebar.html' };
  const context = vm.createContext({
    console, document,
    window: { location, addEventListener: (name, callback) => windowHandlers.set(name, callback) },
    isTauri: () => native,
    listen: async (name, callback) => {
      listenCalls.push(name);
      if (options.listen) await options.listen(name, callback);
      subscriptions.set(name, callback);
      return () => { unlistened.push(name); subscriptions.delete(name); };
    },
    invoke: async (name, args) => {
      calls.push([name, args === undefined ? undefined : JSON.parse(JSON.stringify(args))]);
      const fallback = () => {
        if (name === 'titlebar_action') return state();
        if (name === 'open_titlebar_settings' || name === 'open_titlebar_updates') return undefined;
        if (name === 'get_titlebar_update_state') return options.initialUpdateNotice || updateNotice();
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
    node, calls, subscriptions, listenCalls, unlistened, dispatch, location,
    async click(id, extra) { dispatch(id, 'click', extra); await flush(); },
    key(key, extra = {}) { const event = { key, altKey: false, ctrlKey: false, metaKey: false, repeat: false, prevented: false, preventDefault() { this.prevented = true; }, ...extra }; documentHandlers.get('keydown')?.(event); return event; },
    event(snapshot) { subscriptions.get('titlebar-state')?.({ payload: snapshot }); },
    update(notice) { subscriptions.get('titlebar-update-state')?.({ payload: notice }); },
    unload(type = 'beforeunload') { windowHandlers.get(type)?.(); },
    active: () => document.activeElement,
  };
}

test('titlebar has a decorative logo and adjacent accessible icon-only settings button without menus or shortcuts', async () => {
  const app = await mount(true);
  const logo = app.node('app-logo').attributes;
  assert.equal(logo.class, 'app-icon'); assert.equal(logo['aria-hidden'], 'true');
  assert.match(html, /<span\b[^>]*\bid="app-logo"[^>]*>[\s\S]*?<img src="\/app-icon\.png" width="16" height="16" alt="" \/>[\s\S]*?<\/span>\s*<button\b[^>]*\bid="titlebar-settings"/);
  for (const name of ['role', 'tabindex', 'aria-haspopup']) assert.equal(logo[name], undefined, name);
  for (const [name, value] of Object.entries({ class: 'settings-control', type: 'button', 'aria-label': '设置', title: '设置' })) assert.equal(app.node('titlebar-settings').attributes[name], value, name);
  const button = html.match(/<button\b[^>]*\bid="titlebar-settings"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(button); assert.match(button[1], /<svg\b/);
  assert.equal(button[1].replace(/<[^>]*>/g, '').trim(), '', 'gear has no visible text');
  assert.equal((html.match(/id="titlebar-settings"/g) || []).length, 1);
  assert.doesNotMatch(html, /app-menu|id="menu-(?:file|settings|help)"|aria-haspopup|menubar|aria-keyshortcuts/);
  assert.doesNotMatch(rawSource, /showMenu|show_titlebar_menu|menu-(?:file|settings|help)/);
});

test('browser preview enables the gear with a fixed local route while native controls and IPC stay disabled', async () => {
  const app = await mount(false, { href: 'http://127.0.0.1:1420/titlebar.html?return=https://evil.example' });
  for (const id of controlIds) { assert.equal(app.node(id).disabled, true); await app.click(id); }
  for (const id of settingsIds) assert.equal(app.node(id).disabled, false);
  app.dispatch('drag-area', 'mousedown'); app.dispatch('window-title', 'mousedown', { detail: 2 }); app.dispatch('window-title', 'dblclick');
  for (const key of ['m', 'M', 'f', 'S', 'h']) app.key(key, { altKey: true });
  await app.click('titlebar-settings');
  assert.equal(app.location.href, './index.html?view=settings&section=environment');
  assert.deepEqual(app.calls, []); assert.deepEqual(app.listenCalls, []);
  assert.equal(app.node('titlebar').attributes['data-native'], 'false');
  app.unload(); app.location.href = 'unchanged'; await app.click('titlebar-settings');
  assert.equal(app.location.href, 'unchanged', 'disposed preview must not navigate');
});

test('settings gear directly opens native settings with no arguments or popup geometry', async () => {
  const app = await mount(true);
  await app.click('titlebar-settings'); await app.click('titlebar-settings');
  assert.deepEqual(app.calls.filter(([name]) => name === 'open_titlebar_settings'), [
    ['open_titlebar_settings', undefined], ['open_titlebar_settings', undefined],
  ]);
});

test('decorative logo and its wrapped image ignore clicks and never start drag or settings navigation', async () => {
  for (const native of [true, false]) {
    const app = await mount(native);
    const logo = app.node('app-logo');
    const icon = logo.children.find(child => child.attributes.src === '/app-icon.png');
    assert.ok(icon); const count = app.calls.length; const href = app.location.href;
    for (const target of [logo, icon]) {
      for (const type of ['mousedown', 'click', 'dblclick']) {
        app.dispatch(target, type); app.dispatch(target, type, { detail: 2 });
      }
    }
    await flush(); assert.equal(app.calls.length, count); assert.equal(app.location.href, href);
  }
});

test('clicking the gear SVG opens settings without dragging the window', async () => {
  const app = await mount(true);
  const svg = app.node('titlebar-settings').children.find(child => child.attributes.viewBox);
  assert.ok(svg);
  const count = app.calls.length;
  app.dispatch(svg, 'mousedown'); app.dispatch(svg, 'dblclick'); await flush();
  assert.equal(app.calls.length, count);
  await app.click(svg);
  assert.deepEqual(app.calls.at(-1), ['open_titlebar_settings', undefined]);
});

test('subscribes before initial state, then safely updates title, focus, restore icon and accessible label', async () => {
  const app = await mount(true, { invoke(name, args, { fallback, subscriptions }) {
    if (name !== 'titlebar_action') return fallback();
    assert.ok(subscriptions.has('titlebar-state'));
    assert.equal(args.action, 'state');
    return state();
  } });
  assert.deepEqual([...app.listenCalls].sort(), eventNames);
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
  assert.deepEqual(windowCalls(app), ['state', 'minimize', 'maximize', 'close'].map(action => ['titlebar_action', { action }]));
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
  for (const id of [...settingsIds, ...controlIds]) {
    app.dispatch(id, 'mousedown'); app.dispatch(id, 'mousedown', { detail: 2 }); app.dispatch(id, 'dblclick');
  }
  app.dispatch('drag-area', 'dblclick', { button: 2 }); await flush();
  assert.deepEqual(windowCalls(app), ['state', 'drag', 'drag', 'maximize'].map(action => ['titlebar_action', { action }]));
});

test('pending settings opening blocks repeated clicks, reports static failure and permits retry', async () => {
  const pending = deferred(); let attempt = 0;
  const app = await mount(true, { invoke(name, _args, { fallback }) {
    if (name !== 'open_titlebar_settings') return fallback();
    return ++attempt === 1 ? pending.promise : undefined;
  } });
  app.dispatch('titlebar-settings', 'click');
  for (const id of settingsIds) { assert.equal(app.node(id).disabled, true); app.dispatch(id, 'click'); }
  app.key('M', { altKey: true });
  assert.equal(attempt, 1);
  pending.reject(new Error('secret native diagnostics <script>bad</script>')); await flush();
  assert.equal(app.node('titlebar-status').textContent, '设置打开失败，请重试。');
  assert.equal(app.node('drag-area').attributes.title, '设置打开失败，请重试。');
  for (const id of settingsIds) assert.equal(app.node(id).disabled, false);
  await app.click('titlebar-settings'); assert.equal(attempt, 2);
  assert.equal(app.node('titlebar-status').textContent, '');
  await app.click('titlebar-settings', { detail: 2 }); assert.equal(attempt, 2);
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

test('no Alt menu shortcuts remain and native Enter or Space button clicks open settings', async () => {
  const app = await mount(true); const count = app.calls.length;
  for (const key of ['m', 'M', 'f', 'F', 's', 'S', 'h', 'H']) {
    assert.equal(app.key(key, { altKey: true }).prevented, false);
    assert.equal(app.key(key).prevented, false);
  }
  assert.equal(app.calls.length, count);
  // Browsers synthesize click detail=0 for a focused button activated with Enter or Space.
  for (const key of ['Enter', ' ']) {
    app.node('titlebar-settings').focus(); app.key(key);
    await app.click('titlebar-settings', { detail: 0 });
    assert.deepEqual(app.calls.at(-1), ['open_titlebar_settings', undefined]);
  }
  assert.equal(app.calls.filter(([name]) => name === 'open_titlebar_settings').length, 2);
});

test('unload cleans subscription once and no subsequent actions or events update the view', async () => {
  const app = await mount(true);
  const callback = app.subscriptions.get('titlebar-state');
  const title = app.node('window-title').textContent;
  app.unload(); app.unload('pagehide');
  assert.deepEqual([...app.unlistened].sort(), eventNames);
  assert.equal(app.subscriptions.size, 0);
  const count = app.calls.length;
  for (const id of [...settingsIds, ...controlIds]) await app.click(id);
  app.dispatch('drag-area', 'mousedown'); app.key('m', { altKey: true });
  callback({ payload: state({ title: 'late title' }) });
  assert.equal(app.calls.length, count); assert.equal(app.node('window-title').textContent, title);
});

test('late listener registration after unload is immediately cleaned without querying state', async () => {
  const pending = deferred();
  const app = await mount(true, { listen: () => pending.promise });
  app.unload(); pending.resolve(); await flush();
  assert.deepEqual([...app.unlistened].sort(), eventNames);
  assert.equal(app.subscriptions.size, 0); assert.deepEqual(app.calls, []);
});

test('late state response cannot overwrite a newer event and pending completions do not touch unloaded UI', async () => {
  const pending = deferred();
  const app = await mount(true, { invoke(name, _args, { fallback }) { return name === 'titlebar_action' ? pending.promise : fallback(); } });
  app.event(state({ title: 'newer event', maximized: true }));
  pending.resolve(state({ title: 'stale snapshot' })); await flush();
  assert.equal(app.node('window-title').textContent, 'newer event');
  assert.equal(app.node('window-maximize').attributes['aria-label'], '还原');
  const late = deferred();
  const second = await mount(true, { invoke(name, _args, { fallback }) { return name === 'open_titlebar_settings' ? late.promise : fallback(); } });
  second.dispatch('titlebar-settings', 'click'); second.unload();
  late.reject(new Error('late error')); await flush();
  assert.equal(second.node('titlebar-status').textContent, '');
});

test('late successful settings opening leaves unloaded UI untouched', async () => {
  const pending = deferred();
  const app = await mount(true, { invoke(name, _args, { fallback }) { return name === 'open_titlebar_settings' ? pending.promise : fallback(); } });
  app.dispatch('titlebar-settings', 'click');
  assert.equal(app.node('titlebar-settings').disabled, true);
  app.unload(); pending.resolve(); await flush();
  assert.equal(app.node('titlebar-settings').disabled, true);
  assert.equal(app.node('titlebar-status').textContent, '');
});

test('subscription and initial state failures do not produce unhandled errors or expose diagnostics', async () => {
  const app = await mount(true, { listen: async () => { throw new Error('private'); } });
  assert.equal(app.node('titlebar-status').textContent, '窗口状态订阅失败，请重新打开窗口。');
  await app.click('window-minimize');
  assert.equal(app.node('titlebar-status').textContent, '');
  const broken = await mount(true, { invoke() { throw new Error('private'); } });
  assert.equal(broken.node('titlebar-status').textContent, '窗口操作失败，请重试。');
  broken.unload(); assert.deepEqual([...broken.unlistened].sort(), eventNames);
});

test('software update icon follows the settings gear and starts with a hidden decorative badge', async () => {
  const app = await mount(true);
  assert.match(html, /id="app-logo"[\s\S]*?id="titlebar-settings"[\s\S]*?<\/button>\s*<button\b[^>]*id="titlebar-updates"[\s\S]*?<\/button>\s*<div\b[^>]*id="drag-area"/);
  const button = app.node('titlebar-updates');
  for (const [key, value] of Object.entries({ class: 'update-control', type: 'button', 'aria-label': '软件更新', title: '软件更新' })) assert.equal(button.attributes[key], value, key);
  const markup = html.match(/<button\b[^>]*id="titlebar-updates"[^>]*>([\s\S]*?)<\/button>/)[1];
  assert.match(markup, /<svg\b/); assert.equal(markup.replace(/<[^>]*>/g, '').trim(), '');
  const dot = app.node('titlebar-update-dot');
  assert.equal(dot.attributes.class, 'update-dot'); assert.equal(dot.attributes['aria-hidden'], 'true'); assert.equal(dot.hidden, true);
  assert.equal(dot.parent, button); assert.equal((html.match(/id="titlebar-updates"/g) || []).length, 1);
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)];
  for (const selector of ['.settings-control', '.update-control']) {
    const declarations = rules.filter(([, selectors]) => selectors.split(',').map(part => part.trim()).includes(selector)).map(([, , body]) => body).join(';');
    assert.match(declarations, /width:\s*32px/); assert.match(declarations, /flex:\s*0 0 32px/);
  }
  assert.match(css, /\.update-dot\b/);
});

test('browser update icon opens only the fixed local updates page without reading or checking updates', async () => {
  const app = await mount(false, { href: 'http://127.0.0.1:1420/titlebar.html?return=https://evil.example&section=logs' });
  for (const id of settingsIds) assert.equal(app.node(id).disabled, false);
  assert.equal(app.node('titlebar-update-dot').hidden, true);
  await app.click('titlebar-updates');
  assert.equal(app.location.href, './index.html?view=settings&section=updates');
  assert.deepEqual(app.calls, []); assert.deepEqual(app.listenCalls, []);
  app.unload(); app.location.href = 'unchanged'; await app.click('titlebar-updates');
  assert.equal(app.location.href, 'unchanged');
});

test('native update icon and its SVG open only the own-window update page with no arguments', async () => {
  const app = await mount(true);
  await app.click('titlebar-updates', { detail: 0 });
  const svg = app.node('titlebar-updates').children.find(child => child.attributes.viewBox);
  assert.ok(svg); await app.click(svg);
  assert.deepEqual(app.calls.filter(([name]) => name === 'open_titlebar_updates'), [
    ['open_titlebar_updates', undefined], ['open_titlebar_updates', undefined],
  ]);
  assert.deepEqual(app.calls.filter(([name]) => name === 'get_titlebar_update_state'), [['get_titlebar_update_state', undefined]]);
  assert.equal(app.calls.some(([name]) => /^(?:check_update|install_update|perform_action|get_update_snapshot)$/.test(name)), false);
  await app.click('titlebar-updates', { detail: 2 });
  assert.equal(app.calls.filter(([name]) => name === 'open_titlebar_updates').length, 2);
});

test('settings and updates share a pending navigation guard and update failures are static and retryable', async () => {
  for (const origin of settingsIds) {
    const pending = deferred(); let attempts = 0;
    const app = await mount(true, { invoke(name, _args, { fallback }) {
      if (!['open_titlebar_settings', 'open_titlebar_updates'].includes(name)) return fallback();
      return ++attempts === 1 ? pending.promise : undefined;
    } });
    app.dispatch(origin, 'click');
    for (const id of settingsIds) { assert.equal(app.node(id).disabled, true); app.dispatch(id, 'click'); }
    assert.equal(attempts, 1);
    pending.reject(new Error('private update diagnostics <script>bad</script>')); await flush();
    const expected = origin === 'titlebar-updates' ? '更新页面打开失败，请重试。' : '设置打开失败，请重试。';
    assert.equal(app.node('titlebar-status').textContent, expected);
    for (const id of settingsIds) assert.equal(app.node(id).disabled, false);
    await app.click('titlebar-updates'); assert.equal(attempts, 2); assert.equal(app.node('titlebar-status').textContent, '');
  }
});

test('update badge subscribes before its read and reflects only projected availability, not clicks', async () => {
  const app = await mount(true, { initialUpdateNotice: updateNotice(true), invoke(name, args, { fallback, subscriptions }) {
    if (name === 'get_titlebar_update_state') { assert.ok(subscriptions.has('titlebar-update-state')); assert.equal(args, undefined); }
    return fallback();
  } });
  const dot = app.node('titlebar-update-dot'); const button = app.node('titlebar-updates');
  assert.equal(dot.hidden, false); assert.equal(button.attributes['data-update-available'], 'true');
  for (const key of ['aria-label', 'title']) assert.equal(button.attributes[key], '软件更新（有新版本）');
  await app.click('titlebar-updates'); assert.equal(dot.hidden, false, 'merely revealing updates never acknowledges or clears availability');
  app.update(updateNotice(false));
  assert.equal(dot.hidden, true); assert.ok([undefined, 'false'].includes(button.attributes['data-update-available']));
  for (const key of ['aria-label', 'title']) assert.equal(button.attributes[key], '软件更新');
  app.update(updateNotice(true)); assert.equal(dot.hidden, false);
  assert.equal(app.calls.filter(([name]) => name === 'get_titlebar_update_state').length, 1);
});

test('newer badge events beat delayed initial reads in both availability directions', async () => {
  for (const available of [true, false]) {
    const pending = deferred();
    const app = await mount(true, { invoke(name, _args, { fallback }) { return name === 'get_titlebar_update_state' ? pending.promise : fallback(); } });
    app.update(updateNotice(available)); pending.resolve(updateNotice(!available)); await flush();
    assert.equal(app.node('titlebar-update-dot').hidden, !available);
    assert.equal(app.node('titlebar-updates').attributes['aria-label'], available ? '软件更新（有新版本）' : '软件更新');
  }
});

test('badge read failure preserves newer events and never triggers check or install commands', async () => {
  const pending = deferred();
  const app = await mount(true, { invoke(name, _args, { fallback }) { return name === 'get_titlebar_update_state' ? pending.promise : fallback(); } });
  app.update(updateNotice(true)); pending.reject(new Error('private feed URL')); await flush();
  assert.equal(app.node('titlebar-update-dot').hidden, false);
  assert.doesNotMatch(app.node('titlebar-status').textContent, /private|https?:/);
  const failed = await mount(true, { invoke(name, _args, { fallback }) { if (name === 'get_titlebar_update_state') throw new Error('private'); return fallback(); } });
  assert.equal(failed.node('titlebar-update-dot').hidden, true);
  await failed.click('titlebar-updates'); assert.deepEqual(failed.calls.at(-1), ['open_titlebar_updates', undefined]);
  for (const current of [app, failed]) assert.equal(current.calls.some(([name]) => /^(?:check_update|install_update|perform_action|get_update_snapshot)$/.test(name)), false);
});

test('badge subscription failure still permits a read-only snapshot and update navigation', async () => {
  const app = await mount(true, { initialUpdateNotice: updateNotice(true), listen(name) { if (name === 'titlebar-update-state') throw new Error('private updater subscription error'); } });
  assert.equal(app.node('titlebar-update-dot').hidden, false);
  assert.equal(app.node('titlebar-updates').disabled, false);
  await app.click('titlebar-updates');
  assert.deepEqual(app.calls.at(-1), ['open_titlebar_updates', undefined]);
  assert.doesNotMatch(app.node('titlebar-status').textContent, /private updater|https?:/);
  app.unload(); assert.deepEqual(app.unlistened, ['titlebar-state']);
});

test('badge availability is a strict boolean and extra native fields never become rendered text', async () => {
  const app = await mount(true);
  for (const available of ['true', 1, null, undefined, false]) {
    app.update({ available, version: '<script>private-release</script>', notes: 'private notes', url: 'https://private.example' });
    assert.equal(app.node('titlebar-update-dot').hidden, true);
    assert.equal(app.node('titlebar-updates').attributes['aria-label'], '软件更新');
    assert.doesNotMatch(app.node('titlebar-status').textContent, /private|script/);
  }
  app.update(updateNotice(true)); assert.equal(app.node('titlebar-update-dot').hidden, false);
});

test('unload removes the badge subscription and late events, reads, and update clicks cannot mutate UI', async () => {
  for (const resolves of [true, false]) {
    const pending = deferred();
    const app = await mount(true, { invoke(name, _args, { fallback }) { return name === 'get_titlebar_update_state' ? pending.promise : fallback(); } });
    const event = app.subscriptions.get('titlebar-update-state'); assert.equal(typeof event, 'function');
    app.update(updateNotice(true)); const count = app.calls.length;
    app.unload(); app.unload('pagehide');
    assert.deepEqual([...app.unlistened].sort(), eventNames);
    event({ payload: updateNotice(false) });
    if (resolves) pending.resolve(updateNotice(false)); else pending.reject(new Error('late private badge error'));
    await flush(); await app.click('titlebar-updates');
    assert.equal(app.node('titlebar-update-dot').hidden, false); assert.equal(app.node('titlebar-updates').attributes['aria-label'], '软件更新（有新版本）');
    assert.equal(app.calls.length, count); assert.doesNotMatch(app.node('titlebar-status').textContent, /late private/);
  }
});

test('late badge listener registration is cleaned without starting its initial read', async () => {
  const pending = deferred();
  const app = await mount(true, { listen(name) { if (name === 'titlebar-update-state') return pending.promise; } });
  app.unload(); pending.resolve(); await flush();
  assert.equal(app.subscriptions.size, 0);
  assert.equal(app.unlistened.filter(name => name === 'titlebar-update-state').length, 1);
  assert.equal(app.calls.some(([name]) => name === 'get_titlebar_update_state'), false);
});

test('late update navigation completion cannot re-enable or mutate unloaded controls', async () => {
  for (const resolves of [true, false]) {
    const pending = deferred();
    const app = await mount(true, { invoke(name, _args, { fallback }) { return name === 'open_titlebar_updates' ? pending.promise : fallback(); } });
    app.dispatch('titlebar-updates', 'click'); app.unload();
    if (resolves) pending.resolve(); else pending.reject(new Error('late private navigation error'));
    await flush();
    for (const id of settingsIds) assert.equal(app.node(id).disabled, true);
    assert.equal(app.node('titlebar-status').textContent, '');
  }
});

test('all configuration sections and controls remain on the in-window settings page, not the native titlebar', () => {
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
    assert.ok(markup, section + ' stays on the settings page');
    for (const id of controls) {
      assert.ok(markup[1].includes('id="' + id + '"'), id + ' stays in ' + section);
      assert.ok(!html.includes('id="' + id + '"'), id + ' is not a titlebar control');
    }
  }
});

test('in-window settings reuses its primary titlebar without exposing Back or privileged content commands there', () => {
  const nativeSource = readFileSync(new URL('../src-tauri/src/desktop_titlebar.rs', import.meta.url), 'utf8');
  assert.doesNotMatch(nativeSource, /settings-titlebar/);
  assert.doesNotMatch(rawSource, /return_from_settings|settings_page_ready|perform_action|open_settings/);
  assert.doesNotMatch(html, /返回|settings-back/);
  assert.match(nativeSource, /\("launcher-titlebar", "launcher"\)/);
  assert.match(nativeSource, /\("dsh-titlebar", "dsh"\)/);
});

test('titlebar uses a compact icon and keeps native geometry aligned with CSS height', () => {
  const nativeSource = readFileSync(new URL('../src-tauri/src/desktop_titlebar.rs', import.meta.url), 'utf8');
  const height = Number(css.match(/--titlebar-height: (\d+)px/)[1]);
  assert.equal(height, 32);
  assert.equal(Number(nativeSource.match(/const HEIGHT: f64 = ([\d.]+);/)[1]), height);
  assert.match(css, /\.app-icon img\s*\{[^}]*width: 16px;[^}]*height: 16px/);
  assert.match(html, /<img src="\/app-icon\.png" width="16" height="16" alt="" \/>/);
  assert.match(css, /button\s*\{[^}]*height: calc\(var\(--titlebar-height\) - 1px\)/);
  assert.match(nativeSource, /LogicalSize::new\(width, HEIGHT\)/);
  assert.match(nativeSource, /let top = \(HEIGHT \* window\.scale_factor\(\)\?\)\.round\(\) as u32/);
});

test('entry remains local, single-line 32px, with fixed 46px controls and ample 600px drag space', () => {
  assert.match(css, /--titlebar-height: 32px/);
  assert.match(css, /html, body[^}]*height: var\(--titlebar-height\)[^}]*overflow: hidden/);
  assert.match(css, /\.window-control\s*\{[^}]*width: 46px;[^}]*flex: 0 0 46px/);
  assert.match(css, /\.drag-area\s*\{[^}]*flex: 1 1 0;[^}]*min-width: 80px/);
  assert.ok(600 - 36 - 2 * 32 - 3 * 46 >= 360);
  assert.match(css, /\.window-title\s*\{[^}]*min-width: 0;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis/);
  assert.doesNotMatch(css, /\.window-title\s*\{[^}]*display: none/);
  assert.equal((html.match(/<button /g) || []).length, 5);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /https?:\/\/|<iframe|<dialog/);
  assert.doesNotMatch(rawSource, /innerHTML|@tauri-apps\/api\/(?:window|webview)/);
  assert.deepEqual(rawSource.match(/^import .*/gm), [
    "import { invoke, isTauri } from '@tauri-apps/api/core';",
    "import { listen } from '@tauri-apps/api/event';",
    "import './titlebar.css';",
  ]);
});
