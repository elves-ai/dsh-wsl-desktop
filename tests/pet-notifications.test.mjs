import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Match the existing pet-renderer fixture: import the actual transpiled module,
// then exercise its DOM operations and lifecycle with a deterministic test DOM.
const source = await readFile(new URL('../src/pet/notifications.ts', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/pet/notifications.css', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { PetNotifications } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

class FakeClock {
  time = 0; id = 0; timers = new Map();
  now = () => this.time;
  setTimeout = (fn, delay) => { const id = ++this.id; this.timers.set(id, { fn, at: this.time + delay }); return id; };
  clearTimeout = id => this.timers.delete(id);
  tick(ms) {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].fn();
    }
    this.time = end;
  }
}

class FakeElement {
  children = []; parent = null; handlers = new Map(); attributes = new Map();
  dataset = {}; classes = new Set(); className = ''; type = ''; mutations = 0;
  _text = ''; _hidden = false;
  classList = { add: name => { this.classes.add(name); this.mutations++; } };
  constructor(tagName, document) { this.tagName = tagName.toUpperCase(); this.ownerDocument = document; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = value; this.replaceChildren(); this.mutations++; }
  get hidden() { return this._hidden; }
  set hidden(value) { this._hidden = value; this.mutations++; }
  get childElementCount() { return this.children.length; }
  append(...children) { children.forEach(child => { child.parent = this; this.children.push(child); }); this.mutations++; }
  replaceChildren(...children) { this.children.forEach(child => { child.parent = null; }); this.children = []; this.append(...children); }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); this.mutations++; }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); this.mutations++; }
  addEventListener(type, fn) { if (!this.handlers.has(type)) this.handlers.set(type, new Set()); this.handlers.get(type).add(fn); }
  removeEventListener(type, fn) { this.handlers.get(type)?.delete(fn); }
  emit(type, props = {}) {
    const event = { type, target: this, bubbles: false, stopped: false,
      stopPropagation() { this.stopped = true; }, ...props };
    for (let node = this; node; node = event.bubbles && !event.stopped ? node.parent : null) {
      for (const fn of [...node.handlers.get(type) ?? []]) fn(event);
    }
  }
  click() { this.emit('click', { bubbles: true }); }
  focus() {
    const previous = this.ownerDocument.activeElement;
    this.ownerDocument.activeElement = this;
    if (previous !== this) {
      previous?.emit('focusout', { bubbles: true, relatedTarget: this });
      this.emit('focusin', { bubbles: true, relatedTarget: previous });
    }
  }
  blur() {
    if (this.ownerDocument.activeElement !== this) return;
    this.ownerDocument.activeElement = null;
    this.emit('focusout', { bubbles: true, relatedTarget: null });
  }
  snapshot() {
    return { text: this.textContent, hidden: this.hidden, mutations: this.mutations,
      attributes: [...this.attributes], dataset: { ...this.dataset }, children: this.children.map(child => child.snapshot()) };
  }
}

const item = (id, patch = {}) => ({ id: String(id), kind: 'completed', title: 'Title ' + id, body: 'Body ' + id, ...patch });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(t, options = {}) {
  const clock = new FakeClock();
  const document = { activeElement: null, defaultView: { Node: FakeElement },
    createElement: tag => new FakeElement(tag, document) };
  const outer = document.createElement('main'), root = document.createElement('div');
  outer.append(root);
  const dismissed = [], opened = [], changed = [];
  const notifications = new PetNotifications(root, {
    clock, onDismiss: id => dismissed.push(id), onChange: value => changed.push(value),
    onOpen: async id => { opened.push(id); }, ...options,
  });
  t.after(() => notifications.dispose());
  const [open, close] = root.children;
  const [title, body, error] = open.children;
  return { root, outer, document, clock, notifications, dismissed, opened, changed, open, close, title, body, error };
}

test('FIFO with five pending; overflow dismisses oldest pending exactly once', t => {
  const e = setup(t);
  for (let id = 0; id < 8; id++) e.notifications.enqueue(item(id));
  assert.equal(e.root.childElementCount, 2); // one body/open button, one close
  assert.equal(e.title.textContent, 'Title 0');
  assert.match(e.open.getAttribute('aria-label'), /Title 0/);
  assert.deepEqual(e.dismissed, ['1', '2']);
  for (const id of ['0', '3', '4', '5', '6', '7']) {
    assert.equal(e.title.textContent, 'Title ' + id);
    e.close.click();
  }
  assert.deepEqual(e.dismissed, ['1', '2', '0', '3', '4', '5', '6', '7']);
  assert.deepEqual(e.changed, [true, false]);
  assert.equal(e.root.hidden, true);
  assert.equal(e.clock.timers.size, 0);
  e.notifications.clear(); e.close.click();
  assert.equal(e.dismissed.length, 8);
});

