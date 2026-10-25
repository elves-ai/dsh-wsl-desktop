import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = ts.transpileModule(readFileSync(new URL('../src/pet/menu.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { PetMenuController } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const flush = async () => { for (let i=0;i<12;i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject}; };
const box = (left,top,width,height) => ({left,top,x:left,y:top,width,height,right:left+width,bottom:top+height});
class Events {
  handlers = new Map();
  addEventListener(name, callback, capture=false) { if(!this.handlers.has(name))this.handlers.set(name,[]);this.handlers.get(name).push({callback,capture}); }
  removeEventListener(name, callback, capture=false) { this.handlers.set(name,(this.handlers.get(name)??[]).filter(item=>item.callback!==callback||item.capture!==capture)); }
  emit(name, extra={}) { const event={target:this,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},...extra};for(const {callback} of [...(this.handlers.get(name)??[])])callback(event);return event; }
  get count() { return [...this.handlers.values()].reduce((count,items)=>count+items.length,0); }
}
class Clock {
  time=0; next=0; tasks=new Map(); cancelled=[];
  schedule=(callback,delay)=>{const id=this.next++;this.tasks.set(id,{callback,at:this.time+delay,delay});return id;};
  cancel=id=>{this.cancelled.push(id);this.tasks.delete(id);};
  async advance(ms=80) {this.time+=ms;for(const [id,task]of [...this.tasks])if(task.at<=this.time){this.tasks.delete(id);task.callback();}await flush();}
}
function fixture(options={}) {
  const document=new Events(),view=new Events();document.defaultView=view;
  const clock=new Clock(),changes=[];let measured=0,parentReads=0;
  const parent={getBoundingClientRect(){parentReads++;return box(10,20,360,320);}};
  const child={},menu={ownerDocument:document,parentElement:parent,offsetParent:parent,hidden:true,style:{},
    contains(target){return target===this||target===child;},
    getBoundingClientRect(){measured++;const left=this.style.left===undefined?20:parseFloat(this.style.left)+10;
      const top=this.style.top===undefined?30:parseFloat(this.style.top)+20;
      const width=options.menuWidth??172,height=options.menuHeight??100;
      return box(left,top,Math.min(width,parseFloat(this.style.maxWidth)||width),Math.min(height,parseFloat(this.style.maxHeight)||height));},
  };
  const controller=new PetMenuController(menu,{clock,onChange:open=>changes.push(open),...options});
  return {controller,menu,child,document,view,clock,changes,parent,get measured(){return measured;},get parentReads(){return parentReads;}};
}
const geometry=(patch={})=>({position:{x:-200,y:100},cursor:{x:-140,y:180},scale:2,cursor_down:false,escape_down:false,...patch});
const bounds={x:6,y:6,width:348,height:280};

// A sibling-aware DOM mock. Sizes are explicit rendered CSS border boxes, not a CSS engine.
class MenuElement extends Events {
  children=[]; attributes=new Map(); hidden=false; disabled=false; style={}; reads=0; tagName='DIV';
  constructor(document, width=0, height=0) { super(); this.ownerDocument=document;this.width=width;this.height=height; }
  append(child) { child.parentElement=this;child.offsetParent=this;this.children.push(child);return child; }
  contains(target) { return target===this||this.children.some(child=>child.contains(target)); }
  setAttribute(name,value) { this.attributes.set(name,String(value)); }
  getAttribute(name) { return this.attributes.get(name)??null; }
  matches(selector) {
    if(selector==='button, [role="menuitem"], [role="switch"]')return this.tagName==='BUTTON'||['menuitem','switch'].includes(this.getAttribute('role'));
    if(selector==='[role="menuitem"]')return this.getAttribute('role')==='menuitem';
    if(selector==='[hidden]')return this.hidden;
    if(selector==='[data-submenu-back]')return this.attributes.has('data-submenu-back');
    if(selector===':disabled, [aria-disabled="true"]')return this.disabled||this.getAttribute('aria-disabled')==='true';
    throw new Error('Unsupported selector: '+selector);
  }
  closest(selector) { return this.matches(selector)?this:this.parentElement?.closest(selector)??null; }
  querySelectorAll(selector) { return this.children.flatMap(child=>[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]); }
  emit(name,extra={}) {
    const event=super.emit(name,extra);
    if(['pointerover','focusin','click'].includes(name))this.parentElement?.emit(name,event);
    return event;
  }
  focus() { this.ownerDocument.activeElement=this;this.emit('focusin'); }
  getBoundingClientRect() {
    this.reads++;
    if(this.closest('[hidden]'))return box(0,0,0,0);
    const parent=this.offsetParent?.getBoundingClientRect()??box(0,0,0,0);
    return box(parent.left+(parseFloat(this.style.left)||0),parent.top+(parseFloat(this.style.top)||0),
      Math.min(this.width,parseFloat(this.style.maxWidth)||this.width),Math.min(this.height,parseFloat(this.style.maxHeight)||this.height));
  }
}
function submenuFixture(options={}) {
  const document=new Events(),view=new Events();document.defaultView=view;
  const root=new MenuElement(document,360,320);
  root.style.left=(options.origin?.x??0)+'px';root.style.top=(options.origin?.y??0)+'px';
  const menu=root.append(new MenuElement(document,196,options.menuHeight??200));
  const row=parent=>{const item=parent.append(new MenuElement(document,100,24));item.tagName='BUTTON';item.setAttribute('role','menuitem');return item;};
  const other=row(menu),trigger=row(menu),plain=row(menu);
  other.setAttribute('role','switch');trigger.attributes.delete('role');plain.attributes.delete('role');
  trigger.style.top=(options.triggerOffset??40)+'px';
  const triggerIcon=trigger.append(new MenuElement(document));
  const panel=root.append(new MenuElement(document,148,options.subHeight??240));
  const back=row(panel);back.setAttribute('data-submenu-back','');
  const backIcon=back.append(new MenuElement(document));
  const group=panel.append(new MenuElement(document));group.setAttribute('role','group');
  const first=row(group),disabled=row(group),hidden=row(group),last=row(group);
  disabled.disabled=true;hidden.hidden=true;
  const clock=new Clock(),changes=[],layouts=[];
  const controller=new PetMenuController(menu,{clock,onChange:open=>changes.push(open),
    onLayout:()=>layouts.push(!panel.hidden),...options,submenu:{trigger,panel}});
  const key=(key,target=document.activeElement??trigger,extra={})=>document.emit('keydown',{key,target,...extra});
  const open=(x=6,y=6)=>{controller.toggle(x,y);trigger.emit('pointerenter');};
  return {controller,document,view,clock,menu,trigger,triggerIcon,panel,other,plain,back,backIcon,group,first,disabled,hidden,last,changes,layouts,key,open};
}
const visibleBounds={x:6,y:6,width:348,height:308};
const assertInside=(panel,bounds=visibleBounds)=>{
  const rect=panel.getBoundingClientRect();
  assert.ok(rect.left>=bounds.x&&rect.right<=bounds.x+bounds.width,JSON.stringify(rect));
  assert.ok(rect.top>=bounds.y&&rect.bottom<=bounds.y+bounds.height,JSON.stringify(rect));
};

test('initial menu stays hidden; toggles and close report exactly one transition without preview polling',async()=>{
  const f=fixture();assert.equal(f.menu.hidden,true);assert.deepEqual(f.changes,[]);assert.equal(f.clock.tasks.size,0);
  f.controller.close();f.controller.toggle(100,120);assert.equal(f.menu.hidden,false);assert.deepEqual(f.changes,[true]);
  assert.equal(f.clock.tasks.size,0);f.controller.toggle();f.controller.close();assert.deepEqual(f.changes,[true,false]);
  f.controller.dispose();assert.equal(f.document.count,0);assert.equal(f.view.count,0);
});
test('outside left pointer closes, inside pointer and non-left clicks do not; listeners use capture',()=>{
  const f=fixture();assert.equal(f.document.handlers.get('pointerdown')[0].capture,true);
  f.controller.toggle();f.document.emit('pointerdown',{button:0,target:f.child});assert.equal(f.menu.hidden,false);
  f.document.emit('pointerdown',{button:0,target:f.menu});assert.equal(f.menu.hidden,false);
  f.document.emit('pointerdown',{button:2,target:{}});assert.equal(f.menu.hidden,false);
  f.document.emit('pointerdown',{button:1,target:{}});assert.equal(f.menu.hidden,false);
  f.document.emit('pointerdown',{button:0,target:{}});assert.equal(f.menu.hidden,true);assert.deepEqual(f.changes,[true,false]);
  f.controller.dispose();
});
test('inline composer boundary keeps adjacent speech actions stable for DOM and native clicks',async()=>{
  const action={},boundary={contains:target=>target===action,getBoundingClientRect:()=>box(10,10,200,220)};
  let g=geometry({cursor_down:true,cursor:{x:100,y:20},position:{x:0,y:0},scale:1});
  const f=fixture({dismissBoundary:boundary,getGeometry:async()=>g});f.controller.toggle();
  f.document.emit('pointerdown',{button:0,target:action});assert.equal(f.menu.hidden,false);
  await f.clock.advance();assert.equal(f.menu.hidden,false,'native clicks in speech do not close and move the composer');
  g={...g,cursor:{x:500,y:500}};await f.clock.advance();assert.equal(f.menu.hidden,true);f.controller.dispose();
});

test('separate speech boundary never excludes the composer itself from DOM or native input', async () => {
  const boundary = {hidden:false, contains:()=>false, getBoundingClientRect:()=>box(10,10,200,80)};
  let g=geometry({cursor_down:true,cursor:{x:80,y:220},position:{x:0,y:0},scale:1});
  const f=fixture({dismissBoundary:boundary,getGeometry:async()=>g});
  f.menu.getBoundingClientRect=()=>box(20,200,300,70);
  f.controller.toggle();
  f.document.emit('pointerdown',{button:0,target:f.child});
  assert.equal(f.menu.hidden,false,'input and send buttons stay active outside the speech rectangle');
  await f.clock.advance(); assert.equal(f.menu.hidden,false);
  g={...g,cursor:{x:80,y:40}};await f.clock.advance();assert.equal(f.menu.hidden,false);
  boundary.hidden=true;await f.clock.advance();assert.equal(f.menu.hidden,true);
  f.controller.dispose();
});

test('right pointerdown then contextmenu toggle closes instead of reopening',()=>{
  const f=fixture();f.controller.toggle();f.document.emit('pointerdown',{button:2,target:{}});
  f.controller.toggle(30,40);assert.equal(f.menu.hidden,true);assert.deepEqual(f.changes,[true,false]);f.controller.dispose();
});
test('Escape and meaningful window blur close; unrelated keys and descendant blur do not',()=>{
  const f=fixture();f.controller.toggle();f.document.emit('keydown',{key:'Enter'});assert.equal(f.menu.hidden,false);
  f.document.emit('keydown',{key:'Escape'});assert.equal(f.menu.hidden,true);
  f.controller.toggle();f.view.emit('blur',{target:f.child});assert.equal(f.menu.hidden,false);
  f.view.emit('blur');assert.equal(f.menu.hidden,true);assert.deepEqual(f.changes,[true,false,true,false]);f.controller.dispose();
});
test('position opens near the pointer with offset-parent-relative coordinates',()=>{
  const f=fixture();f.controller.toggle(80,90);f.controller.position(bounds);
  assert.equal(f.menu.style.left,'70px');assert.equal(f.menu.style.top,'70px');
  assert.equal(f.menu.style.maxWidth,'348px');assert.equal(f.menu.style.maxHeight,'280px');
  assert.equal(f.menu.style.right,'auto');assert.equal(f.menu.style.bottom,'auto');assert.equal(f.menu.style.width,undefined);
  f.controller.dispose();
});
test('position clamps right edge and prefers opening upward when bottom space is insufficient',()=>{
  const f=fixture();f.controller.toggle(300,270);f.controller.position(bounds,{x:0,y:0});
  assert.equal(f.menu.style.left,'182px');assert.equal(f.menu.style.top,'170px');
  f.controller.position({x:112.5,y:6,width:235.5,height:210},{x:0,y:0});
  assert.equal(f.menu.style.left,'176px');assert.equal(f.menu.style.top,'116px');f.controller.dispose();
});
test('fractional pointer/bounds and negative parent origins are not rounded or DPI-scaled',()=>{
  const f=fixture();f.controller.toggle(260.25,100.5);f.controller.position({x:112.5,y:6.25,width:235.5,height:220.5},{x:-80.25,y:-20.5});
  assert.equal(f.menu.style.left,'256.25px');assert.equal(f.menu.style.top,'121px');f.controller.dispose();
});
test('position without a pointer uses current bounds center; tiny bounds cap the entire menu',()=>{
  const f=fixture();f.controller.toggle();f.controller.position({x:6,y:6,width:100,height:60},{x:0,y:0});
  assert.equal(f.menu.style.left,'6px');assert.equal(f.menu.style.top,'6px');
  assert.equal(f.menu.style.maxWidth,'100px');assert.equal(f.menu.style.maxHeight,'60px');
  f.controller.position(bounds,{x:0,y:0});assert.equal(f.menu.style.left,'180px');assert.equal(f.menu.style.top,'146px');f.controller.dispose();
});
test('invalid pointer pair falls back to bounds center and parentElement origin is supported',()=>{
  const f=fixture();f.menu.offsetParent=null;f.controller.toggle(NaN,20);f.controller.position(bounds);
  assert.equal(f.menu.style.left,'170px');assert.equal(f.menu.style.top,'126px');assert.equal(f.parentReads,1);f.controller.dispose();
});
test('polished 196px menu fits all corners of 360x320 and caps tiny visible bounds',()=>{
  // Explicit rendered-size inputs: this mock does not evaluate CSS.
  for(const [x,y] of [[6,6],[354,6],[6,314],[354,314]]) {
    const f=fixture({menuWidth:196,menuHeight:286});
    f.controller.toggle(x,y);f.controller.position({x:6,y:6,width:348,height:308},{x:0,y:0});
    const left=parseFloat(f.menu.style.left),top=parseFloat(f.menu.style.top);
    assert.ok(left>=6&&left+196<=354);assert.ok(top>=6&&top+286<=314);
    f.controller.position({x:112,y:6,width:140,height:100},{x:0,y:0});
    assert.equal(f.menu.style.maxWidth,'140px');assert.equal(f.menu.style.maxHeight,'100px');
    assert.equal(f.menu.style.left,'112px');assert.equal(f.menu.style.top,'6px');
    f.controller.dispose();
  }
});

test('hidden or closed positioning does no layout reads or writes',()=>{
  const f=fixture();f.controller.position(bounds);assert.equal(f.measured,0);assert.equal(f.parentReads,0);assert.deepEqual(f.menu.style,{});
  f.controller.toggle();f.menu.hidden=true;f.controller.position(bounds);assert.equal(f.measured,0);assert.deepEqual(f.menu.style,{});f.controller.dispose();
});
for(const patch of [{x:NaN},{y:Infinity},{width:0},{height:-1},{width:Infinity},{x:Number.MAX_VALUE,width:Number.MAX_VALUE}])test('invalid positioning bounds are ignored: '+JSON.stringify(patch),()=>{
  const f=fixture();f.controller.toggle();f.controller.position({...bounds,...patch});assert.equal(f.measured,0);assert.equal(f.parentReads,0);assert.deepEqual(f.menu.style,{});f.controller.dispose();
});
test('invalid origins and zero-sized measured menus do not write positions',()=>{
  const f=fixture();f.controller.toggle();f.controller.position(bounds,{x:NaN,y:0});assert.deepEqual(f.menu.style,{});
  f.menu.getBoundingClientRect=()=>box(0,0,0,0);f.controller.position(bounds);assert.equal(f.menu.style.left,undefined);assert.equal(f.menu.style.top,undefined);f.controller.dispose();
});
test('native polling starts after 80ms and converts physical negative-screen pixels using scale once',async()=>{
  let reads=0,current=geometry({cursor_down:true});const f=fixture({getGeometry:async()=>{reads++;return current;}});
  assert.equal(reads,0);f.controller.toggle();assert.equal(f.clock.tasks.size,1);await f.clock.advance(79);assert.equal(reads,0);
  await f.clock.advance(1);assert.equal(reads,1);assert.equal(f.menu.hidden,false); // CSS (30,40) is inside (20,30)..(192,130).
  current=geometry({cursor_down:true,cursor:{x:-162,y:180}});await f.clock.advance();assert.equal(f.menu.hidden,true); // CSS x=19, outside.
  assert.deepEqual(f.changes,[true,false]);assert.equal(f.clock.tasks.size,0);f.controller.dispose();
});
test('native cursor movement without left down is ignored; native Escape dismisses without DOM focus',async()=>{
  let current=geometry({cursor:{x:-9999,y:-9999}});const f=fixture({getGeometry:async()=>current});f.controller.toggle();await f.clock.advance();
  assert.equal(f.menu.hidden,false);current={escape_down:true};await f.clock.advance();assert.equal(f.menu.hidden,true);assert.equal(f.clock.tasks.size,0);f.controller.dispose();
});
for(const [name,point] of [['left',{x:19.99,y:40}],['right',{x:192,y:40}],['top',{x:30,y:29.99}],['bottom',{x:30,y:130}]])test('native pressed cursor outside '+name+' boundary closes',async()=>{
  const f=fixture({getGeometry:async()=>geometry({cursor_down:true,cursor:{x:-200+point.x*2,y:100+point.y*2}})});f.controller.toggle();await f.clock.advance();assert.equal(f.menu.hidden,true);f.controller.dispose();
});
test('native menu top-left pixel is inside',async()=>{
  const f=fixture({getGeometry:async()=>geometry({cursor_down:true,cursor:{x:-160,y:160}})});f.controller.toggle();await f.clock.advance();assert.equal(f.menu.hidden,false);f.controller.dispose();
});
test('slow native requests are serialized with no timer backlog and reschedule after settling',async()=>{
  const pending=deferred();let reads=0,inFlight=0,maxFlight=0;
  const f=fixture({getGeometry:async()=>{reads++;inFlight++;maxFlight=Math.max(maxFlight,inFlight);await pending.promise;inFlight--;return geometry();}});
  f.controller.toggle();await f.clock.advance();for(let i=0;i<20;i++)await f.clock.advance();
  assert.equal(reads,1);assert.equal(maxFlight,1);assert.equal(f.clock.tasks.size,0);
  pending.resolve();await flush();assert.equal(f.clock.tasks.size,1);assert.equal([...f.clock.tasks.values()][0].at,f.clock.time+80);
  await f.clock.advance();assert.equal(reads,2);assert.equal(maxFlight,1);f.controller.dispose();
});
test('late prior-generation outside/escape response cannot close a reopened menu or overlap a new request',async()=>{
  const old=deferred();let reads=0;const f=fixture({getGeometry:()=>++reads===1?old.promise:Promise.resolve(geometry())});
  f.controller.toggle();await f.clock.advance();f.controller.close();f.controller.toggle(50,60);
  for(let i=0;i<5;i++)await f.clock.advance();assert.equal(reads,1);assert.equal(f.clock.tasks.size,0);
  old.resolve(geometry({escape_down:true,cursor_down:true,cursor:{x:-9999,y:-9999}}));await flush();
  assert.equal(f.menu.hidden,false);assert.deepEqual(f.changes,[true,false,true]);assert.equal(f.clock.tasks.size,1);
  await f.clock.advance();assert.equal(reads,2);assert.equal(f.menu.hidden,false);f.controller.dispose();
});
test('close cancels even timer handle zero and old pending responses cannot recreate polling',async()=>{
  const f=fixture({getGeometry:async()=>geometry()});f.controller.toggle();f.controller.close();assert.deepEqual(f.clock.cancelled,[0]);await f.clock.advance(800);assert.equal(f.clock.tasks.size,0);f.controller.dispose();
  const pending=deferred();const g=fixture({getGeometry:()=>pending.promise});g.controller.toggle();await g.clock.advance();g.controller.close();pending.resolve(geometry());await flush();assert.equal(g.clock.tasks.size,0);assert.equal(g.menu.hidden,true);g.controller.dispose();
});
test('native rejection is handled and polling recovers while explicit close remains available',async()=>{
  let reads=0;const f=fixture({getGeometry:async()=>{if(++reads===1)throw new Error('native read failed');return geometry();}});
  f.controller.toggle();await f.clock.advance();assert.equal(f.menu.hidden,false);assert.equal(f.clock.tasks.size,1);
  await f.clock.advance();assert.equal(reads,2);f.document.emit('keydown',{key:'Escape'});assert.equal(f.clock.tasks.size,0);assert.equal(f.menu.hidden,true);f.controller.dispose();
});
for(const patch of [null,{}, {cursor_down:true,scale:0},geometry({cursor_down:true,scale:NaN}),geometry({cursor_down:true,cursor:{x:Infinity,y:0}})])test('malformed native geometry cannot dismiss or poison the poll loop: '+JSON.stringify(patch),async()=>{
  const f=fixture({getGeometry:async()=>patch});f.controller.toggle();await f.clock.advance();assert.equal(f.menu.hidden,false);assert.equal(f.clock.tasks.size,1);f.controller.dispose();
});
test('external hiding is reconciled once by native polling without reading hidden menu geometry',async()=>{
  let reads=0;const f=fixture({getGeometry:async()=>{reads++;return geometry();}});f.controller.toggle();f.menu.hidden=true;await f.clock.advance();assert.equal(reads,0);assert.deepEqual(f.changes,[true,false]);assert.equal(f.measured,0);f.controller.dispose();
});
test('external hiding during native RPC does not read layout or reopen the menu',async()=>{
  const pending=deferred();const f=fixture({getGeometry:()=>pending.promise});f.controller.toggle();await f.clock.advance();f.menu.hidden=true;pending.resolve(geometry({cursor_down:true}));await flush();assert.equal(f.measured,0);assert.deepEqual(f.changes,[true,false]);assert.equal(f.clock.tasks.size,0);f.controller.dispose();
});
test('dispose removes listeners, closes once, cancels timers and ignores late RPCs and future calls',async()=>{
  const pending=deferred();const f=fixture({getGeometry:()=>pending.promise});f.controller.toggle();await f.clock.advance();f.controller.dispose();f.controller.dispose();
  assert.equal(f.document.count,0);assert.equal(f.view.count,0);assert.equal(f.menu.hidden,true);assert.deepEqual(f.changes,[true,false]);
  pending.resolve(geometry({escape_down:true}));await flush();f.controller.toggle();f.controller.position(bounds);f.controller.close();await f.clock.advance(1000);
  assert.deepEqual(f.changes,[true,false]);assert.equal(f.clock.tasks.size,0);assert.equal(f.menu.hidden,true);
});
test('throwing or reentrant onChange observers cannot strand polling or resurrect a disposed menu',async()=>{
  const f=fixture({onChange(){throw new Error('observer');},getGeometry:async()=>geometry()});assert.doesNotThrow(()=>f.controller.toggle());assert.equal(f.clock.tasks.size,1);assert.doesNotThrow(()=>f.controller.dispose());assert.equal(f.clock.tasks.size,0);
  let controller;const g=fixture({onChange(open){if(!open)controller.toggle();}});controller=g.controller;controller.toggle();controller.dispose();assert.equal(g.menu.hidden,true);assert.equal(g.document.count,0);
});
test('native bridge exposes read-only Escape state using the current high bit only',()=>{
  const native=readFileSync(new URL('../src-tauri/src/desktop_pet.rs',import.meta.url),'utf8');
  assert.match(native,/escape_down: bool/);assert.match(native,/escape_down: unsafe \{ GetAsyncKeyState\(0x1B\) < 0 \}/);
  assert.ok(native.includes('horizontal_inset: pet_horizontal_inset(size)'));
});


test('submenu starts hidden, hover opens without stealing focus, click toggles, and layout notifies only changes',()=>{
  const f=submenuFixture();
  assert.equal(f.panel.hidden,true);assert.equal(f.trigger.getAttribute('aria-expanded'),'false');
  f.trigger.emit('pointerenter');assert.equal(f.panel.hidden,true,'closed parent ignores hover');
  f.controller.toggle(6,6);f.other.focus();f.trigger.emit('pointerenter');
  assert.equal(f.panel.hidden,false);assert.equal(f.document.activeElement,f.other);
  assert.equal(f.trigger.getAttribute('aria-expanded'),'true');assert.deepEqual(f.layouts,[true]);
  f.trigger.emit('pointerenter');f.controller.position(visibleBounds);assert.deepEqual(f.layouts,[true]);
  f.triggerIcon.emit('click');assert.equal(f.panel.hidden,false,'first click must not undo hover-open');
  assert.equal(f.document.activeElement,f.back);assert.deepEqual(f.layouts,[true]);
  f.triggerIcon.emit('click');assert.equal(f.panel.hidden,true);assert.equal(f.trigger.getAttribute('aria-expanded'),'false');
  f.triggerIcon.emit('click');assert.equal(f.panel.hidden,false);assert.deepEqual(f.layouts,[true,false,true]);
  assert.deepEqual(f.changes,[true]);assert.equal(f.clock.tasks.size,0);f.controller.dispose();
});
test('crossing from trigger to sibling panel stays open; only another parent row closes it',()=>{
  const f=submenuFixture();f.open();
  f.trigger.emit('pointerleave',{relatedTarget:f.panel});f.menu.emit('pointerleave',{relatedTarget:f.panel});
  f.panel.emit('pointerover');f.first.emit('pointerover');f.first.focus();
  assert.equal(f.panel.hidden,false);
  f.triggerIcon.emit('pointerover');f.triggerIcon.emit('focusin');assert.equal(f.panel.hidden,false);
  f.menu.emit('pointerover');assert.equal(f.panel.hidden,false,'parent padding is not a menu row');
  f.other.emit('pointerover');assert.equal(f.panel.hidden,true);assert.equal(f.menu.hidden,false);
  f.trigger.emit('pointerenter');f.other.focus();assert.equal(f.panel.hidden,true);
  f.trigger.emit('pointerenter');f.plain.emit('pointerover');assert.equal(f.panel.hidden,true,'plain parent button closes submenu too');
  f.trigger.emit('pointerenter');f.plain.focus();assert.equal(f.panel.hidden,true);
  f.controller.dispose();
});
for(const openingKey of ['ArrowRight','ArrowDown'])test(openingKey+' enters submenu and grouped keyboard navigation wraps/skips unavailable rows',()=>{
  const f=submenuFixture();f.controller.toggle();f.trigger.focus();
  assert.equal(f.key(openingKey,f.triggerIcon).defaultPrevented,true);
  assert.equal(f.panel.hidden,false);assert.equal(f.document.activeElement,f.back);
  assert.equal(f.key('ArrowDown').defaultPrevented,true);assert.equal(f.document.activeElement,f.first);
  f.key('ArrowDown');assert.equal(f.document.activeElement,f.last);
  f.key('ArrowDown');assert.equal(f.document.activeElement,f.back);
  f.key('ArrowUp');assert.equal(f.document.activeElement,f.last);
  f.key('Home');assert.equal(f.document.activeElement,f.back);
  f.key('End');assert.equal(f.document.activeElement,f.last);
  f.key('ArrowLeft');assert.equal(f.panel.hidden,true);assert.equal(f.menu.hidden,false);
  assert.equal(f.document.activeElement,f.trigger);assert.equal(f.trigger.getAttribute('aria-expanded'),'false');
  f.controller.dispose();
});
test('keyboard handling is scoped and IME-safe; native button activation remains available',()=>{
  const f=submenuFixture();f.controller.toggle();
  for(const extra of [{isComposing:true},{keyCode:229}]) {
    assert.equal(f.key('ArrowRight',f.trigger,extra).defaultPrevented,false);assert.equal(f.panel.hidden,true);
    f.key('Escape',f.trigger,extra);assert.equal(f.menu.hidden,false);
  }
  for(const key of ['ArrowDown','Home','ArrowLeft'])assert.equal(f.key(key,f.other).defaultPrevented,false);
  assert.equal(f.key('Enter',f.trigger).defaultPrevented,false);
  f.trigger.emit('click');assert.equal(f.panel.hidden,false);
  assert.equal(f.key('Enter',f.first).defaultPrevented,false);
  assert.equal(f.key('Tab',f.first).defaultPrevented,false);
  f.key('Escape',f.first);assert.equal(f.menu.hidden,true);assert.equal(f.panel.hidden,true);
  f.controller.dispose();
});
test('back button descendant click returns to trigger; action clicks stay available to integration',()=>{
  const f=submenuFixture();f.open();f.first.focus();f.first.emit('click');assert.equal(f.panel.hidden,false);
  f.backIcon.emit('click');assert.equal(f.panel.hidden,true);assert.equal(f.document.activeElement,f.trigger);
  assert.equal(f.menu.hidden,false);assert.deepEqual(f.layouts,[true,false]);f.controller.dispose();
});
test('empty submenu and unavailable groups are safe for all navigation keys',()=>{
  const f=submenuFixture();f.open();f.back.hidden=true;f.group.hidden=true;
  for(const key of ['ArrowDown','ArrowUp','Home','End'])assert.doesNotThrow(()=>f.key(key,f.panel));
  f.key('ArrowRight',f.trigger);assert.equal(f.document.activeElement,undefined);
  f.key('ArrowLeft',f.panel);assert.equal(f.document.activeElement,f.trigger);f.controller.dispose();
});
test('DOM pointer dismissal counts only the visible sibling panel as inside',()=>{
  const f=submenuFixture();f.open();
  for(const target of [f.panel,f.group,f.first,f.backIcon]) {
    f.document.emit('pointerdown',{target,button:0});assert.equal(f.menu.hidden,false);
  }
  f.document.emit('pointerdown',{target:{},button:2});assert.equal(f.menu.hidden,false);
  f.back.emit('click');f.document.emit('pointerdown',{target:f.first,button:0});
  assert.equal(f.menu.hidden,true);f.controller.dispose();
});
for(const [x,y] of [[6,6],[354,6],[6,314],[354,314],[80,160],[100,160]])test('both panels fit at '+x+','+y+' with touching edges and minimum main displacement',()=>{
  const f=submenuFixture();f.controller.toggle(x,y);f.controller.position(visibleBounds);
  const before=f.menu.getBoundingClientRect();
  assert.equal(f.panel.reads,0,'hidden submenu is never measured');
  f.trigger.emit('pointerenter');f.controller.position(visibleBounds);
  const main=f.menu.getBoundingClientRect(),sub=f.panel.getBoundingClientRect();
  assertInside(f.menu);assertInside(f.panel);
  assert.ok(main.right===sub.left||sub.right===main.left,'sibling panels have no pointer gap');
  const rightCandidate=Math.min(10,Math.max(6,before.left));
  const leftCandidate=Math.min(158,Math.max(154,before.left));
  assert.equal(Math.abs(main.left-before.left),Math.min(Math.abs(rightCandidate-before.left),Math.abs(leftCandidate-before.left)));
  assert.equal(main.top,before.top);
  assert.ok(sub.top<=f.trigger.getBoundingClientRect().top&&sub.bottom>=f.trigger.getBoundingClientRect().bottom,'trigger row meets panel vertically');
  f.back.emit('click');f.controller.position(visibleBounds);assert.equal(f.menu.getBoundingClientRect().left,before.left);
  f.controller.dispose();
});
test('normal side choice needs no shift and exact combined-width bounds still fit',()=>{
  for(const [x,expectedMain,expectedSub] of [[6,6,202],[158,158,10]]) {
    const f=submenuFixture();f.open(x,6);f.controller.position(visibleBounds);
    assert.equal(f.menu.getBoundingClientRect().left,expectedMain);assert.equal(f.panel.getBoundingClientRect().left,expectedSub);f.controller.dispose();
  }
  const f=submenuFixture();f.open(80,100);f.controller.position({x:8,y:6,width:344,height:308});
  const a=f.menu.getBoundingClientRect(),b=f.panel.getBoundingClientRect();assert.equal(a.right,b.left);assert.equal(a.left,8);assert.equal(b.right,352);f.controller.dispose();
});
for(const bounds of [{x:112.5,y:6.25,width:235.5,height:220.5},{x:112,y:6,width:140,height:100},{x:20,y:30,width:50,height:40}])test('narrow/inset bounds cap both panels and overlap without moving parent: '+JSON.stringify(bounds),()=>{
  const f=submenuFixture({origin:{x:-80.25,y:-20.5}});f.controller.toggle(260.25,100.5);f.controller.position(bounds);
  const before=f.menu.getBoundingClientRect();f.trigger.emit('pointerenter');f.controller.position(bounds);
  const main=f.menu.getBoundingClientRect(),sub=f.panel.getBoundingClientRect();assertInside(f.menu,bounds);assertInside(f.panel,bounds);
  assert.equal(main.left,before.left);assert.equal(main.top,before.top);
  assert.ok(main.left<sub.right&&sub.left<main.right);
  assert.equal(f.panel.style.maxWidth,bounds.width+'px');assert.equal(f.panel.style.maxHeight,bounds.height+'px');
  assert.equal(f.panel.style.right,'auto');assert.equal(f.panel.style.bottom,'auto');
  f.backIcon.emit('click');assert.equal(f.panel.hidden,true);assert.equal(f.document.activeElement,f.trigger);f.controller.dispose();
});
test('explicit sibling origin, fractional coordinates, tall panels, and invalid measurements stay safe',()=>{
  const origin={x:-80.25,y:-20.5};const f=submenuFixture({origin,subHeight:500});f.open(100.5,100.25);
  const bounds={x:6.25,y:6.5,width:348.5,height:307.25};f.controller.position(bounds,origin);
  assertInside(f.menu,bounds);assertInside(f.panel,bounds);assert.equal(f.panel.getBoundingClientRect().top,6.5);
  const styles=JSON.stringify([f.menu.style,f.panel.style]);
  f.controller.position({...bounds,width:NaN},origin);f.controller.position(bounds,{x:NaN,y:0});
  assert.equal(JSON.stringify([f.menu.style,f.panel.style]),styles);
  f.panel.getBoundingClientRect=()=>box(0,0,0,0);assert.doesNotThrow(()=>f.controller.position(bounds,origin));
  f.controller.dispose();
});
test('native clicks in sibling submenu survive DPI conversion, shared edge, and polling; outside closes both',async()=>{
  let point={x:220,y:80};const f=submenuFixture({getGeometry:async()=>geometry({cursor_down:true,cursor:{x:-200+point.x*2,y:100+point.y*2}})});
  f.open();f.controller.position(visibleBounds);const sub=f.panel.getBoundingClientRect();
  assert.equal(f.clock.tasks.size,1);
  for(const p of [point,{x:sub.left,y:sub.top},{x:sub.right-0.01,y:sub.bottom-0.01}]) {
    point=p;await f.clock.advance();assert.equal(f.menu.hidden,false);assert.equal(f.panel.hidden,false);assert.equal(f.clock.tasks.size,1);
  }
  point={x:sub.right,y:sub.top};await f.clock.advance();assert.equal(f.menu.hidden,true);assert.equal(f.panel.hidden,true);
  assert.equal(f.trigger.getAttribute('aria-expanded'),'false');assert.equal(f.clock.tasks.size,0);f.controller.dispose();
});
test('hidden submenu does not protect native clicks and native Escape always dismisses both',async()=>{
  let current=geometry({cursor_down:true,cursor:{x:240,y:260}});
  const f=submenuFixture({getGeometry:async()=>current});f.open();f.controller.position(visibleBounds);
  f.back.emit('click');await f.clock.advance();assert.equal(f.menu.hidden,true);
  f.open();current={escape_down:true};await f.clock.advance();assert.equal(f.menu.hidden,true);assert.equal(f.panel.hidden,true);f.controller.dispose();
});
test('submenu changes never duplicate pending polling and dispose removes every listener and resets state',async()=>{
  const pending=deferred();let reads=0;
  const f=submenuFixture({getGeometry:()=>{reads++;return pending.promise;}});f.open();await f.clock.advance();
  for(let i=0;i<6;i++){f.trigger.emit('click');f.trigger.emit('pointerenter');await f.clock.advance();}
  assert.equal(reads,1);assert.equal(f.clock.tasks.size,0);
  f.controller.close();assert.equal(f.panel.hidden,true);f.open();assert.equal(f.clock.tasks.size,0);
  f.controller.dispose();f.controller.dispose();
  for(const element of [f.document,f.view,f.menu,f.trigger,f.panel])assert.equal(element.count,0);
  assert.equal(f.menu.hidden,true);assert.equal(f.panel.hidden,true);assert.equal(f.trigger.getAttribute('aria-expanded'),'false');
  pending.resolve(geometry({escape_down:true}));await flush();
  f.trigger.emit('click');f.trigger.emit('pointerenter');f.controller.toggle();await f.clock.advance();
  assert.equal(reads,1);assert.equal(f.panel.hidden,true);assert.equal(f.clock.tasks.size,0);
});
test('throwing and disposal-reentrant layout callbacks cannot interrupt cleanup or focus hidden panels',()=>{
  const f=submenuFixture({onLayout(){throw new Error('layout failed');}});
  assert.doesNotThrow(()=>f.open());assert.doesNotThrow(()=>f.controller.dispose());
  assert.equal(f.panel.hidden,true);assert.equal(f.trigger.count,0);assert.equal(f.document.count,0);
  let controller;const g=submenuFixture({onLayout(){controller.dispose();}});controller=g.controller;
  controller.toggle();g.key('ArrowRight',g.trigger);assert.equal(g.panel.hidden,true);assert.equal(g.menu.hidden,true);assert.equal(g.document.activeElement,undefined);
  assert.equal(g.panel.count,0);assert.equal(g.document.count,0);
});
