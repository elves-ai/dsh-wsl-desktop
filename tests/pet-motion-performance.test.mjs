import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Exercise the real adapter and upstream physics; no substituted motion implementation.
registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.ts')) return {
    format: 'module', shortCircuit: true,
    source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText,
  };
  return nextLoad(url, context);
} });
const { PetMotion } = await import('../src/pet/motion.ts');
const physics = await import('../src/vendor/dsh-pet/physics.ts');
const FRAME = 1000 / 60;
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, actual + ' != ' + expected);
class Clock {
  time = 0; id = 0; tasks = new Map();
  now = () => this.time;
  schedule = (callback, delay) => { const id = ++this.id; this.tasks.set(id, { callback, at: this.time + delay }); return id; };
  cancel = id => this.tasks.delete(id);
  async advance(ms = FRAME) {
    this.time += ms;
    const ready = [...this.tasks].filter(([, task]) => task.at <= this.time);
    for (const [id, task] of ready) { this.tasks.delete(id); task.callback(); }
    await flush();
  }
  async frame() {
    assert.equal(this.tasks.size, 1, 'exactly one future frame, never a backlog');
    const at = Math.min(...[...this.tasks.values()].map(task => task.at));
    await this.advance(Math.max(0, at - this.time));
  }
}
function fixture({ fused = true, geometry = {} } = {}) {
  const clock = new Clock();
  const g = { position: { x: 100, y: 100 }, cursor: { x: 140, y: 150 }, size: { width: 200, height: 300 }, scale: 1,
    areas: [{ x: 0, y: 0, width: 3000, height: 1800 }], cursor_down: true, ...geometry };
  const calls = [], nativeMoves = [], moves = [], active = [], events = [], errors = [];
  let inFlight = 0, maxFlight = 0;
  const clone = () => structuredClone(g);
  // Native-like individual-work-area clamping, physical rounding and no-op movement skip.
  const applyPosition = (x, y) => {
    const inset = g.horizontal_inset ?? 0;
    let position, best = Infinity;
    for (const a of g.areas) {
      const p = { x: Math.round(x), y: Math.round(y) };
      p.x = Math.max(Math.ceil(a.x - inset), Math.min(Math.floor(a.x + a.width - g.size.width + inset), p.x));
      p.y = Math.max(Math.ceil(a.y), Math.min(Math.floor(a.y + a.height - g.size.height), p.y));
      const distance = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (distance < best) { best = distance; position = p; }
    }
    assert.ok(position);
    if (position.x !== g.position.x || position.y !== g.position.y) {
      nativeMoves.push({ ...position, t: clock.time }); g.position = position;
    }
  };
  const impl = {
    getGeometry: async () => clone(),
    drag: async (grabX, grabY) => { if (g.cursor_down) applyPosition(g.cursor.x - grabX, g.cursor.y - grabY); return clone(); },
    move: async (x, y) => { moves.push({ x, y, t: clock.time }); applyPosition(x, y); return clone(); },
    setActive: async value => { active.push(value); },
  };
  const track = kind => async (...args) => {
    calls.push({ kind, args, t: clock.time }); ++inFlight; maxFlight = Math.max(maxFlight, inFlight);
    try { return await impl[kind](...args); } finally { --inFlight; }
  };
  const options = { getGeometry: track('getGeometry'), move: track('move'), setActive: track('setActive'),
    clock, onDragStart: () => events.push('start'), onDragEnd: () => events.push('end'), onError: error => errors.push(error) };
  if (fused) options.drag = track('drag');
  const pet = new PetMotion(options);
  return { pet, g, impl, clock, calls, nativeMoves, moves, active, events, errors,
    clone, defaultDrag: impl.drag, count: kind => calls.filter(call => call.kind === kind).length,
    get maxFlight() { return maxFlight; }, get inFlight() { return inFlight; } };
}
async function begin(f, sling = false) { await flush(); f.pet.begin(sling); await flush(); }
async function dispose(f) { f.pet.dispose(); await flush(); }
function integrate(state, dt, bounds, params = physics.DEFAULT_PHYSICS) {
  const count = physics.throwSubsteps(state.vx, state.vy, dt);
  let result = physics.throwStep(state, dt / count, bounds, params);
  for (let i = 1; i < count && !result.atRest; i++) result = physics.throwStep(result, dt / count, bounds, params);
  return result;
}