test('each current item gets 12 seconds, independently of pending wait time', t => {
  const e = setup(t);
  e.notifications.enqueue(item('a')); e.clock.tick(11_999);
  e.notifications.enqueue(item('b'));
  assert.deepEqual(e.dismissed, []);
  e.clock.tick(1);
  assert.deepEqual(e.dismissed, ['a']);
  assert.equal(e.title.textContent, 'Title b');
  e.clock.tick(11_999);
  assert.deepEqual(e.dismissed, ['a']);
  e.clock.tick(1);
  assert.deepEqual(e.dismissed, ['a', 'b']);
  assert.equal(e.root.hidden, true);
});

test('validation rejects malformed/oversized data and accepts Unicode codepoint boundaries', t => {
  const e = setup(t);
  const invalid = [null, [], 12, 'x', {}, item(''), item('   '), item('x'.repeat(129)),
    item('title', { title: 'x'.repeat(81) }), item('blank', { title: ' ' }),
    item('body', { body: 'x'.repeat(181) }), item('kind', { kind: 'other' }),
    item('not-string', { body: {} }), { get id() { throw new Error('getter'); } },
    item('emoji-title-over', { title: '😀'.repeat(81) }), item('emoji-body-over', { body: '😀'.repeat(181) })];
  invalid.forEach(value => e.notifications.enqueue(value));
  assert.equal(e.root.hidden, true);
  assert.equal(e.clock.timers.size, 0);
  assert.deepEqual(e.dismissed, []);
  e.notifications.enqueue(item('x'.repeat(128), { title: 't'.repeat(80), body: 'b'.repeat(180), kind: 'waiting' }));
  assert.equal(e.root.hidden, false);
  assert.equal(e.root.dataset.kind, 'waiting');
  e.notifications.clear();
  e.notifications.enqueue(item('emoji', { title: '😀'.repeat(80), body: '😀'.repeat(180), kind: 'failed' }));
  assert.equal(e.title.textContent, '😀'.repeat(80));
  assert.equal(e.body.textContent, '😀'.repeat(180));
  assert.equal(e.root.dataset.kind, 'failed');
});

