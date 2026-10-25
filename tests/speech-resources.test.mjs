import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const raw = await readFile(new URL('../src/speech-resources.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace("import './speech-resources.css';", '');
const { SpeechResources, isSpeechInstallStatus } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const state = (extra = {}) => ({ id: 0, status: 'idle', stage: '', downloaded_bytes: 0, total_bytes: null, error: null, ...extra });
const installing = (extra = {}) => state({ id: 1, status: 'installing', stage: '下载并校验模型', ...extra });
class Node extends EventTarget {
  constructor() { super(); this.disabled = false; this.hidden = false; this.textContent = ''; this.value = 0; }
  removeAttribute(key) { if (key === 'value') this.value = undefined; }
  emit(type) { this.dispatchEvent(new Event(type)); }
}
function fixture({ native = true, initial = state(), invoke: custom, listen: customListen } = {}) {
  const nodes = new Map(), calls = [], listeners = new Map(), root = new Node();
  let unlistens = 0, busyEvents = 0, completedEvents = 0;
  Object.defineProperty(root, 'innerHTML', { set(html) { for (const m of html.matchAll(/id="(speech-resource-[^"]+)"/g)) nodes.set(m[1], new Node()); } });
  root.querySelector = selector => nodes.get(selector.slice(1));
  const fallback = name => {
    if (name === 'get_speech_install') return initial;
    if (name === 'install_speech') return installing();
    if (name === 'cancel_speech_install') return state({ id: 1, status: 'cancelled' });
    throw Error('Unexpected RPC: ' + name);
  };
  const bridge = {
    async invoke(name, args) { calls.push({ name, args }); return custom ? custom(name, args, fallback) : fallback(name, args); },
    async listen(name, callback) { listeners.set(name, callback); if (customListen) await customListen(name, callback); return () => { unlistens++; if (listeners.get(name) === callback) listeners.delete(name); }; },
  };
  root.addEventListener('speech-resources-busy', () => busyEvents++);
  root.addEventListener('speech-resources-completed', () => completedEvents++);
  const resources = new SpeechResources(root, {}, native, bridge);
  const node = id => nodes.get('speech-resource-' + id);
  return { resources, root, node, calls, listeners, get unlistens() { return unlistens; }, get busyEvents() { return busyEvents; }, get completedEvents() { return completedEvents; },
    show() { resources.setVisible(true); }, hide() { resources.setVisible(false); }, click(id) { node(id).emit('click'); }, event(payload) { listeners.get('launcher-speech-install')?.({ payload }); } };
}

test('preview disables all controls and ignores synthetic clicks', async () => {
  const f = fixture({ native: false }); f.show();
  for (const id of ['install', 'cancel']) { assert.equal(f.node(id).disabled, true); f.click(id); }
  await tick(); assert.deepEqual(f.calls, []); assert.equal(f.listeners.size, 0); assert.match(f.node('message').textContent, /浏览器预览/); f.resources.dispose();
});
test('opening and reopening only read installation status, with no path or save controls', async () => {
  const f = fixture(); assert.equal(f.calls.length, 0); f.show(); await tick();
  assert.deepEqual(f.calls.map(c => c.name), ['get_speech_install']); assert.equal(f.node('install').disabled, false);
  assert.match(f.node('message').textContent, /已有可用资源将复用/);
  assert.doesNotMatch(raw, /pick_settings_path|save_speech_config|speech_action|initialize_speech_environment|download_speech_model|<input|<select/);
  assert.match(raw, /联网.*较大的 Q8 模型/); assert.match(raw, /无需选择目录或手动保存/);
  f.hide(); assert.equal(f.unlistens, 1); f.show(); await tick();
  assert.deepEqual(f.calls.map(c => c.name), ['get_speech_install', 'get_speech_install']); f.resources.dispose();
});
test('single click invokes install with no arguments and no selector or manual save; duplicate clicks are guarded', async () => {
  const gate = deferred(), f = fixture({ invoke: (name, args, fallback) => name === 'install_speech' ? gate.promise : fallback(name) });
  f.show(); await tick(); f.click('install'); f.click('install');
  assert.deepEqual(f.calls.at(-1), { name: 'install_speech', args: undefined });
  assert.equal(f.calls.filter(c => c.name === 'install_speech').length, 1); assert.equal(f.resources.isBusy(), true); assert.equal(f.node('cancel').disabled, false);
  gate.resolve(installing()); await tick(); f.click('install'); assert.equal(f.calls.length, 2);
  f.event(installing({ stage: '下载并校验模型', downloaded_bytes: 75, total_bytes: 100 }));
  assert.equal(f.node('message').textContent, '下载并校验模型'); assert.equal(f.node('progress').value, 75); assert.match(f.node('progress-label').textContent, /75%/);
  f.event(state({ id: 1, status: 'completed' })); assert.equal(f.completedEvents, 1); assert.equal(f.resources.isBusy(), false);
  assert.match(f.node('message').textContent, /已检测并保存/); assert.equal(f.node('install').textContent, '已安装'); assert.equal(f.node('install').disabled, true);
  f.event(state({ id: 1, status: 'completed' })); assert.equal(f.completedEvents, 1); assert.equal(f.calls.length, 2); f.resources.dispose();
});
test('error has bounded plain text and a single-click retry with a newer id', async () => {
  let id = 0; const f = fixture({ invoke: (name, args, fallback) => name === 'install_speech' ? installing({ id: ++id }) : fallback(name) });
  f.show(); await tick(); f.click('install'); await tick();
  f.event(state({ id: 1, status: 'error', error: '<img src=x>下载失败\n' + '错误'.repeat(400) }));
  assert.match(f.node('message').textContent, /<img src=x>下载失败/); assert.ok(f.node('message').textContent.length < 420);
  assert.equal(f.node('install').textContent, '重试安装'); assert.equal(f.node('install').disabled, false);
  f.click('install'); f.click('install'); await tick(); assert.equal(id, 2); assert.equal(f.resources.isBusy(), true);
  f.event(state({ id: 1, status: 'completed' })); assert.equal(f.completedEvents, 0); assert.equal(f.resources.isBusy(), true); f.resources.dispose();
});
test('cancel is deduplicated, terminal cancellation beats late start reply, and retry is safe', async () => {
  const start = deferred(), cancel = deferred(); let attempts = 0;
  const f = fixture({ invoke: (name, args, fallback) => name === 'install_speech' ? ++attempts === 1 ? start.promise : installing({ id: 2 }) : name === 'cancel_speech_install' ? cancel.promise : fallback(name) });
  f.show(); await tick(); f.click('install'); f.click('cancel'); f.click('cancel');
  assert.equal(f.calls.filter(c => c.name === 'cancel_speech_install').length, 1); assert.equal(f.node('cancel').disabled, true);
  cancel.resolve(state({ id: 1, status: 'cancelled' })); await tick(); assert.equal(f.resources.isBusy(), false); assert.match(f.node('message').textContent, /已取消/);
  f.click('install'); await tick(); start.resolve(installing({ id: 1 })); await tick();
  assert.equal(attempts, 2); assert.equal(f.resources.isBusy(), true); assert.equal(f.node('message').textContent, '下载并校验模型'); f.resources.dispose();
});
test('cancel failure does not pretend installation stopped and permits retry', async () => {
  let cancels = 0; const f = fixture({ initial: installing(), invoke: (name, args, fallback) => { if (name === 'cancel_speech_install' && ++cancels === 1) throw Error('raw secret'); return fallback(name); } });
  f.show(); await tick(); f.resources.setBlocked(true); f.click('cancel'); await tick();
  assert.equal(f.resources.isBusy(), true); assert.equal(f.node('cancel').disabled, false); assert.match(f.node('message').textContent, /未成功/); assert.doesNotMatch(f.node('message').textContent, /secret/);
  f.click('cancel'); await tick(); assert.equal(f.resources.isBusy(), false); f.resources.dispose();
});
test('events during the initial query and start RPC beat stale same-id replies', async () => {
  const query = deferred(), start = deferred();
  const f = fixture({ invoke: (name, args, fallback) => name === 'get_speech_install' ? query.promise : name === 'install_speech' ? start.promise : fallback(name) });
  f.show(); await tick(); assert.equal(f.node('install').disabled, true); f.click('install'); assert.equal(f.calls.length, 1);
  f.event(installing({ stage: '编译原生库', downloaded_bytes: 80, total_bytes: 100 })); query.resolve(installing({ stage: '下载模型', downloaded_bytes: 20, total_bytes: 100 })); await tick();
  assert.equal(f.node('message').textContent, '编译原生库'); assert.equal(f.node('progress').value, undefined);
  f.event(state({ id: 1, status: 'error', error: '失败' })); f.click('install');
  f.event(installing({ id: 2, stage: '检测并保存' })); start.resolve(installing({ id: 2, stage: '下载模型' })); await tick();
  assert.equal(f.node('message').textContent, '检测并保存'); f.resources.dispose();
});
test('terminal status cannot be resurrected by late events or old RPC failures', async () => {
  const gate = deferred(), f = fixture({ invoke: (name, args, fallback) => name === 'install_speech' ? gate.promise : fallback(name) });
  f.show(); await tick(); f.click('install'); f.event(state({ id: 1, status: 'completed' }));
  f.event(installing()); f.event(state({ id: 0, status: 'error', error: 'late' })); gate.reject(Error('late RPC failure')); await tick();
  assert.equal(f.node('install').textContent, '已安装'); assert.equal(f.resources.isBusy(), false); assert.doesNotMatch(f.node('message').textContent, /未能|late/); f.resources.dispose();
});
test('leaving continues backend installation, reentry restores it and ignores old listeners/replies', async () => {
  const gate = deferred(); let reads = 0;
  const f = fixture({ invoke: (name, args, fallback) => name === 'install_speech' ? gate.promise : name === 'get_speech_install' && ++reads > 1 ? installing({ id: 2, stage: '恢复安装进度' }) : fallback(name) });
  f.show(); await tick(); const late = f.listeners.get('launcher-speech-install'); f.click('install'); f.hide();
  assert.equal(f.listeners.size, 0); assert.equal(f.calls.some(c => c.name === 'cancel_speech_install'), false);
  f.show(); await tick(); late({ payload: state({ id: 99, status: 'completed' }) }); gate.resolve(state({ id: 1, status: 'completed' })); await tick();
  assert.equal(f.node('message').textContent, '恢复安装进度'); assert.equal(f.completedEvents, 0); assert.equal(f.node('install').disabled, true); f.resources.dispose();
});
test('leaving while subscription pending cleans late listeners and performs no query', async () => {
  const gate = deferred(), f = fixture({ listen: () => gate.promise }); f.show(); f.hide(); gate.resolve(); await tick();
  assert.equal(f.listeners.size, 0); assert.deepEqual(f.calls, []); f.resources.dispose();
});
test('existing completed state is read without installing or loading and remains completed on reentry', async () => {
  const f = fixture({ initial: state({ id: 8, status: 'completed' }) }); f.show(); await tick(); f.click('install');
  assert.equal(f.node('install').textContent, '已安装'); assert.equal(f.completedEvents, 1); assert.deepEqual(f.calls.map(c => c.name), ['get_speech_install']);
  f.hide(); f.show(); await tick(); assert.equal(f.node('install').textContent, '已安装'); assert.equal(f.completedEvents, 1); f.resources.dispose();
});
test('unknown or failed read locks conflicting work; retry reads only and recovers', async () => {
  let reads = 0; const f = fixture({ invoke: (name, args, fallback) => { if (name === 'get_speech_install' && ++reads === 1) throw Error('private'); return fallback(name); } });
  f.show(); await tick(); assert.equal(f.resources.isBusy(), true); assert.equal(f.node('install').textContent, '重试读取状态');
  f.click('install'); f.click('install'); await tick(); assert.deepEqual(f.calls.map(c => c.name), ['get_speech_install', 'get_speech_install']); assert.equal(f.listeners.size, 1); assert.equal(f.resources.isBusy(), false); f.resources.dispose();
});
test('late callback from a failed read subscription cannot contaminate its retry', async () => {
  let reads = 0, old;
  const f = fixture({ listen: (name, callback) => { old ??= callback; }, invoke: (name, args, fallback) => { if (name === 'get_speech_install' && ++reads === 1) throw Error('failed read'); return fallback(name); } });
  f.show(); await tick(); f.click('install'); await tick();
  old({ payload: state({ id: 999, status: 'completed' }) });
  assert.equal(f.completedEvents, 0); assert.equal(f.node('install').textContent, '一键安装'); f.resources.dispose();
});
test('transport failure reconciles state before any second install request', async () => {
  let reads = 0; const f = fixture({ invoke: (name, args, fallback) => { if (name === 'install_speech') throw Error('raw private token'); if (name === 'get_speech_install' && ++reads > 1) return installing(); return fallback(name); } });
  f.show(); await tick(); f.click('install'); await tick(); assert.equal(f.resources.isBusy(), true); assert.doesNotMatch(f.node('message').textContent, /private|token/);
  f.click('install'); await tick(); assert.equal(f.node('install').textContent, '正在安装…'); assert.equal(f.calls.filter(c => c.name === 'install_speech').length, 1); f.resources.dispose();
});
test('malformed DTOs never unlock controls or overwrite valid progress', async () => {
  assert.equal(isSpeechInstallStatus(state()), true);
  for (const patch of [{ id: -1 }, { id: 0.5 }, { id: Number.MAX_SAFE_INTEGER + 1 }, { status: 'ready' }, { stage: null }, { downloaded_bytes: NaN }, { downloaded_bytes: -1 }, { downloaded_bytes: 1.5 }, { total_bytes: Infinity }, { total_bytes: 1, downloaded_bytes: 2 }, { error: {} }]) assert.equal(isSpeechInstallStatus(state(patch)), false, JSON.stringify(patch));
  const f = fixture({ initial: installing() }); f.show(); await tick();
  f.event({ ...state({ id: 99, status: 'completed' }), stage: null }); assert.equal(f.resources.isBusy(), true); assert.equal(f.completedEvents, 0);
  assert.equal(f.node('progress').value, undefined); f.event(installing({ downloaded_bytes: 100, total_bytes: null })); assert.match(f.node('progress-label').textContent, /总大小待确定/); f.resources.dispose();
});
test('every real installer phase shows explanatory text and indeterminate activity without invented percentages', async () => {
  const phases = [
    ['准备安装', /启动安装任务/], ['检查已有语音配置', /直接复用/],
    ['准备默认语音环境', /Python/], ['识别可用显卡', /检测显卡/],
    ['安装固定版本依赖', /体积较大/], ['获取固定版本源码', /源码/],
    ['编译原生语音库', /可能较久/], ['检测并保存语音配置', /还不是安装完成/],
  ];
  const f = fixture({ initial: installing() }); f.show(); await tick();
  for (const [stage, hint] of phases) {
    f.event(installing({ stage, downloaded_bytes: 100, total_bytes: 100 }));
    assert.equal(f.node('message').textContent, stage);
    assert.equal(f.node('detail').hidden, false); assert.match(f.node('detail').textContent, hint);
    assert.equal(f.node('progress').hidden, false); assert.equal(f.node('progress').value, undefined);
    assert.doesNotMatch(f.node('progress-label').textContent, /100%|已下载/);
  }
  f.event(installing({ stage: '后端新增阶段' })); assert.match(f.node('detail').textContent, /当前步骤/);
  f.resources.dispose();
});
test('download byte percentage is distinct from final validation and completed installation', async () => {
  const f = fixture({ initial: installing() }); f.show(); await tick();
  f.event(installing({ downloaded_bytes: 50, total_bytes: 100 }));
  assert.equal(f.node('progress').value, 50); assert.match(f.node('progress-label').textContent, /模型文件.*50%/);
  f.event(installing({ downloaded_bytes: 100, total_bytes: 100 }));
  assert.equal(f.node('progress').value, 100); assert.equal(f.node('install').textContent, '正在安装…');
  f.event(installing({ stage: '检测并保存语音配置', downloaded_bytes: 100, total_bytes: null }));
  assert.equal(f.node('progress').value, undefined); assert.doesNotMatch(f.node('progress-label').textContent, /总大小待确定|100%/);
  f.event(state({ id: 1, status: 'completed' }));
  assert.equal(f.node('progress').value, 100); assert.equal(f.node('progress').hidden, false);
  assert.equal(f.node('progress-label').textContent, '安装完成'); assert.equal(f.node('detail').hidden, true);
  f.resources.dispose();
});
test('cancel and retry discard old download progress while awaiting confirmation', async () => {
  const start = deferred(), cancel = deferred();
  const f = fixture({ initial: installing({ downloaded_bytes: 90, total_bytes: 100 }), invoke: (name, args, fallback) => name === 'cancel_speech_install' ? cancel.promise : name === 'install_speech' ? start.promise : fallback(name) });
  f.show(); await tick(); f.click('cancel');
  assert.equal(f.node('progress').value, undefined); assert.match(f.node('detail').textContent, /清理临时文件/);
  f.event(installing({ stage: '正在取消并清理', downloaded_bytes: 90, total_bytes: 100 }));
  cancel.resolve(installing({ stage: '正在取消并清理', downloaded_bytes: 90, total_bytes: 100 })); await tick();
  assert.equal(f.node('progress').value, undefined); assert.match(f.node('progress-label').textContent, /正在取消/);
  f.event(state({ id: 1, status: 'cancelled', downloaded_bytes: 90, total_bytes: 100 }));
  assert.equal(f.node('progress').hidden, true); assert.equal(f.node('detail').hidden, true);
  f.click('install'); assert.equal(f.node('progress').hidden, false); assert.equal(f.node('progress').value, undefined);
  assert.match(f.node('detail').textContent, /启动安装任务/);
  start.resolve(installing({ id: 2, stage: '准备安装' })); await tick(); f.resources.dispose();
});
test('progress remains unknown while reconnecting to an in-flight installation', async () => {
  const query = deferred(); let reads = 0;
  const f = fixture({ initial: installing({ downloaded_bytes: 50, total_bytes: 100 }), invoke: (name, args, fallback) => name === 'get_speech_install' && ++reads > 1 ? query.promise : fallback(name) });
  f.show(); await tick(); f.hide(); f.show(); await tick();
  assert.equal(f.node('progress').value, undefined); assert.match(f.node('detail').textContent, /确认后台任务状态/);
  query.resolve(installing({ stage: '编译原生语音库' })); await tick();
  assert.match(f.node('detail').textContent, /可能较久/); f.resources.dispose();
});
test('progress is accessible, visibly animated only when indeterminate and respects reduced motion', async () => {
  const css = await readFile(new URL('../src/speech-resources.css', import.meta.url), 'utf8');
  assert.match(raw, /aria-label="本地语音安装进度" aria-describedby="speech-resource-detail speech-resource-progress-label"/);
  assert.match(css, /progress:indeterminate/); assert.match(css, /@keyframes speech-install-activity/);
  assert.match(css, /prefers-reduced-motion: reduce/); assert.match(css, /animation: none/);
});
test('owner blocking prevents synthetic install but never prevents cancellation of existing work', async () => {
  const f = fixture(); f.show(); await tick(); f.resources.setBlocked(true); f.click('install'); assert.equal(f.calls.length, 1);
  f.event(installing()); assert.equal(f.node('cancel').disabled, false); f.click('cancel'); await tick(); assert.equal(f.calls.at(-1).name, 'cancel_speech_install'); f.resources.dispose();
});