test('120 ordinary drag frames use exactly one fused RPC each, with no per-frame geometry/read-move pair', async () => {
  const f = fixture(); await begin(f); const reads = f.count('getGeometry');
  for (let frame = 1; frame <= 120; frame++) {
    f.g.cursor.x = 140 + frame * 3; await f.clock.frame();
    assert.equal(f.count('drag'), frame); near(f.g.position.x, 100 + frame * 3);
    near(f.clock.time, frame * FRAME);
  }
  assert.equal(f.count('getGeometry'), reads); assert.equal(f.count('move'), 0);
  assert.equal(f.maxFlight, 1); assert.equal(f.nativeMoves.length, 120);
  assert.deepEqual(f.active, [true]); await dispose(f); assert.deepEqual(f.active, [true, false]);
});

test('fused ticks preserve the original physical grab across clamp feedback, negative monitors and DPI changes', async () => {
  const f = fixture({ geometry: { position: { x: -1800, y: -300 }, cursor: { x: -1760, y: -250 }, scale: 2,
    areas: [{ x: -2000, y: -500, width: 2000, height: 1800 }, { x: 0, y: 0, width: 3000, height: 1800 }] } });
  await begin(f);
  for (const [x, y, scale, expected] of [[-2500, -800, 2, { x: -2000, y: -500 }], [-1500, -100, 1.25, { x: -1540, y: -150 }], [700, 600, 1, { x: 660, y: 550 }]]) {
    f.g.cursor = { x, y }; f.g.scale = scale; await f.clock.frame();
    assert.deepEqual(f.g.position, expected); assert.deepEqual(f.calls.filter(call => call.kind === 'drag').at(-1).args, [40, 50]);
  }
  await dispose(f);
});

test('stationary drag still polls fused native state but performs no native move and detects release', async () => {
  const f = fixture(); await begin(f);
  for (let i = 0; i < 15; i++) await f.clock.frame();
  assert.equal(f.count('drag'), 15); assert.equal(f.nativeMoves.length, 0); assert.equal(f.count('move'), 0);
  f.g.cursor_down = false; await f.clock.frame();
  assert.equal(f.count('drag'), 16); assert.equal(f.nativeMoves.length, 0); assert.equal(f.pet.isActive, false);
  assert.deepEqual(f.active, [true, false]); assert.deepEqual(f.events, ['start', 'end']); assert.equal(f.clock.tasks.size, 0);
  await dispose(f); assert.deepEqual(f.active, [true, false]);
});

test('fused native release samples the final cursor once and preserves upstream release velocity and throw integration', async () => {
  const f = fixture(); await begin(f); const trail = [{ x: 140, y: 150, t: 0 }];
  for (const x of [180, 230, 300]) { f.g.cursor.x = x; await f.clock.frame(); trail.push({ x, y: 150, t: f.clock.time }); }
  const position = { ...f.g.position };
  f.g.cursor.x = 380; f.g.cursor_down = false; await f.clock.frame(); trail.push({ x: 380, y: 150, t: f.clock.time });
  const velocity = physics.estimateReleaseVelocity(physics.trimTrail(trail, f.clock.time), f.clock.time);
  assert.ok(velocity); assert.deepEqual(f.g.position, position, 'native fused call must not move after mouse-up');
  assert.deepEqual(f.active, [true, false]); assert.deepEqual(f.events, ['start']);
  const fusedCalls = f.count('drag');
  const expected = integrate({ ...position, ...velocity }, FRAME / 1000, { minX: 0, minY: 0, maxX: 2800, maxY: 1500 });
  await f.clock.frame(); near(f.moves[0].x, expected.x); near(f.moves[0].y, expected.y);
  assert.equal(f.count('drag'), fusedCalls, 'throw must use movement RPC, not fused dragging');
  f.pet.end(); await flush(); assert.deepEqual(f.active, [true, false]); assert.equal(f.maxFlight, 1); await dispose(f);
});

