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
  pet.getBoundingClientRect = () => box(anchor.x, anchor.y - (parseFloat(host.style['--pet-composer-space']) || 0), anchor.width, anchor.height);
  const bubble = make(box(0,0,324,50)); let naturalHeight = 50;
  bubble.getBoundingClientRect = () => box(parseFloat(bubble.style.left || '0'),parseFloat(bubble.style.top || '0'),parseFloat(bubble.style.width || '324'),bubble.style.height === 'auto' ? Math.min(naturalHeight,parseFloat(bubble.style['max-height'])) : parseFloat(bubble.style.height || naturalHeight));
  const interaction = make(box(0,0,348,256)); interaction.hidden = true;
  let summary = null;
  interaction.querySelector = () => summary;
  interaction.getBoundingClientRect = () => box(0,0,parseFloat(interaction.style.width || '348'),parseFloat(interaction.style.height || '256'));
  const dialogue = make(box(0,0,324,128)); dialogue.hidden=true;
  dialogue.getBoundingClientRect=()=>box(0,0,parseFloat(dialogue.style.width||'324'),Math.min(dialogue.dataset.expanded==='true'?256:128,parseFloat(dialogue.style['max-height']||'128')));
  const nodes = { '#pet-dialogue':dialogue, '.pet-shell':host, '.pet-tools':tools, '#pet-bubble':bubble, '#pet-interaction':interaction };
  const root = make(box(x,y,width,height)); root.querySelector = selector => nodes[selector] ?? null;
  return {root,pet,bubble,interaction,dialogue,host, setHeight(value) {naturalHeight=value;}, collapse() {summary=make(box(0,0,120,32)); summary.getBoundingClientRect=()=>box(0,0,120,interaction.style.height === 'auto' ? 10 : 32);}, nodes};
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
  layoutPetBubbles(f.root,f.pet); assert.equal(rectOf(f.interaction).height,280);
  f.collapse(); layoutPetBubbles(f.root,f.pet); assert.equal(rectOf(f.interaction).height,32);
  assert.equal(rectOf(f.interaction).width,120); assert.equal(f.interaction.dataset.placement,'above');
});
test('speech expansion follows measured overflow instead of message kind or character count', () => {
  const f=fixture(); f.bubble.hidden=true; f.dialogue.hidden=false;
  const expand={hidden:false};
  const attributes=new Map();
  const text={scrollHeight:40,clientHeight:40,scrollWidth:180,clientWidth:180,
    setAttribute:(name,value)=>attributes.set(name,value),removeAttribute:name=>attributes.delete(name)};
  f.dialogue.querySelector=selector=>selector==='#pet-speech-expand'?expand:selector==='#pet-speech-text'?text:null;
  layoutPetBubbles(f.root,f.pet); assert.equal(expand.hidden,true);
  f.dialogue.dataset.kind='error'; text.scrollHeight=400;
  layoutPetBubbles(f.root,f.pet); assert.equal(expand.hidden,false,'long errors can be read in full too');
  f.dialogue.dataset.expanded='true'; text.scrollHeight=40;
  layoutPetBubbles(f.root,f.pet); assert.equal(expand.hidden,false);assert.equal(attributes.get('tabindex'),'0');
  f.dialogue.dataset.expanded='false';text.scrollWidth=800;
  layoutPetBubbles(f.root,f.pet); assert.equal(expand.hidden,false);assert.equal(attributes.has('tabindex'),false);
  text.scrollWidth=180;
  layoutPetBubbles(f.root,f.pet); assert.equal(expand.hidden,true,'short new content removes stale expand action');
});

test('readable speech height is not reduced to a sliver when input occupies the feet', () => {
  for (const height of [320,240]) for (const insets of [{left:0,right:0},{left:112.5,right:0},{left:0,right:112.5}]) {
    const f=fixture({height,anchor:box(112,142,135,160)});f.bubble.hidden=true;f.dialogue.hidden=false;
    const composer={hidden:false,dataset:{},style:{getPropertyValue(key){return this[key]??'';},setProperty(key,value){this[key]=value;}},
      getClientRects:()=>[{}],getBoundingClientRect:()=>box(0,height-106,324,100)};
    f.nodes['#pet-composer']=composer;
    layoutPetBubbles(f.root,f.pet,insets);
    const compact=rectOf(f.dialogue);assert.ok(compact.height>=100);
    assert.ok(compact.y+compact.height<=height-114,'speech never covers input');
    assert.equal(parseFloat(f.host.style['--pet-composer-space']),302-(height-106)+8);
    assert.equal(f.pet.getBoundingClientRect().bottom + 8, composer.getBoundingClientRect().top);
    assert.equal(composer.style['max-height'],'128px');
    f.dialogue.dataset.expanded='true';layoutPetBubbles(f.root,f.pet,insets);
    const expanded=rectOf(f.dialogue);
    assert.ok(expanded.y+expanded.height<=height-114);assert.ok(expanded.x>=insets.left+6);
    assert.ok(expanded.x+expanded.width<=360-insets.right-6);
  }
});

