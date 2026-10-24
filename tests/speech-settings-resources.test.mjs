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

async function fixture() {
  const document = { nodes: new Map(), createElement(tag) { return new Node(tag, this); } };
  const root = new Node('div', document), listeners = new Map(), calls = [], timers = new Map();
  let timer = 0, resolveRefresh, resources;
  let snapshot = { revision: 0, configured: false, config: { model_dir: '', python_path: '', native_lib: '' },
    distribution: 'Ubuntu', busy: false, operation: null, environment_state: 'unknown', models_state: 'unknown',
    model_progress: null, service_state: 'stopped', ownership: 'none', model_state: 'unloaded', gpu_name: null,
    message: '', error: null, logs: [] };
  const node = id => document.nodes.get(id);
  const publish = patch => { snapshot = { ...snapshot, ...patch, revision: snapshot.revision + 1 }; listeners.get('launcher-speech-state')?.({ payload: snapshot }); };
  const bridge = {
    async listen(name, callback) { listeners.set(name, callback); return () => listeners.delete(name); },
    async invoke(name, args) {
      calls.push({ name, args });
      if (name === 'get_speech_settings') return snapshot;
      if (name === 'get_speech_preferences') return { revision: 0, initialized: true, auto_read: false, volume: 100 };
      if (name === 'get_speech_download') return { id: 0, status: 'idle', model_dir: '', file: null, downloaded_bytes: 0, total_bytes: null, error: null };
      if (name === 'discover_speech_resources') return { python_environments: [{ path: '/env/bin/python', version: '3.12.0', ready: true }], model_dir: '/models/q8', native_lib: '/lib/qwen.so' };
      if (name === 'browse_speech_path') return { path: args.path || '/home/user', parent: '/', entries: [{ name: 'models', path: '/home/user/models', directory: true }], truncated: false };
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

test('actual nested resource controls stay enabled through repeated background refresh snapshots', async () => {
  const f = await fixture();
  try {
    f.node('speech-resource-defaults').click();
    assert.equal(f.node('speech-python_path').value, '/env/bin/python');
    const guidance = f.node('speech-resource-message').textContent;
    for (let i = 0; i < 4; i++) {
      await f.poll();
      for (const id of ['python', 'discover', 'python-browse', 'defaults', 'model-browse', 'native-browse', 'download']) assert.equal(f.node('speech-resource-' + id).disabled, false, id);
      assert.equal(f.node('speech-resource-message').textContent, guidance);
      assert.equal(f.node('speech-save').disabled, false);
      f.node('speech-resource-python').value = '/env/bin/python'; f.node('speech-resource-python').emit('change');
      await f.finishRefresh();
    }
    assert.equal(f.calls.filter(call => call.args?.action === 'refresh').length, 4);
  } finally { f.settings.dispose(); }
});

test('actual path browser and download confirmation survive polling without losing selection or target', async () => {
  const f = await fixture();
  try {
    f.node('speech-resource-model-browse').click(); await tick();
    f.node('speech-resource-path').value = '/typed/target';
    await f.poll();
    assert.equal(f.node('speech-resource-browser').hidden, false);
    assert.equal(f.node('speech-resource-path').value, '/typed/target');
    assert.equal(f.node('speech-resource-choose').disabled, false);
    await f.finishRefresh();
    f.node('speech-resource-choose').click();
    assert.equal(f.node('speech-model_dir').value, '/home/user');
    f.node('speech-resource-download').click();
    assert.equal(f.node('speech-resource-confirm').hidden, false);
    await f.poll();
    assert.equal(f.node('speech-resource-confirm').hidden, false);
    assert.equal(f.node('speech-resource-target').textContent, '/home/user');
    f.node('speech-resource-confirm-yes').click(); await tick();
    assert.ok(f.calls.some(call => call.name === 'download_speech_model' && call.args.modelDir === '/home/user'));
    assert.equal(f.node('speech-resource-download-cancel').disabled, false);
    await f.finishRefresh();
    assert.equal(f.node('speech-resource-download-cancel').disabled, false);
  } finally { f.settings.dispose(); }
});

test('actual resource browser still closes and blocks for real validation, never for passive refresh', async () => {
  const f = await fixture();
  try {
    f.node('speech-resource-model-browse').click(); await tick();
    f.publish({ busy: true, operation: 'check', environment_state: 'checking' });
    assert.equal(f.node('speech-resource-model-browse').disabled, true);
    assert.equal(f.node('speech-resource-browser').hidden, true);
    f.publish({ busy: false, operation: null, environment_state: 'passed' });
    assert.equal(f.node('speech-resource-model-browse').disabled, false);
  } finally { f.settings.dispose(); }
});
