import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const url = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const read = path => readFile(new URL('../src/' + path, import.meta.url), 'utf8');
const qwen = url(compile(await read('pet/qwen-speech.ts')));
const { SpeechSettings } = await import(url(compile(await read('speech-settings.ts')).replace("'./pet/qwen-speech'", JSON.stringify(qwen))));
const { SpeechResources } = await import(url(compile(await read('speech-resources.ts')).replace("import './speech-resources.css';", '')));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const initialized = { config: { python_path: '/home/user/.dsh-wsl-desktop/speech/runtime/venv/bin/python', model_dir: '/home/user/.dsh-wsl-desktop/speech/models/qwen3-tts-q8', native_lib: '' }, config_path: '/home/user/.dsh-wsl-desktop/speech/config.json', reused_python: false, created_venv: true };

/** Minimal DOM, but both controllers, their nested mount and events are production code. */
class Node extends EventTarget {
  constructor(tag, document) {
    super(); this.tagName = tag.toUpperCase(); this.ownerDocument = document;
    this.children = []; this.value = ''; this.checked = false; this.disabled = false;
    this.hidden = false; this.textContent = ''; this.dataset = {};
  }
  set innerHTML(markup) {
    this.children = [];
    for (const match of markup.matchAll(/<([a-z0-9]+)[^>]* id="([^"]+)"[^>]*>/g)) {
      const child = new Node(match[1], this.ownerDocument);
      child.hidden = /[ ]hidden(?:[ >])/.test(match[0]); child.disabled = /[ ]disabled(?:[ >])/.test(match[0]);
      child.readOnly = /[ ]readonly(?:[ >])/.test(match[0]);
      this.ownerDocument.nodes.set(match[2], child); this.children.push(child);
    }
  }
  querySelector(selector) { return this.ownerDocument.nodes.get(selector.slice(1)); }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(selector === 'button' && child.tagName === 'BUTTON' ? [child] : []), ...child.querySelectorAll(selector)]); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  removeAttribute(name) { if (name === 'value') this.value = undefined; }
  emit(name) { this.dispatchEvent(new Event(name)); }
  click() { if (!this.disabled) this.emit('click'); }
}

async function fixture({ initialize = () => initialized, cancel = () => undefined, pick = () => '/home/user', config = { model_dir: '', python_path: '', native_lib: '' } } = {}) {
  const document = { nodes: new Map(), createElement(tag) { return new Node(tag, this); } };
  const root = new Node('div', document), listeners = new Map(), calls = [], timers = new Map();
  let timer = 0, resolveRefresh, resources;
  let snapshot = { revision: 0, configured: false, config,
    distribution: 'Ubuntu', busy: false, operation: null, environment_state: 'unknown', models_state: 'unknown',
    model_progress: null, service_state: 'stopped', ownership: 'none', model_state: 'unloaded', gpu_name: null,
    message: '', error: null, logs: [] };
  const node = id => document.nodes.get(id);
  const publish = patch => { snapshot = { ...snapshot, ...patch, revision: snapshot.revision + 1 }; listeners.get('launcher-speech-state')?.({ payload: snapshot }); };
  const bridge = {
    async listen(name, callback) { listeners.set(name, callback); return () => listeners.delete(name); },
    async invoke(name, args) {
      calls.push({ name, args });
      if (name === 'initialize_speech_environment') return initialize(args);
      if (name === 'cancel_speech_initialization') return cancel();
      if (name === 'set_speech_preferences') return { revision: 1, initialized: true, auto_read: args.patch.auto_read, volume: 100 };
      if (name === 'get_speech_settings') return snapshot;
      if (name === 'save_speech_config') { publish({ config: args.config, configured: true }); return snapshot; }
      if (name === 'get_speech_preferences') return { revision: 0, initialized: true, auto_read: false, volume: 100 };
      if (name === 'get_speech_download') return { id: 0, status: 'idle', model_dir: '', file: null, downloaded_bytes: 0, total_bytes: null, error: null };
      if (name === 'pick_settings_path') return pick(args);
      if (name === 'speech_action' && args.action === 'refresh') {
        publish({ busy: true, operation: 'refresh' });
        return new Promise(resolve => { resolveRefresh = resolve; });
      }
      if (name === 'download_speech_model') return { id: 1, status: 'downloading', model_dir: args.modelDir, file: null, downloaded_bytes: 0, total_bytes: null, error: null };
      throw Error('unexpected RPC: ' + name);
    },
  };
  const view = { setTimeout(callback) { timers.set(++timer, callback); return timer; }, clearTimeout(id) { timers.delete(id); } };
  const settings = new SpeechSettings(root, view, true, bridge, (mount, select, draft) => {
    resources = new SpeechResources(mount, view, true, bridge, select, draft); return resources;
  });
  settings.setVisible(true); await tick();
  return { settings, resources, node, calls, publish,
    async poll() { const tasks = [...timers.values()]; timers.clear(); tasks.forEach(task => task()); await tick(); },
    async finishRefresh() { publish({ busy: false, operation: null }); resolveRefresh?.(snapshot); await tick(); },
  };
}