test('real feet reservation leaves a 62px speech bubble above the head and is stable across relayouts', () => {
  for (const offset of [0,20]) for (const insets of [{left:0,right:0},{left:112.5,right:0},{left:0,right:112.5}]) {
    // Actual 360x320 stage geometry: the hit box ends 14.0625px above the video bottom.
    const f=fixture({y:offset,anchor:box(112.5,offset+141.625,135,160.3125)});
    f.bubble.hidden=true;f.dialogue.hidden=false;
    f.dialogue.getBoundingClientRect=()=>box(0,0,324,62);
    const composer={hidden:false,dataset:{},style:{getPropertyValue(key){return this[key]??'';},setProperty(key,value){this[key]=value;}},
      getClientRects:()=>composer.hidden?[]:[{}],getBoundingClientRect:()=>box(0,offset+238,324,76)};
    f.nodes['#pet-composer']=composer;
    for (let pass=0;pass<4;pass++) {
      layoutPetBubbles(f.root,f.pet,insets);
      const speech=rectOf(f.dialogue),pet=f.pet.getBoundingClientRect();
      assert.equal(speech.height,62,'do not shrink the header or the readable text line');
      assert.equal(parseFloat(f.host.style['--pet-composer-space']),71.9375);
      assert.equal(pet.bottom+8,composer.getBoundingClientRect().top,'reserve only the real feet clearance');
      assert.ok(speech.y+speech.height<=pet.top-offset,'speech must not cover the head');
      assert.ok(speech.x>=insets.left+6);assert.ok(speech.x+speech.width<=360-insets.right-6);
    }
    composer.hidden=true;layoutPetBubbles(f.root,f.pet,insets);
    assert.equal(f.host.style['--pet-composer-space'],'0px');
    assert.equal(f.pet.getBoundingClientRect().top,offset+141.625,'closing input restores the resting pet');
    composer.hidden=false;layoutPetBubbles(f.root,f.pet,insets);
    assert.equal(parseFloat(f.host.style['--pet-composer-space']),71.9375,'reopening input uses the same reservation');
  }
});

test('shell offsets use local coordinates and hidden bubbles or missing hosts are ignored', () => {
  const f=fixture({x:100,y:20,anchor:box(212,130,135,130),toolsTop:300});
  layoutPetBubbles(f.root,f.pet); assert.deepEqual(rectOf(f.bubble),{x:17.5,y:52,width:324,height:50});
  f.bubble.hidden=true; f.setHeight(80); layoutPetBubbles(f.root,f.pet); assert.equal(rectOf(f.bubble).height,50);
  delete f.nodes['.pet-shell']; assert.doesNotThrow(()=>layoutPetBubbles(f.root,f.pet));
});

test('inline conversation fits above the pet at either screen edge and expanded text stays bounded',()=>{
  for(const insets of [{left:0,right:0},{left:112.5,right:0},{left:0,right:112.5}]){
    const f=fixture({anchor:box(112.5,142,135,160)});f.bubble.hidden=true;f.dialogue.hidden=false;
    layoutPetBubbles(f.root,f.pet,insets);const compact=rectOf(f.dialogue);
    assert.equal(f.dialogue.dataset.placement,'above');assert.ok(compact.y+compact.height<=134);
    assert.ok(compact.x>=insets.left+6);assert.ok(compact.x+compact.width<=360-insets.right-6);
    f.dialogue.dataset.expanded='true';layoutPetBubbles(f.root,f.pet,insets);const full=rectOf(f.dialogue);
    assert.equal(full.height,256);assert.ok(full.y>=6);assert.ok(full.y+full.height<=314);
    assert.deepEqual(f.pet.style.getPropertyValue('top'),'');
  }
});
