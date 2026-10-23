import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Same transpile + deterministic DOM approach as pet-renderer/notifications.
const source = await readFile(new URL('../src/pet/interactions.ts', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/pet/interactions.css', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { PetInteractions, parsePetInteractionSnapshot } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

class FakeClock {
  time = 0; id = 0; timers = new Map();
  setTimeout = (fn, delay) => { const id = ++this.id; this.timers.set(id, { fn, at: this.time + delay }); return id; };
  clearTimeout = id => this.timers.delete(id);
  tick(ms) {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at; this.timers.delete(next[0]); next[1].fn();
    }
    this.time = end;
  }
}
class FakeElement {
  children = []; parent = null; handlers = new Map(); attributes = new Map();
  className = ''; type = ''; name = ''; value = ''; checked = false; disabled = false;
  hidden = false; _text = ''; mutations = 0;
  classList = { add: value => { this.className += ' ' + value; this.mutations++; } };
  constructor(tag, document) { this.tagName = tag.toUpperCase(); this.ownerDocument = document; }
  set innerHTML(_) { throw new Error('HTML rendering is forbidden'); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = value; this.replaceChildren(); }
  set inert(value) { if (value) this.attributes.set('inert', ''); else this.attributes.delete('inert'); }
  get inert() { return this.attributes.has('inert'); }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } this.mutations++; }
  replaceChildren(...children) { this.children.forEach(child => { child.parent = null; }); this.children = []; this.append(...children); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); this.mutations++; }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  addEventListener(type, fn) { if (!this.handlers.has(type)) this.handlers.set(type, new Set()); this.handlers.get(type).add(fn); }
  removeEventListener(type, fn) { this.handlers.get(type)?.delete(fn); }
  emit(type, props = {}) {
    const event = { type, target: this, bubbles: true, stopped: false, defaultPrevented: false,
      stopPropagation() { this.stopped = true; }, preventDefault() { this.defaultPrevented = true; }, ...props };
    for (let node = this; node; node = event.bubbles && !event.stopped ? node.parent : null) {
      for (const fn of [...node.handlers.get(type) ?? []]) fn(event);
    }
    return event;
  }
  click() { if (!this.disabled) this.emit('click'); }
  forceClick() { this.emit('click'); }
  snapshot() { return { tag: this.tagName, text: this._text, hidden: this.hidden, disabled: this.disabled,
    value: this.value, checked: this.checked, mutations: this.mutations,
    attrs: [...this.attributes], children: this.children.map(child => child.snapshot()) }; }
}
const all = (node, predicate) => [node, ...node.children.flatMap(child => all(child, () => true))].filter(predicate);
const byClass = (root, name) => all(root, node => node.className.split(' ').includes('pet-interactions-' + name));
const one = (root, name) => { const nodes = byClass(root, name); assert.equal(nodes.length, 1, name); return nodes[0]; };
const tag = (root, name) => all(root, node => node.tagName === name.toUpperCase());
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const question = (id = 'q', patch = {}) => ({ id, question: 'Question ' + id, options: [{ label: 'First' }, { label: 'Second' }], ...patch });
const card = (id = 'a', patch = {}) => ({ id, kind: 'questions', agent_label: 'Agent ' + id, questions: [question()], ...patch });
const approval = (id = 'a', patch = {}) => ({ id, kind: 'approval', agent_label: 'Agent ' + id, can_allow: true, ...patch });
const plan = (patch = {}) => question('plan', { options: [{ label: 'Approve' }, { label: 'Keep planning' }],
  intent: { kind: 'plan-review', approve: 'Approve', callId: 'real-call' }, ...patch });
const select = input => { input.checked = true; input.emit('change'); };
const type = (input, text) => { input.value = text; input.emit('input'); };
function setup(t, options = {}) {
  const clock = new FakeClock();
  const document = { defaultView: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    createElement: name => new FakeElement(name, document) };
  const outer = document.createElement('main'), root = document.createElement('div'); outer.append(root);
  const sent = [], opened = [], changed = [];
  const interactions = new PetInteractions(root, {
    onSubmit: async (id, reply) => { sent.push({ id, reply }); },
    onOpen: async id => { opened.push(id); }, onChange: value => changed.push(value), ...options,
  });
  let revision = 0;
  const update = (items, connected = true) => interactions.update({ revision: ++revision, connected, items });
  t.after(() => interactions.dispose());
  return { root, outer, clock, interactions, sent, opened, changed, update };
}

