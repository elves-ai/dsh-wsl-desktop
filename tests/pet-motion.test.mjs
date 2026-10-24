import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Compile the actual adapter and its real vendored imports, not substituted physics stubs.
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
const { planMove } = await import('../src/vendor/dsh-pet/motion.ts');
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
class Clock {
  time = 0; next = 0; tasks = new Map();
  now = () => this.time;
  schedule = (callback, delay) => { const id = ++this.next; this.tasks.set(id, { callback, at: this.time + delay }); return id; };
  cancel = id => this.tasks.delete(id);
  async advance(ms = 30) {
    this.time += ms;
    const ready = [...this.tasks.entries()].filter(([, t]) => t.at <= this.time);
    for (const [id, task] of ready) { this.tasks.delete(id); task.callback(); }
    await flush();
  }
}
function fixture(extra = {}, options = {}) {
  const clock = new Clock();
  const g = { position: { x: 100, y: 100 }, size: { width: 200, height: 300 },
    cursor: { x: 140, y: 150 }, scale: 1, areas: [{ x: 0, y: 0, width: 3000, height: 1800 }], cursor_down: true, ...extra };
  const moves = [], active = [], events = [], errors = [];
  const api = {
    getGeometry: async () => structuredClone(g),
    move: async (x, y) => { moves.push({ x, y, t: clock.time }); g.position = { x, y }; return structuredClone(g); },
    setActive: value => { active.push(value); },
    onDragStart: () => events.push('start'), onDragEnd: () => events.push('end'),
    onBounce: () => events.push('bounce'), onError: e => errors.push(e), clock,
    ...options,
  };
  const pet = new PetMotion(api);
  return { pet, g, clock, moves, active, events, errors, api };
}
function integrate(state, dt, bounds, p) {
  const n = physics.throwSubsteps(state.vx, state.vy, dt);
  let result = physics.throwStep(state, dt / n, bounds, p);
  for (let i = 1; i < n && !result.atRest; i++) result = physics.throwStep(result, dt / n, bounds, p);
  return result;
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, actual + ' != ' + expected);

test('disposing before initial geometry settles cannot initialize or schedule motion', async () => {
  const request = deferred(); const f = fixture({}, { getGeometry: () => request.promise });
  await flush(); f.pet.dispose(); request.resolve(structuredClone(f.g)); await flush();
  f.pet.begin(); await f.clock.advance(1000);
  assert.equal(f.pet.startRoam('walk', { minDist: 50, maxDist: 50 }), false);
  assert.equal(f.pet.isActive, false); assert.equal(f.clock.tasks.size, 0);
  assert.deepEqual(f.active, []); assert.deepEqual(f.events, []); assert.deepEqual(f.moves, []);
});

for (const scale of [1, 1.25, 2]) test('ordinary drag directly retains physical grab offset at DPI scale ' + scale, async () => {
  const f = fixture({ scale }); await flush(); f.pet.begin(); await flush();
  const frame = 1000 / 60;
  for (const [x, y, nextScale] of [[170, 140, scale], [240, 190, 2], [-310, -160, 1.25], [400, 110, scale]]) {
    f.g.cursor = { x, y }; f.g.scale = nextScale;
    const count = f.moves.length;
    await f.clock.advance(frame);
    assert.equal(f.moves.length, count + 1);
    near(f.moves.at(-1).x, x - 40); near(f.moves.at(-1).y, y - 50);
  }
  for (let i = 1; i < f.moves.length; i++) near(f.moves[i].t - f.moves[i - 1].t, frame);
  f.pet.dispose(); await flush(); assert.deepEqual(f.active, [true, false]);
});