test('nested UI offers no manual Python input and migrates legacy configuration only through explicit initialization', async () => {
  const legacy = { python_path: '/external/bin/python', model_dir: '/custom/models', native_lib: '/custom/lib.so' };
  const f = await fixture({ config: legacy, initialize: () => ({ ...initialized, config: { ...legacy, python_path: initialized.config.python_path } }) });
  try {
    assert.equal(f.node('speech-python_path').readOnly, true);
    assert.equal(f.node('speech-python_path').value, '');
    assert.equal(f.node('speech-resource-python-browse'), undefined);
    for (const id of ['python', 'gpu', 'found', 'discover', 'defaults']) assert.equal(f.node('speech-resource-' + id), undefined, id);
    assert.equal(f.node('speech-python_path').value, '');
    f.node('speech-resource-initialize').click(); await tick();
    assert.equal(f.node('speech-python_path').value, initialized.config.python_path);
    assert.equal(f.node('speech-model_dir').value, legacy.model_dir); assert.equal(f.node('speech-native_lib').value, legacy.native_lib);
    // A later model edit must survive old configured paths delivered by background refresh.
    f.node('speech-model_dir').value = '/later/models'; f.node('speech-model_dir').emit('input');
    await f.poll(); await f.finishRefresh();
    assert.equal(f.node('speech-model_dir').value, '/later/models'); assert.equal(f.node('speech-python_path').value, initialized.config.python_path);
    f.node('speech-save').click(); await tick();
    assert.deepEqual(f.calls.find(call => call.name === 'save_speech_config')?.args.config,
      { ...legacy, python_path: initialized.config.python_path, model_dir: '/later/models' });
    assert.equal(f.calls.some(call => call.name === 'pick_settings_path'), false);
  } finally { f.settings.dispose(); }
});

test('missing managed default never carries a legacy external Python into save and initialization prepares only the default', async () => {
  const legacy = { python_path: '/external/bin/python', model_dir: '/custom/models', native_lib: '/custom/lib.so' };
  const f = await fixture({ config: legacy });
  try {
    assert.equal(f.node('speech-python_path').value, '');
    assert.equal(f.node('speech-resource-initialize').disabled, false);
    // Even synthetic input on the read-only compatibility field cannot save external Python.
    f.node('speech-python_path').value = legacy.python_path; f.node('speech-python_path').emit('input');
    f.node('speech-save').click(); await tick();
    assert.equal(f.calls.some(call => call.name === 'save_speech_config'), false);
    assert.match(f.node('speech-message').textContent, /固定使用托管默认路径/);
    f.node('speech-resource-initialize').click(); await tick();
    assert.equal(f.node('speech-python_path').value, initialized.config.python_path);
    assert.equal(f.calls.some(call => call.name === 'save_speech_config' || call.name === 'pick_settings_path'), false);
  } finally { f.settings.dispose(); }
});

test('actual nested resource controls stay enabled through repeated background refresh snapshots', async () => {
  const f = await fixture();
  try {
    f.node('speech-resource-initialize').click(); await tick();
    assert.equal(f.node('speech-python_path').value, initialized.config.python_path);
    const guidance = f.node('speech-resource-message').textContent;
    for (let i = 0; i < 4; i++) {
      await f.poll();
      for (const id of ['initialize', 'model-browse', 'native-browse', 'download']) assert.equal(f.node('speech-resource-' + id).disabled, false, id);
      assert.equal(f.node('speech-resource-message').textContent, guidance);
      assert.equal(f.node('speech-save').disabled, false);
      assert.equal(f.node('speech-python_path').value, initialized.config.python_path);
      await f.finishRefresh();
    }
    assert.equal(f.calls.filter(call => call.args?.action === 'refresh').length, 4);
  } finally { f.settings.dispose(); }
});

test('actual system picker locks parent actions and selected draft survives polling until explicit download confirmation', async () => {
  const pending = deferred(); const f = await fixture({ pick: () => pending.promise });
  try {
    f.node('speech-resource-model-browse').click(); await tick();
    assert.equal(f.resources.isBusy(), true); assert.equal(f.node('speech-save').disabled, true);
    await f.poll();
    pending.resolve('/home/user'); await tick();
    assert.equal(f.resources.isBusy(), false); assert.equal(f.node('speech-model_dir').value, '/home/user');
    assert.equal(f.calls.some(call => call.name === 'save_speech_config'), false);
    f.node('speech-resource-download').click(); await f.poll();
    assert.equal(f.node('speech-resource-confirm').hidden, false);
    assert.equal(f.node('speech-resource-target').textContent, '/home/user');
    f.node('speech-resource-confirm-yes').click(); await tick();
    assert.ok(f.calls.some(call => call.name === 'download_speech_model' && call.args.modelDir === '/home/user'));
    await f.finishRefresh(); assert.equal(f.node('speech-resource-download-cancel').disabled, false);
  } finally { f.settings.dispose(); }
});