test('stationary fused samples retain moving timestamps: short pauses preserve exact velocity, stale pauses do not throw', async () => {
  for (const pauseFrames of [2, 12]) {
    const f = fixture(); await begin(f); const trail = [{ x: 140, y: 150, t: 0 }];
    for (const x of [180, 230, 300]) { f.g.cursor.x = x; await f.clock.frame(); trail.push({ x, y: 150, t: f.clock.time }); }
    for (let i = 0; i < pauseFrames; i++) await f.clock.frame();
    const position = { ...f.g.position }; f.g.cursor_down = false; await f.clock.frame();
    const velocity = physics.estimateReleaseVelocity(physics.trimTrail(trail, f.clock.time), f.clock.time);
    if (pauseFrames === 2) {
      assert.ok(velocity);
      const expected = integrate({ ...position, ...velocity }, FRAME / 1000, { minX: 0, minY: 0, maxX: 2800, maxY: 1500 });
      await f.clock.frame(); near(f.moves[0].x, expected.x); near(f.moves[0].y, expected.y);
    } else {
      assert.equal(velocity, null); assert.equal(f.pet.isActive, false); assert.equal(f.count('move'), 0);
      assert.equal(f.clock.tasks.size, 0); assert.deepEqual(f.events, ['start', 'end']);
    }
    await dispose(f);
  }
});

test('DOM end during an unresolved fused RPC releases exactly once and cannot schedule another drag frame', async () => {
  const f = fixture(); await begin(f); const pending = deferred();
  f.impl.drag = async () => { await pending.promise; return f.clone(); };
  const reads = f.count('getGeometry'); await f.clock.frame();
  assert.equal(f.inFlight, 1); f.pet.end(); f.pet.end(); f.g.cursor_down = false;
  for (let i = 0; i < 8; i++) await f.clock.advance(100);
  assert.equal(f.count('drag'), 1); assert.equal(f.clock.tasks.size, 0);
  pending.resolve(); await flush();
  assert.equal(f.pet.isActive, false); assert.deepEqual(f.active, [true, false]); assert.deepEqual(f.events, ['start', 'end']);
  assert.equal(f.count('getGeometry'), reads, 'queued DOM end is redundant after fused response releases');
  assert.equal(f.clock.tasks.size, 0); assert.equal(f.maxFlight, 1); await dispose(f);
});

test('dispose ignores a late fused response and compensates active state exactly once', async () => {
  const f = fixture(); await begin(f); const pending = deferred(); f.impl.drag = () => pending.promise;
  await f.clock.frame(); f.pet.dispose(); f.pet.dispose();
  pending.resolve({ ...f.clone(), position: { x: -999, y: -999 } }); await flush(); await f.clock.advance(1000);
  assert.equal(f.count('drag'), 1); assert.equal(f.count('move'), 0); assert.equal(f.pet.isActive, false);
  assert.deepEqual(f.active, [true, false]); assert.deepEqual(f.events, ['start', 'end']); assert.equal(f.clock.tasks.size, 0);
});

test('old fused response cannot reset the grab of a queued new generation; all geometry and movement remain serialized', async () => {
  const f = fixture(); await begin(f); const pending = deferred(); f.impl.drag = () => pending.promise;
  await f.clock.frame(); f.pet.stop(); f.g.position = { x: 600, y: 100 }; f.g.cursor = { x: 640, y: 150 }; f.pet.begin();
  await flush(); assert.equal(f.count('getGeometry'), 2, 'new begin waits behind old native work'); assert.equal(f.inFlight, 1);
  f.impl.drag = f.defaultDrag; pending.resolve({ ...f.clone(), position: { x: -999, y: -999 }, cursor: { x: -400, y: -400 } }); await flush();
  f.g.cursor.x = 740; await f.clock.frame();
  assert.deepEqual(f.calls.filter(call => call.kind === 'drag').at(-1).args, [40, 50]); assert.equal(f.g.position.x, 700);
  assert.equal(f.maxFlight, 1); assert.deepEqual(f.active, [true, false, true]);
  await dispose(f); assert.deepEqual(f.active, [true, false, true, false]);
});