for (const [readMs, moveMs] of [[5, 7], [12, 24]]) test('frame deadline subtracts geometry/move IPC ' + readMs + '/' + moveMs + 'ms without catch-up backlog', async () => {
  const f = fixture(); await flush(); f.pet.begin(); await flush();
  const frame = 1000 / 60, starts = [];
  const move = f.api.move;
  f.api.getGeometry = async () => { starts.push(f.clock.time); f.clock.time += readMs; return structuredClone(f.g); };
  f.api.move = async (x, y) => { f.clock.time += moveMs; return move(x, y); };
  f.g.cursor.x = 500;
  await f.clock.advance(frame);
  for (let i = 0; i < 4; i++) {
    assert.equal(f.clock.tasks.size, 1);
    const next = [...f.clock.tasks.values()][0];
    near(next.at - f.clock.time, Math.max(0, frame - readMs - moveMs));
    if (next.at > f.clock.time) {
      const count = f.moves.length;
      await f.clock.advance(next.at - f.clock.time - .001);
      assert.equal(f.moves.length, count);
      await f.clock.advance(.001);
    } else await f.clock.advance(0);
    assert.equal(f.moves.length, i + 2);
  }
  for (let i = 1; i < starts.length; i++) near(starts[i] - starts[i - 1], Math.max(frame, readMs + moveMs));
  f.pet.dispose(); await flush();
});

test('geometry and move IPC share one in-flight slot; stalled frames resume from latest cursor only', async () => {
  const f = fixture(); await flush(); f.pet.begin(); await flush();
  const geometry = deferred(), movement = deferred();
  const getGeometry = f.api.getGeometry, move = f.api.move;
  let reads = 0, inFlight = 0, maxFlight = 0;
  f.api.getGeometry = async () => {
    reads++; inFlight++; maxFlight = Math.max(maxFlight, inFlight);
    if (reads === 1) await geometry.promise;
    inFlight--; return getGeometry();
  };
  f.api.move = async (x, y) => {
    inFlight++; maxFlight = Math.max(maxFlight, inFlight);
    if (f.moves.length === 0) await movement.promise;
    inFlight--; return move(x, y);
  };
  await f.clock.advance(1000 / 60);
  for (let i = 0; i < 20; i++) await f.clock.advance();
  assert.equal(reads, 1); assert.equal(f.moves.length, 0); assert.equal(f.clock.tasks.size, 0);
  f.g.cursor.x = 500; geometry.resolve(); await flush();
  for (let i = 0; i < 20; i++) await f.clock.advance();
  assert.equal(reads, 1); assert.equal(f.clock.tasks.size, 0);
  f.g.cursor.x = 900; movement.resolve(); await flush();
  assert.equal(f.moves.length, 1); assert.equal(f.clock.tasks.size, 1);
  await f.clock.advance(0);
  assert.equal(reads, 2); assert.equal(f.moves.length, 2); near(f.moves.at(-1).x, 860);
  assert.equal(maxFlight, 1); assert.equal(f.clock.tasks.size, 1);
  f.pet.dispose(); await flush();
});

test('slingshot cursor spring trajectory is upstream-exact and never rescales cursor pixels', async () => {
  const f = fixture({ scale: 2 }); await flush(); f.pet.begin(true); await flush();
  let state = { x: 100, y: 100, vx: 0, vy: 0 };
  for (const [x, y] of [[170, 140], [240, 190], [310, 160], [400, 110]]) {
    f.g.cursor = { x, y };
    state.vx = physics.springStep(state.vx, state.x, x - 40, .03);
    state.vy = physics.springStep(state.vy, state.y, y - 50, .03);
    state.x += state.vx * .03; state.y += state.vy * .03;
    await f.clock.advance();
    near(f.moves.at(-1).x, state.x); near(f.moves.at(-1).y, state.y);
  }
  assert.deepEqual(f.active, [true]); f.pet.dispose(); await flush();
  assert.deepEqual(f.active, [true, false]);
});

