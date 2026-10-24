import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Exercise the actual pure TypeScript export, not a copied placement algorithm.
registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.ts')) return {
    format: 'module', shortCircuit: true,
    source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText,
  };
  return nextLoad(url, context);
} });
const { placePetBubble } = await import('../src/pet/bubble-layout.ts');
const bounds = { x: 0, y: 0, width: 360, height: 260 };
const anchor = { x: 120, y: 150, width: 120, height: 70 };
const preferred = { width: 200, height: 100 };
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, actual + ' != ' + expected);
function bounded(result, b) {
  assert.ok(result);
  assert.ok(result.x >= b.x - 1e-9); assert.ok(result.y >= b.y - 1e-9);
  assert.ok(result.x + result.width <= b.x + b.width + 1e-9);
  assert.ok(result.y + result.height <= b.y + b.height + 1e-9);
  assert.ok(result.width > 0); assert.ok(result.height > 0);
  const mx = Math.min(14, result.width / 2), my = Math.min(14, result.height / 2);
  assert.ok(result.arrowX >= mx && result.arrowX <= result.width - mx);
  assert.ok(result.arrowY >= my && result.arrowY <= result.height - my);
}

test('centered notification prefers above with exactly eight CSS pixels of gap', () => {
  assert.deepEqual(placePetBubble(anchor, preferred, bounds), {
    x: 80, y: 42, width: 200, height: 100, side: 'above', arrowX: 100, arrowY: 86,
  });
});

test('above wins even when below also fits', () => {
  const b = { ...bounds, height: 500 };
  assert.equal(placePetBubble(anchor, preferred, b).side, 'above');
});

test('anchor near screen top places below without clipping', () => {
  const a = { ...anchor, y: 5 };
  const result = placePetBubble(a, preferred, bounds);
  assert.deepEqual(result, { x: 80, y: 83, width: 200, height: 100, side: 'below', arrowX: 100, arrowY: 14 });
  bounded(result, bounds);
});

for (const [x, expectedX, expectedArrow] of [[0, 0, 30], [300, 160, 170]]) test('above bubble clamps secondary axis at horizontal edge ' + x, () => {
  const result = placePetBubble({ ...anchor, x, width: 60 }, preferred, bounds);
  assert.equal(result.side, 'above'); assert.equal(result.x, expectedX); assert.equal(result.arrowX, expectedArrow);
  assert.equal(result.y, 42); bounded(result, bounds);
});

test('below bubble also clamps horizontal secondary axis at either edge', () => {
  for (const [x, expectedX] of [[0, 0], [300, 160]]) {
    const result = placePetBubble({ ...anchor, x, y: 0, width: 60 }, preferred, bounds);
    assert.equal(result.side, 'below'); assert.equal(result.x, expectedX); bounded(result, bounds);
  }
});

for (const [x, side, expectedX] of [[260, 'right', 348], [100, 'right', 188], [420, 'left', 272]]) test('horizontal side chooses more available space and right on a tie: anchor ' + x, () => {
  const b = { x: 0, y: 0, width: 600, height: 180 };
  const a = { x, y: 50, width: 80, height: 80 };
  const result = placePetBubble(a, { width: 140, height: 100 }, b);
  assert.equal(result.side, side); assert.equal(result.x, expectedX); assert.equal(result.y, 40);
  assert.equal(side === 'right' ? result.x - a.x - a.width : a.x - result.x - result.width, 8);
  bounded(result, b);
});

test('side bubbles clamp the vertical secondary axis against actual available span', () => {
  const b = { x: 0, y: 0, width: 600, height: 180 };
  for (const [y, expectedY] of [[-50, 0], [130, 20]]) {
    const result = placePetBubble({ x: 260, y, width: 80, height: 100 }, { width: 140, height: 160 }, b);
    assert.equal(result.side, 'right'); assert.equal(result.y, expectedY); bounded(result, b);
  }
});

test('a side requires the entire width plus gap, not merely positive spare room', () => {
  const b = { x: 0, y: 0, width: 600, height: 180 };
  const result = placePetBubble({ x: 260, y: 50, width: 80, height: 80 }, { width: 253, height: 100 }, b);
  assert.equal(result.side, 'overlay'); bounded(result, b);
});

test('exact fit includes the eight pixel primary gap', () => {
  const a = { x: 120, y: 108, width: 120, height: 70 };
  assert.equal(placePetBubble(a, preferred, bounds).side, 'above');
  assert.equal(placePetBubble(a, preferred, bounds).y, 0);
  const b = { x: 0, y: 0, width: 600, height: 180 };
  const result = placePetBubble({ x: 260, y: 50, width: 80, height: 80 }, { width: 252, height: 100 }, b);
  assert.equal(result.side, 'right'); assert.equal(result.x + result.width, 600);
});

test('bounded overlay resolves equal overlap toward centered above deterministically', () => {
  const b = { x: 0, y: 0, width: 100, height: 100 };
  const result = placePetBubble({ x: 30, y: 25, width: 40, height: 50 }, { width: 80, height: 70 }, b);
  assert.deepEqual(result, { x: 10, y: 0, width: 80, height: 70, side: 'overlay', arrowX: 40, arrowY: 50 });
  bounded(result, b);
});

test('overlay considers corners to reduce overlap rather than always centering on anchor', () => {
  const b = { x: 0, y: 0, width: 100, height: 100 };
  const result = placePetBubble({ x: 40, y: 25, width: 40, height: 50 }, { width: 60, height: 70 }, b);
  assert.equal(result.side, 'overlay'); assert.equal(result.x, 0); assert.equal(result.y, 0); bounded(result, b);
});