test('exported parser accepts copied wire snapshots and rejects malformed optional fields', () => {
  const wire = { revision: 0, connected: true, items: [card('q-card'), approval('approval-card', { answerable: false })] };
  const parsed = parsePetInteractionSnapshot(wire);
  assert.deepEqual(parsed, wire);
  assert.notEqual(parsed, wire);
  assert.notEqual(parsed.items[0].questions, wire.items[0].questions);
  assert.equal(parsePetInteractionSnapshot({ ...wire, revision: -1 }), null);
  assert.equal(parsePetInteractionSnapshot({ ...wire, items: [card('bad', { questions: [question('q', { header: null })] })] }), null);
  assert.equal(parsePetInteractionSnapshot({ ...wire, items: [card('bad', { questions: [question('q', { options: [{ label: 'ok', description: null }] })] })] }), null);
  assert.equal(parsePetInteractionSnapshot({ ...wire, items: [approval('bad', { answerable: null })] }), null);
});

test('all untrusted strings are plain text; full details and plan are readable', t => {
  const { root, update } = setup(t);
  const unsafe = '<img src=x onerror=alert(1)><script>bad()</script>';
  const details = JSON.stringify({ args: unsafe + '完整风险信息'.repeat(2000), tail: 'END' }, null, 2);
  update([card('a', { agent_label: unsafe, tool_name: unsafe, reason: unsafe, warning: unsafe, details,
    questions: [plan({ question: unsafe, header: unsafe, detail: details,
      options: [{ label: 'Approve', description: unsafe }, { label: 'Keep planning', description: details }] })] })]);
  assert.equal(one(root, 'details').textContent, details);
  assert.equal(one(root, 'detail').textContent, details);
  assert.equal(tag(root, 'script').length, 0); assert.equal(tag(root, 'img').length, 0);
  assert.ok(root.textContent.includes(unsafe));
  assert.ok(root.textContent.includes('END'));
});

test('layout fits pet viewport with scrollable full text and no timeout or clamp', () => {
  for (const rule of [/top: 4px/, /left: 6px/, /right: 6px/, /bottom: 60px/, /z-index: 9/, /12px/, /overflow: auto/, /min-height: 0/]) assert.match(css, rule);
  assert.doesNotMatch(css, /ellipsis|line-clamp/);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|setTimeout|setInterval/);
  assert.doesNotMatch(source, /allowed-session|allowed-always|sessionId/);
});

test('no preselected options and empty answers require explicit skip', async t => {
  const { root, update, sent } = setup(t); update([card()]);
  const inputs = tag(root, 'input'); assert.ok(inputs.every(input => !input.checked));
  const submit = one(root, 'submit'); assert.equal(submit.disabled, true);
  submit.forceClick(); assert.equal(sent.length, 0);
  one(root, 'skip').click(); assert.equal(submit.disabled, false);
  assert.match(root.textContent, /已选择跳过/);
  submit.click(); await flush();
  assert.deepEqual(sent, [{ id: 'a', reply: { kind: 'questions', answers: [{ id: 'q', selected: [] }] } }]);
});

test('multi-question single/multiple/free text preserve labels and serialize custom correctly', async t => {
  const { root, update, sent } = setup(t);
  update([card('a', { questions: [question('single', { options: [{ label: ' Original label ' }, { label: 'Two' }] }),
    question('multiple', { multiSelect: true }), question('text', { options: undefined })] })]);
  const inputs = tag(root, 'input'), texts = tag(root, 'textarea');
  select(inputs[0]); select(inputs[2]); select(inputs[3]);
  type(texts[0], '  custom single  '); type(texts[1], 'extra\nline'); type(texts[2], '回答');
  one(root, 'submit').click(); await flush();
  assert.deepEqual(sent[0].reply, { kind: 'questions', answers: [
    { id: 'single', selected: [], custom: '  custom single  ' },
    { id: 'multiple', selected: ['First', 'Second'], custom: 'extra\nline' },
    { id: 'text', selected: [], custom: '回答' },
  ] });
});