test('native cursor_down releases without DOM pointerup; throw matches upstream estimate/substeps and gravity scales once', async () => {
  const f = fixture({ scale: 2 }); await flush(); f.pet.begin(); await flush();
  const trail = [{ x: 140, y: 150, t: 0 }];
  for (const x of [180, 230, 300]) {
    f.g.cursor.x = x; await f.clock.advance(); trail.push({ x, y: 150, t: f.clock.time });
  }
  f.g.cursor.x = 380; f.g.cursor_down = false;
  await f.clock.advance(); trail.push({ x: 380, y: 150, t: 120 });
  const velocity = physics.estimateReleaseVelocity(physics.trimTrail(trail, 120), 120);
  assert.ok(velocity); assert.deepEqual(f.active, [true, false]);
  assert.deepEqual(f.events, ['start']);
  let state = { ...f.g.position, ...velocity };
  for (let i = 0; i < 8; i++) {
    state = integrate(state, .03, { minX: 0, minY: 0, maxX: 2800, maxY: 1500 }, { ...physics.DEFAULT_PHYSICS, gravity: physics.DEFAULT_PHYSICS.gravity * 2 });
    await f.clock.advance(); near(f.moves.at(-1).x, state.x); near(f.moves.at(-1).y, state.y);
  }
  f.pet.dispose();
});

test('resuming after a long native stall integrates only upstream MAX_STEP_DT, not substep-count times that limit', async () => {
  const f = fixture(); await flush(); f.pet.begin(true); await flush();
  f.g.cursor.x -= 120; f.g.cursor_down = false; await f.clock.advance();
  const velocity = physics.slingshotVelocity(physics.pullAngle(-120, 0), physics.slingshotPower(120, 200));
  const expected = integrate({ ...f.g.position, ...velocity }, physics.MAX_STEP_DT,
    { minX: 0, minY: 0, maxX: 2800, maxY: 1500 }, physics.DEFAULT_PHYSICS);
  await f.clock.advance(10000);
  near(f.moves[0].x, expected.x); near(f.moves[0].y, expected.y); f.pet.dispose();
});

test('ordinary dragging keeps its original grab after native clamp feedback', async () => {
  const f = fixture({ scale: 2 });
  f.api.move = async (x, y) => { f.moves.push({ x, y }); f.g.position = { x: 50, y: 60 }; return structuredClone(f.g); };
  await flush(); f.pet.begin(); await flush();
  f.g.cursor = { x: 700, y: 600 }; await f.clock.advance();
  near(f.moves[0].x, 660); near(f.moves[0].y, 550);
  f.g.cursor = { x: 200, y: 220 }; await f.clock.advance();
  near(f.moves[1].x, 160); near(f.moves[1].y, 170);
  f.pet.dispose(); await flush();
});

test('native full-window clamp feedback, not requested or 16:9 stage position, seeds next spring step', async () => {
  const f = fixture({ scale: 2 });
  f.api.move = async (x, y) => { f.moves.push({ x, y }); f.g.position = { x: 50, y: 60 }; return structuredClone(f.g); };
  await flush(); f.pet.begin(true); await flush(); f.g.cursor = { x: 700, y: 600 };
  await f.clock.advance();
  const vx = physics.springStep(0, 100, 660, .03), vy = physics.springStep(0, 100, 550, .03);
  await f.clock.advance();
  near(f.moves[1].x, 50 + physics.springStep(vx, 50, 660, .03) * .03);
  near(f.moves[1].y, 60 + physics.springStep(vy, 60, 550, .03) * .03);
  f.pet.dispose();
});

