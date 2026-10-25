import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const raw = await readFile(new URL('../src/speech-resources.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace("import './speech-resources.css';", '');
const { SpeechResources, isSpeechDownloadStatus, isSpeechInitializationResult } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const config = { python_path: '/env/bin/python', model_dir: '/models/current', native_lib: '/lib/current.so' };
const initialized = (extra = {}) => ({ config: { python_path: '/home/user/.dsh-wsl-desktop/speech/runtime/venv/bin/python', model_dir: '/home/user/.dsh-wsl-desktop/speech/models/qwen3-tts-q8', native_lib: '' }, config_path: '/home/user/.dsh-wsl-desktop/speech/config.json', reused_python: false, created_venv: true, ...extra });
const state = (extra = {}) => ({ id: 0, status: 'idle', model_dir: '', file: null, downloaded_bytes: 0, total_bytes: null, error: null, ...extra });
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
    if (name === 'initialize_speech_environment') return initialized();
    if (name === 'cancel_speech_initialization') return;
    if (name === 'get_speech_download') return state();
    if (name === 'pick_settings_path') return '/selected/' + args.kind;
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
    show() { resources.setVisible(true); }, hide() { resources.setVisible(false); }, click(id) { node(id).emit('click'); }, event(payload) { listeners.get('launcher-speech-download')?.({ payload }); } };
}

test('preview disables every control and never invokes or subscribes, including synthetic events', async () => {
  const f = fixture({ native: false }); f.show();
  for (const id of ['initialize', 'initialize-cancel', 'model-browse', 'native-browse', 'download', 'confirm-yes', 'download-cancel', 'download-retry']) { assert.equal(f.node(id).disabled, true); f.click(id); }
  assert.deepEqual(f.calls, []); assert.deepEqual(f.patches, []); assert.equal(f.listeners.size, 0); assert.match(f.node('message').textContent, /浏览器预览/); f.resources.dispose();
});

test('opening, reopening and owner unlock only read download status, never discover or probe Python', async () => {
  const f = fixture(); assert.equal(f.calls.length, 0); f.show(); await tick();
  assert.deepEqual(f.calls.map(c => c.name), ['get_speech_download']);
  assert.deepEqual(f.patches, []); assert.equal(f.listeners.size, 1);
  assert.equal(f.node('initialize').disabled, false);
  for (const id of ['discover', 'defaults', 'gpu', 'python', 'found', 'python-browse']) assert.equal(f.node(id), undefined, id);
  f.resources.setBlocked(true); f.resources.setBlocked(false); await tick();
  assert.equal(f.calls.length, 1);
  f.hide(); assert.equal(f.unlistens, 1); f.show(); await tick();
  assert.deepEqual(f.calls.map(c => c.name), ['get_speech_download', 'get_speech_download']);
  assert.deepEqual(f.patches, []); f.resources.dispose();
});

test('resource guidance is static and offers managed Python initialization, not discovery or manual Python', () => {
  assert.match(raw, /Python 固定使用托管默认路径.*不支持手动选择/);
  assert.match(raw, /点击“初始化语音环境”离线创建或复用默认 venv/);
  assert.doesNotMatch(raw, /discover_speech_resources|SpeechResourcesFound|pythonStatusLabels|gpuGuidance|discovered|discovering|speech-resource-(?:discover|defaults|gpu|python|found)|python-browse|<select/);
});

test('system picker uses latest drafts and a single narrow command without web path browsing', async () => {
  const f = fixture(); f.show(); await tick();
  for (const [id, kind] of [['model-browse', 'model_dir'], ['native-browse', 'native_lib']]) {
    f.setDraft({ [kind]: '/latest/' + kind }); f.click(id); await tick();
    assert.deepEqual(f.calls.at(-1), { name: 'pick_settings_path', args: { kind, currentPath: '/latest/' + kind } });
    assert.equal(f.draft[kind], '/selected/' + kind);
  }
  assert.equal(f.htmlWrites, 1); assert.doesNotMatch(raw, /speech-resource-(?:browser|path|entries)|browse_speech_path/);
  assert.equal(f.calls.some(c => /save|speech_action/.test(c.name)), false); f.resources.dispose();
});

