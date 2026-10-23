import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Load the actual renderer AND its actual vendored pure imports, not mock selectors.
const modules = new Map();
async function moduleUrl(file) {
  if (modules.has(file.href)) return modules.get(file.href);
  const source = await readFile(file, 'utf8');
  let js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const match of [...js.matchAll(/from ["'](\.[^"']+)["']/g)]) {
    const path = match[1].endsWith('.ts') ? match[1] : match[1] + '.ts';
    const url = await moduleUrl(new URL(path, file));
    js = js.replace(match[0], 'from ' + JSON.stringify(url));
  }
  const url = 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
  modules.set(file.href, url);
  return url;
}
const { PetRenderer, toPetWorkStatus } = await import(await moduleUrl(new URL('../src/pet/renderer.ts', import.meta.url)));
const { squashScale, SQ_DURATION_MS } = await import(await moduleUrl(new URL('../src/vendor/dsh-pet/physics.ts', import.meta.url)));
const { PET_ANIMATIONS } = await import(await moduleUrl(new URL('../src/pet/config.ts', import.meta.url)));

class FakeWindow {
  time = 0; id = 0; timers = new Map(); frames = new Map();
  performance = { now: () => this.time };
  setTimeout = (fn, delay) => { const id = ++this.id; this.timers.set(id, { fn, at: this.time + delay }); return id; };
  clearTimeout = id => this.timers.delete(id);
  requestAnimationFrame = fn => { const id = ++this.id; this.frames.set(id, fn); return id; };
  cancelAnimationFrame = id => this.frames.delete(id);
  matchMedia = () => ({ matches: false });
  tick(ms = 16) {
    this.time += ms;
    const frames = [...this.frames.values()]; this.frames.clear();
    frames.forEach(fn => fn(this.time));
    for (const [id, timer] of [...this.timers]) if (timer.at <= this.time) { this.timers.delete(id); timer.fn(); }
  }
}
class FakeElement {
  style = {}; dataset = {}; attributes = {}; children = []; hidden = false;
  textContent = ''; events = new Map(); parent = null; className = '';
  classes = new Set();
  classList = { add: name => this.classes.add(name), remove: name => this.classes.delete(name), contains: name => this.classes.has(name) };
  constructor(tagName, document) { this.tagName = tagName; this.ownerDocument = document; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; if (name === 'src') this._src = ''; }
  append(...children) { children.forEach(child => { child.parent = this; this.children.push(child); }); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  addEventListener(type, fn) { if (!this.events.has(type)) this.events.set(type, new Set()); this.events.get(type).add(fn); }
  removeEventListener(type, fn) { this.events.get(type)?.delete(fn); }
  emit(type) { for (const fn of [...this.events.get(type) ?? []]) fn(); this['on' + type]?.(); }
}
class FakeVideo extends FakeElement {
  _src = ''; loads = []; readyState = 0; paused = true; playCalls = 0; pauseCalls = 0;
  currentTime = 0; duration = 10; loop = false; frameCallbacks = new Map(); frameId = 0;
  set src(value) { this._src = value; this.readyState = 0; }
  get src() { return this._src; }
  load() { this.loads.push(this.src); this.readyState = 0; this.currentTime = 0; }
  pause() { this.paused = true; this.pauseCalls++; }
  play() { this.playCalls++; this.paused = false; return this.playImpl?.() ?? Promise.resolve(); }
  requestVideoFrameCallback(fn) { const id = ++this.frameId; this.frameCallbacks.set(id, fn); return id; }
  cancelVideoFrameCallback(id) { this.frameCallbacks.delete(id); }
  decoded() { this.readyState = 2; this.emit('loadeddata'); }
  presented() { const callbacks = [...this.frameCallbacks.values()]; this.frameCallbacks.clear(); callbacks.forEach(fn => fn()); }
  ended() { this.currentTime = this.duration; this.emit('ended'); }
}
const animations = {
  idle: ['idle-a', 'idle-b'], turn: ['turn'], clicks: ['click'], drag: ['drag'],
  moves: { default: { minDist: 60, maxDist: 240, leadSec: 2, tailSec: 2 }, actions: [{ name: 'walk', params: { minDist: 80 } }] },
  categories: [{ id: 'normal', weight: 1, actions: ['dance'] }, { id: 'text', weight: 1, noMirror: true, actions: ['lettering'] }],
  events: { workStatus: [['think-a', 'think-b'], ['work-a', 'work-b'], 'result', 'wait', ['success-a', 'success-b'], ['error-a', 'error-b']], whisper: ['whisper'] },
};
function setup(t, options = {}) {
  const view = new FakeWindow();
  const document = { defaultView: view, createElement: tag => tag === 'video' ? new FakeVideo(tag, document) : new FakeElement(tag, document) };
  const root = document.createElement('div');
  const renderer = new PetRenderer(root, { animations, weights: { idle: 100, turn: 0, move: 0 }, assetBase: '/test/', ...options });
  t.after(() => renderer.dispose());
  const videos = root.children.filter(e => e.tagName === 'video');
  return { root, view, renderer, videos, status: root.children.find(e => e.tagName === 'div') };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
async function ready(video) { video.decoded(); await flush(); video.presented(); await flush(); }
function front(env) { return env.videos.find(v => v.style.opacity === '1'); }
function back(env) { return env.videos.find(v => v !== front(env)); }
function name(video) { return video.src ? decodeURIComponent(video.src.split('/').at(-1)).replace(/\.webm$/, '') : ''; }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function random(value, fn) { const old = Math.random; Math.random = () => value; try { await fn(); } finally { Math.random = old; } }
const totalLoads = env => env.videos.flatMap(v => v.loads).filter(Boolean).length;

test('only two real videos; old frame stays visible until decoded, play fulfilled AND presented', async t => {
  const env = setup(t);
  assert.equal(env.videos.length, 2);
  assert.equal(env.videos.filter(v => v.src).length, 1);
  assert.equal(front(env), undefined);
  assert.match(env.status.textContent, /加载/);
  await ready(env.videos[0]);
  const old = front(env);
  assert.equal(name(old), 'idle-a');
  assert.equal(env.status.style.display, 'none');
  for (const v of env.videos) { assert.equal(v.muted, true); assert.equal(v.autoplay, true); assert.equal(v.playsInline, true); }
  const wait = deferred(); back(env).playImpl = () => wait.promise;
  env.renderer.click();
  const target = back(env);
  assert.equal(name(target), 'click');
  target.decoded(); await flush();
  assert.equal(front(env), old);
  wait.resolve(); await flush();
  assert.equal(front(env), old, 'play resolve alone must not show a blank compositor frame');
  target.presented();
  assert.equal(front(env), target);
  assert.equal(old.src, '', 'demoted video decoder released');
  assert.equal(old.onended, null);
  assert.equal(old.paused, true);
  assert.equal(env.view.timers.size, 0);
});

test('older WebViews without video-frame callback still swap after decoded play success', async t => {
  const env = setup(t);
  env.videos[0].requestVideoFrameCallback = undefined;
  env.videos[0].decoded(); await flush();
  assert.equal(front(env), env.videos[0]);
});

test('stale loadeddata, play resolution, video frame and ended cannot replace a newer generation', async t => {
  const env = setup(t);
  await ready(env.videos[0]);
  const old = front(env);
  const staleEnded = old.onended;
  env.renderer.click();
  const target = back(env), delayed = deferred();
  const staleReady = [...target.events.get('loadeddata')][0];
  target.playImpl = () => delayed.promise;
  target.decoded(); await flush();
  env.renderer.dragStart();
  const currentReady = [...target.events.get('loadeddata')][0];
  staleReady(); staleEnded(); delayed.resolve(); await flush();
  assert.equal(target.frameCallbacks.size, 0);
  assert.equal(name(target), 'drag');
  target.playImpl = undefined;
  currentReady(); await flush();
  const staleFrame = [...target.frameCallbacks.values()][0];
  env.renderer.dragEnd();
  staleFrame();
  assert.equal(front(env), old);
  await ready(target);
  assert.ok(name(front(env)).startsWith('idle-'));
  assert.equal(env.root.dataset.petRenderer, 'ready');
});

test('decode error, timeout and late loadeddata show explicit failure, release pending and allow retry', async t => {
  const env = setup(t, { loadTimeoutMs: 50 });
  const target = env.videos[0];
  const stale = [...target.events.get('loadeddata')][0];
  target.emit('error'); stale(); await flush();
  assert.equal(front(env), undefined);
  assert.equal(env.root.dataset.petRenderer, 'error');
  assert.match(env.status.textContent, /加载失败.*video error/);
  assert.equal(env.status.style.display, 'grid');
  assert.equal(target.src, '');
  assert.equal(env.view.timers.size, 0);
  env.renderer.click(); env.view.tick(51);
  assert.match(env.status.textContent, /加载超时/);
  env.renderer.click();
  await ready(target);
  assert.equal(name(front(env)), 'click');
  assert.equal(env.status.hidden, true);
});

test('autoplay rejection and synchronous play failure retain old frame and are not unhandled', async t => {
  for (const playImpl of [() => Promise.reject(new Error('NotAllowedError')), () => { throw new Error('NotSupportedError'); }]) {
    const env = setup(t);
    await ready(env.videos[0]);
    const old = front(env), target = back(env);
    target.playImpl = playImpl;
    env.renderer.click(); target.decoded(); await flush();
    assert.equal(front(env), old);
    assert.equal(env.root.dataset.petRenderer, 'error');
    assert.match(env.status.textContent, /play rejected/);
    assert.equal(target.src, '');
    assert.equal(env.view.timers.size, 0);
  }
});

test('timeout includes stalled first-frame presentation, not merely loadeddata', async t => {
  const env = setup(t, { loadTimeoutMs: 20 });
  const target = env.videos[0]; target.decoded(); await flush();
  const staleFrame = [...target.frameCallbacks.values()][0];
  env.view.tick(21); staleFrame();
  assert.equal(env.root.dataset.petRenderer, 'error');
  assert.equal(front(env), undefined);
  assert.equal(target.frameCallbacks.size, 0);
});

test('weighted idle chain uses upstream pick, excludes last idle and can turn/mirror', async t => {
  const env = setup(t);
  await ready(env.videos[0]);
  await random(0, async () => { front(env).ended(); await ready(back(env)); });
  assert.equal(name(front(env)), 'idle-b');
  env.renderer.trigger('turn'); await ready(back(env));
  front(env).ended();
  assert.equal(env.root.dataset.petFacing, 'right');
  await ready(back(env));
  assert.equal(front(env).style.transform, 'scaleX(-1)');
  assert.equal(env.renderer.trigger('lettering'), true); await ready(back(env));
  assert.equal(env.root.dataset.petFacing, 'left', 'manual noMirror action corrects facing');
});

test('rollKind chooses turn then category; mirrored random chain excludes noMirror category', async t => {
  const weights = { idle: 0, turn: 50, move: 0 };
  const env = setup(t, { weights }); await ready(env.videos[0]);
  await random(0.1, async () => { front(env).ended(); await ready(back(env)); });
  assert.equal(name(front(env)), 'turn');
  await random(0.9, async () => { front(env).ended(); await ready(back(env)); });
  assert.equal(name(front(env)), 'dance', 'noMirror lettering excluded even with high random roll');
});

test('click Q spring samples actual upstream squashScale and click ended returns to idle random chain', async t => {
  const env = setup(t); await ready(env.videos[0]);
  env.renderer.click(); await ready(back(env));
  const clicked = front(env);
  env.view.tick(SQ_DURATION_MS * 0.45);
  assert.equal(clicked.style.transformOrigin, 'bottom');
  assert.equal(clicked.style.transform, ' scaleY(' + squashScale(0.45) + ')');
  env.view.tick(SQ_DURATION_MS);
  assert.equal(clicked.style.transform, '');
  assert.equal(env.view.frames.size, 0);
  clicked.ended(); await ready(back(env));
  assert.match(name(front(env)), /^idle-/);
  front(env).ended(); assert.match(name(back(env)), /^idle-/);
});

test('pending repeated click deduplicates loading but keeps squash; reduced motion suppresses only squash', async t => {
  const env = setup(t, { reducedMotion: true }); await ready(env.videos[0]);
  env.renderer.click(); const count = totalLoads(env);
  env.renderer.click(); assert.equal(totalLoads(env), count);
  await ready(back(env)); assert.equal(env.view.frames.size, 0);
  assert.equal(name(front(env)), 'click');
});

test('six DSH states map to original workStatus slots; revisions do not replay; multi-candidate rotates', async t => {
  const env = setup(t); await ready(env.videos[0]);
  await random(0, async () => {
    env.renderer.updateState({ phase: 'thinking', running: true, connected: true }); await ready(back(env));
    assert.equal(name(front(env)), 'think-a');
    const loads = totalLoads(env);
    for (let revision = 1; revision < 20; revision++) env.renderer.updateState({ phase: 'thinking', running: true, connected: true, revision });
    assert.equal(totalLoads(env), loads);
    front(env).ended(); await ready(back(env));
    assert.equal(name(front(env)), 'think-b', 'nextWorkStatusAnim avoids consecutive repetition');
    for (const [state, expected, loop] of [['working', 'work-a', false], ['result', 'result', true], ['waiting', 'wait', true], ['completed', 'success-a', false], ['error', 'error-a', false]]) {
      env.renderer.updateState({ phase: state, connected: true }); await ready(back(env));
      assert.equal(name(front(env)), expected); assert.equal(front(env).loop, loop);
    }
    front(env).ended(); await ready(back(env));
    assert.match(name(front(env)), /^idle-/, 'terminal error plays once, not the next error candidate');
  });
});

test('click and drag interrupt status and restore its single or rotating pool', async t => {
  const env = setup(t); await ready(env.videos[0]);
  env.renderer.updateState({ waiting: true, connected: true }); await ready(back(env));
  assert.equal(front(env).loop, true);
  env.renderer.click(); await ready(back(env)); front(env).ended(); await ready(back(env));
  assert.equal(name(front(env)), 'wait'); assert.equal(front(env).loop, true);
  env.renderer.dragStart(); await ready(back(env));
  const loads = totalLoads(env); front(env).ended(); assert.equal(totalLoads(env), loads, 'drag guard stops ended chain');
  env.renderer.updateState({ phase: 'working', connected: true });
  assert.equal(totalLoads(env), loads, 'state recorded but does not override active drag');
  env.renderer.dragEnd(); await ready(back(env));
  assert.match(name(front(env)), /^work-/);
  const afterRelease = totalLoads(env); env.renderer.click(); assert.equal(totalLoads(env), afterRelease, 'synthetic post-drag click suppressed');
  env.view.tick(101); env.renderer.click(); assert.equal(name(back(env)), 'click');
});

test('running->ready synthesizes success once, repeated ready does not cancel or replay it', async t => {
  const env = setup(t); await ready(env.videos[0]);
  env.renderer.updateState({ phase: 'ready', running: true, connected: true, session_id: 'a' }); await ready(back(env));
  env.renderer.updateState({ phase: 'ready', running: false, connected: true, session_id: 'a' });
  const loads = totalLoads(env);
  env.renderer.updateState({ phase: 'ready', running: false, connected: true, session_id: 'a', revision: 100 });
  assert.equal(totalLoads(env), loads);
  await ready(back(env)); assert.match(name(front(env)), /^success-/);
  front(env).ended(); await ready(back(env));
  env.renderer.updateState({ phase: 'ready', running: false, connected: true, session_id: 'a', revision: 101 });
  assert.equal(env.root.dataset.petWorkStatus, 'success');
  assert.match(name(front(env)), /^idle-/);
  env.renderer.updateState({ phase: 'ready', connected: true, session_id: 'b' });
  assert.equal(env.root.dataset.petWorkStatus, 'idle');
});

test('disconnect while running is not a successful completion', async t => {
  const env = setup(t); await ready(env.videos[0]);
  env.renderer.updateState({ running: true, connected: true }); await ready(back(env));
  env.renderer.updateState({ running: false, connected: false });
  assert.match(name(back(env)), /^idle-/);
  assert.equal(env.root.dataset.petWorkStatus, 'idle');
});

test('native roam fires only after presentation, receives original params/video clock, cancels on interaction', async t => {
  const moves = [], stops = [];
  const env = setup(t, { weights: { idle: 0, turn: 0, move: 100 }, onMove: (...args) => moves.push(args), onMoveEnd: () => stops.push(true) });
  await ready(env.videos[0]);
  front(env).ended(); assert.equal(name(back(env)), 'walk'); assert.equal(moves.length, 0);
  back(env).decoded(); await flush(); assert.equal(moves.length, 0);
  back(env).presented(); assert.equal(moves.length, 1);
  assert.deepEqual(moves[0][1], { minDist: 80, maxDist: 240, leadSec: 2, tailSec: 2, direction: -1, durationSec: 10 });
  assert.equal(moves[0][2].video, front(env));
  env.renderer.click(); assert.equal(stops.length, 1);
  await ready(back(env));
  env.renderer.trigger('walk'); await ready(back(env)); front(env).ended(); assert.equal(stops.length, 2);
});

test('rejected roam falls through upstream category picker; fixed disables random move/turn, not manual actions', async t => {
  const moves = [];
  const env = setup(t, { weights: { idle: 0, turn: 0, move: 100 }, canMove: () => false, onMove: name => moves.push(name) });
  await ready(env.videos[0]);
  await random(0, async () => { front(env).ended(); await ready(back(env)); });
  assert.equal(name(front(env)), 'dance'); assert.equal(moves.length, 0);
  assert.equal(env.renderer.toggleFixed(), true);
  assert.equal(env.renderer.trigger('turn'), true); await ready(back(env));
  await random(0, async () => { front(env).ended(); await ready(back(env)); });
  assert.equal(name(front(env)), 'dance');
  assert.equal(env.renderer.toggleFixed(false), false);
});

test('onMove false rejection does not leave a native drive running', async t => {
  const env = setup(t, { weights: { idle: 0, turn: 0, move: 100 }, onMove: () => false });
  await ready(env.videos[0]);
  await random(0, async () => { front(env).ended(); await ready(back(env)); });
  assert.equal(name(back(env)), 'dance');
  await ready(back(env)); assert.equal(name(front(env)), 'dance');
});

test('action list includes all configured pools without duplicate names, rejects arbitrary paths', async t => {
  const env = setup(t);
  const list = env.renderer.listActions();
  assert.ok(list.some(a => a.name === 'work-b' && a.group === 'workStatus'));
  assert.ok(list.some(a => a.name === 'lettering' && a.noMirror));
  assert.equal(new Set(list.map(a => a.name)).size, list.length);
  const loads = totalLoads(env);
  for (const bad of ['../etc/passwd', 'https://example.com/x', '<script>', 'unknown']) assert.equal(env.renderer.trigger(bad), false);
  assert.equal(totalLoads(env), loads);
});

test('dispose cancels timers/listeners/decoders/rAF and all late async callbacks', async t => {
  const env = setup(t);
  const target = env.videos[0], delayed = deferred();
  target.playImpl = () => delayed.promise;
  const staleReady = [...target.events.get('loadeddata')][0];
  target.decoded(); await flush();
  env.renderer.dispose(); env.renderer.dispose();
  delayed.reject(new Error('late AbortError')); staleReady(); env.view.tick(20_000); await flush();
  assert.equal(env.root.children.length, 0);
  assert.equal(env.view.timers.size, 0); assert.equal(env.view.frames.size, 0);
  assert.equal(target.src, ''); assert.equal(target.onended, null); assert.equal(target.onerror, null);
  assert.equal(target.events.get('loadeddata').size, 0);
  assert.equal(env.root.dataset.petRenderer, undefined);
  env.renderer.click(); env.renderer.updateState({ phase: 'working' }); env.renderer.dragStart();
  assert.equal(env.root.children.length, 0);
});

test('root replacement disposes an in-flight old renderer (asynchronous HMR safe)', async t => {
  const env = setup(t);
  const oldVideo = env.videos[0], delayed = deferred(); oldVideo.playImpl = () => delayed.promise;
  oldVideo.decoded(); await flush();
  const replacement = new PetRenderer(env.root, { animations, assetBase: '/new/' }); t.after(() => replacement.dispose());
  const replacementVideo = env.root.children.find(v => v.tagName === 'video');
  delayed.resolve(); await flush();
  assert.equal(env.root.children.filter(v => v.tagName === 'video').length, 2);
  assert.equal(oldVideo.frameCallbacks.size, 0);
  await ready(replacementVideo);
  env.renderer.dispose();
  assert.equal(env.root.dataset.petRenderer, 'ready', 'old teardown must not erase replacement ownership');
  assert.equal(replacementVideo.style.opacity, '1');
});

test('default real dsh-pet config resolves encoded URLs and uses the original thinking candidates', async t => {
  const env = setup(t, { animations: PET_ANIMATIONS, assetBase: undefined });
  assert.equal(name(env.videos[0]), PET_ANIMATIONS.idle[0]);
  assert.ok(env.videos[0].src.startsWith('/pet/dsh-pet/webm/'));
  assert.ok(!env.videos[0].src.includes(PET_ANIMATIONS.idle[0]));
  await ready(env.videos[0]);
  env.renderer.updateState({ phase: 'thinking', connected: true }); await ready(back(env));
  assert.ok(PET_ANIMATIONS.events.workStatus[0].includes(name(front(env))));
});

test('state adapter prioritizes error/waiting and preserves original six-slot vocabulary', () => {
  for (const [state, expected] of [[{ phase: 'thinking' }, 'thinking'], [{ running: true }, 'thinking'], [{ phase: 'working' }, 'working'], [{ phase: 'result' }, 'result'], [{ waiting: true, running: true }, 'waiting'], [{ phase: 'completed' }, 'success'], [{ phase: 'failed', running: true }, 'error'], [{ connected: false, running: true }, null], [{ enabled: false, phase: 'working' }, null], [{ workStatus: null }, null]]) assert.equal(toPetWorkStatus(state), expected);
});