test('slingshot is reverse pull, distance based, uncapped, and uses upstream full-window floor', async () => {
  const f = fixture({ position: { x: 1500, y: 1400 }, cursor: { x: 1540, y: 1450 } });
  await flush(); f.pet.begin(true); await flush();
  f.g.cursor = { x: 940, y: 850 }; f.g.cursor_down = false;
  await f.clock.advance();
  const velocity = physics.slingshotVelocity(physics.pullAngle(-600, -600), physics.slingshotPower(Math.hypot(600, 600), 200));
  assert.ok(Math.hypot(velocity.vx, velocity.vy) > physics.MAX_THROW_SPEED);
  const expected = integrate({ x: 1500, y: 1400, ...velocity }, .03,
    { minX: 0, minY: 0, maxX: 2800, maxY: 1500 }, physics.DEFAULT_PHYSICS);
  await f.clock.advance(); near(f.moves[0].x, expected.x); near(f.moves[0].y, expected.y);
  for (let i = 0; i < 1000 && f.pet.isActive; i++) await f.clock.advance();
  assert.equal(f.pet.isActive, false); assert.ok(f.events.includes('bounce'));
  assert.deepEqual(f.events.filter(e => e !== 'bounce'), ['start', 'end']);
  assert.ok(f.moves.every(m => m.y <= 1500));
  f.pet.dispose();
});

for (const kind of ['pause', 'deadzone', 'zero sling']) test(kind + ' places gently without residual spring/throw velocity', async () => {
  const f = fixture(); await flush(); f.pet.begin(kind === 'zero sling'); await flush();
  if (kind === 'pause') {
    f.g.cursor.x += 100; await f.clock.advance();
    for (let i = 0; i < 7; i++) await f.clock.advance();
  } else if (kind === 'deadzone') { f.g.cursor.x += 2; await f.clock.advance(); }
  f.pet.end(); f.pet.end(); await flush();
  const count = f.moves.length; await f.clock.advance(300);
  assert.equal(f.moves.length, count); assert.equal(f.pet.isActive, false);
  assert.deepEqual(f.events, ['start', 'end']); assert.deepEqual(f.active, [true, false]);
  f.pet.dispose();
});

test('end during unresolved begin is remembered, no late drag resurrection', async () => {
  const f = fixture(); await flush(); const request = deferred(); f.api.getGeometry = () => request.promise;
  f.pet.begin(); await flush(); f.pet.end(); assert.equal(f.pet.isActive, true);
  request.resolve(structuredClone(f.g)); await flush(); await f.clock.advance(300);
  assert.equal(f.pet.isActive, false); assert.equal(f.moves.length, 0);
  assert.deepEqual(f.active, [true, false]); assert.deepEqual(f.events, ['start', 'end']);
  f.pet.dispose();
});

test('one serialized move in flight, slow IPC cannot create an unbounded queue; dispose ignores late response', async () => {
  const f = fixture(); const pending = deferred(); let inFlight = 0, maxFlight = 0;
  f.api.move = async (x, y) => { inFlight++; maxFlight = Math.max(maxFlight, inFlight); f.moves.push({ x, y, t: f.clock.time }); await pending.promise; inFlight--; return structuredClone(f.g); };
  await flush(); f.pet.begin(); await flush(); f.g.cursor.x = 500;
  await f.clock.advance(); for (let i = 0; i < 20; i++) await f.clock.advance();
  assert.equal(f.moves.length, 1); assert.equal(maxFlight, 1); assert.equal(f.clock.tasks.size, 0);
  f.pet.dispose(); pending.resolve(); await flush(); await f.clock.advance(1000);
  assert.equal(f.moves.length, 1); assert.equal(f.pet.isActive, false); assert.equal(f.clock.tasks.size, 0);
  assert.deepEqual(f.active, [true, false]); assert.deepEqual(f.events, ['start', 'end']);
});

test('dispose after active=true issued compensates once, even if its RPC resolves late', async () => {
  const pending = deferred(); const active = [];
  const f = fixture({}, { setActive: async value => { active.push(value); if (value) await pending.promise; } });
  await flush(); f.pet.begin(); await flush(); f.pet.dispose(); f.pet.dispose();
  pending.resolve(); await flush(); await f.clock.advance(1000);
  assert.deepEqual(active, [true, false]); assert.equal(f.moves.length, 0); assert.equal(f.clock.tasks.size, 0);
});