for (const latency of [7, 35]) test('fused latency ' + latency + 'ms consumes frame budget without timer backlogs or catch-up RPC bursts', async () => {
  const f = fixture(); await begin(f); const starts = []; f.g.cursor.x = 500;
  f.impl.drag = async (...args) => { starts.push(f.clock.time); f.clock.time += latency; return f.defaultDrag(...args); };
  for (let i = 0; i < 6; i++) {
    await f.clock.frame(); assert.equal(f.count('drag'), i + 1); assert.equal(f.clock.tasks.size, 1);
    const next = [...f.clock.tasks.values()][0]; near(next.at - f.clock.time, Math.max(0, FRAME - latency));
  }
  for (let i = 1; i < starts.length; i++) near(starts[i] - starts[i - 1], Math.max(FRAME, latency));
  assert.equal(f.maxFlight, 1); assert.equal(f.count('move'), 0); await dispose(f);
});

test('a stalled fused RPC does not accumulate frames and the following native call uses the freshest cursor', async () => {
  const f = fixture(); await begin(f); const pending = deferred(); let first = true;
  f.impl.drag = async (...args) => { if (first) { first = false; await pending.promise; } return f.defaultDrag(...args); };
  await f.clock.frame(); for (let i = 0; i < 30; i++) await f.clock.advance(100);
  assert.equal(f.count('drag'), 1); assert.equal(f.clock.tasks.size, 0); assert.equal(f.maxFlight, 1);
  f.g.cursor.x = 800; pending.resolve(); await flush(); assert.equal(f.g.position.x, 760);
  f.g.cursor.x = 900; await f.clock.frame(); assert.equal(f.count('drag'), 2); assert.equal(f.g.position.x, 860);
  assert.equal(f.clock.tasks.size, 1); await dispose(f);
});

test('fused failure stops animation, timer and active pointer mode without retrying or moving', async () => {
  const f = fixture(); await begin(f); f.impl.drag = async () => { throw new Error('fused failure'); };
  await f.clock.frame(); await f.clock.advance(1000);
  assert.equal(f.count('drag'), 1); assert.equal(f.count('move'), 0); assert.equal(f.pet.isActive, false);
  assert.equal(f.clock.tasks.size, 0); assert.deepEqual(f.active, [true, false]); assert.deepEqual(f.events, ['start', 'end']);
  assert.equal(f.errors.length, 1); assert.match(f.errors[0].message, /fused failure/); await dispose(f);
});

for (const bad of [undefined, { scale: NaN }]) test('invalid fused native geometry is rejected atomically: ' + String(bad), async () => {
  const f = fixture(); await begin(f); f.impl.drag = async () => bad ? { ...f.clone(), ...bad } : bad;
  await f.clock.frame(); await f.clock.advance(1000);
  assert.equal(f.count('drag'), 1); assert.equal(f.count('move'), 0); assert.equal(f.pet.isActive, false);
  assert.equal(f.errors.length, 1); assert.match(f.errors[0].message, /Invalid native pet geometry/);
  assert.deepEqual(f.active, [true, false]); assert.equal(f.clock.tasks.size, 0); await dispose(f);
});

test('slingshot deliberately bypasses fused dragging and retains upstream spring trajectory', async () => {
  const f = fixture(); await begin(f, true); const reads = f.count('getGeometry'); f.g.cursor.x = 300;
  await f.clock.frame(); const vx = physics.springStep(0, 100, 260, FRAME / 1000);
  assert.equal(f.count('drag'), 0); assert.equal(f.count('getGeometry'), reads + 1); assert.equal(f.count('move'), 1);
  near(f.moves[0].x, 100 + vx * FRAME / 1000); await dispose(f);
});

test('roaming uses existing move RPC and never starts fused pointer dragging', async () => {
  const f = fixture(); await flush(); const video = { duration: 2, currentTime: 0 };
  assert.equal(f.pet.startRoam('walk', { minDist: 100, maxDist: 100 }, 'right', undefined, video), true);
  video.currentTime = 1; await f.clock.frame(); assert.equal(f.count('move'), 1); assert.equal(f.count('drag'), 0);
  assert.deepEqual(f.active, []); await dispose(f);
});

test('hosts without an optional fused API retain the existing ordinary drag fallback', async () => {
  const f = fixture({ fused: false }); await begin(f); const reads = f.count('getGeometry'); f.g.cursor = { x: 300, y: 240 };
  await f.clock.frame(); assert.equal(f.count('drag'), 0); assert.equal(f.count('getGeometry'), reads + 1); assert.equal(f.count('move'), 1);
  assert.deepEqual(f.g.position, { x: 260, y: 190 }); assert.equal(f.maxFlight, 1); await dispose(f);
});