test('XSS and URLs stay literal text, copied payload cannot mutate the bubble', t => {
  const e = setup(t);
  const title = '<img src=x onerror=window.xss=true>';
  const body = '<a href="https://bad.invalid">click</a> javascript:alert(1)';
  const value = item('safe', { title, body, src: 'https://bad.invalid/asset' });
  e.notifications.enqueue(value); value.title = 'mutated';
  assert.equal(e.title.textContent, title); assert.equal(e.body.textContent, body);
  assert.equal(e.title.childElementCount, 0); assert.equal(e.body.childElementCount, 0);
  assert.equal(e.root.getAttribute('role'), 'status');
  assert.equal(e.root.getAttribute('aria-live'), 'polite');
  assert.doesNotMatch(source, /\.innerHTML\s*=|insertAdjacentHTML|createElement\(['"](?:a|img|iframe|script)['"]\)/);
});

test('recent IDs deduplicate at 256, survive clear, and active IDs stay protected after eviction', t => {
  const e = setup(t);
  e.notifications.enqueue(item('a')); e.notifications.enqueue(item('a', { title: 'duplicate' }));
  assert.equal(e.title.textContent, 'Title a');
  e.notifications.clear(); e.notifications.enqueue(item('a'));
  assert.equal(e.root.hidden, true);
  for (let i = 0; i < 255; i++) { e.notifications.enqueue(item('next-' + i)); e.notifications.clear(); }
  e.notifications.enqueue(item('a'));
  assert.equal(e.root.hidden, true);
  e.notifications.enqueue(item('evict')); e.notifications.clear(); e.notifications.enqueue(item('a'));
  assert.equal(e.title.textContent, 'Title a');
  e.notifications.clear();
  assert.equal(e.dismissed.filter(id => id === 'a').length, 2);
  const pinned = setup(t);
  pinned.notifications.enqueue(item('pinned'));
  for (let i = 0; i < 300; i++) pinned.notifications.enqueue(item('flood-' + i));
  pinned.notifications.enqueue(item('pinned')); pinned.notifications.clear();
  assert.equal(pinned.dismissed.filter(id => id === 'pinned').length, 1);
});

test('hover and focus pause independently, including focus movement within the bubble', t => {
  const e = setup(t);
  e.notifications.enqueue(item('a')); e.clock.tick(3000);
  e.root.emit('mouseenter'); e.clock.tick(50_000);
  e.open.focus(); assert.equal(e.document.activeElement, e.open);
  e.root.emit('mouseleave'); e.clock.tick(50_000);
  assert.deepEqual(e.dismissed, []);
  e.close.focus(); e.clock.tick(50_000);
  assert.deepEqual(e.dismissed, []);
  e.close.blur(); e.clock.tick(8999);
  assert.deepEqual(e.dismissed, []);
  e.clock.tick(1); assert.deepEqual(e.dismissed, ['a']);
});

test('opening is single-flight and paused; failure retains static retry error, retry success dismisses', async t => {
  const first = deferred(), second = deferred(), calls = [];
  const e = setup(t, { onOpen: id => { calls.push(id); return calls.length === 1 ? first.promise : second.promise; } });
  e.notifications.enqueue(item('a')); e.notifications.enqueue(item('b')); e.clock.tick(4000);
  e.open.click(); e.open.click();
  assert.deepEqual(calls, ['a']);
  assert.equal(e.open.getAttribute('aria-busy'), 'true');
  e.clock.tick(100_000); assert.deepEqual(e.dismissed, []);
  first.reject(new Error('<img src=x> secret server response')); await flush();
  assert.equal(e.error.hidden, false);
  assert.equal(e.error.textContent, '打开失败，点击重试');
  assert.equal(e.root.textContent.includes('secret'), false);
  assert.equal(e.open.getAttribute('aria-disabled'), null);
  e.open.click(); assert.deepEqual(calls, ['a', 'a']);
  second.resolve(); await flush();
  assert.deepEqual(e.dismissed, ['a']); assert.equal(e.title.textContent, 'Title b');
  assert.equal(e.error.hidden, true);
  e.clock.tick(12_000); assert.deepEqual(e.dismissed, ['a', 'b']);
});

test('synchronous opening exception is retryable and resumes only the remaining lifetime', async t => {
  const e = setup(t, { onOpen: () => { throw new Error('private'); } });
  e.notifications.enqueue(item('a')); e.clock.tick(3000); e.open.click(); await flush();
  assert.equal(e.error.hidden, false); assert.deepEqual(e.dismissed, []);
  e.clock.tick(8999); assert.deepEqual(e.dismissed, []);
  e.clock.tick(1); assert.deepEqual(e.dismissed, ['a']);
});

test('manual dismissal during open prevents a late reply from dismissing the next item', async t => {
  for (const reject of [false, true]) {
    const gate = deferred(), e = setup(t, { onOpen: () => gate.promise });
    e.notifications.enqueue(item('a')); e.notifications.enqueue(item('b'));
    e.open.click(); e.close.click(); assert.deepEqual(e.dismissed, ['a']);
    reject ? gate.reject(new Error('late')) : gate.resolve(); await flush();
    assert.equal(e.title.textContent, 'Title b'); assert.equal(e.error.hidden, true);
    assert.deepEqual(e.dismissed, ['a']);
    e.notifications.clear(); assert.deepEqual(e.dismissed, ['a', 'b']);
  }
});

test('inactive clears once, refuses messages, never replays, and ignores late pending failure', async t => {
  const gate = deferred(), e = setup(t, { onOpen: () => gate.promise });
  e.notifications.enqueue(item('a')); e.notifications.enqueue(item('b')); e.open.click();
  e.notifications.setActive(false); assert.deepEqual(e.dismissed, ['a', 'b']);
  assert.equal(e.clock.timers.size, 0);
  e.notifications.setActive(false); e.notifications.enqueue(item('hidden')); e.notifications.setActive(true);
  assert.equal(e.root.hidden, true);
  gate.reject(new Error('late')); await flush(); assert.equal(e.root.hidden, true);
  e.notifications.enqueue(item('a')); assert.equal(e.root.hidden, true);
  e.notifications.enqueue(item('hidden')); assert.equal(e.title.textContent, 'Title hidden');
  e.notifications.clear(); e.notifications.clear();
  assert.deepEqual(e.dismissed, ['a', 'b', 'hidden']);
  assert.deepEqual(e.changed, [true, false, true, false]);
});

test('obscured pauses without loss, accepts pending, blocks opening and resumes remaining lifetime', t => {
  const e = setup(t);
  e.notifications.enqueue(item('a')); e.clock.tick(5000); e.notifications.setObscured(true);
  e.notifications.enqueue(item('b')); e.open.click(); assert.deepEqual(e.opened, []);
  e.clock.tick(100_000); assert.deepEqual(e.dismissed, []);
  assert.deepEqual(e.changed, [true]); assert.equal(e.root.hidden, false);
  e.notifications.setObscured(false); e.clock.tick(6999); assert.deepEqual(e.dismissed, []);
  e.clock.tick(1); assert.deepEqual(e.dismissed, ['a']); assert.equal(e.title.textContent, 'Title b');
  e.clock.tick(12_000); assert.deepEqual(e.dismissed, ['a', 'b']);
});

test('dispose removes timers/listeners; late success/reject and old controls cannot touch remounted DOM', async t => {
  for (const reject of [false, true]) {
    const gate = deferred(), e = setup(t, { onOpen: () => gate.promise });
    e.notifications.enqueue(item('a')); e.notifications.enqueue(item('b')); e.open.click();
    e.notifications.dispose(); e.notifications.dispose();
    assert.deepEqual(e.dismissed, []); assert.equal(e.clock.timers.size, 0);
    assert.equal(e.root.childElementCount, 0);
    for (const node of [e.root, e.open, e.close]) {
      assert.equal([...node.handlers.values()].reduce((total, handlers) => total + handlers.size, 0), 0);
    }
    const marker = e.document.createElement('span'); marker.textContent = 'HMR owner'; e.root.replaceChildren(marker);
    const before = e.root.snapshot();
    reject ? gate.reject(new Error('late')) : gate.resolve(); await flush();
    e.open.click(); e.close.click(); e.root.emit('mouseenter'); e.root.emit('mouseleave'); e.root.emit('focusin');
    e.notifications.enqueue(item('ignored')); e.notifications.clear();
    e.notifications.setActive(false); e.notifications.setObscured(false); e.clock.tick(100_000); await flush();
    assert.deepEqual(e.root.snapshot(), before); assert.deepEqual(e.dismissed, []);
    assert.equal(e.clock.timers.size, 0);
  }
  const e = setup(t); e.notifications.enqueue(item('timer'));
  assert.equal(e.clock.timers.size, 1); e.notifications.dispose(); assert.equal(e.clock.timers.size, 0);
});

test('host callback exceptions cannot corrupt lifecycle and events never start underlying pet actions', t => {
  let dismissCalls = 0, pointerEvents = 0, clickEvents = 0;
  const e = setup(t, { onDismiss: () => { dismissCalls++; throw new Error('host'); }, onChange: () => { throw new Error('host'); } });
  e.outer.addEventListener('pointerdown', () => pointerEvents++); e.outer.addEventListener('click', () => clickEvents++);
  e.notifications.enqueue(item('a')); e.close.emit('pointerdown', { bubbles: true }); e.close.click();
  assert.equal(pointerEvents, 0); assert.equal(clickEvents, 0); assert.equal(dismissCalls, 1);
  e.notifications.enqueue(item('b')); e.notifications.clear(); assert.equal(dismissCalls, 2);
});

test('CSS keeps compact speech bubble bounds and z8 below menu z10; visual verification is separate', () => {
  assert.match(css, /position:\s*absolute/); assert.match(css, /top:\s*7px/);
  assert.match(css, /left:\s*calc\(18px \+ var\(--pet-visible-left, 0px\)\)/); assert.match(css, /right:\s*calc\(18px \+ var\(--pet-visible-right, 0px\)\)/);
  assert.match(css, /max-height:\s*110px/); assert.match(css, /z-index:\s*8/);
  assert.match(css, /\.pet-notifications::after\s*\{/);
  assert.match(css, /-webkit-line-clamp:\s*3/);
  assert.doesNotMatch(css, /url\(/i);
});

test('withdrawal removes matching current/queued reminders and tombstones racing payloads', t => {
  const e=setup(t);e.notifications.enqueue(item('current'));e.notifications.enqueue(item('queued'));
  e.notifications.withdraw('queued');e.notifications.withdraw('current');
  assert.equal(e.root.hidden,true);assert.deepEqual(e.dismissed,['queued','current']);
  e.notifications.withdraw('racing');e.notifications.enqueue(item('racing'));
  assert.equal(e.root.hidden,true);assert.deepEqual(e.dismissed,['queued','current']);
});