test('stop/new begin serializes generations and stale geometry cannot reset new grab', async () => {
  const f = fixture(); await flush(); const old = deferred(); let reads = 0;
  f.api.getGeometry = () => ++reads === 1 ? old.promise : Promise.resolve(structuredClone(f.g));
  f.pet.begin(); await flush(); f.pet.stop(); f.g.position.x = 600; f.g.cursor.x = 640; f.pet.begin();
  old.resolve({ ...structuredClone(f.g), position: { x: -999, y: -999 } }); await flush();
  f.g.cursor.x = 740; await f.clock.advance();
  near(f.moves[0].x, 700);
  assert.deepEqual(f.active, [true, false, true]); f.pet.dispose(); await flush();
  assert.deepEqual(f.active, [true, false, true, false]);
});

for (const failAt of ['getGeometry', 'move', 'setActive']) test(failAt + ' rejection cleans pointer mode, animation, timers and reports once', async () => {
  const f = fixture(); await flush(); f.pet.begin(); await flush();
  f.api[failAt] = async () => { throw new Error('native failure'); };
  f.g.cursor.x = 600;
  if (failAt === 'setActive') f.pet.end(); else await f.clock.advance();
  await flush(); const count = f.moves.length; await f.clock.advance(1000);
  assert.equal(f.pet.isActive, false); assert.equal(f.clock.tasks.size, 0); assert.equal(f.moves.length, count);
  assert.deepEqual(f.events, ['start', 'end']); assert.ok(f.errors.length >= 1);
  if (failAt !== 'setActive') assert.deepEqual(f.active, [true, false]);
  f.pet.dispose();
});

test('negative-screen video roaming uses upstream planMove and lead/travel/tail media time, not wall time', async () => {
  const f = fixture({ position: { x: -1500, y: -200 }, areas: [{ x: -2000, y: -500, width: 2000, height: 1400 }] });
  await flush(); const video = { duration: 10, currentTime: 0 };
  const params = { minDist: 231, maxDist: 231, margin: 20, leadSec: 2, tailSec: 2 };
  const plan = planMove({ cx: 600, cy: 450, W: 2000, H: 1400, dir: 1, minDist: 100, maxDist: 100, margin: 20, halfW: 100 });
  assert.ok(plan); assert.equal(f.pet.startRoam('walk', params, 'right', undefined, video), true);
  await f.clock.advance(10000); assert.equal(f.moves.length, 0);
  video.currentTime = 5; await f.clock.advance(); near(f.moves[0].x, -1450);
  video.currentTime = 8; await f.clock.advance(); near(f.moves.at(-1).x, -2000 + plan.targetRatio * 2000 - 100);
  assert.equal(f.pet.isActive, false); assert.deepEqual(f.active, []); assert.deepEqual(f.events, []);
  f.pet.dispose();
});

test('roam stop is nonrecursive, stopped late RPC cannot resurrect; boundary/gap target is rejected', async () => {
  const f = fixture({ position: { x: 2750, y: 100 }, areas: [{ x: 0, y: 0, width: 3000, height: 1800 }, { x: 4000, y: -1000, width: 2000, height: 2000 }] });
  await flush(); assert.equal(f.pet.startRoam('walk', { minDist: 3000, maxDist: 3000 }, 'right'), false);
  const pending = deferred(); f.api.move = () => pending.promise;
  assert.equal(f.pet.startRoam('walk', { minDist: 100, maxDist: 100 }, 'left'), true);
  await f.clock.advance(); f.pet.stopRoam(); f.pet.stopRoam(); pending.resolve(structuredClone(f.g));
  await flush(); await f.clock.advance(1000); assert.equal(f.pet.isActive, false); assert.equal(f.clock.tasks.size, 0);
  assert.deepEqual(f.events, []); f.pet.dispose();
});