test('single radio changes clear other choice; whitespace does not send custom key', async t => {
  const { root, update, sent } = setup(t);
  update([card('a', { questions: [question('q', { options: [{ label: ' Original label ' }, { label: ' exact Second ' }] })] })]);
  const inputs = tag(root, 'input'); select(inputs[0]); select(inputs[1]);
  type(tag(root, 'textarea')[0], ' \n '); one(root, 'submit').click(); await flush();
  assert.equal(inputs[0].checked, false);
  assert.deepEqual(sent[0].reply.answers, [{ id: 'q', selected: [' exact Second '] }]);
  assert.equal(Object.hasOwn(sent[0].reply.answers[0], 'custom'), false);
});

test('explicit plan approval uses original label with no custom or fabricated identity', async t => {
  const { root, update, sent } = setup(t); update([card('a', { questions: [plan()] })]);
  one(root, 'submit').forceClick(); assert.equal(sent.length, 0);
  select(tag(root, 'input')[0]); assert.equal(sent.length, 0);
  one(root, 'submit').click(); await flush();
  assert.deepEqual(sent, [{ id: 'a', reply: { kind: 'questions', answers: [{ id: 'plan', selected: ['Approve'] }] } }]);
});

test('plan feedback blocks Approve and permits original Keep planning + custom', async t => {
  const { root, update, sent } = setup(t); update([card('a', { questions: [plan()] })]);
  const inputs = tag(root, 'input'); select(inputs[0]); type(tag(root, 'textarea')[0], '请修改\n风险项');
  assert.equal(one(root, 'submit').disabled, true); assert.match(root.textContent, /请选择 Keep planning/);
  one(root, 'submit').forceClick(); assert.equal(sent.length, 0);
  select(inputs[1]); one(root, 'submit').click(); await flush();
  assert.deepEqual(sent[0].reply.answers, [{ id: 'plan', selected: ['Keep planning'], custom: '请修改\n风险项' }]);
});

test('plan custom alone cannot approve or implicitly skip; clearing feedback allows explicit approval', async t => {
  const { root, update, sent } = setup(t); update([card('a', { questions: [plan()] })]);
  const textarea = tag(root, 'textarea')[0]; type(textarea, 'Feedback');
  one(root, 'submit').forceClick(); assert.equal(sent.length, 0);
  select(tag(root, 'input')[0]); type(textarea, ''); one(root, 'submit').click(); await flush();
  assert.deepEqual(sent[0].reply.answers, [{ id: 'plan', selected: ['Approve'] }]);
});

test('explicit skip clears prior custom/selection and can skip a plan without approving', async t => {
  const { root, update, sent } = setup(t); update([card('a', { questions: [plan()] })]);
  select(tag(root, 'input')[0]); type(tag(root, 'textarea')[0], 'Feedback'); one(root, 'skip').click();
  one(root, 'submit').click(); await flush();
  assert.deepEqual(sent[0].reply.answers, [{ id: 'plan', selected: [] }]);
});

test('native cannot-allow still exposes rejection and open-in-DSH', async t => {
  const { root, update, sent, opened } = setup(t); update([approval('native', { can_allow: false })]);
  assert.equal(one(root, 'allow').disabled, true); one(root, 'allow').forceClick(); assert.equal(sent.length, 0);
  one(root, 'open').click(); await flush(); assert.deepEqual(opened, ['native']);
  one(root, 'reject').click(); await flush();
  assert.deepEqual(sent, [{ id: 'native', reply: { kind: 'approval', decision: 'rejected' } }]);
  assert.equal(root.hidden, false); assert.equal(one(root, 'reject').disabled, true);
});

test('allow requires an explicit click and sends only one-time decision', async t => {
  const { root, update, sent, clock } = setup(t); update([approval()]);
  clock.tick(120_000); assert.equal(sent.length, 0); one(root, 'allow').click(); await flush();
  assert.deepEqual(sent, [{ id: 'a', reply: { kind: 'approval', decision: 'allowed-once' } }]);
  one(root, 'allow').forceClick(); assert.equal(sent.length, 1);
});

