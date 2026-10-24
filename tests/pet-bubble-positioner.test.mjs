import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === './bubble-layout') specifier += '.ts';
  return next(specifier, context);
}, load(url, context, next) {
  if (url.startsWith('file:') && url.endsWith('.ts')) return {
    format: 'module', shortCircuit: true,
    source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText,
  };
  return next(url, context);
} });
const { layoutPetBubbles } = await import('../src/pet/bubble-positioner.ts');
const box = (x,y,width,height) => ({ x,y,left:x,top:y,right:x+width,bottom:y+height,width,height });
function fixture({x=0,y=0,width=360,height=320,anchor=box(112,110,135,130),toolsTop=280}={}) {
  const make = (rect) => ({ hidden:false, dataset:{}, style:{
    getPropertyValue(key) { return this[key] ?? ''; }, setProperty(key,value) { this[key] = value; },
  }, getClientRects() { return this.hidden ? [] : [{}]; }, getBoundingClientRect() { return rect; }, querySelector() { return null; } });
  const host = make(box(x,y,width,height)); const pet = make(anchor); const tools = make(box(0,toolsTop,width,30));
  const bubble = make(box(0,0,324,50)); let naturalHeight = 50;
  bubble.getBoundingClientRect = () => box(parseFloat(bubble.style.left || '0'),parseFloat(bubble.style.top || '0'),parseFloat(bubble.style.width || '324'),bubble.style.height === 'auto' ? Math.min(naturalHeight,parseFloat(bubble.style['max-height'])) : parseFloat(bubble.style.height || naturalHeight));
  const interaction = make(box(0,0,348,256)); interaction.hidden = true;
  let summary = null;
  interaction.querySelector = () => summary;
  interaction.getBoundingClientRect = () => box(0,0,parseFloat(interaction.style.width || '348'),parseFloat(interaction.style.height || '256'));
  const nodes = { '.pet-shell':host, '.pet-tools':tools, '#pet-bubble':bubble, '#pet-interaction':interaction };
  const root = make(box(x,y,width,height)); root.querySelector = selector => nodes[selector] ?? null;
  return {root,pet,bubble,interaction,host, setHeight(value) {naturalHeight=value;}, collapse() {summary=make(box(0,0,120,32)); summary.getBoundingClientRect=()=>box(0,0,120,interaction.style.height === 'auto' ? 10 : 32);}, nodes};
}
const rectOf = node => ({x:parseFloat(node.style.left),y:parseFloat(node.style.top),width:parseFloat(node.style.width),height:parseFloat(node.style.height)});

test('actual measured notification height and pet anchor choose above or below without touching the pet', () => {
  const f=fixture(); layoutPetBubbles(f.root,f.pet);
  assert.equal(f.bubble.dataset.placement,'above'); assert.deepEqual(rectOf(f.bubble),{x:17.5,y:52,width:324,height:50});
  assert.deepEqual(f.pet.style.getPropertyValue('top'),'');
  const g=fixture({anchor:box(112,8,135,40)}); layoutPetBubbles(g.root,g.pet);
  assert.equal(g.bubble.dataset.placement,'below'); assert.equal(rectOf(g.bubble).y,56);
});
test('edge insets and fractional CSS coordinates fit both sides without converting DPI again', () => {
  for (const insets of [{left:112.5,right:0},{left:0,right:112.5}]) {
    const f=fixture(); layoutPetBubbles(f.root,f.pet,insets); const r=rectOf(f.bubble);
    assert.ok(r.x>=insets.left+6); assert.ok(r.x+r.width<=360-insets.right-6);
    assert.equal(r.width,235.5); assert.ok(parseFloat(f.bubble.style['--pet-bubble-arrow-x'])>=14);
  }
});
test('content height changes recalculate position; messages fit the full toolbar-free viewport', () => {
  const f=fixture(); layoutPetBubbles(f.root,f.pet); const first=rectOf(f.bubble);
  f.setHeight(90); layoutPetBubbles(f.root,f.pet); assert.notEqual(rectOf(f.bubble).y,first.y);
  f.setHeight(900); layoutPetBubbles(f.root,f.pet); const r=rectOf(f.bubble);
  assert.equal(r.height,110); assert.ok(r.y>=6); assert.ok(r.y+r.height<=266);
});
test('removed toolbar no longer reserves empty bottom space for interaction bubbles', () => {
  const f=fixture({height:220,toolsTop:60}); f.bubble.hidden=true; f.interaction.hidden=false;
  layoutPetBubbles(f.root,f.pet); assert.equal(rectOf(f.interaction).height,208);
  assert.ok(rectOf(f.interaction).y+rectOf(f.interaction).height<=214);
});

test('expanded interaction fits available height, collapsed summary gets its own measured anchor box', () => {
  const f=fixture(); f.bubble.hidden=true; f.interaction.hidden=false;
  layoutPetBubbles(f.root,f.pet); assert.equal(rectOf(f.interaction).height,256);
  f.collapse(); layoutPetBubbles(f.root,f.pet); assert.equal(rectOf(f.interaction).height,32);
  assert.equal(rectOf(f.interaction).width,120); assert.equal(f.interaction.dataset.placement,'above');
});
test('shell offsets use local coordinates and hidden bubbles or missing hosts are ignored', () => {
  const f=fixture({x:100,y:20,anchor:box(212,130,135,130),toolsTop:300});
  layoutPetBubbles(f.root,f.pet); assert.deepEqual(rectOf(f.bubble),{x:17.5,y:52,width:324,height:50});
  f.bubble.hidden=true; f.setHeight(80); layoutPetBubbles(f.root,f.pet); assert.equal(rectOf(f.bubble).height,50);
  delete f.nodes['.pet-shell']; assert.doesNotThrow(()=>layoutPetBubbles(f.root,f.pet));
});
