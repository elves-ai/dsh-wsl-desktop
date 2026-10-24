import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const raw = await readFile(new URL('../src/speech-resources.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace("import './speech-resources.css';", '');
const { SpeechResources, isSpeechResourcesFound, isSpeechPathListing, isSpeechDownloadStatus } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const config = { python_path: '/env/bin/python', model_dir: '/models/current', native_lib: '/lib/current.so' };
const found = { python_environments: [{ path: '/env/bin/python', version: '3.12.0', ready: true }, { path: '/usr/bin/python3', version: '3.10.2', ready: false }], model_dir: '/models/found', native_lib: '/lib/found.so' };
const state = (extra = {}) => ({ id: 0, status: 'idle', model_dir: '', file: null, downloaded_bytes: 0, total_bytes: null, error: null, ...extra });
const listing = (path = '/models/current', extra = {}) => ({ path, parent: path === '/' ? null : '/', entries: [{ name: 'child', path: path.replace(/\/$/, '') + '/child', directory: true }, { name: 'python3', path: path.replace(/\/$/, '') + '/python3', directory: false }], truncated: false, ...extra });
class Node extends EventTarget {
  constructor(tag = 'div', document) { super(); this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.children = []; this.value = ''; this.disabled = false; this.hidden = false; this.textContent = ''; this.attributes = new Map(); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  removeAttribute(key) { this.attributes.delete(key); if (key === 'value') this.value = undefined; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(selector === 'button' && child.tagName === 'BUTTON' ? [child] : []), ...child.querySelectorAll(selector)]); }
  emit(type) { this.dispatchEvent(new Event(type)); }
}
function fixture({ native = true, draft = config, invoke: custom, listen: customListen } = {}) {
  const document = { createElement(tag) { return new Node(tag, document); } }, nodes = new Map(), calls = [], listeners = new Map(), patches = [];
  const root = new Node('div', document); let htmlWrites = 0, current = { ...draft }, unlistens = 0, busyEvents = 0;
  Object.defineProperty(root, 'innerHTML', { set(html) { htmlWrites++; for (const m of html.matchAll(/<(\w+)[^>]*\bid="(speech-resource-[^"]+)"[^>]*>/g)) { const node = new Node(m[1], document); node.disabled = /\bdisabled\b/.test(m[0]); node.hidden = /\bhidden\b/.test(m[0]); nodes.set(m[2], node); root.append(node); } } });
  root.querySelector = selector => nodes.get(selector.slice(1));
  const fallback = (name, args) => {
    if (name === 'discover_speech_resources') return found;
    if (name === 'get_speech_download') return state();
    if (name === 'browse_speech_path') return listing(args.path ?? '/');
    if (name === 'download_speech_model') return state({ id: 1, status: 'downloading', model_dir: args.modelDir });
    if (name === 'cancel_speech_download') return state({ id: 1, status: 'cancelled', model_dir: current.model_dir });
    throw Error('Unexpected RPC: ' + name);
  };
  const bridge = {
    async invoke(name, args) { calls.push({ name, args }); return custom ? custom(name, args, fallback) : fallback(name, args); },
    async listen(name, callback) { listeners.set(name, callback); if (customListen) await customListen(name, callback); return () => { unlistens++; if (listeners.get(name) === callback) listeners.delete(name); }; },
  };
  root.addEventListener('speech-resources-busy', () => busyEvents++);
  const resources = new SpeechResources(root, {}, native, bridge, patch => { patches.push(patch); current = { ...current, ...patch }; }, () => ({ ...current }));
  const node = id => nodes.get('speech-resource-' + id);
  return { resources, root, node, calls, listeners, patches, get draft() { return current; }, setDraft(patch) { current = { ...current, ...patch }; }, get htmlWrites() { return htmlWrites; }, get unlistens() { return unlistens; }, get busyEvents() { return busyEvents; },
    show() { resources.setVisible(true); }, hide() { resources.setVisible(false); }, click(id) { node(id).emit('click'); }, event(payload) { listeners.get('launcher-speech-download')?.({ payload }); }, entries() { return node('entries').children.map(li => li.children[0]); } };
}

test('preview disables every control and never invokes or subscribes, including synthetic events', async () => {
  const f = fixture({ native: false }); f.show();
  for (const id of ['discover', 'defaults', 'python-browse', 'model-browse', 'native-browse', 'download', 'confirm-yes', 'download-cancel', 'download-retry']) { assert.equal(f.node(id).disabled, true); f.click(id); }
  f.node('python').value = '/env/bin/python'; f.node('python').emit('change'); await tick();
  assert.deepEqual(f.calls, []); assert.deepEqual(f.patches, []); assert.equal(f.listeners.size, 0); assert.match(f.node('message').textContent, /浏览器预览/); f.resources.dispose();
});

test('first open performs only lightweight discovery and download-state read, without saving or selecting', async () => {
  const f = fixture(); assert.equal(f.calls.length, 0); f.show(); await tick();
  assert.deepEqual(f.calls.map(c => c.name).sort(), ['discover_speech_resources', 'get_speech_download']);
  assert.deepEqual(f.patches, []); assert.equal(f.listeners.size, 1); assert.equal(f.node('python').value, config.python_path);
  assert.match(f.node('message').textContent, /不代表 GPU 或 ABI/);
  f.hide(); assert.equal(f.unlistens, 1); f.show(); await tick();
  assert.equal(f.calls.filter(c => c.name === 'discover_speech_resources').length, 1); f.resources.dispose();
});

test('explicit defaults consult the latest draft and fill empty paths only', async () => {
  const f = fixture({ draft: { python_path: '', model_dir: '', native_lib: '' } }); f.show(); await tick();
  f.setDraft({ model_dir: '/newly/typed' }); f.click('defaults');
  assert.deepEqual(f.patches, [{ python_path: found.python_environments[0].path, native_lib: found.native_lib }]); assert.equal(f.draft.model_dir, '/newly/typed');
  f.node('python').value = '/usr/bin/python3'; f.node('python').emit('change'); assert.equal(f.draft.python_path, '/usr/bin/python3');
  f.click('discover'); await tick(); assert.equal(f.node('python').value, '/usr/bin/python3'); f.resources.dispose();
});

test('model browser supports parent, path jump, truncation, selection and invalid-path rejection', async () => {
  const f = fixture({ invoke(name, args, fallback) { return name === 'browse_speech_path' ? listing(args.path ?? '/', { truncated: true }) : fallback(name, args); } }); f.show(); await tick();
  f.setDraft({ model_dir: '/latest/models' }); f.click('model-browse'); await tick();
  assert.deepEqual(f.calls.at(-1), { name: 'browse_speech_path', args: { path: '/latest/models', kind: 'model_dir' } });
  assert.equal(f.entries().length, 1); assert.match(f.node('browser-message').textContent, /部分/); f.click('parent'); await tick(); assert.equal(f.node('path').value, '/');
  const count = f.calls.length; f.node('path').value = 'C:/bad'; f.click('go'); assert.equal(f.calls.length, count); assert.match(f.node('browser-message').textContent, /WSL 绝对路径/);
  f.node('path').value = '/new/models'; f.click('go'); await tick(); f.click('choose');
  assert.deepEqual(f.patches, [{ model_dir: '/new/models' }]); assert.equal(f.node('browser').hidden, true); f.resources.dispose();
});

test('file browser starts from latest file parent and uses safe text, with explicit single-file selection', async () => {
  const dangerous = '<img src=x onerror=alert(1)>';
  const f = fixture({ invoke(name, args, fallback) { return name === 'browse_speech_path' ? listing(args.path, { entries: [{ name: dangerous, path: '/bin/python3', directory: false }] }) : fallback(name, args); } });
  f.show(); await tick(); f.setDraft({ python_path: '/updated/bin/python' }); f.click('python-browse'); await tick();
  assert.deepEqual(f.calls.at(-1).args, { path: '/updated/bin', kind: 'python_path' }); assert.equal(f.node('choose').disabled, true);
  assert.equal(f.entries()[0].textContent, '文件 · ' + dangerous); f.entries()[0].emit('click'); assert.equal(f.patches.length, 0); f.click('choose');
  assert.deepEqual(f.patches, [{ python_path: '/bin/python3' }]); assert.equal(f.htmlWrites, 1); f.resources.dispose();
});

test('cancelled and blocked browsers ignore late replies and cannot apply stale selection', async () => {
  const pending = deferred(); const f = fixture({ invoke(name, args, fallback) { return name === 'browse_speech_path' ? pending.promise : fallback(name, args); } });
  f.show(); await tick(); f.click('native-browse'); f.click('browser-cancel'); pending.resolve(listing('/lib')); await tick();
  assert.equal(f.node('browser').hidden, true); assert.equal(f.entries().length, 0); assert.equal(f.patches.length, 0);
  f.resources.setBlocked(true); for (const id of ['discover', 'defaults', 'model-browse', 'download', 'confirm-yes']) f.click(id); f.node('python').value = '/usr/bin/python3'; f.node('python').emit('change');
  assert.equal(f.patches.length, 0); assert.equal(f.calls.filter(c => c.name === 'browse_speech_path').length, 1); f.resources.dispose();
});

test('hidden async work cannot mutate the next epoch and late subscriptions are released', async () => {
  const old = deferred(), stop = deferred(); let discovers = 0;
  const f = fixture({ invoke(name, args, fallback) { return name === 'discover_speech_resources' && ++discovers === 1 ? old.promise : fallback(name, args); }, listen() { return stop.promise; } });
  f.show(); f.hide(); stop.resolve(); old.resolve({ ...found, model_dir: '/stale' }); await tick(); assert.equal(f.unlistens, 1); assert.equal(f.node('found').textContent, '');
  f.show(); await tick(); assert.match(f.node('found').textContent, /models\/found/); assert.doesNotMatch(f.node('found').textContent, /stale/); f.resources.dispose();
});

test('download requires explicit source and target confirmation, rejects changed target and never starts on open', async () => {
  const f = fixture(); f.show(); await tick(); f.click('download'); assert.equal(f.node('confirm').hidden, false); assert.match(f.node('source').textContent, /Serveurperso\/Qwen3-TTS-GGUF/); assert.equal(f.node('target').textContent, config.model_dir);
  assert.equal(f.calls.some(c => c.name === 'download_speech_model'), false); f.click('confirm-no'); assert.equal(f.node('confirm').hidden, true);
  f.click('download'); f.setDraft({ model_dir: '/changed' }); f.click('confirm-yes'); await tick(); assert.equal(f.calls.some(c => c.name === 'download_speech_model'), false); assert.match(f.node('message').textContent, /重新确认/);
  f.click('download'); f.click('confirm-yes'); f.click('confirm-yes'); await tick(); assert.equal(f.calls.filter(c => c.name === 'download_speech_model').length, 1); assert.deepEqual(f.calls.at(-1).args, { modelDir: '/changed' }); assert.equal(f.resources.isBusy(), true); assert.equal(f.busyEvents, 1); f.resources.dispose();
});

test('download event wins over stale getter and malformed progress, with unknown-size progress', async () => {
  const initial = deferred(); const f = fixture({ invoke(name, args, fallback) { return name === 'get_speech_download' ? initial.promise : fallback(name, args); } }); f.show(); await tick();
  f.event(state({ id: 5, status: 'downloading', model_dir: '/active', downloaded_bytes: 1048576, file: '<script>file</script>' })); initial.resolve(state()); await tick();
  assert.equal(f.resources.isBusy(), true); assert.equal(f.node('progress').value, undefined); assert.match(f.node('download-message').textContent, /1.0 MiB \/ 总体积未知/); assert.match(f.node('download-message').textContent, /<script>file<\/script>/);
  f.event(state({ status: 'completed', downloaded_bytes: NaN })); assert.equal(f.resources.isBusy(), true); assert.equal(f.htmlWrites, 1); f.resources.dispose();
});

test('cancel during pending download prevents late initial response from resurrecting it', async () => {
  const pending = deferred(); const f = fixture({ invoke(name, args, fallback) { return name === 'download_speech_model' ? pending.promise : fallback(name, args); } }); f.show(); await tick();
  f.click('download'); f.click('confirm-yes'); f.click('download-cancel'); await tick(); pending.resolve(state({ id: 1, status: 'downloading', model_dir: config.model_dir })); await tick();
  assert.match(f.node('download-message').textContent, /已取消/); assert.equal(f.resources.isBusy(), false); assert.equal(f.node('download-retry').hidden, false); assert.equal(f.busyEvents, 2); f.resources.dispose();
});

test('completion selects only initiated current target once; newer path drafts are never overwritten', async () => {
  const f = fixture(); f.show(); await tick(); f.click('download'); f.click('confirm-yes'); await tick();
  const completed = state({ id: 1, status: 'completed', model_dir: config.model_dir, downloaded_bytes: 100, total_bytes: 100 }); f.event(completed); f.event(completed);
  assert.deepEqual(f.patches, [{ model_dir: config.model_dir }]); assert.equal(f.resources.isBusy(), false); f.event({ ...completed, status: 'downloading' }); assert.equal(f.resources.isBusy(), false); f.resources.dispose();
  const g = fixture(); g.show(); await tick(); g.click('download'); g.click('confirm-yes'); await tick(); g.setDraft({ model_dir: '/new/draft' }); g.event(completed); assert.deepEqual(g.patches, []); assert.equal(g.draft.model_dir, '/new/draft'); g.resources.dispose();
});

test('retry requires a new explicit confirmation and reads the latest draft', async () => {
  const f = fixture(); f.show(); await tick(); f.click('download'); f.click('confirm-yes'); await tick(); f.event(state({ id: 1, status: 'error', model_dir: config.model_dir, error: 'network failed' }));
  f.setDraft({ model_dir: '/retry/here' }); f.click('download-retry'); assert.equal(f.node('target').textContent, '/retry/here'); assert.equal(f.calls.filter(c => c.name === 'download_speech_model').length, 1);
  f.click('confirm-yes'); await tick(); assert.equal(f.calls.filter(c => c.name === 'download_speech_model').length, 2); assert.equal(f.calls.at(-1).args.modelDir, '/retry/here'); f.resources.dispose();
});

test('RPC errors remain bounded static guidance and failed browser cannot select old listings', async () => {
  const f = fixture({ invoke(name, args, fallback) { if (name === 'browse_speech_path' || name === 'download_speech_model') throw Error('SECRET /home/token'); return fallback(name, args); } }); f.show(); await tick(); f.click('model-browse'); await tick();
  assert.match(f.node('browser-message').textContent, /无法读取/); assert.doesNotMatch(f.node('browser-message').textContent, /SECRET|token/); assert.equal(f.node('choose').disabled, true);
  f.click('download'); f.click('confirm-yes'); await tick(); assert.match(f.node('message').textContent, /未能开始/); assert.doesNotMatch(f.node('message').textContent, /SECRET|token/); assert.equal(f.resources.isBusy(), false); f.resources.dispose();
});

test('payload validation rejects malformed states, Windows listings and unbounded discovery', () => {
  assert.equal(isSpeechResourcesFound(found), true); assert.equal(isSpeechResourcesFound({ ...found, python_environments: [{ path: '/p', version: 3, ready: true }] }), false);
  assert.equal(isSpeechPathListing(listing()), true); assert.equal(isSpeechPathListing(listing('C:/windows')), false); assert.equal(isSpeechPathListing(listing('/ok', { entries: [{ name: 'bad', path: '/bad\\path', directory: true }] })), false);
  assert.equal(isSpeechDownloadStatus(state()), true); assert.equal(isSpeechDownloadStatus(state({ status: 'fake-ready' })), false); assert.equal(isSpeechDownloadStatus(state({ total_bytes: -1 })), false);
});

test('numeric download IDs and same-ID byte counts never regress from stale events', async () => {
  const f = fixture(); f.show(); await tick();
  f.event(state({ id: 7, status: 'downloading', model_dir: '/seven', downloaded_bytes: 1000 }));
  f.event(state({ id: 6, status: 'completed', model_dir: '/six', downloaded_bytes: 9000 }));
  assert.equal(f.resources.isBusy(), true); assert.match(f.node('download-message').textContent, /0.0 MiB/);
  f.event(state({ id: 7, status: 'downloading', model_dir: '/seven', downloaded_bytes: 1048576 }));
  f.event(state({ id: 7, status: 'downloading', model_dir: '/seven', downloaded_bytes: 1 }));
  assert.match(f.node('download-message').textContent, /1.0 MiB/);
  assert.equal(isSpeechDownloadStatus(state({ id: '7' })), false); assert.equal(isSpeechDownloadStatus(state({ id: -1 })), false);
  f.resources.dispose();
});

test('events delivered synchronously while subscribing beat a stale initial idle getter', async () => {
  const f = fixture({ listen(name, callback) { callback({ payload: state({ id: 4, status: 'downloading', model_dir: '/active' }) }); } });
  f.show(); await tick(); assert.equal(f.resources.isBusy(), true); assert.match(f.node('download-message').textContent, /下载中/); f.resources.dispose();
});

test('completion read after leaving preserves a draft edited while the module was hidden', async () => {
  let current = state();
  const f = fixture({ invoke(name, args, fallback) { return name === 'get_speech_download' ? current : fallback(name, args); } });
  f.show(); await tick(); f.click('download'); f.click('confirm-yes'); await tick(); f.hide(); f.setDraft({ model_dir: '/typed/while/hidden' });
  current = state({ id: 1, status: 'completed', model_dir: config.model_dir, downloaded_bytes: 10, total_bytes: 10 });
  f.show(); await tick(); assert.equal(f.resources.isBusy(), false); assert.deepEqual(f.patches, []); assert.equal(f.draft.model_dir, '/typed/while/hidden'); f.resources.dispose();
});

test('dispose removes subscription and ignores deferred responses and synthetic clicks', async () => {
  const pending = deferred(); const f = fixture({ invoke(name, args, fallback) { return name === 'browse_speech_path' ? pending.promise : fallback(name, args); } }); f.show(); await tick(); f.click('model-browse'); f.resources.dispose(); const count = f.calls.length;
  pending.resolve(listing('/old')); await tick(); f.click('defaults'); f.click('download'); f.resources.setVisible(true); assert.equal(f.calls.length, count); assert.equal(f.listeners.size, 0); assert.equal(f.patches.length, 0); assert.equal(f.node('model-browse').disabled, true);
});