test('native picker cancellation, malformed results and errors never change drafts or expose raw errors', async () => {
  for (const result of [null, 'C:/host', String.raw`\\wsl.localhost\Other\home`, '/bad\\path', {}, undefined]) {
    const f = fixture({ invoke(name, args, fallback) { return name === 'pick_settings_path' ? result : fallback(name, args); } });
    f.show(); await tick(); f.click('model-browse'); await tick();
    assert.deepEqual(f.patches, []); assert.deepEqual(f.draft, config); assert.equal(f.resources.isBusy(), false); f.resources.dispose();
  }
});

test('system picker busy blocks duplicate synthetic events and all draft-changing controls', async () => {
  const pending = deferred(); const f = fixture({ invoke(name, args, fallback) { return name === 'pick_settings_path' ? pending.promise : fallback(name, args); } });
  f.show(); await tick(); f.click('model-browse'); const count = f.calls.length;
  assert.equal(f.resources.isBusy(), true);
  for (const id of ['model-browse', 'native-browse', 'initialize', 'download', 'confirm-yes']) { assert.equal(f.node(id).disabled, true); f.click(id); }
  assert.equal(f.calls.length, count); assert.deepEqual(f.patches, []);
  pending.resolve('/selected/models'); await tick(); assert.deepEqual(f.patches, [{ model_dir: '/selected/models' }]);
  assert.equal(f.resources.isBusy(), false); f.resources.dispose();
});

test('late picker replies cannot overwrite a newer draft, hidden visit, owner block or disposed view', async () => {
  for (const mode of ['draft', 'hide', 'block', 'dispose']) {
    const pending = deferred(); const f = fixture({ invoke(name, args, fallback) { return name === 'pick_settings_path' ? pending.promise : fallback(name, args); } });
    f.show(); await tick(); f.click('native-browse');
    if (mode === 'draft') f.setDraft({ model_dir: '/newer/models' });
    if (mode === 'hide') { f.hide(); f.show(); await tick(); }
    if (mode === 'block') f.resources.setBlocked(true);
    if (mode === 'dispose') f.resources.dispose();
    pending.resolve('/stale/lib.so'); await tick(); assert.deepEqual(f.patches, []); f.resources.dispose();
  }
});

test('hidden download getter cannot mutate a reopened epoch', async () => {
  const old = deferred(); let reads = 0;
  const f = fixture({ invoke(name, args, fallback) { return name === 'get_speech_download' && ++reads === 1 ? old.promise : fallback(name, args); } });
  f.show(); await tick(); f.hide(); f.show(); await tick();
  old.resolve(state({ id: 99, status: 'downloading', model_dir: '/stale' })); await tick();
  assert.equal(f.resources.isBusy(), false); assert.doesNotMatch(f.node('download-message').textContent, /下载中|stale/);
  assert.deepEqual(f.patches, []); assert.equal(f.unlistens, 1); f.resources.dispose();
});

test('late download subscriptions are released after hiding or disposal without a status read', async () => {
  for (const dispose of [false, true]) {
    const stop = deferred(); const f = fixture({ listen() { return stop.promise; } });
    f.show(); dispose ? f.resources.dispose() : f.hide(); stop.resolve(); await tick();
    assert.equal(f.unlistens, 1); assert.deepEqual(f.calls, []); assert.deepEqual(f.patches, []);
    if (!dispose) { f.show(); await tick(); assert.deepEqual(f.calls.map(c => c.name), ['get_speech_download']); }
    f.resources.dispose();
  }
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
  const f = fixture({ invoke(name, args, fallback) { if (name === 'pick_settings_path' || name === 'download_speech_model') throw Error('SECRET /home/token'); return fallback(name, args); } }); f.show(); await tick(); f.click('model-browse'); await tick();
  assert.match(f.node('message').textContent, /无法选择/); assert.doesNotMatch(f.node('message').textContent, /SECRET|token/); assert.deepEqual(f.patches, []);
  f.click('download'); f.click('confirm-yes'); await tick(); assert.match(f.node('message').textContent, /未能开始/); assert.doesNotMatch(f.node('message').textContent, /SECRET|token/); assert.equal(f.resources.isBusy(), false); f.resources.dispose();
});