test('explicit initialization locks parent actions without recursive setBlocked and preserves later edits', async () => {
  const pending = deferred(); const f = await fixture({ initialize: () => pending.promise });
  try {
    f.publish({ configured: true });
    const draft = { python_path: f.node('speech-python_path').value, model_dir: f.node('speech-model_dir').value, native_lib: f.node('speech-native_lib').value };
    const count = f.calls.length; f.node('speech-resource-initialize').click();
    assert.equal(f.resources.isBusy(), true);
    for (const id of ['save', 'check', 'start', 'test', 'refresh']) { assert.equal(f.node('speech-' + id).disabled, true, id); f.node('speech-' + id).emit('click'); }
    for (const id of ['initialize', 'model-browse', 'native-browse', 'download', 'download-cancel']) assert.equal(f.node('speech-resource-' + id).disabled, true, id);
    assert.equal(f.node('speech-resource-initialize-cancel').disabled, false);
    assert.equal(f.node('speech-model_dir').disabled, false);
    f.node('speech-model_dir').value = '/later/models'; f.node('speech-model_dir').emit('input');
    await f.poll();
    assert.deepEqual(f.calls.slice(count), [{ name: 'initialize_speech_environment', args: { config: draft } }]);
    pending.resolve(initialized); await tick();
    assert.equal(f.resources.isBusy(), false); assert.equal(f.node('speech-resource-initialize').disabled, false);
    assert.equal(f.node('speech-model_dir').value, '/later/models'); assert.equal(f.node('speech-python_path').value, initialized.config.python_path);
    assert.equal(f.node('speech-native_lib').value, ''); assert.match(f.node('speech-draft').textContent, /未保存/);
    assert.equal(f.node('speech-save').disabled, false); assert.equal(f.node('speech-auto').checked, false);
    assert.match(f.node('speech-resource-message').textContent, /speech\/config.json/);
    assert.equal(f.calls.some(call => ['save_speech_config', 'test_speech', 'set_speech_preferences'].includes(call.name) || ['check', 'start'].includes(call.args?.action)), false);
    f.publish({}); assert.equal(f.node('speech-model_dir').value, '/later/models');
  } finally { f.settings.dispose(); }
});

test('opening, reopening, polling and auto-read never discover resources, probe Python or implicitly initialize', async () => {
  const f = await fixture();
  try {
    await f.poll(); await f.finishRefresh();
    f.node('speech-auto').checked = true; f.node('speech-auto').emit('change'); await tick();
    assert.equal(f.node('speech-auto').checked, true);
    f.settings.setVisible(false); f.settings.setVisible(true); await tick();
    await f.poll(); await f.finishRefresh();
    f.node('speech-refresh').click(); await tick(); await f.finishRefresh();
    assert.ok(f.calls.every(call => ['get_speech_settings', 'get_speech_preferences', 'get_speech_download', 'set_speech_preferences'].includes(call.name) || call.name === 'speech_action' && call.args.action === 'refresh'), JSON.stringify(f.calls));
    assert.equal(f.calls.some(call => call.name === 'discover_speech_resources' || /python|runtime_check/.test(call.name) || ['check', 'start'].includes(call.args?.action)), false);
    assert.equal(f.node('speech-python_path').value, '');
    assert.equal(f.node('speech-resource-initialize').disabled, false);
  } finally { f.settings.dispose(); }
});

test('parent hide cancels initialization and old success does not refill or unlock the next visit', async () => {
  const first = deferred(), second = deferred(); let runs = 0;
  const f = await fixture({ initialize: () => ++runs === 1 ? first.promise : second.promise });
  try {
    f.node('speech-resource-initialize').click(); f.settings.setVisible(false);
    assert.equal(f.calls.filter(call => call.name === 'cancel_speech_initialization').length, 1);
    f.settings.setVisible(true); await tick(); f.node('speech-resource-initialize').click();
    first.resolve(initialized); await tick();
    assert.equal(f.node('speech-python_path').value, ''); assert.equal(f.resources.isBusy(), true);
    assert.equal(f.node('speech-resource-initialize').disabled, true);
    second.resolve(initialized); await tick(); assert.equal(f.resources.isBusy(), false);
    assert.equal(f.node('speech-python_path').value, initialized.config.python_path);
  } finally { f.settings.dispose(); }
});

test('actual system picker rejects late reply after real validation begins', async () => {
  const pending = deferred(); const f = await fixture({ pick: () => pending.promise });
  try {
    f.node('speech-resource-model-browse').click(); await tick();
    f.publish({ busy: true, operation: 'check', environment_state: 'checking' });
    assert.equal(f.node('speech-resource-model-browse').disabled, true);
    pending.resolve('/stale/models'); await tick();
    assert.equal(f.node('speech-model_dir').value, '');
    f.publish({ busy: false, operation: null, environment_state: 'passed' });
    assert.equal(f.node('speech-resource-model-browse').disabled, false);
  } finally { f.settings.dispose(); }
});