test('overlay chooses bottom corner when that overlaps less than all top candidates', () => {
  const b = { x: 0, y: 0, width: 100, height: 100 };
  const result = placePetBubble({ x: 40, y: 10, width: 40, height: 50 }, { width: 60, height: 70 }, b);
  assert.equal(result.side, 'overlay'); assert.equal(result.x, 0); assert.equal(result.y, 30); bounded(result, b);
});

test('oversized expanded interaction shrinks to available width and height', () => {
  const b = { x: 112, y: 4, width: 248, height: 256 };
  const result = placePetBubble(anchor, { width: 600, height: 800 }, b);
  assert.equal(result.side, 'overlay');
  assert.deepEqual({ x: result.x, y: result.y, width: result.width, height: result.height }, b);
  bounded(result, b);
});

test('size is shrunk before fitting: too-wide notification can still go above', () => {
  const result = placePetBubble(anchor, { width: 900, height: 100 }, bounds);
  assert.equal(result.side, 'above'); assert.equal(result.width, 360); assert.equal(result.x, 0);
  bounded(result, bounds);
});

test('negative work-area relative origins are preserved without assuming zero', () => {
  const b = { x: -220, y: -90, width: 360, height: 260 };
  const a = { x: -100, y: 60, width: 120, height: 70 };
  const result = placePetBubble(a, preferred, b);
  assert.deepEqual(result, { x: -140, y: -48, width: 200, height: 100, side: 'above', arrowX: 100, arrowY: 86 });
  bounded(result, b);
});

test('fractional DPI CSS geometry is neither rounded nor scaled a second time', () => {
  const b = { x: 112.5, y: 3.25, width: 247.5, height: 256.5 };
  const a = { x: 150.25, y: 160.75, width: 70.5, height: 60.25 };
  const result = placePetBubble(a, { width: 180.5, height: 90.25 }, b);
  assert.equal(result.side, 'above'); near(result.x, 112.5); near(result.y, 62.5);
  near(result.width, 180.5); near(result.height, 90.25); near(result.arrowX, 73);
  bounded(result, b);
});

test('arrow tracks anchor center while staying fourteen pixels clear of corners', () => {
  const result = placePetBubble({ x: -20, y: 150, width: 10, height: 70 }, preferred, bounds);
  assert.equal(result.side, 'above'); assert.equal(result.arrowX, 14); assert.equal(result.arrowY, 86);
  const right = placePetBubble({ x: 370, y: 150, width: 10, height: 70 }, preferred, bounds);
  assert.equal(right.arrowX, 186); bounded(right, bounds);
});

test('tiny bubble arrow falls back to half width/height instead of impossible corner margin', () => {
  const b = { x: -1.25, y: 2.5, width: 10, height: 8 };
  const result = placePetBubble({ x: 0, y: 3, width: 3, height: 2 }, { width: 100, height: 100 }, b);
  assert.equal(result.side, 'overlay'); assert.equal(result.arrowX, 5); assert.equal(result.arrowY, 4);
  bounded(result, b);
});

for (const invalid of [0, -1, NaN, Infinity, -Infinity, undefined, '100']) test('rejects invalid dimensions ' + String(invalid), () => {
  for (const key of ['width', 'height']) {
    assert.equal(placePetBubble({ ...anchor, [key]: invalid }, preferred, bounds), null);
    assert.equal(placePetBubble(anchor, { ...preferred, [key]: invalid }, bounds), null);
    assert.equal(placePetBubble(anchor, preferred, { ...bounds, [key]: invalid }), null);
  }
});

for (const invalid of [NaN, Infinity, -Infinity, undefined, '0']) test('rejects invalid coordinate ' + String(invalid), () => {
  for (const key of ['x', 'y']) {
    assert.equal(placePetBubble({ ...anchor, [key]: invalid }, preferred, bounds), null);
    assert.equal(placePetBubble(anchor, preferred, { ...bounds, [key]: invalid }), null);
  }
});

test('missing objects and overflowing finite rectangle endpoints fail closed', () => {
  for (const invalid of [null, undefined, {}]) {
    assert.equal(placePetBubble(invalid, preferred, bounds), null);
    assert.equal(placePetBubble(anchor, invalid, bounds), null);
    assert.equal(placePetBubble(anchor, preferred, invalid), null);
  }
  const overflow = { x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: 1 };
  assert.equal(placePetBubble(overflow, preferred, bounds), null);
  assert.equal(placePetBubble(anchor, preferred, overflow), null);
});

test('frozen inputs are not mutated and repeated placement returns equal fresh results', () => {
  const a = Object.freeze({ ...anchor }), p = Object.freeze({ ...preferred }), b = Object.freeze({ ...bounds });
  const before = JSON.stringify([a, p, b]); const first = placePetBubble(a, p, b);
  for (let i = 0; i < 20; i++) {
    const next = placePetBubble(a, p, b); assert.deepEqual(next, first); assert.notEqual(next, first);
  }
  assert.equal(JSON.stringify([a, p, b]), before);
});

test('grid of anchors and sizes stays bounded with deterministic arrows and no input mutation', () => {
  const b = { x: -112.5, y: 4.25, width: 247.5, height: 256.5 };
  for (const x of [-150, -112.5, -20.25, 100, 180]) for (const y of [-30, 4.25, 80.5, 200, 280]) {
    for (const [width, height] of [[10, 8], [100.5, 60.25], [220, 240], [600, 800]]) {
      const a = Object.freeze({ x, y, width: 80.5, height: 70.25 });
      const p = Object.freeze({ width, height });
      const result = placePetBubble(a, p, Object.freeze(b));
      bounded(result, b); assert.deepEqual(placePetBubble(a, p, b), result);
    }
  }
});