test('download payload validation rejects malformed states and negative totals', () => {
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

test('explicit initialization sends the latest draft and only fills unsaved paths', async () => {
  const f = fixture(); f.show(); await tick(); f.setDraft({ python_path: '/latest/python' });
  const before = f.calls.length; f.click('initialize'); await tick();
  assert.deepEqual(f.calls.slice(before), [{ name: 'initialize_speech_environment', args: { config: { ...config, python_path: '/latest/python' } } }]);
  assert.deepEqual(f.draft, initialized().config); assert.deepEqual(f.patches, [initialized().config]);
  assert.match(f.node('message').textContent, /离线创建 Python venv.*本地配置存储于：.*speech\/config.json/);
  assert.match(f.node('message').textContent, /不代表依赖、GPU、ABI 或模型检测通过/);
  assert.match(f.node('message').textContent, /未保存为应用有效配置/);
  assert.equal(f.resources.isBusy(), false); assert.equal(f.busyEvents, 2); f.resources.dispose();
});

test('initialization preserves paths edited after clicking while filling unchanged fields', async () => {
  const pending = deferred(); const f = fixture({ invoke(name, args, fallback) { return name === 'initialize_speech_environment' ? pending.promise : fallback(name, args); } });
  f.show(); await tick(); f.click('initialize'); f.setDraft({ model_dir: '/later/models', native_lib: '/later/lib.so' });
  pending.resolve(initialized({ reused_python: true, created_venv: false })); await tick();
  assert.deepEqual(f.patches, [{ python_path: initialized().config.python_path }]);
  assert.equal(f.draft.model_dir, '/later/models'); assert.equal(f.draft.native_lib, '/later/lib.so');
  assert.match(f.node('message').textContent, /复用现有 Python/); f.resources.dispose();
});

test('initialization busy disables picker, download and duplicate synthetic actions, not download progress', async () => {
  const pending = deferred(); const f = fixture({ invoke(name, args, fallback) { return name === 'initialize_speech_environment' ? pending.promise : fallback(name, args); } });
  f.show(); await tick(); f.click('download'); f.click('initialize'); const count = f.calls.length;
  assert.equal(f.resources.isBusy(), true); assert.equal(f.node('initialize-cancel').disabled, false);
  for (const id of ['initialize', 'model-browse', 'native-browse', 'download', 'confirm-yes', 'download-cancel', 'download-retry']) {
    assert.equal(f.node(id).disabled, true, id); f.click(id);
  }
  assert.equal(f.calls.length, count); assert.deepEqual(f.patches, []); assert.equal(f.node('progress').hidden, true);
  assert.equal(f.node('confirm').hidden, true); assert.doesNotMatch(f.node('download-message').textContent, /下载中/);
  pending.resolve(initialized()); await tick(); assert.equal(f.node('initialize').disabled, false); f.resources.dispose();
});

test('explicit cancellation ignores an old success and cannot unlock a newer initialization', async () => {
  const first = deferred(), second = deferred(), cancel = deferred(); let runs = 0;
  const f = fixture({ invoke(name, args, fallback) {
    if (name === 'initialize_speech_environment') return ++runs === 1 ? first.promise : second.promise;
    return name === 'cancel_speech_initialization' ? cancel.promise : fallback(name, args);
  } });
  f.show(); await tick(); f.click('initialize'); f.click('initialize-cancel'); f.click('initialize-cancel');
  assert.equal(f.calls.filter(c => c.name === 'cancel_speech_initialization').length, 1);
  assert.equal(f.resources.isBusy(), true); first.resolve(initialized()); await tick();
  assert.deepEqual(f.patches, []); assert.equal(f.resources.isBusy(), true);
  cancel.resolve(); await tick(); assert.equal(f.resources.isBusy(), false); assert.match(f.node('message').textContent, /已取消/);
  f.click('initialize'); assert.equal(f.resources.isBusy(), true);
  second.resolve(initialized()); await tick(); assert.equal(f.patches.length, 1); f.resources.dispose();
});

test('hide and dispose cancel pending initialization and old callbacks never affect a later visit', async () => {
  for (const dispose of [false, true]) {
    const first = deferred(), second = deferred(), cancel = deferred(); let runs = 0;
    const f = fixture({ invoke(name, args, fallback) {
      if (name === 'initialize_speech_environment') return ++runs === 1 ? first.promise : second.promise;
      return name === 'cancel_speech_initialization' ? cancel.promise : fallback(name, args);
    } });
    f.show(); await tick(); f.click('initialize'); dispose ? f.resources.dispose() : f.hide();
    assert.equal(f.calls.filter(c => c.name === 'cancel_speech_initialization').length, 1);
    if (!dispose) { f.show(); await tick(); f.click('initialize'); }
    first.resolve(initialized({ config_path: '/stale/config' })); cancel.resolve(); await tick();
    assert.deepEqual(f.patches, []); assert.doesNotMatch(f.node('message').textContent, /stale/);
    assert.equal(f.node('initialize').disabled, true);
    if (!dispose) { assert.equal(f.resources.isBusy(), true); second.resolve(initialized()); await tick(); assert.equal(f.patches.length, 1); }
    f.resources.dispose();
  }
});

test('cancelled initializer replying after a new run cannot apply paths or clear its busy state', async () => {
  const first = deferred(), second = deferred(); let runs = 0;
  const f = fixture({ invoke(name, args, fallback) { return name === 'initialize_speech_environment' ? (++runs === 1 ? first.promise : second.promise) : fallback(name, args); } });
  f.show(); await tick(); f.click('initialize'); f.click('initialize-cancel'); await tick(); f.click('initialize');
  first.resolve(initialized({ config_path: '/stale/config' })); await tick();
  assert.deepEqual(f.patches, []); assert.equal(f.resources.isBusy(), true); assert.equal(f.node('initialize').disabled, true);
  assert.doesNotMatch(f.node('message').textContent, /stale/); second.resolve(initialized()); await tick();
  assert.equal(f.patches.length, 1); assert.equal(f.resources.isBusy(), false); f.resources.dispose();
});

test('initialization cannot overlap pending browse, download or an owner block', async () => {
  for (const activity of ['browse', 'download', 'owner']) {
    const pending = deferred(); const f = fixture({ invoke(name, args, fallback) {
      if (activity === 'browse' && name === 'pick_settings_path') return pending.promise;
      return fallback(name, args);
    } });
    f.show(); await tick();
    if (activity === 'browse') f.click('model-browse');
    if (activity === 'download') { f.click('download'); f.click('confirm-yes'); await tick(); }
    if (activity === 'owner') f.resources.setBlocked(true);
    assert.equal(f.node('initialize').disabled, true, activity); f.click('initialize'); await tick();
    assert.equal(f.calls.some(call => call.name === 'initialize_speech_environment'), false, activity);
    if (activity === 'download') assert.equal(f.node('download-cancel').disabled, false);
    pending.resolve('/selected/models'); await tick(); f.resources.dispose();
  }
});

test('initialization failures and malformed results retain drafts, show static errors and allow explicit retry', async () => {
  for (const invalid of [null, { config: initialized().config }, initialized({ config_path: '' }), initialized({ reused_python: true })]) {
    let runs = 0; const f = fixture({ invoke(name, args, fallback) {
      if (name === 'initialize_speech_environment') { if (++runs === 1) return invalid; if (runs === 2) throw Error('SECRET raw subprocess /token'); return initialized(); }
      return fallback(name, args);
    } });
    f.show(); await tick();
    for (let i = 0; i < 2; i++) {
      f.click('initialize'); await tick(); assert.deepEqual(f.patches, []); assert.deepEqual(f.draft, config);
      assert.match(f.node('message').textContent, /初始化未完成/); assert.doesNotMatch(f.node('message').textContent, /SECRET|subprocess|token/);
      assert.equal(f.resources.isBusy(), false); assert.equal(f.node('initialize').disabled, false);
    }
    f.click('initialize'); await tick(); assert.equal(f.patches.length, 1); f.resources.dispose();
  }
});

test('failed cancellation stays locked until original settlement and never applies its success', async () => {
  const pending = deferred(); const f = fixture({ invoke(name, args, fallback) {
    if (name === 'initialize_speech_environment') return pending.promise;
    if (name === 'cancel_speech_initialization') throw Error('SECRET cancel'); return fallback(name, args);
  } });
  f.show(); await tick(); f.click('initialize'); f.click('initialize-cancel'); await tick();
  assert.equal(f.resources.isBusy(), true); assert.equal(f.node('initialize-cancel').disabled, false);
  assert.match(f.node('message').textContent, /取消初始化未成功/); assert.doesNotMatch(f.node('message').textContent, /SECRET/);
  pending.resolve(initialized()); await tick(); assert.equal(f.resources.isBusy(), false); assert.deepEqual(f.patches, []); f.resources.dispose();
});

test('initialization result validates absolute bounded paths, optional native lib and exclusive typed flags', () => {
  assert.equal(isSpeechInitializationResult(initialized()), true);
  assert.equal(isSpeechInitializationResult(initialized({ config: { ...config, python_path: '/external/bin/python' } })), false);
  assert.equal(isSpeechInitializationResult(initialized({ created_venv: false, reused_python: true })), true);
  for (const key of ['python_path', 'model_dir', 'native_lib', 'config_path']) {
    for (const value of ['', 'relative', '//host/path', 'C:/bad', '/bad\\path', '/bad\npath', '/bad' + String.fromCharCode(127), '/' + 'x'.repeat(4096), 1, null]) {
      const result = initialized(); if (key === 'config_path') result[key] = value; else result.config[key] = value;
      assert.equal(isSpeechInitializationResult(result), key === 'native_lib' && value === '', key + ':' + String(value));
    }
  }
  for (const invalidPath of ['/home/user/.dsh-wsl-desktop/speech-config.json', '/home/user/.dsh-wsl-desktop/speech/config.json.bak', '/other/config.json']) assert.equal(isSpeechInitializationResult(initialized({ config_path: invalidPath })), false);
  for (const flags of [{ reused_python: true, created_venv: true }, { reused_python: false, created_venv: false }, { reused_python: 'true' }, { created_venv: 1 }]) assert.equal(isSpeechInitializationResult(initialized(flags)), false);
});

test('dispose removes subscription and ignores deferred responses and synthetic clicks', async () => {
  const pending = deferred(); const f = fixture({ invoke(name, args, fallback) { return name === 'pick_settings_path' ? pending.promise : fallback(name, args); } }); f.show(); await tick(); f.click('model-browse'); f.resources.dispose(); const count = f.calls.length;
  pending.resolve('/old'); await tick(); f.click('initialize'); f.click('download'); f.resources.setVisible(true); assert.equal(f.calls.length, count); assert.equal(f.listeners.size, 0); assert.equal(f.patches.length, 0); assert.equal(f.node('model-browse').disabled, true);
});