test('disconnected and not-ready requests cannot answer, but may open in DSH', async t => {
  const { root, update, sent, opened } = setup(t); const item = approval();
  update([item], false); one(root, 'allow').forceClick(); one(root, 'reject').forceClick();
  assert.equal(sent.length, 0); assert.equal(one(root, 'open').disabled, false);
  one(root, 'open').click(); await flush();
  update([{ ...item, answerable: false }]); one(root, 'allow').forceClick(); one(root, 'reject').forceClick();
  assert.equal(sent.length, 0); one(root, 'open').click(); await flush(); assert.equal(opened.length, 2);
  update([{ ...item, answerable: true }]); one(root, 'reject').click(); await flush(); assert.equal(sent.length, 1);
});

test('question answerable changes preserve draft, and false gates skip and submit', async t => {
  const { root, update, sent } = setup(t); const item = card(); update([item]);
  type(tag(root, 'textarea')[0], 'draft');
  update([{ ...item, answerable: false }]);
  assert.equal(tag(root, 'textarea')[0].value, 'draft'); one(root, 'submit').forceClick(); one(root, 'skip').forceClick();
  assert.equal(sent.length, 0); assert.equal(tag(root, 'textarea')[0].value, 'draft');
  update([{ ...item, answerable: true }]); one(root, 'submit').click(); await flush();
  assert.equal(sent[0].reply.answers[0].custom, 'draft');
});

test('pending is single-flight; rejection keeps draft and retries only after explicit click', async t => {
  const calls = [], first = deferred();
  const { root, update, clock } = setup(t, { onSubmit: (id, reply) => { calls.push({ id, reply }); return calls.length === 1 ? first.promise : Promise.resolve(); } });
  update([card()]); const textarea = tag(root, 'textarea')[0]; type(textarea, '草稿'); const submit = one(root, 'submit');
  submit.click(); submit.forceClick(); submit.forceClick(); one(root, 'open').forceClick();
  assert.equal(calls.length, 1); assert.equal(textarea.disabled, true);
  first.reject(new Error('network')); await flush(); clock.tick(90_000); await flush();
  assert.equal(calls.length, 1); assert.equal(textarea.value, '草稿'); assert.equal(submit.disabled, false);
  assert.match(root.textContent, /发送失败/); submit.click(); await flush();
  assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]); assert.equal(submit.disabled, true);
});

test('approval failure does not auto-retry and permits explicit reject retry', async t => {
  let attempts = 0; const { root, update, clock } = setup(t, { onSubmit: async () => { attempts++; throw new Error('bad'); } });
  update([approval()]); one(root, 'reject').click(); await flush(); clock.tick(100_000);
  assert.equal(attempts, 1); one(root, 'reject').click(); await flush(); assert.equal(attempts, 2);
});

test('open is single-flight, failure can retry, success does not answer/remove', async t => {
  const first = deferred(); let attempts = 0;
  const { root, update, sent } = setup(t, { onOpen: () => ++attempts === 1 ? first.promise : Promise.resolve() });
  update([card()]); const open = one(root, 'open'); open.click(); open.forceClick(); assert.equal(attempts, 1);
  first.reject(new Error('open')); await flush(); assert.match(root.textContent, /打开失败/);
  open.click(); await flush(); assert.equal(attempts, 2); assert.equal(sent.length, 0); assert.equal(root.hidden, false);
});

test('revision rejects stale/equal/unsafe snapshots and malformed newer data fail closed', t => {
  const { root, interactions, sent } = setup(t); const item = approval();
  interactions.update({ revision: 10, connected: true, items: [item] });
  for (const revision of [9, 10]) interactions.update({ revision, connected: true, items: [] });
  assert.equal(root.hidden, false);
  for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    interactions.update({ revision, connected: true, items: [item] });
    one(root, 'allow').forceClick(); assert.equal(sent.length, 0);
  }
  interactions.update({ revision: 11, connected: true, items: [item, item] });
  one(root, 'allow').forceClick(); assert.equal(sent.length, 0);
  interactions.update({ revision: 12, connected: true, items: [item] }); assert.equal(one(root, 'allow').disabled, false);
});