for (const inset of [NaN, Infinity, -1, 100, 101]) test('invalid horizontal inset is rejected: ' + inset, async () => {
  const f = fixture({ horizontal_inset: inset }); await flush();
  assert.equal(f.errors.length, 1); assert.match(f.errors[0].message, /Invalid native pet geometry/);
  assert.equal(f.pet.isActive, false); assert.equal(f.clock.tasks.size, 0);
  f.pet.dispose();
});

for (const scale of [1, 2]) for (const side of ['left', 'right']) test('physical inset permits ' + side + ' edge throw on negative mixed-DPI screen at scale ' + scale, async () => {
  const width = 200 * scale, height = 300 * scale, inset = width * 200 / 640;
  const bounds = { minX: -2000 - inset, minY: -500, maxX: -width + inset, maxY: 900 - height };
  const x = side === 'left' ? bounds.minX : bounds.maxX;
  const f = fixture({ position: { x, y: 100 }, cursor: { x: x + 40, y: 150 },
    size: { width, height }, scale, horizontal_inset: inset,
    areas: [{ x: -2000, y: -500, width: 2000, height: 1400 }, { x: 0, y: 0, width: 3000, height: 1800 }] });
  await flush(); f.pet.begin(true); await flush();
  const pull = side === 'left' ? 120 : -120;
  f.g.cursor.x += pull; f.g.cursor_down = false; await f.clock.advance();
  const velocity = physics.slingshotVelocity(physics.pullAngle(pull, 0), physics.slingshotPower(120, width));
  const expected = integrate({ x, y: 100, ...velocity }, .03, bounds,
    { ...physics.DEFAULT_PHYSICS, gravity: physics.DEFAULT_PHYSICS.gravity * scale });
  await f.clock.advance();
  near(f.moves[0].x, expected.x); near(f.moves[0].y, expected.y);
  assert.ok(f.events.includes('bounce'));
  f.pet.dispose(); await flush();
});

for (const scale of [1, 2]) for (const side of ['left', 'right']) test('roam reaches visual ' + side + ' edge without rescaling native inset at scale ' + scale, async () => {
  const width = 200 * scale, inset = width * 200 / 640;
  const edge = side === 'left' ? -2000 - inset : -width + inset;
  const start = edge + (side === 'left' ? 100 : -100) * scale;
  const f = fixture({ position: { x: start, y: 0 }, size: { width, height: 300 * scale },
    horizontal_inset: inset, scale,
    areas: [{ x: -2000, y: -500, width: 2000, height: 1400 }, { x: 0, y: 0, width: 3000, height: 1800 }] });
  await flush();
  const params = { minDist: 231, maxDist: 231 };
  assert.equal(f.pet.startRoam('walk', params, side, 1), true);
  await f.clock.advance(1000); near(f.moves[0].x, edge);
  assert.equal(f.pet.isActive, false);
  assert.equal(f.pet.startRoam('walk', params, side, 1), false);
  f.pet.dispose(); await flush();
});

test('drag can cross to another monitor, then throw stays inside its actual full-window work area', async () => {
  const f = fixture({ areas: [{ x: 0, y: 0, width: 1000, height: 1800 }, { x: 1000, y: 0, width: 2000, height: 1800 }] });
  await flush(); f.pet.begin(); await flush();
  for (let i = 0; i < 10; i++) { f.g.cursor.x = 2400; await f.clock.advance(); }
  assert.ok(f.moves.some(m => m.x >= 1000));
  f.g.cursor.x = 2500; await f.clock.advance(); f.g.cursor.x = 2600; f.g.cursor_down = false; await f.clock.advance();
  const start = f.moves.length;
  for (let i = 0; i < 30; i++) await f.clock.advance();
  assert.ok(f.moves.slice(start).every(m => m.x >= 1000 && m.x <= 2800 && m.y <= 1500));
  f.pet.dispose();
});