test('removed/cancelled/answered-elsewhere card cannot submit through stale nodes', t => {
  const { root, update, sent } = setup(t); update([approval()]); const allow = one(root, 'allow');
  update([]); assert.equal(root.hidden, true); allow.forceClick(); assert.equal(sent.length, 0);
  update([approval('b')]); allow.forceClick(); assert.equal(sent.length, 0);
});

test('FIFO keeps current DOM, focusable inputs and draft on new/reordered snapshots', t => {
  const { root, update } = setup(t); const a = card('a'), b = card('b'), c = approval('c');
  update([a]); const textarea = tag(root, 'textarea')[0]; type(textarea, 'stay');
  update([b, a]); assert.equal(tag(root, 'textarea')[0], textarea); assert.equal(textarea.value, 'stay');
  update([c, b, a]); assert.match(one(root, 'heading').textContent, /Agent a/);
  update([c, b]); assert.match(one(root, 'heading').textContent, /Agent b/);
  update([c]); assert.match(one(root, 'heading').textContent, /Agent c/);
});

test('X collapses to persistent count; summary restores pending draft without answering', t => {
  const { root, update, sent, clock, changed } = setup(t); update([card(), approval('b')]);
  const textarea = tag(root, 'textarea')[0]; type(textarea, 'keep'); one(root, 'close').click();
  const summary = one(root, 'summary'); assert.equal(summary.hidden, false); assert.equal(summary.textContent, '有2个待处理请求');
  assert.equal(one(root, 'panel').hidden, true); one(root, 'submit').forceClick();
  clock.tick(3600_000); assert.equal(summary.hidden, false); assert.equal(clock.timers.size, 0); assert.equal(sent.length, 0);
  summary.click(); assert.equal(one(root, 'panel').hidden, false); assert.equal(tag(root, 'textarea')[0], textarea);
  assert.equal(textarea.value, 'keep'); assert.deepEqual(changed, [true, false, true]);
});

test('inactive hides but retains requests/drafts and cannot send any action', t => {
  const { root, update, interactions, sent, opened, changed } = setup(t); update([card()]);
  const textarea = tag(root, 'textarea')[0]; type(textarea, 'draft'); interactions.setActive(false);
  one(root, 'submit').forceClick(); one(root, 'open').forceClick(); assert.equal(sent.length, 0); assert.equal(opened.length, 0);
  assert.equal(root.hidden, true); interactions.setActive(true); assert.equal(tag(root, 'textarea')[0], textarea);
  assert.equal(textarea.value, 'draft'); assert.deepEqual(changed, [true, false, true]);
});

test('obscured right-menu state blocks replies/open/collapse without changing request', t => {
  const { root, update, interactions, sent, opened, changed } = setup(t); update([approval()]); interactions.setObscured(true);
  assert.equal(root.inert, true); one(root, 'allow').forceClick(); one(root, 'reject').forceClick();
  one(root, 'open').forceClick(); one(root, 'close').forceClick();
  assert.equal(sent.length, 0); assert.equal(opened.length, 0); assert.equal(one(root, 'panel').hidden, false);
  assert.deepEqual(changed, [true]); interactions.setObscured(false); assert.equal(one(root, 'allow').disabled, false);
});

test('Enter has no root shortcut, textarea keeps newline, IME cannot submit', async t => {
  const { root, outer, update, sent } = setup(t); update([card()]); let leaked = 0;
  outer.addEventListener('keydown', () => leaked++); const textarea = tag(root, 'textarea')[0];
  type(textarea, 'first\nsecond'); const event = textarea.emit('keydown', { key: 'Enter' });
  root.emit('keydown', { key: 'Enter' }); assert.equal(event.defaultPrevented, false); assert.equal(leaked, 0); assert.equal(sent.length, 0);
  textarea.emit('compositionstart'); textarea.emit('keydown', { key: 'Enter', isComposing: true });
  one(root, 'submit').forceClick(); assert.equal(sent.length, 0); textarea.emit('compositionend');
  one(root, 'submit').click(); await flush(); assert.equal(sent[0].reply.answers[0].custom, 'first\nsecond');
});

test('disconnect while drafting disables response; reconnect retains same DOM and draft', t => {
  const { root, update, sent } = setup(t); const item = card(); update([item]); const textarea = tag(root, 'textarea')[0]; type(textarea, 'draft');
  update([item], false); one(root, 'submit').forceClick(); assert.equal(sent.length, 0); assert.match(root.textContent, /连接已断开/);
  update([item]); assert.equal(tag(root, 'textarea')[0], textarea); assert.equal(one(root, 'submit').disabled, false);
});

test('obsolete RPC completions cannot mark another request answered or show its error', async t => {
  const pending = deferred(); const { root, update } = setup(t, { onSubmit: () => pending.promise });
  update([approval('a')]); one(root, 'allow').click(); update([approval('b')]); pending.reject(new Error('old failure')); await flush();
  assert.match(one(root, 'heading').textContent, /Agent b/); assert.equal(one(root, 'allow').disabled, false);
  assert.doesNotMatch(root.textContent, /失败|已发送/);
});

test('same-ID metadata changes preserve answers and cannot duplicate an in-flight RPC', async t => {
  const pending = deferred(); let attempts = 0;
  const { root, update } = setup(t, { onSubmit: () => { attempts++; return pending.promise; } }); const item = card();
  update([item]); type(tag(root, 'textarea')[0], 'draft'); one(root, 'submit').click();
  update([{ ...item, warning: 'new full warning' }]); assert.equal(tag(root, 'textarea')[0].value, 'draft');
  one(root, 'submit').forceClick(); assert.equal(attempts, 1); pending.reject(new Error('obsolete')); await flush();
  assert.doesNotMatch(root.textContent, /发送失败/); assert.equal(one(root, 'submit').disabled, false);
});

test('same-ID metadata update cannot unlock a successful submission', async t => {
  const pending = deferred(); let attempts = 0;
  const { root, update } = setup(t, { onSubmit: () => { attempts++; return pending.promise; } }); const item = approval();
  update([item]); one(root, 'allow').click(); update([{ ...item, warning: 'metadata changed' }]);
  pending.resolve(); await flush(); one(root, 'allow').forceClick(); one(root, 'reject').forceClick();
  assert.equal(attempts, 1); assert.equal(one(root, 'allow').disabled, true); assert.match(root.textContent, /已发送/);
});

test('removed then reused ID is a new incarnation, not changed by obsolete success', async t => {
  const pending = deferred(); const { root, update } = setup(t, { onSubmit: () => pending.promise });
  update([approval('a')]); one(root, 'allow').click(); update([]); update([approval('a')]);
  pending.resolve(); await flush(); assert.equal(one(root, 'allow').disabled, false); assert.doesNotMatch(root.textContent, /已发送/);
});

test('host onChange exceptions do not prevent lifecycle cleanup', t => {
  const { root, update, interactions } = setup(t, { onChange: () => { throw new Error('host'); } });
  assert.doesNotThrow(() => update([card()])); assert.doesNotThrow(() => interactions.setActive(false));
  assert.doesNotThrow(() => interactions.dispose()); assert.equal(root.hidden, true);
});

test('snapshot values are copied rather than retaining mutable caller questions', t => {
  const { root, update } = setup(t); const item = card(); update([item]); item.questions[0].options[0].label = 'MUTATED';
  item.questions[0].question = 'MUTATED'; assert.equal(tag(root, 'input')[0].value, 'First'); assert.doesNotMatch(root.textContent, /MUTATED/);
});

test('dispose cleans listeners and late RPC/update cannot mutate DOM', async t => {
  const pending = deferred(); const { root, interactions, update, sent, changed } = setup(t, { onSubmit: () => pending.promise });
  update([approval()]); const nodes = all(root, () => true); one(root, 'allow').click(); interactions.dispose();
  assert.ok(nodes.every(node => [...node.handlers.values()].every(handlers => handlers.size === 0)));
  const snapshot = root.snapshot(); interactions.update({ revision: 999, connected: true, items: [approval()] });
  interactions.setActive(true); interactions.setObscured(false); pending.resolve(); await flush();
  assert.deepEqual(root.snapshot(), snapshot); assert.equal(sent.length, 0); assert.deepEqual(changed, [true, false]);
});
