import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
const source = await readFile(new URL('../src/assistant.ts', import.meta.url), 'utf8');
const petConversationSource = await readFile(new URL('../src/pet/conversation.ts', import.meta.url), 'utf8');
const petConversation = await import('data:text/javascript;base64,' + Buffer.from(ts.transpileModule(petConversationSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString('base64'));
const speechSource = await readFile(new URL('../src/pet/speech.ts', import.meta.url), 'utf8');
const speech = await import('data:text/javascript;base64,' + Buffer.from(ts.transpileModule(speechSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString('base64'));
const modelSource = await readFile(new URL('../src/assistant-model.ts', import.meta.url), 'utf8');
const markdownSource = await readFile(new URL('../src/assistant-markdown.ts', import.meta.url), 'utf8');
const menuSource = await readFile(new URL('../src/pet/menu.ts', import.meta.url), 'utf8');
const { PetMenuController } = await import('data:text/javascript;base64,' + Buffer.from(ts.transpileModule(menuSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString('base64'));
const markdown = await import('data:text/javascript;base64,' + Buffer.from(ts.transpileModule(markdownSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString('base64'));
const model = await import('data:text/javascript;base64,' + Buffer.from(ts.transpileModule(modelSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString('base64'));
const script = ts.transpileModule(source.replace(/^import .*;$/gm, '').replace('import.meta.hot', 'false').replace('import.meta.hot', 'false'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; let reject; const promise = new Promise((a,b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
class Node {
  constructor(id = '') { this.id = id; this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false; this.children = []; this.handlers = new Map(); this.scrollHeight = 0; this.scrollTop = 0; this.clientHeight = 300; this.dataset = {}; this.checked = true; this.style = { setProperty(k, v) { this[k] = v; } }; this.attributes = new Map(); }
  addEventListener(type, fn, options = {}) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
    options.signal?.addEventListener('abort', () => this.handlers.set(type, this.handlers.get(type).filter(f => f !== fn)));
  }
  emit(type, props = {}) { const event = { target: this, preventDefault() {}, ...props }; for (const fn of this.handlers.get(type) ?? []) fn(event); }
  replaceChildren(...nodes) { this.children = nodes; }
  append(...nodes) { this.children.push(...nodes); }
  add(node) { this.children.push(node); }
  closest() { return this; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  contains(node) { return node === this || this.children.some(child => child.contains?.(node)); }
  removeEventListener(type, fn) { this.handlers.set(type, (this.handlers.get(type) ?? []).filter(handler => handler !== fn)); }
  setAttribute(k,v) { this.attributes.set(k,String(v)); }
  getAttribute(k) { return this.attributes.get(k); }
  removeAttribute(k) { this.attributes.delete(k); }
  focus() { this.ownerDocument.activeElement = this; this.focusCount = (this.focusCount ?? 0) + 1; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }
  setPointerCapture() {}
  getClientRects() { return [{}]; }
  getBoundingClientRect() { return { x: 10, y: 20, left: 10, top: 20, right: 110, bottom: 120, width: 100, height: 100 }; }
}
function setup({ native = true, view = 'chat', speechSupported = false, autoRead = false, legacyAutoRead = false, storageDenied = false, getSpeechPreferences, setSpeechPreferences, listenGate, getSnapshot, getPreferences, getInbox, openNotification, getInteractions, submitInteraction, openInteraction, setTopmost, setSlingshot, actionResult, getGeometry, movePet, dragPet, now = () => performance.now() } = {}) {
  const nodes = new Map();
  const ids = ['initialize', 'pet-initialize', 'pet-read', 'pet-read-status', 'pet-auto-read', 'assistant-root', 'pet-dialogue', 'pet-speech', 'pet-speech-label', 'pet-speech-text', 'pet-speech-close', 'pet-speech-expand', 'pet-composer', 'pet-input-close', 'pet-enable', 'preview', 'pet', 'pet-media', 'pet-animation-trigger', 'pet-animation', 'pet-animation-list', 'pet-menu', 'pet-bubble', 'pet-interaction', 'pet-topmost', 'pet-slingshot', 'pet-fixed', 'notice', 'status', 'setup', 'conversation', 'sessions', 'new-session', 'session-bar', 'composer-footnote', 'runtime-message', 'draft-hint', 'retry', 'send', 'cancel', 'enable', 'workspace', 'consent', 'enable-form', 'send-form', 'draft'];
  ids.forEach(id => nodes.set(id, new Node(id)));
  nodes.get('pet-menu').hidden = true;
  nodes.get('pet-menu').append(nodes.get('pet-animation-trigger'));
  nodes.get('pet-animation').append(nodes.get('pet-animation-list'));
  const root = nodes.get('assistant-root');
  // Model the setup fields' HTML defaults rather than inventing a pre-consented form.
  let markup = '';
  Object.defineProperty(root, 'innerHTML', {
    get: () => markup,
    set(html) {
      markup = html;
      const input = html.match(/<input id="workspace"[^>]*>/)?.[0];
      if (input) {
        nodes.get('workspace').value = input.match(/value="([^"]*)"/)?.[1] ?? '';
        nodes.get('workspace').readOnly = /\breadonly\b/.test(input);
      }
      nodes.get('consent').checked = false;
    },
  });
  const calls = []; const events = []; const petEvents = []; const storage = new Map(); const frames = new Map(); let frameId = 0;
  const listeners = new Map(); let stopped = 0;
  let topmost = true; let slingshot = true; let petRevision = 0;
  const window = new Node(); window.confirm = () => false;
  const preferences = new Map([['dsh-assistant:qwen-auto-read', String(autoRead)], ['dsh-assistant:auto-read', String(legacyAutoRead)]]);
  window.localStorage = { getItem:key=>{if(storageDenied)throw new Error('storage denied');return preferences.get(key)??null;},setItem:(key,value)=>{if(storageDenied)throw new Error('storage denied');preferences.set(key,value);},removeItem:key=>preferences.delete(key) };
  let nativeSpeechPreferences = { revision:0, initialized:false, auto_read:false, volume:100 };
  const narration = { played:[], stops:0, disposed:false };
  const document = Object.assign(new Node(), { defaultView:window, body:{dataset:{}}, querySelector:()=>root, getElementById:id=>nodes.get(id), createDocumentFragment:()=>new Node(), createElement:()=>new Node(), getSelection:()=>null });
  for (const node of nodes.values()) node.ownerDocument = document;
  const menuTimers = new Map(); let menuTimerId = 0;
  const speechTimers = new Map(); let speechTimerId = 0;
  window.setTimeout = callback => { speechTimers.set(++speechTimerId, callback); return speechTimerId; };
  window.clearTimeout = id => speechTimers.delete(id);
  const invoke = async (name, args) => {
    calls.push({ name, args });
    if (name === 'get_speech_preferences') return getSpeechPreferences ? getSpeechPreferences() : nativeSpeechPreferences;
    if (name === 'set_speech_preferences') {
      if (setSpeechPreferences) return setSpeechPreferences(args.patch);
      const {migrate,...patch}=args.patch;
      if (!migrate || !nativeSpeechPreferences.initialized) nativeSpeechPreferences={...nativeSpeechPreferences,...patch,initialized:true,revision:nativeSpeechPreferences.revision+1};
      return nativeSpeechPreferences;
    }
    if (name === 'get_pet_geometry') return getGeometry ? getGeometry() : geometry();
    if (name === 'move_pet') return movePet ? movePet(args) : geometry();
    if (name === 'drag_pet') return dragPet ? dragPet(args) : geometry();
    if (name === 'get_pet_preferences') return getPreferences ? getPreferences() : {visible:true,always_on_top:topmost,slingshot_enabled:slingshot,roaming_enabled:true,bubble_notifications:true,message:'',revision:petRevision};
    if (name === 'set_pet_topmost') {
      if(setTopmost) return setTopmost(args.alwaysOnTop);
      topmost=args.alwaysOnTop; petRevision++;
      return {visible:true,always_on_top:topmost,slingshot_enabled:slingshot,roaming_enabled:true,bubble_notifications:true,message:'',revision:petRevision};
    }
    if (name === 'set_pet_slingshot_enabled') {
      if (setSlingshot) return setSlingshot(args.enabled);
      slingshot=args.enabled; petRevision++;
      return {visible:true,always_on_top:topmost,slingshot_enabled:slingshot,roaming_enabled:true,bubble_notifications:true,message:'',revision:petRevision};
    }
    if (name === 'get_pet_notifications') return getInbox ? getInbox() : [];
    if (name === 'open_pet_notification') return openNotification ? openNotification(args.id) : undefined;
    if (name === 'dismiss_pet_notification') return undefined;
    if (name === 'get_pet_interactions') return getInteractions ? getInteractions() : {revision:0,connected:true,items:[]};
    if (name === 'submit_pet_interaction') return submitInteraction ? submitInteraction(args.id,args.reply) : undefined;
    if (name === 'open_pet_interaction') return openInteraction ? openInteraction(args.id) : undefined;
    if (name === 'set_pet_interaction_surface') return undefined;
    if (name === 'get_assistant_snapshot') return getSnapshot ? getSnapshot() : ready();
    return actionResult ? actionResult(args.request) : undefined;
  };
  const context = {
    ...model, ...markdown, ...petConversation, toSpeechText:speech.toSpeechText, invoke, isTauri: () => native,
    HIT_BOX: { x0: 200, y0: 50, x1: 440, y1: 335 }, SLINGSHOT_DOUBLE_MS: 200, physics: {}, PET_UPSTREAM_URL: 'https://github.com/PC2005-cloud/dsh-pet',
    QwenSpeech: class {
      constructor(options) { this.options=options;this.state={supported:speechSupported,phase:'idle',error:''};narration.engine=this; }
      publish(phase,error='') {if(narration.disposed)return;this.state={supported:speechSupported,phase,error};this.options.onChange(this.state);}
      setVolume(value) {narration.volume=value;}
      stopRequest(id) {narration.stopRequests ??= [];narration.stopRequests.push(id);}
      unlock() {narration.unlocks=(narration.unlocks??0)+1;}
      play(text) {narration.played.push(text);this.publish('loading');}
      stop() {narration.stops++;this.publish('idle');}
      dispose() {narration.disposed=true;}
    },
    PetInteractions: class {
      constructor(root,options) {this.root=root;this.options=options;this.active=true;this.snapshot={connected:true,items:[]};petEvents.push(['interaction-mounted',options]);}
      update(snapshot) {this.snapshot=snapshot;petEvents.push(['interaction-update',snapshot]);this.show();}
      setActive(value) {this.active=value;petEvents.push(['interaction-active',value]);this.show();}
      setObscured(value) {petEvents.push(['interaction-obscured',value]);}
      show() {const visible=this.active&&this.snapshot.items.length>0;this.root.hidden=!visible;this.options.onChange(visible);}
      dispose() {petEvents.push(['interaction-dispose']);}
    },
    PetNotifications: class {
      constructor(root,options) { this.root=root; this.options=options; this.active=true; petEvents.push(['bubble-mounted',options]); }
      setActive(active) {this.active=active;petEvents.push(['bubble-active',active]); if(!active){this.root.hidden=true;this.options.onChange(false);}}
      setObscured(value) {petEvents.push(['bubble-obscured',value]);}
      enqueue(value) {if(this.active){this.root.hidden=false;petEvents.push(['bubble-enqueue',value]);this.options.onChange(true);}}
      withdraw(id) {petEvents.push(['bubble-withdraw',id]);}
      dispose() {petEvents.push(['bubble-dispose']);}
    },
    PetRenderer: class {
      constructor(root,options) { this.options=options; petEvents.push(['renderer-mounted',options]); }
      updateState(state) { petEvents.push(['state',state]); }
      listActions() { return [{name:'待机呼吸休闲',group:'待机'}]; }
      click() { petEvents.push(['click']); }
      dragStart() { petEvents.push(['drag-start']); }
      dragEnd() { petEvents.push(['drag-end']); }
      startSquash() { petEvents.push(['squash']); }
      toggleFixed(fixed) { petEvents.push(['fixed',fixed]); return fixed; }
      trigger(name) { petEvents.push(['trigger',name]); return true; }
      dispose() { petEvents.push(['renderer-dispose']); }
    },
    layoutPetBubbles: () => { petEvents.push(['bubble-layout']); },
    PetMenuController: class extends PetMenuController {
      constructor(menu, options) { super(menu, {...options, clock:{schedule:callback=>{menuTimers.set(++menuTimerId,callback);return menuTimerId;},cancel:id=>menuTimers.delete(id)}}); petEvents.push(['menu-mounted',this]); }
    },
    PetMotion: class {
      constructor(options) { this.options=options; petEvents.push(['motion-mounted',options]); }
      setSlingshotEnabled(enabled) { petEvents.push(['slingshot-enabled',enabled]); }
      begin(sling) { petEvents.push(['motion-begin',sling]); this.options.onDragStart(); }
      end() { petEvents.push(['motion-end']); this.options.onDragEnd(); }
      stop() { petEvents.push(['motion-stop']); }
      stopRoam() {} startRoam() { petEvents.push(['roam']); return true; }
      dispose() { petEvents.push(['motion-dispose']); }
    },
    listen: async (name, callback) => { events.push(name); listeners.set(name, callback); if (typeof listenGate === 'function') await listenGate(name); else if (listenGate) await listenGate.promise; return () => { stopped++; }; },
    location: { search: '?view=' + view }, URLSearchParams,
    document,
    window, sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    AbortController, Option: class extends Node { constructor(text, value) { super(); this.textContent = text; this.value = value; } },
    crypto: { randomUUID: () => 'request-' + calls.length }, Intl, performance: { now },
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; }, cancelAnimationFrame(id) { frames.delete(id); }, ResizeObserver: class { observe() {} disconnect() {} }, console,
  };
  vm.runInNewContext(script, context);
  return { nodes, calls, events, petEvents, narration, preferences, window, document, menuTimers, speechTimers, storage, flushSpeechTimer: () => { const callbacks=[...speechTimers.values()]; speechTimers.clear(); callbacks.forEach(callback=>callback()); }, flushMenuTimer: () => { const callbacks=[...menuTimers.values()]; menuTimers.clear(); callbacks.forEach(callback=>callback()); }, flushFrames: () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); return callbacks.length; }, emit: state => listeners.get('assistant-state')({ payload: state }), emitEvent: (name,value) => listeners.get(name)?.({ payload:value }), stopped: () => stopped };
}
function geometry(patch = {}) { return { position:{x:100,y:100}, size:{width:360,height:320}, scale:1, areas:[{x:0,y:0,width:1920,height:1080}], cursor:{x:200,y:200}, cursor_down:false, horizontal_inset:112.5, ...patch }; }
function ready(revision = 1, patch = {}) { return { ...model.initialSnapshot(), enabled: true, connected: true, phase: 'ready', workspace_id: 'w', session_id: 's', sessions: [{ id: 's', title: 'hello' }], revision, ...patch }; }

test('pet geometry wrappers keep overlays in real work areas using the returned physical scale', async () => {
  let current = geometry({ position:{x:-112,y:100} });
  const ui = setup({view:'pet', getGeometry:() => current, movePet:() => current}); await tick();
  const motion = ui.petEvents.find(event => event[0] === 'motion-mounted')[1];
  const style = ui.nodes.get('assistant-root').style;
  assert.equal(await motion.getGeometry(), current);
  assert.equal(style['--pet-visible-left'], '112px');
  assert.equal(style['--pet-visible-right'], '0px');
  current = geometry({position:{x:3345,y:100},size:{width:720,height:640},scale:2,areas:[{x:0,y:0,width:3840,height:2160}]});
  assert.equal(await motion.move(9999, 100), current); // use native clamped response, not requested x
  assert.equal(style['--pet-visible-left'], '0px');
  assert.equal(style['--pet-visible-right'], '112.5px');
  assert.equal(ui.calls.at(-1).name, 'move_pet');
  current = geometry({position:{x:-2032,y:100},areas:[{x:-1920,y:0,width:1920,height:1080},{x:0,y:0,width:1920,height:1080}]});
  await motion.getGeometry(); assert.equal(style['--pet-visible-left'], '112px');
  current = geometry({position:{x:48,y:100},areas:[{x:160,y:0,width:1760,height:1080}]});
  await motion.getGeometry(); assert.equal(style['--pet-visible-left'], '112px');
  current = geometry(); await motion.getGeometry();
  assert.equal(style['--pet-visible-left'], '0px'); assert.equal(style['--pet-visible-right'], '0px');
});

test('ordinary drag hook uses one scoped native command and adopts its actual clamped geometry for overlays', async () => {
  const actual = geometry({position:{x:-112,y:100}}); let args;
  const ui=setup({view:'pet',dragPet:value=>{args=value;return actual;}}); await tick();
  const motion=ui.petEvents.find(event=>event[0]==='motion-mounted')[1];
  const before=ui.calls.length;
  assert.equal(await motion.drag(40,50),actual);
  assert.deepEqual(JSON.parse(JSON.stringify(args)),{grabX:40,grabY:50});
  assert.deepEqual(ui.calls.slice(before).map(call=>call.name),['drag_pet']);
  assert.equal(ui.nodes.get('assistant-root').style['--pet-visible-left'],'112px');
  assert.equal(ui.nodes.get('assistant-root').style['--pet-visible-right'],'0px');
});

test('pet overlay updates resync moved hit regions and reject stale/disposed geometry replies', async () => {
  const stale = deferred(); const late = deferred(); let reads = 0;
  const ui = setup({view:'pet', getGeometry:() => ++reads === 1 ? stale.promise : late.promise, movePet:() => geometry({position:{x:1672,y:100}})}); await tick();
  const motion = ui.petEvents.find(event => event[0] === 'motion-mounted')[1];
  const root = ui.nodes.get('assistant-root'); const button = new Node();
  button.getBoundingClientRect = () => ({x:200 - parseFloat(root.style['--pet-visible-right'] || '0'),y:280,width:40,height:20});
  root.querySelectorAll = () => [button];
  ui.flushFrames();
  const read = motion.getGeometry(); await motion.move(3000,100); ui.flushFrames();
  assert.equal(ui.calls.filter(call => call.args?.request?.action === 'hit_regions').at(-1).args.request.regions[0].x, 88);
  await motion.move(3000,100);
  assert.equal(ui.flushFrames(), 0, 'unchanged insets must not schedule per-frame hit work');
  stale.resolve(geometry({position:{x:-112,y:100}})); await read;
  assert.equal(root.style['--pet-visible-left'], '0px');
  assert.equal(root.style['--pet-visible-right'], '112px');
  const afterDispose = motion.getGeometry(); ui.window.emit('pagehide');
  late.resolve(geometry()); await afterDispose; ui.flushFrames();
  assert.equal(root.style['--pet-visible-right'], '112px');
});

test('pet bubble layout runs in preview without native IPC and stops after disposal', async () => {
  const ui = setup({native:false,view:'pet'}); await tick();
  ui.flushFrames();
  assert.ok(ui.petEvents.some(event => event[0] === 'bubble-layout'));
  assert.equal(ui.calls.length, 0);
  const layouts = ui.petEvents.filter(event => event[0] === 'bubble-layout').length;
  ui.window.emit('pagehide'); ui.flushFrames();
  assert.equal(ui.petEvents.filter(event => event[0] === 'bubble-layout').length, layouts);
});

test('pet preview retains default overlay layout without native geometry', async () => {
  const ui = setup({native:false,view:'pet'}); await tick();
  assert.equal(ui.nodes.get('assistant-root').style['--pet-visible-left'], undefined);
  assert.equal(ui.nodes.get('assistant-root').style['--pet-visible-right'], undefined);
  assert.equal(ui.petEvents.some(event => event[0] === 'motion-mounted'), false);
  assert.equal(ui.calls.length, 0);
});

test('a deleted current session can recover through explicit history selection or new session', async () => {
  const ui = setup({ getSnapshot: () => ready(1, { connected: false, session_id: null, phase: 'error' }) }); await tick();
  assert.equal(ui.nodes.get('sessions').disabled, false); assert.equal(ui.nodes.get('new-session').disabled, false);
  ui.nodes.get('draft').value = '不要丢掉草稿'; ui.nodes.get('draft').emit('input');
  ui.nodes.get('sessions').value = 's'; ui.nodes.get('sessions').emit('change'); await tick();
  assert.equal(ui.calls.find(c => c.name === 'assistant_action').args.request.action, 'select_session');
  const button = ui.nodes.get('new-session'); button.dataset.action = 'new_session';
  ui.nodes.get('assistant-root').emit('click', { target: button }); await tick();
  assert.equal(ui.calls.filter(c => c.name === 'assistant_action').at(-1).args.request.action, 'new_session');
  assert.equal(ui.nodes.get('draft').value, '不要丢掉草稿');
  ui.emit(ready(2, { connected: false, workspace_id: null }));
  assert.equal(ui.nodes.get('sessions').disabled, true); assert.equal(ui.nodes.get('new-session').disabled, true);
});
test('assistant setup sends users to settings instead of enabling from chat', async () => {
  const ui = setup({ getSnapshot: () => ({ ...model.initialSnapshot(), phase: 'setup', revision: 1 }) }); await tick();
  const markup = ui.nodes.get('assistant-root').innerHTML;
  assert.match(markup, /设置 → 桌面宠物 → 对话工作目录/);
  assert.match(markup, /开启宠物时也会自动初始化/);
  assert.match(markup, /id="initialize"[^>]+data-action="pet_settings"/);
  assert.doesNotMatch(markup, /id="enable-form"|id="consent"|id="workspace"/);
  assert.equal(ui.nodes.get('setup').hidden, false); assert.equal(ui.nodes.get('retry').hidden, true);
  assert.equal(ui.calls.filter(call => call.name === 'assistant_action').length, 0);
  const button = ui.nodes.get('initialize'); button.dataset.action = 'pet_settings';
  ui.nodes.get('assistant-root').emit('click', { target: button }); await tick();
  const requests = ui.calls.filter(call => call.name === 'assistant_action').map(call => call.args.request);
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [{ action: 'pet_settings' }]);
});
test('setup from old custom snapshots hides sending without auto-enabling or moving history', async () => {
  const ui = setup(); await tick();
  ui.emit(ready(2, { enabled: false, connected: false, phase: 'setup', workspace_path: '/home/me/old' }));
  assert.equal(ui.nodes.get('setup').hidden, false);
  for (const id of ['session-bar', 'send-form', 'composer-footnote']) assert.equal(ui.nodes.get(id).hidden, true);
  assert.equal(ui.nodes.get('send').disabled, true); assert.equal(ui.nodes.get('retry').hidden, true);
  assert.equal(ui.calls.filter(call => call.name === 'assistant_action').length, 0);
});
test('uninitialized and missing pet directories provide settings action instead of reconnect', async () => {
  for (const patch of [{enabled:false,phase:'setup'}, {enabled:true,phase:'workspace_missing'}]) {
    const ui = setup({view:'pet',getSnapshot:()=>ready(1,{...patch,connected:false})}); await tick();
    ui.nodes.get('pet').emit('click'); await tick();
    assert.match(ui.nodes.get('pet-speech-text').textContent, /设置.*初始化/);
    assert.equal(ui.nodes.get('retry').hidden, true);
    assert.equal(ui.nodes.get('pet-initialize').hidden, false); assert.equal(ui.nodes.get('pet-initialize').disabled, false);
    assert.equal(ui.nodes.get('send').disabled, true);
    const button = ui.nodes.get('pet-initialize'); button.dataset.action = 'pet_settings';
    ui.nodes.get('assistant-root').emit('click',{target:button}); await tick();
    assert.ok(ui.calls.some(c=>c.name==='assistant_action' && c.args.request.action==='pet_settings'));
    assert.ok(!ui.calls.some(c=>c.name==='assistant_action' && ['enable','retry','send'].includes(c.args.request.action)));
    ui.emit(ready(2)); assert.equal(ui.nodes.get('pet-initialize').hidden, true);
  }
});
test('offline initialized pets still offer reconnect and previews cannot initialize', async () => {
  const offline = setup({view:'pet',getSnapshot:()=>ready(1,{connected:false,phase:'error'})}); await tick();
  assert.equal(offline.nodes.get('pet-initialize').hidden, true); assert.equal(offline.nodes.get('retry').hidden, false);
  const preview = setup({view:'pet',native:false}); await tick();
  assert.equal(preview.nodes.get('pet-initialize').disabled, true);
  assert.equal(preview.calls.length, 0);
});

test('cancelling without a running turn retains an explicit retry recovery path', async () => {
  const ui = setup({ getSnapshot: () => ready(1, { phase: 'cancelling', running: false }) }); await tick();
  assert.equal(ui.nodes.get('cancel').disabled, true); assert.equal(ui.nodes.get('retry').hidden, false);
  assert.equal(ui.nodes.get('retry').disabled, false);
  const retry = ui.nodes.get('retry'); retry.dataset.action = 'retry';
  ui.nodes.get('assistant-root').emit('click', { target: retry }); await tick();
  assert.equal(ui.calls.find(c => c.name === 'assistant_action').args.request.action, 'retry');
});
test('browser preview marks itself and never invokes or subscribes native IPC', async () => {
  const ui = setup({ native: false }); await tick();
  assert.equal(ui.nodes.get('preview').hidden, false);
  assert.equal(ui.nodes.get('send').disabled, true);
  ui.nodes.get('pet').emit('click', { detail: 0 });
  assert.equal(ui.calls.length, 0); assert.equal(ui.events.length, 0);
});
test('subscribes before snapshot read; streamed newer event defeats stale initial reply', async () => {
  const response = deferred(); const gate = deferred();
  const ui = setup({ listenGate: gate, getSnapshot: () => response.promise });
  assert.deepEqual(ui.events, ['assistant-state']); assert.equal(ui.calls.length, 0);
  gate.resolve(); await tick(); assert.equal(ui.calls[0].name, 'get_assistant_snapshot');
  ui.emit(ready(10, { running: true })); response.resolve(ready(1)); await tick();
  assert.equal(ui.nodes.get('status').textContent, '正在思考');
  ui.window.emit('pagehide'); assert.equal(ui.stopped(), 1);
});
test('retry resubscribes after listener failure before issuing actions or reading a snapshot', async () => {
  let attempts = 0;
  const ui = setup({ listenGate: async () => { if (++attempts === 1) throw new Error('no listener'); } });
  await tick(); assert.equal(ui.calls.length, 0);
  const retry = ui.nodes.get('retry'); retry.dataset.action = 'retry';
  ui.nodes.get('assistant-root').emit('click', { target: retry }); await tick();
  assert.equal(attempts, 2);
  assert.deepEqual(ui.calls.map(call => call.name), ['assistant_action', 'get_assistant_snapshot']);
  assert.equal(ui.calls[0].args.request.action, 'retry');
  assert.equal(ui.nodes.get('status').textContent, '随时聊聊');
});
test('unloading before async subscription resolves still releases the eventual listener', async () => {
  const gate = deferred(); const ui = setup({ listenGate: gate });
  ui.window.emit('pagehide'); gate.resolve(); await tick();
  assert.equal(ui.stopped(), 1); assert.equal(ui.calls.length, 0);
  ui.emit(ready(4)); assert.equal(ui.nodes.get('status').textContent, '连接中');
});
test('IME and pending send block duplicates; failed send retains draft, no automatic resend', async () => {
  const sending = deferred(); const ui = setup({ actionResult: () => sending.promise }); await tick();
  const draft = ui.nodes.get('draft'); draft.value = '保留这段草稿'; draft.emit('input');
  draft.emit('compositionstart'); ui.nodes.get('send-form').emit('submit');
  draft.emit('keydown', { key: 'Enter', shiftKey: false, isComposing: true });
  assert.equal(ui.calls.filter(c => c.name === 'assistant_action').length, 0);
  draft.emit('compositionend'); ui.nodes.get('send-form').emit('submit'); ui.nodes.get('send-form').emit('submit');
  const sends = ui.calls.filter(c => c.name === 'assistant_action'); assert.equal(sends.length, 1);
  assert.equal(sends[0].args.request.action, 'send'); assert.equal(sends[0].args.request.text, draft.value);
  assert.equal(typeof sends[0].args.request.clientTimeZone, 'string'); assert.ok(sends[0].args.request.requestId);
  sending.reject(new Error('connection lost')); await tick();
  assert.equal(draft.value, '保留这段草稿'); assert.match(ui.nodes.get('notice').textContent, /未确认/);
  ui.nodes.get('send-form').emit('submit'); await tick();
  assert.equal(ui.calls.filter(c => c.name === 'assistant_action').length, 1, 'explicit retry confirmation denied');
  ui.window.emit('pagehide'); assert.equal([...ui.storage.values()].includes('保留这段草稿'), true);
});
test('authoritative user echo clears only original sent draft, never text typed during send', async () => {
  const result = deferred(); const ui = setup({ actionResult: () => result.promise }); await tick();
  const draft = ui.nodes.get('draft'); draft.value = '第一条'; draft.emit('input'); ui.nodes.get('send-form').emit('submit');
  draft.value = '接下来的新想法'; draft.emit('input');
  ui.emit(ready(2, { messages: [{ id: 'u1', role: 'user', text: '第一条', request_id: ui.calls.find(c => c.name === 'assistant_action').args.request.requestId }], running: true }));
  assert.equal(draft.value, '接下来的新想法');
  result.resolve(undefined); await tick();
  assert.equal(draft.value, '接下来的新想法');
});
test('same text from another client cannot acknowledge or clear this draft', async () => {
  const result = deferred(); const ui = setup({ actionResult: () => result.promise }); await tick();
  const draft = ui.nodes.get('draft'); draft.value = '同一句话'; draft.emit('input'); ui.nodes.get('send-form').emit('submit');
  ui.emit(ready(2, { messages: [{ id: 'foreign', role: 'user', text: '同一句话', request_id: 'other-client' }] }));
  assert.equal(draft.value, '同一句话');
  result.resolve(undefined); await tick(); assert.equal(draft.value, '同一句话');
});
test('lost action reply after authoritative echo does not resurrect or resend acknowledged draft', async () => {
  const result = deferred(); const ui = setup({ actionResult: () => result.promise }); await tick();
  const draft = ui.nodes.get('draft'); draft.value = '你好'; draft.emit('input'); ui.nodes.get('send-form').emit('submit');
  ui.emit(ready(2, { messages: [{ id: 'u1', role: 'user', text: '你好', request_id: ui.calls.find(c => c.name === 'assistant_action').args.request.requestId }] }));
  assert.equal(draft.value, ''); result.reject(new Error('reply lost')); await tick();
  assert.equal(draft.value, ''); assert.equal(ui.calls.filter(c => c.name === 'assistant_action').length, 1);
});
test('pet drag crosses threshold once and suppresses the trailing click', async () => {
  const ui = setup({ view: 'pet' }); await tick(); const pet = ui.nodes.get('pet');
  pet.emit('pointerdown', { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
  pet.emit('pointermove', { pointerId: 1, clientX: 3, clientY: 4 });
  assert.equal(ui.calls.filter(c => c.name === 'assistant_action').length, 0);
  pet.emit('pointermove', { pointerId: 1, clientX: 6, clientY: 0 });
  pet.emit('pointermove', { pointerId: 1, clientX: 30, clientY: 0 });
  pet.emit('pointerup', { pointerId: 1 }); pet.emit('click', { detail: 1 }); await tick();
  assert.equal(ui.petEvents.filter(e => e[0] === 'motion-begin').length, 1);
  assert.equal(ui.petEvents.filter(e => e[0] === 'motion-end').length, 1);
  assert.equal(ui.petEvents.filter(e => e[0] === 'drag-start').length, 1);
  assert.deepEqual(ui.calls.filter(c => c.name === 'assistant_action').map(c => c.args.request.action), []);
  pet.emit('click', { detail: 0 }); await tick();
  assert.deepEqual(ui.calls.filter(c => c.name === 'assistant_action').map(c => c.args.request.action), ['pet_input']);
});
test('double-press slingshot follows native preferences without changing ordinary dragging', async () => {
  let time = 1000;
  const ui = setup({ view: 'pet', now: () => time }); await tick();
  const pet = ui.nodes.get('pet');
  const press = () => pet.emit('pointerdown', { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
  const release = () => pet.emit('pointerup', { pointerId: 1 });
  const drag = () => pet.emit('pointermove', { pointerId: 1, clientX: 10, clientY: 0 });
  const began = () => ui.petEvents.filter(e => e[0] === 'motion-begin').at(-1)[1];
  const prefs = (revision, slingshot_enabled) => ({ revision, visible: true, roaming_enabled: true, slingshot_enabled });
  press(); release(); time += 100; press(); drag(); assert.equal(began(), true); release();
  ui.emitEvent('pet-settings-state', prefs(2, false));
  press(); release(); time += 100; press(); drag(); assert.equal(began(), false); release();
  ui.emitEvent('pet-settings-state', prefs(1, true));
  time += 100; press(); drag(); assert.equal(began(), false); release();
  ui.emitEvent('pet-settings-state', prefs(3, true));
  time += 100; press(); drag(); assert.equal(began(), false, 'enabling does not reuse an old press'); release();
  time += 100; press(); drag(); assert.equal(began(), true); release();
  ui.window.emit('pagehide');
});

test('pending preferences and disabling an armed pull cannot launch a slingshot', async () => {
  let time = 1000; const reply = deferred();
  const ui = setup({ view: 'pet', now: () => time, getPreferences: () => reply.promise }); await tick();
  const pet = ui.nodes.get('pet');
  const press = () => pet.emit('pointerdown', { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
  const release = () => pet.emit('pointerup', { pointerId: 1 });
  const drag = () => pet.emit('pointermove', { pointerId: 1, clientX: 10, clientY: 0 });
  const prefs = (revision, slingshot_enabled) => ({ revision, visible: true, roaming_enabled: false, slingshot_enabled });
  press(); release(); time += 100; press(); drag();
  assert.equal(ui.petEvents.filter(e => e[0] === 'motion-begin').length, 0, 'native motion waits for preferences'); release();
  ui.emitEvent('pet-settings-state', prefs(4, false));
  reply.resolve(prefs(3, true)); await tick();
  ui.emitEvent('pet-settings-state', prefs(5, true));
  press(); release(); time += 100; press();
  ui.emitEvent('pet-settings-state', prefs(6, false));
  drag(); assert.equal(ui.petEvents.filter(e => e[0] === 'motion-begin').at(-1)[1], false); release();
  const settings = ui.petEvents.filter(e => e[0] === 'slingshot-enabled');
  assert.equal(settings.at(-1)[1], false, 'late initial read cannot re-enable slingshot');
  ui.emitEvent('pet-settings-state', prefs(7, 'false'));
  ui.emitEvent('pet-settings-state', { ...prefs(7, true), slingshot_enabled: undefined });
  assert.equal(ui.petEvents.filter(e => e[0] === 'slingshot-enabled').length, settings.length);
  ui.emitEvent('pet-settings-state', prefs(7, true));
  assert.equal(ui.petEvents.filter(e => e[0] === 'slingshot-enabled').at(-1)[1], true);
  ui.window.emit('pagehide');
});

test('all received messages and titles use text-only DOM sinks, never HTML interpolation', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const ui = setup({ getSnapshot: () => ready(1, { messages: [{ id: 'x', role: 'assistant', text: hostile }], sessions: [{ id: 's', title: hostile }] }) }); await tick();
  const fragment = ui.nodes.get('conversation').children[0];
  const collectText = node => node.textContent + node.children.map(collectText).join('');
  assert.equal(collectText(fragment.children[0].children[1]), hostile);
  assert.equal(ui.nodes.get('sessions').children[0].textContent, hostile);
  assert.equal((source.match(/innerHTML\s*=/g) ?? []).length, 1, 'only static initial markup can use innerHTML');
});

test('upstream renderer mounts in preview without native motion or IPC and disposes on unload', async () => {
  const ui = setup({ native:false,view:'pet' }); await tick();
  assert.equal(ui.petEvents.filter(e=>e[0]==='renderer-mounted').length,1);
  assert.equal(ui.petEvents.filter(e=>e[0]==='motion-mounted').length,0);
  assert.equal(ui.calls.length,0); assert.equal(ui.events.length,0);
  ui.nodes.get('pet').emit('click',{detail:1}); await tick();
  assert.equal(ui.petEvents.filter(e=>e[0]==='click').length,1);
  assert.equal(ui.calls.length,0);
  ui.window.emit('pagehide');
  assert.equal(ui.petEvents.filter(e=>e[0]==='renderer-dispose').length,1);
});

test('native pet visibility stops motion and rejects roaming until restored', async () => {
  const ui=setup({view:'pet'}); await tick();
  const hooks=ui.petEvents.find(e=>e[0]==='renderer-mounted')[1];
  assert.equal(hooks.onMove('move',{durationSec:10},{facing:'left',video:{}}),true);
  const before=ui.petEvents.filter(e=>e[0]==='roam').length;
  ui.emitEvent('pet-visibility',{visible:false,revision:1});
  assert.equal(hooks.onMove('move',{},{}),false);
  assert.equal(ui.petEvents.filter(e=>e[0]==='roam').length,before);
  ui.emitEvent('pet-visibility',{visible:true,revision:2});
  assert.equal(hooks.onMove('move',{durationSec:10},{facing:'left',video:{}}),true);
  ui.window.emit('pagehide');
  assert.equal(ui.stopped(),7);
});


test('pet preference events beat a delayed initial read and same-state events do not restart actions', async () => {
  const reply=deferred();const ui=setup({view:'pet',getPreferences:()=>reply.promise});await tick();
  ui.emitEvent('pet-settings-state',{visible:true,slingshot_enabled:true,roaming_enabled:false,revision:3});
  const before=ui.petEvents.filter(e=>e[0]==='fixed').length;
  reply.resolve({visible:true,slingshot_enabled:true,roaming_enabled:true,revision:2});await tick();
  assert.equal(ui.petEvents.filter(e=>e[0]==='fixed').length,before);
  assert.equal(ui.petEvents.filter(e=>e[0]==='fixed').at(-1)[1],true);
  ui.emitEvent('pet-settings-state',{visible:true,slingshot_enabled:true,roaming_enabled:false,revision:4});
  assert.equal(ui.petEvents.filter(e=>e[0]==='fixed').length,before);
  ui.emitEvent('pet-settings-state',{visible:true,slingshot_enabled:true,roaming_enabled:true,revision:5});
  assert.equal(ui.petEvents.filter(e=>e[0]==='fixed').at(-1)[1],false);
  ui.window.emit('pagehide');assert.equal(ui.stopped(),5);
});

test('pet rejects reordered visibility events independently of roaming preference revisions', async () => {
  const ui=setup({view:'pet'});await tick();
  const hooks=ui.petEvents.find(e=>e[0]==='renderer-mounted')[1];
  ui.emitEvent('pet-visibility',{visible:false,revision:9});
  ui.emitEvent('pet-visibility',{visible:true,revision:8});
  ui.emitEvent('pet-settings-state',{visible:true,slingshot_enabled:true,roaming_enabled:false,revision:7});
  assert.equal(hooks.onMove('move',{},{}),false);
  ui.emitEvent('pet-visibility',{visible:true,revision:10});
  assert.equal(hooks.onMove('move',{},{}),true);
});


test('pet keeps all existing menu actions without a bottom material attribution', async () => {
  const ui=setup({view:'pet'}); await tick(); const markup=ui.nodes.get('assistant-root').innerHTML;
  assert.ok(!markup.includes('pet-status'));
  assert.ok(!markup.includes('class="pet-tools"')); assert.ok(!markup.includes('class="pet-attribution"'));
  const menu=markup.slice(markup.indexOf('<section id="pet-menu"'),markup.indexOf('<div id="pet-bubble"'));
  for(const action of ['toggle_chat','open_dsh','pet_settings','hide']) assert.ok(menu.includes('data-action="'+action+'"'));
  assert.ok(menu.includes('data-pet-command="close-menu"'));
  assert.ok(!menu.includes('data-upstream="true"')); assert.ok(!menu.includes('pet-menu-credit'));
  assert.ok(!menu.includes('动画素材禁止商用')); assert.ok(!menu.includes('<p>'));
});

test('pet menu closes on repeated right-click, explicit close, outside press, Escape and blur', async () => {
  const ui=setup({view:'pet'}); await tick(); const pet=ui.nodes.get('pet'),menu=ui.nodes.get('pet-menu');
  const open=()=>{pet.emit('contextmenu',{clientX:150,clientY:200}); assert.equal(menu.hidden,false);};
  open(); assert.equal(pet.getAttribute('aria-expanded'),'true'); pet.emit('contextmenu'); assert.equal(menu.hidden,true);
  open(); const close=new Node(); close.dataset.petCommand='close-menu'; ui.nodes.get('assistant-root').emit('click',{target:close}); assert.equal(menu.hidden,true);
  open(); ui.document.emit('pointerdown',{button:0,target:new Node()}); assert.equal(menu.hidden,true);
  open(); ui.document.emit('keydown',{key:'Escape'}); assert.equal(menu.hidden,true);
  open(); ui.window.emit('blur'); assert.equal(menu.hidden,true);
  assert.equal(pet.getAttribute('aria-expanded'),'false'); assert.equal(ui.menuTimers.size,0);
  ui.window.emit('pagehide'); pet.emit('contextmenu'); assert.equal(menu.hidden,true);
});

for(const action of ['toggle_chat','open_dsh','pet_settings','hide']) test('pet menu action '+action+' closes before dispatch and restores bubble visibility', async()=>{
  const ui=setup({view:'pet'}); await tick(); ui.nodes.get('pet').emit('contextmenu');
  const button=new Node(); button.dataset.action=action;
  ui.nodes.get('assistant-root').emit('click',{target:button}); await tick();
  assert.equal(ui.nodes.get('pet-menu').hidden,true);
  assert.equal(ui.calls.filter(call=>call.name==='assistant_action').at(-1).args.request.action,action);
  assert.equal(ui.petEvents.filter(event=>event[0]==='bubble-obscured').at(-1)[1],false);
});

test('native visibility loss closes the pet menu and cancels its polling', async()=>{
  const ui=setup({view:'pet'}); await tick(); ui.nodes.get('pet').emit('contextmenu');
  ui.emitEvent('pet-visibility',{visible:false,revision:10});
  assert.equal(ui.nodes.get('pet-menu').hidden,true); assert.equal(ui.menuTimers.size,0);
});

test('pet menu closes from native desktop input even without a DOM outside event', async()=>{
  let g=geometry(); const ui=setup({view:'pet',getGeometry:()=>g}); await tick();
  ui.nodes.get('pet').emit('contextmenu');
  g=geometry({cursor_down:true,cursor:{x:900,y:900}}); ui.flushMenuTimer(); await tick();
  assert.equal(ui.nodes.get('pet-menu').hidden,true); assert.equal(ui.menuTimers.size,0);
  ui.nodes.get('pet').emit('contextmenu'); g=geometry({escape_down:true}); ui.flushMenuTimer(); await tick();
  assert.equal(ui.nodes.get('pet-menu').hidden,true); assert.equal(ui.calls.some(call=>call.name==='move_pet'),false);
});

function clickTopmost(ui) {
  const button=ui.nodes.get('pet-topmost');button.dataset.petCommand='topmost';
  ui.nodes.get('assistant-root').emit('click',{target:button});
}
const petState=(revision,always_on_top)=>({visible:true,slingshot_enabled:true,roaming_enabled:true,always_on_top,revision});

test('right click reads actual topmost and its switch changes only the native pet window', async () => {
  const ui=setup({view:'pet'});await tick();
  const button=ui.nodes.get('pet-topmost');
  assert.equal(button.getAttribute('aria-checked'),'true');
  ui.nodes.get('pet-menu').hidden=true;
  ui.nodes.get('pet').emit('contextmenu');await tick();
  assert.equal(ui.nodes.get('pet-menu').hidden,false);
  assert.equal(ui.calls.filter(c=>c.name==='get_pet_preferences').length,2);
  clickTopmost(ui);await tick();
  assert.equal(button.getAttribute('aria-checked'),'false');
  assert.equal(ui.calls.find(c=>c.name==='set_pet_topmost').args.alwaysOnTop,false);
  clickTopmost(ui);await tick();
  assert.equal(button.getAttribute('aria-checked'),'true');
  assert.equal(ui.calls.filter(c=>c.name==='assistant_action').length,0);
});

test('topmost pending prevents repeat writes and failed writes require read before retry', async () => {
  const reply=deferred();let first=true;
  const ui=setup({view:'pet',setTopmost:value=>{ if(first){first=false;return reply.promise;} return petState(1,value); }});await tick();
  const button=ui.nodes.get('pet-topmost');clickTopmost(ui);clickTopmost(ui);
  assert.equal(button.disabled,true);assert.equal(button.getAttribute('aria-checked'),'true');
  assert.equal(ui.calls.filter(c=>c.name==='set_pet_topmost').length,1);
  reply.reject(new Error('native failed'));await tick();
  assert.equal(button.disabled,false);assert.equal(button.getAttribute('aria-checked'),undefined);
  clickTopmost(ui);await tick();
  assert.equal(ui.calls.filter(c=>c.name==='set_pet_topmost').length,1);
  assert.equal(button.getAttribute('aria-checked'),'true');
  clickTopmost(ui);await tick();
  assert.equal(ui.calls.filter(c=>c.name==='set_pet_topmost').length,2);
  assert.equal(button.getAttribute('aria-checked'),'false');
});

test('newer pet state beats delayed topmost reply and unknown booleans cannot alter switch', async () => {
  const reply=deferred();const ui=setup({view:'pet',setTopmost:()=>reply.promise});await tick();
  const button=ui.nodes.get('pet-topmost');clickTopmost(ui);
  ui.emitEvent('pet-settings-state',petState(8,false));
  reply.resolve(petState(2,true));await tick();
  assert.equal(button.getAttribute('aria-checked'),'false');
  ui.emitEvent('pet-settings-state',{revision:9,always_on_top:'true'});
  assert.equal(button.getAttribute('aria-checked'),'false');
});

test('topmost is disabled and sends no IPC in browser preview', async () => {
  const ui=setup({view:'pet',native:false});await tick();
  const button=ui.nodes.get('pet-topmost');assert.equal(button.disabled,true);
  assert.equal(button.getAttribute('aria-checked'),undefined);
  clickTopmost(ui);ui.nodes.get('pet').emit('contextmenu');await tick();
  assert.equal(ui.calls.length,0);
});

test('late topmost reply after unload cannot change the right-click switch', async () => {
  const reply=deferred();const ui=setup({view:'pet',setTopmost:()=>reply.promise});await tick();
  const button=ui.nodes.get('pet-topmost');clickTopmost(ui);
  const before=[button.textContent,button.getAttribute('aria-checked'),button.disabled];
  ui.window.emit('pagehide');reply.resolve(petState(1,false));await tick();
  assert.deepEqual([button.textContent,button.getAttribute('aria-checked'),button.disabled],before);
});


const bubbleMessage=id=>({id,kind:'completed',title:'本轮执行结束',body:'点击查看对应会话'});
function clickSlingshot(ui) {
  const button=ui.nodes.get('pet-slingshot');button.dataset.petCommand='slingshot';
  ui.nodes.get('assistant-root').emit('click',{target:button});
}
const slingshotState=(revision,slingshot_enabled)=>({...petState(revision,true),slingshot_enabled});

test('pet slingshot menu item has an accessible switch and scoped command', () => {
  const markup=source.match(/<button\b[^>]*\bid="pet-slingshot"[^>]*>/g) ?? [];
  assert.equal(markup.length,1);
  assert.match(markup[0],/role="switch"/);
  assert.match(markup[0],/aria-label="允许弹弓"/);
  assert.match(markup[0],/data-pet-command="slingshot"/);
});

test('right-click slingshot switch persists both directions without changing topmost or ordinary drag', async () => {
  let time=1000;
  const ui=setup({view:'pet',now:()=>time});await tick();
  const button=ui.nodes.get('pet-slingshot'),pet=ui.nodes.get('pet');
  assert.equal(button.getAttribute('aria-checked'),'true');
  pet.emit('contextmenu');await tick();
  assert.equal(ui.calls.filter(c=>c.name==='get_pet_preferences').length,2,'menu shares one preference refresh');
  clickSlingshot(ui);await tick();
  assert.equal(button.getAttribute('aria-checked'),'false');
  assert.match(button.title,/拖动松手即停，不再弹射或甩抛/);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.find(c=>c.name==='set_pet_slingshot_enabled').args)),{enabled:false});
  assert.equal(ui.nodes.get('pet-menu').hidden,true);
  assert.equal(ui.nodes.get('pet-topmost').getAttribute('aria-checked'),'true');
  const press=()=>pet.emit('pointerdown',{button:0,pointerId:1,clientX:0,clientY:0});
  const release=()=>pet.emit('pointerup',{pointerId:1});
  const drag=()=>pet.emit('pointermove',{pointerId:1,clientX:10,clientY:0});
  press();release();time+=100;press();drag();release();
  assert.equal(ui.petEvents.filter(e=>e[0]==='motion-begin').at(-1)[1],false);
  clickTopmost(ui);await tick(); // another native setting must preserve the saved slingshot value/revision
  assert.equal(button.getAttribute('aria-checked'),'false');
  pet.emit('contextmenu');await tick();
  assert.equal(button.getAttribute('aria-checked'),'false','readback keeps the saved preference');
  clickSlingshot(ui);await tick();
  assert.equal(button.getAttribute('aria-checked'),'true');
  assert.equal(ui.nodes.get('pet-topmost').getAttribute('aria-checked'),'false');
  assert.deepEqual(ui.calls.filter(c=>c.name==='set_pet_slingshot_enabled').map(c=>c.args.enabled),[false,true]);
  time+=100;press();drag();release();
  assert.equal(ui.petEvents.filter(e=>e[0]==='motion-begin').at(-1)[1],false,'enabling does not reuse an old press');
  time+=100;press();drag();release();
  assert.equal(ui.petEvents.filter(e=>e[0]==='motion-begin').at(-1)[1],true);
  assert.equal(ui.calls.filter(c=>c.name==='assistant_action').length,0);
  ui.window.emit('pagehide');
});

test('slingshot save disables repeat clicks without optimistic switch or motion updates', async () => {
  const reply=deferred();const ui=setup({view:'pet',setSlingshot:()=>reply.promise});await tick();
  const button=ui.nodes.get('pet-slingshot');
  const changes=ui.petEvents.filter(e=>e[0]==='slingshot-enabled').length;
  clickSlingshot(ui);clickSlingshot(ui);
  assert.equal(button.disabled,true);
  assert.equal(button.getAttribute('aria-checked'),'true');
  assert.equal(ui.petEvents.filter(e=>e[0]==='slingshot-enabled').length,changes);
  assert.equal(ui.calls.filter(c=>c.name==='set_pet_slingshot_enabled').length,1);
  reply.resolve(slingshotState(1,false));await tick();
  assert.equal(button.disabled,false);assert.equal(button.getAttribute('aria-checked'),'false');
  assert.equal(ui.petEvents.filter(e=>e[0]==='slingshot-enabled').at(-1)[1],false);
});

test('unknown slingshot click only retries reading and pending read prevents duplicate writes', async () => {
  const reply=deferred();let reads=0;
  const ui=setup({view:'pet',getPreferences:()=>++reads===1?Promise.reject(new Error('read failed')):reply.promise});await tick();
  const button=ui.nodes.get('pet-slingshot');
  assert.equal(button.getAttribute('aria-checked'),undefined);
  assert.equal(button.getAttribute('data-state'),'unknown');assert.equal(button.disabled,false);
  clickSlingshot(ui);clickSlingshot(ui);
  assert.equal(button.disabled,true);
  assert.equal(ui.calls.filter(c=>c.name==='get_pet_preferences').length,2);

  assert.equal(ui.calls.filter(c=>c.name==='set_pet_slingshot_enabled').length,0);
  reply.resolve(slingshotState(0,false));await tick();
  assert.equal(button.disabled,false);assert.equal(button.getAttribute('aria-checked'),'false');
  assert.equal(ui.calls.filter(c=>c.name==='set_pet_slingshot_enabled').length,0,'successful retry is not an implicit toggle');
});

test('failed slingshot write reports failure and requires same-revision read before another write', async () => {
  const reply=deferred();let first=true;
  const ui=setup({view:'pet',setSlingshot:value=>{if(first){first=false;return reply.promise;}return slingshotState(1,value);}});await tick();
  const button=ui.nodes.get('pet-slingshot');clickSlingshot(ui);
  reply.reject(new Error('native failed'));await tick();
  assert.equal(button.disabled,false);assert.equal(button.getAttribute('aria-checked'),undefined);
  assert.equal(button.getAttribute('data-state'),'unknown');
  assert.equal(ui.nodes.get('pet-speech').hidden,false);assert.match(ui.nodes.get('pet-speech-text').textContent,/弹弓/);
  clickSlingshot(ui);await tick();
  assert.equal(button.getAttribute('aria-checked'),'true','same-revision read restores known state');
  assert.equal(ui.calls.filter(c=>c.name==='set_pet_slingshot_enabled').length,1);
  clickSlingshot(ui);await tick();
  assert.equal(button.getAttribute('aria-checked'),'false');
  assert.equal(ui.calls.filter(c=>c.name==='set_pet_slingshot_enabled').length,2);
});

test('newer pet settings beat delayed slingshot write and invalid booleans cannot alter switch', async () => {
  const reply=deferred();const ui=setup({view:'pet',setSlingshot:()=>reply.promise});await tick();
  const button=ui.nodes.get('pet-slingshot');clickSlingshot(ui);
  ui.emitEvent('pet-settings-state',slingshotState(8,false));
  reply.resolve(slingshotState(2,true));await tick();
  assert.equal(button.getAttribute('aria-checked'),'false');assert.equal(button.disabled,false);
  ui.emitEvent('pet-settings-state',slingshotState(7,true));
  for(const invalid of ['true',null,undefined]) ui.emitEvent('pet-settings-state',slingshotState(9,invalid));
  assert.equal(button.getAttribute('aria-checked'),'false');
  ui.emitEvent('pet-settings-state',slingshotState(9,true));
  assert.equal(button.getAttribute('aria-checked'),'true','invalid state must not consume revision');
});

test('newer pet settings keep slingshot known when an older write fails', async () => {
  const reply=deferred();const ui=setup({view:'pet',setSlingshot:()=>reply.promise});await tick();
  const button=ui.nodes.get('pet-slingshot');clickSlingshot(ui);
  ui.emitEvent('pet-settings-state',slingshotState(8,false));
  reply.reject(new Error('reply lost'));await tick();
  assert.equal(button.getAttribute('aria-checked'),'false');assert.equal(button.disabled,false);
  assert.equal(ui.nodes.get('pet-speech').hidden,false);assert.match(ui.nodes.get('pet-speech-text').textContent,/弹弓/);
  const reads=ui.calls.filter(c=>c.name==='get_pet_preferences').length;
  clickSlingshot(ui);await tick();
  assert.equal(ui.calls.filter(c=>c.name==='get_pet_preferences').length,reads,'newer event avoids unnecessary recovery read');
  assert.equal(ui.calls.filter(c=>c.name==='set_pet_slingshot_enabled').length,2);
});

test('newer pet settings beat delayed initial and menu preference reads for slingshot', async () => {
  const initial=deferred(),refresh=deferred();let reads=0;
  const ui=setup({view:'pet',getPreferences:()=>++reads===1?initial.promise:refresh.promise});await tick();
  const button=ui.nodes.get('pet-slingshot');
  assert.equal(button.getAttribute('aria-checked'),undefined);
  ui.emitEvent('pet-settings-state',slingshotState(8,false));
  initial.resolve(slingshotState(2,true));await tick();
  assert.equal(button.getAttribute('aria-checked'),'false');
  ui.nodes.get('pet').emit('contextmenu');await tick();
  ui.emitEvent('pet-settings-state',slingshotState(9,true));
  refresh.resolve(slingshotState(8,false));await tick();
  assert.equal(button.getAttribute('aria-checked'),'true');
});

test('malformed slingshot write response leaves unknown state and read-only retry', async () => {
  const ui=setup({view:'pet',setSlingshot:()=>slingshotState(1,'false')});await tick();
  const button=ui.nodes.get('pet-slingshot');clickSlingshot(ui);await tick();
  assert.equal(button.getAttribute('aria-checked'),undefined);assert.equal(button.getAttribute('data-state'),'unknown');
  assert.equal(ui.nodes.get('pet-speech').hidden,false);assert.match(ui.nodes.get('pet-speech-text').textContent,/弹弓/);
  clickSlingshot(ui);await tick();
  assert.equal(button.getAttribute('aria-checked'),'true');
  assert.equal(ui.calls.filter(c=>c.name==='set_pet_slingshot_enabled').length,1);
});

test('slingshot switch is disabled and never invokes or subscribes IPC in browser preview', async () => {
  const ui=setup({view:'pet',native:false});await tick();
  const button=ui.nodes.get('pet-slingshot');
  assert.equal(button.disabled,true);assert.equal(button.getAttribute('aria-checked'),undefined);
  clickSlingshot(ui);ui.nodes.get('pet').emit('contextmenu');clickSlingshot(ui);await tick();
  assert.equal(ui.calls.length,0);assert.equal(ui.events.length,0);
});

for(const outcome of ['resolve','reject']) test('late slingshot '+outcome+' after unload cannot write DOM', async () => {
  const reply=deferred();const ui=setup({view:'pet',setSlingshot:()=>reply.promise});await tick();
  clickSlingshot(ui);ui.window.emit('pagehide');
  const state=()=>['pet-slingshot','notice'].map(id=>{const node=ui.nodes.get(id);return [node.textContent,[...node.attributes],{...node.dataset},node.disabled,node.hidden,node.title];});
  const before=state();const count=ui.calls.length;
  if(outcome==='resolve') reply.resolve(slingshotState(1,false));else reply.reject(new Error('late failure'));
  ui.emitEvent('pet-settings-state',slingshotState(9,false));await tick();
  clickSlingshot(ui);await tick();
  assert.deepEqual(state(),before);assert.equal(ui.calls.length,count);
});

test('late slingshot preference retry after unload cannot write DOM', async () => {
  const reply=deferred();let reads=0;
  const ui=setup({view:'pet',getPreferences:()=>++reads===1?Promise.reject(new Error('read failed')):reply.promise});await tick();
  clickSlingshot(ui);ui.window.emit('pagehide');
  const button=ui.nodes.get('pet-slingshot');
  const before=[button.textContent,[...button.attributes],button.disabled,button.title];
  reply.resolve(slingshotState(1,true));await tick();
  assert.deepEqual([button.textContent,[...button.attributes],button.disabled,button.title],before);
});

const bubblePreferences=(revision,enabled=true,visible=true)=>({visible,bubble_notifications:enabled,slingshot_enabled:true,roaming_enabled:true,message:'',revision});

test('bubble host subscribes before pulling inbox and opens only opaque native ids', async () => {
  const ui=setup({view:'pet',getInbox:()=>{assert.ok(ui.events.includes('pet-notification'));return [];}});await tick();
  assert.equal(ui.calls.filter(c=>c.name==='get_pet_notifications').length,1);
  ui.emitEvent('pet-notification',bubbleMessage('opaque-1'));
  assert.equal(ui.petEvents.filter(e=>e[0]==='bubble-enqueue').at(-1)[1].id,'opaque-1');
  const renderer=ui.petEvents.find(e=>e[0]==='renderer-mounted')[1];
  assert.equal(renderer.onMove('move',{},{}),false);
  const hooks=ui.petEvents.find(e=>e[0]==='bubble-mounted')[1];
  await hooks.onOpen('opaque-1');hooks.onDismiss('opaque-1');await tick();
  for(const name of ['open_pet_notification','dismiss_pet_notification']) {
    const call=ui.calls.find(c=>c.name===name);assert.equal(call.args.id,'opaque-1');assert.deepEqual(Object.keys(call.args),['id']);
  }
  assert.equal(ui.calls.filter(c=>c.name==='assistant_action').length,0);
});

test('bubble visibility and its own preference clear and suppress notifications without showing pet', async () => {
  const ui=setup({view:'pet'});await tick();ui.emitEvent('pet-notification',bubbleMessage('first'));
  ui.emitEvent('pet-visibility',{visible:false,revision:1});
  ui.emitEvent('pet-notification',bubbleMessage('hidden'));
  assert.equal(ui.petEvents.filter(e=>e[0]==='bubble-enqueue').length,1);
  ui.emitEvent('pet-settings-state',bubblePreferences(2,true,true));
  ui.emitEvent('pet-notification',bubbleMessage('shown'));
  ui.emitEvent('pet-settings-state',bubblePreferences(3,false,true));
  ui.emitEvent('pet-notification',bubbleMessage('disabled'));
  assert.deepEqual(ui.petEvents.filter(e=>e[0]==='bubble-enqueue').map(e=>e[1].id),['first','shown']);
  assert.equal(ui.nodes.get('pet-bubble').hidden,true);
  assert.equal(ui.calls.filter(c=>c.name==='assistant_action').length,0);
});

test('pet action menu pauses bubble clock and roaming without navigating away', async () => {
  const ui=setup({view:'pet'});await tick();
  const command=new Node();command.dataset.petCommand='menu';
  ui.nodes.get('assistant-root').emit('click',{target:command});await tick();
  assert.equal(ui.petEvents.filter(e=>e[0]==='bubble-obscured').at(-1)[1],true);
  const renderer=ui.petEvents.find(e=>e[0]==='renderer-mounted')[1];assert.equal(renderer.onMove('move',{},{}),false);
  command.dataset.petCommand='close-menu';ui.nodes.get('assistant-root').emit('click',{target:command});
  assert.equal(ui.petEvents.filter(e=>e[0]==='bubble-obscured').at(-1)[1],false);
});

test('stale inbox reply cannot replay hidden-period bubbles after reactivation', async () => {
  const old=deferred();let reads=0;
  const ui=setup({view:'pet',getInbox:()=>++reads===1?old.promise:[bubbleMessage('fresh')]});await tick();
  ui.emitEvent('pet-visibility',{visible:false,revision:1});ui.emitEvent('pet-visibility',{visible:true,revision:2});
  old.resolve([bubbleMessage('old')]);await tick();
  assert.equal(reads,2);assert.deepEqual(ui.petEvents.filter(e=>e[0]==='bubble-enqueue').map(e=>e[1].id),['fresh']);
});

test('bubble listener failure leaves chat transport usable and menu reopens retry the feed', async () => {
  let failed=false;
  const ui=setup({view:'pet',listenGate:name=>{if(name==='pet-notification'&&!failed){failed=true;throw new Error('listener');}}});await tick();
  assert.equal(ui.calls.filter(c=>c.name==='get_assistant_snapshot').length,1);
  const command=new Node();command.dataset.petCommand='menu';ui.nodes.get('assistant-root').emit('click',{target:command});await tick();
  assert.equal(ui.events.filter(e=>e==='pet-notification').length,2);
  assert.equal(ui.calls.filter(c=>c.name==='get_pet_notifications').length,1);
});

test('late bubble listener registration after unload is released without reading or rendering', async () => {
  const gate=deferred();
  const ui=setup({view:'pet',listenGate:name=>name==='pet-notification'?gate.promise:undefined});await tick();
  ui.window.emit('pagehide');gate.resolve();await tick();
  assert.equal(ui.stopped(),7);assert.equal(ui.calls.filter(c=>c.name==='get_pet_notifications').length,0);
  ui.emitEvent('pet-notification',bubbleMessage('late'));
  assert.equal(ui.petEvents.filter(e=>e[0]==='bubble-enqueue').length,0);
  assert.equal(ui.petEvents.filter(e=>e[0]==='bubble-dispose').length,1);
});


const interactionCard=(id='opaque-question')=>({id,kind:'questions',agent_label:'会话 demo',questions:[{id:'q',question:'选择方案',options:[{label:'A'},{label:'B'}]}],can_allow:false,answerable:true});
const interactionState=(revision,items=[],connected=true)=>({revision,items,connected});

test('interactive host subscribes before get and sends only opaque id plus typed reply', async () => {
  const ui=setup({view:'pet',getInteractions:()=>{assert.ok(ui.events.includes('pet-interactions-state'));return interactionState(1,[interactionCard()]);}});await tick();
  const hooks=ui.petEvents.find(e=>e[0]==='interaction-mounted')[1];
  await hooks.onSubmit('opaque-question',{kind:'questions',answers:[{id:'q',selected:['A']}]});
  const call=ui.calls.find(c=>c.name==='submit_pet_interaction');
  assert.deepEqual(Object.keys(call.args).sort(),['id','reply']);assert.equal(call.args.id,'opaque-question');
  assert.equal(call.args.reply.answers[0].selected[0],'A');
  await hooks.onOpen('opaque-question');assert.equal(ui.calls.find(c=>c.name==='open_pet_interaction').args.id,'opaque-question');
  assert.equal(ui.calls.filter(c=>c.name==='assistant_action').length,0);
});

test('cancel snapshot rejects obsolete reply hooks and disables input surface without resending', async () => {
  const ui=setup({view:'pet'});await tick();ui.emitEvent('pet-interactions-state',interactionState(1,[interactionCard()]));await tick();
  const hooks=ui.petEvents.find(e=>e[0]==='interaction-mounted')[1];
  ui.emitEvent('pet-interactions-state',interactionState(2,[]));await tick();
  await assert.rejects(hooks.onSubmit('opaque-question',{kind:'approval',decision:'allowed-once'}));
  assert.equal(ui.calls.filter(c=>c.name==='submit_pet_interaction').length,0);
  assert.equal(ui.calls.filter(c=>c.name==='set_pet_interaction_surface').at(-1).args.active,false);
  assert.equal(ui.nodes.get('pet-interaction').hidden,true);
});

test('newer interaction stream state defeats old initial get and pauses passive reminders', async () => {
  const reply=deferred();const ui=setup({view:'pet',getInteractions:()=>reply.promise});await tick();
  ui.emitEvent('pet-interactions-state',interactionState(5,[interactionCard()]));
  reply.resolve(interactionState(1,[]));await tick();
  assert.equal(ui.petEvents.filter(e=>e[0]==='interaction-update').at(-1)[1].revision,5);
  assert.equal(ui.petEvents.filter(e=>e[0]==='bubble-obscured').at(-1)[1],true);
  const renderer=ui.petEvents.find(e=>e[0]==='renderer-mounted')[1];assert.equal(renderer.onMove('move',{},{}),false);
});

test('hidden and disabled interaction surface cannot submit and hiding sends no business rejection', async () => {
  const ui=setup({view:'pet'});await tick();ui.emitEvent('pet-interactions-state',interactionState(1,[interactionCard()]));
  const hooks=ui.petEvents.find(e=>e[0]==='interaction-mounted')[1];
  ui.emitEvent('pet-visibility',{visible:false,revision:1});await tick();
  assert.equal(ui.nodes.get('pet-interaction').hidden,true);
  await assert.rejects(hooks.onSubmit('opaque-question',{kind:'approval',decision:'rejected'}));
  ui.emitEvent('pet-settings-state',bubblePreferences(2,false,true));await tick();
  await assert.rejects(hooks.onSubmit('opaque-question',{kind:'questions',answers:[]}));
  assert.equal(ui.calls.filter(c=>c.name==='submit_pet_interaction').length,0);
});

test('withdrawn passive reminder ids do not become a second waiting bubble', async () => {
  const ui=setup({view:'pet'});await tick();
  ui.emitEvent('pet-notification',{type:'withdraw',ids:['old-reminder']});
  assert.equal(ui.petEvents.filter(e=>e[0]==='bubble-withdraw').at(-1)[1],'old-reminder');
  assert.equal(ui.petEvents.filter(e=>e[0]==='bubble-enqueue').length,0);
});

test('late interactive listener is cleaned after unload and no snapshot or answer is sent', async () => {
  const gate=deferred();const ui=setup({view:'pet',listenGate:name=>name==='pet-interactions-state'?gate.promise:undefined});await tick();
  ui.window.emit('pagehide');gate.resolve();await tick();
  assert.equal(ui.stopped(),7);assert.equal(ui.calls.filter(c=>c.name==='get_pet_interactions').length,0);
  ui.emitEvent('pet-interactions-state',interactionState(1,[interactionCard()]));
  assert.equal(ui.petEvents.filter(e=>e[0]==='interaction-update').length,0);
  assert.equal(ui.petEvents.filter(e=>e[0]==='interaction-dispose').length,1);
});

test('pet click opens inline input with explicit focus, never the chat window; closing keeps the draft', async () => {
  const ui=setup({view:'pet'}); await tick();
  assert.equal(ui.nodes.get('pet-dialogue').hidden,true);
  ui.nodes.get('pet').emit('click',{detail:1}); await tick();
  assert.equal(ui.nodes.get('pet-dialogue').hidden,false);
  assert.equal(ui.nodes.get('pet-composer').hidden,false);
  assert.equal(ui.document.activeElement,ui.nodes.get('draft'));
  assert.equal(ui.calls.filter(c=>c.args?.request?.action==='toggle_chat').length,0);
  const draft=ui.nodes.get('draft');draft.value='明天继续聊';draft.emit('input');
  ui.nodes.get('pet-input-close').emit('click');await tick();
  assert.equal(ui.nodes.get('pet-composer').hidden,true);
  assert.equal(draft.value,'明天继续聊');assert.equal(ui.document.activeElement,null);
  assert.equal(ui.calls.filter(c=>c.args?.request?.action==='pet_input').at(-1).args.request.active,false);
  ui.nodes.get('pet').emit('click',{detail:1});await tick();assert.equal(draft.value,'明天继续聊');
  ui.window.emit('pagehide');
});

for (const entry of ['click', 'talk']) test('pet '+entry+' input survives native focus handoff blur and still dismisses explicitly', async () => {
  const activation=deferred();
  const ui=setup({view:'pet',actionResult:request=>request.action==='pet_input'&&request.active?activation.promise:undefined});await tick();
  if(entry==='click') ui.nodes.get('pet').emit('click',{detail:1});
  else {
    ui.nodes.get('pet').emit('contextmenu');
    const talk=new Node();talk.dataset.petCommand='talk';
    ui.nodes.get('assistant-root').emit('click',{target:talk});
  }
  await tick();
  const composer=ui.nodes.get('pet-composer'),draft=ui.nodes.get('draft');
  draft.value='保留这句话';draft.emit('input');
  // WebView2 can emit blur while the initially non-focusable pet gains native focus.
  ui.window.emit('blur');
  assert.equal(composer.hidden,false,'focus handoff must not close the input lease');
  activation.resolve();await tick();
  assert.equal(ui.document.activeElement,draft);
  ui.window.emit('blur');
  assert.equal(composer.hidden,false,'a late native blur is not an explicit outside click');
  assert.equal(ui.calls.filter(c=>c.args?.request?.action==='pet_input'&&!c.args.request.active).length,0);
  ui.document.emit('pointerdown',{button:0,target:new Node()});await tick();
  assert.equal(composer.hidden,true);
  assert.equal(draft.value,'保留这句话');
  assert.equal(ui.calls.filter(c=>c.args?.request?.action==='pet_input').at(-1).args.request.active,false);
  ui.window.emit('pagehide');assert.equal(ui.menuTimers.size,0);
});

test('pet shows current-turn thinking then streamed reply without stealing keyboard focus', async () => {
  const old={id:'old',role:'assistant',text:'上一轮的回答'};
  const ui=setup({view:'pet',getSnapshot:()=>ready(1,{messages:[old]})});await tick();
  assert.equal(ui.nodes.get('pet-dialogue').hidden,true,'history must not pop up on startup');
  const user={id:'u',role:'user',text:'你好'};
  ui.emit(ready(2,{running:true,messages:[old,user]}));
  assert.equal(ui.nodes.get('pet-speech-text').textContent,'让我想想…');
  assert.equal(ui.nodes.get('cancel').hidden,false);
  ui.emit(ready(3,{running:true,messages:[old,user,{id:'answer',role:'assistant',text:'你好，'}]}));
  assert.equal(ui.nodes.get('pet-speech-text').textContent,'你好，');assert.equal(ui.speechTimers.size,0);
  ui.emit(ready(4,{messages:[old,user,{id:'answer',role:'assistant',text:'你好，我在呢。'}]}));
  assert.equal(ui.nodes.get('pet-speech-text').textContent,'你好，我在呢。');assert.equal(ui.speechTimers.size,1);
  assert.equal(ui.document.activeElement,undefined);
  assert.equal(ui.calls.filter(c=>c.args?.request?.action==='pet_input').length,0);
  ui.nodes.get('pet-dialogue').emit('pointerenter');assert.equal(ui.speechTimers.size,0);
  ui.nodes.get('pet-dialogue').emit('pointerleave');assert.equal(ui.speechTimers.size,1);
  ui.flushSpeechTimer();assert.equal(ui.nodes.get('pet-dialogue').hidden,true);
  ui.nodes.get('pet').emit('click',{detail:1});await tick();
  assert.equal(ui.nodes.get('pet-speech-text').textContent,'你好，我在呢。');
  ui.window.emit('pagehide');
});

test('pet send uses shared acknowledgement safety and only collapses input after its exact echo', async () => {
  const result=deferred();
  const ui=setup({view:'pet',actionResult:request=>request.action==='send'?result.promise:undefined});await tick();
  ui.nodes.get('pet').emit('click',{detail:1});await tick();
  const draft=ui.nodes.get('draft');draft.value='你好';draft.emit('input');
  ui.nodes.get('send-form').emit('submit');await tick();
  const request=ui.calls.find(c=>c.args?.request?.action==='send').args.request;
  assert.equal(ui.nodes.get('pet-composer').hidden,false);
  ui.emit(ready(2,{running:true,messages:[{id:'u',role:'user',text:'你好',request_id:request.requestId}]}));await tick();
  assert.equal(draft.value,'');assert.equal(ui.nodes.get('pet-composer').hidden,true);
  assert.equal(ui.nodes.get('pet-speech-text').textContent,'让我想想…');
  result.reject(new Error('late IPC error'));await tick();assert.equal(draft.value,'');
  assert.equal(ui.calls.filter(c=>c.args?.request?.action==='send').length,1);
  ui.window.emit('pagehide');
});

test('long pet replies stay readable, expand locally and do not inject HTML', async () => {
  const ui=setup({view:'pet'});await tick();
  const text='<img src=x onerror=alert(1)>\n'+ '这是长回复。'.repeat(60);
  ui.emit(ready(2,{messages:[{id:'a',role:'assistant',text}]}));
  assert.equal(ui.nodes.get('pet-speech-text').textContent,text);assert.equal(ui.speechTimers.size,0);
  ui.nodes.get('pet-speech-expand').emit('click');
  assert.equal(ui.nodes.get('pet-dialogue').dataset.expanded,'true');
  ui.nodes.get('pet-speech-close').emit('click');
  assert.equal(ui.nodes.get('pet-dialogue').hidden,true);
  ui.emit(ready(3,{messages:[{id:'a',role:'assistant',text}]}));
  assert.equal(ui.nodes.get('pet-dialogue').hidden,true,'unchanged snapshots cannot resurrect dismissed speech');
  ui.window.emit('pagehide');
});

test('pending confirmations take priority over pet speech and close input without discarding the draft', async () => {
  const ui=setup({view:'pet'});await tick();ui.nodes.get('pet').emit('click',{detail:1});await tick();
  const draft=ui.nodes.get('draft');draft.value='稍后发送';draft.emit('input');
  ui.emitEvent('pet-interactions-state',interactionState(1,[interactionCard()]));await tick();
  assert.equal(ui.nodes.get('pet-dialogue').hidden,true);assert.equal(ui.nodes.get('pet-composer').hidden,true);
  assert.equal(draft.value,'稍后发送');assert.equal(ui.nodes.get('pet-interaction').hidden,false);
  ui.nodes.get('pet').emit('click',{detail:1});await tick();
  assert.equal(ui.nodes.get('pet-composer').hidden,true);
  ui.emitEvent('pet-interactions-state',interactionState(2,[]));
  assert.equal(ui.nodes.get('pet-dialogue').hidden,false);
  ui.window.emit('pagehide');
});

test('late native input activation cannot focus a closed or disposed composer', async () => {
  const gate=deferred();
  const ui=setup({view:'pet',actionResult:request=>request.action==='pet_input'&&request.active?gate.promise:undefined});await tick();
  ui.nodes.get('pet').emit('click',{detail:1});await tick();
  ui.nodes.get('pet-input-close').emit('click');ui.window.emit('pagehide');
  gate.resolve(undefined);await tick();
  assert.equal(ui.nodes.get('draft').focusCount,undefined);
  assert.equal(ui.calls.filter(c=>c.args?.request?.action==='pet_input').at(-1).args.request.active,false);
});

test('native input failure keeps the draft and reports recovery in the pet bubble', async () => {
  const ui=setup({view:'pet',actionResult:request=>{if(request.action==='pet_input'&&request.active)throw new Error('focus failed');}});await tick();
  const draft=ui.nodes.get('draft');draft.value='保留我';
  ui.nodes.get('pet').emit('click',{detail:1});await tick();
  assert.equal(ui.nodes.get('pet-composer').hidden,true);assert.equal(draft.value,'保留我');
  assert.match(ui.nodes.get('pet-speech-text').textContent,/暂时无法输入/);
  assert.equal(ui.calls.filter(c=>c.args?.request?.action==='pet_input').at(-1).args.request.active,false);
  ui.window.emit('pagehide');
});

test('inline pet input works with passive bubbles disabled and closes on desktop outside click', async () => {
  let g=geometry();
  const ui=setup({view:'pet',getGeometry:()=>g,getPreferences:()=>bubblePreferences(1,false,true)});await tick();
  ui.nodes.get('pet').emit('click',{detail:1});await tick();
  assert.equal(ui.nodes.get('pet-composer').hidden,false);
  g=geometry({cursor_down:true,cursor:{x:900,y:900}});ui.flushMenuTimer();await tick();
  assert.equal(ui.nodes.get('pet-composer').hidden,true);
  assert.equal(ui.calls.some(c=>c.args?.request?.action==='toggle_chat'),false);
  ui.window.emit('pagehide');
});

test('Escape hides pet conversation without cancelling its running task or losing the draft', async () => {
  const ui=setup({view:'pet'});await tick();ui.nodes.get('pet').emit('click',{detail:1});await tick();
  const draft=ui.nodes.get('draft');draft.value='还有一句';draft.emit('input');
  ui.emit(ready(2,{running:true}));ui.document.emit('keydown',{key:'Escape'});await tick();
  assert.equal(ui.nodes.get('pet-dialogue').hidden,true);assert.equal(draft.value,'还有一句');
  assert.equal(ui.calls.some(c=>c.args?.request?.action==='cancel'),false);
  ui.window.emit('pagehide');
});

test('restoring a connection hydrates saved history silently before delivering live replies',async()=>{
  const ui=setup({view:'pet',getSnapshot:()=>ready(1,{connected:false,phase:'connecting'})});await tick();
  ui.emit(ready(2,{messages:[{id:'saved',role:'assistant',text:'历史回复'}]}));
  assert.equal(ui.nodes.get('pet-dialogue').hidden,true);
  ui.emit(ready(3,{messages:[{id:'new',role:'assistant',text:'刚收到的新回复'}]}));
  assert.equal(ui.nodes.get('pet-dialogue').hidden,false);ui.window.emit('pagehide');
});

test('dismissed streamed speech is not resurrected by chunks or its completion',async()=>{
  const ui=setup({view:'pet'});await tick();
  ui.emit(ready(2,{running:true,messages:[{id:'a',role:'assistant',text:'开始'}]}));
  ui.nodes.get('pet-speech-close').emit('click');
  ui.emit(ready(3,{running:true,messages:[{id:'a',role:'assistant',text:'开始处理'}]}));
  ui.emit(ready(4,{messages:[{id:'a',role:'assistant',text:'开始处理，完成了。'}]}));
  assert.equal(ui.nodes.get('pet-dialogue').hidden,true);
  ui.nodes.get('pet').emit('click',{detail:1});await tick();
  assert.equal(ui.nodes.get('pet-dialogue').hidden,false);ui.window.emit('pagehide');
});

test('IME Escape neither sends nor closes the pet composer',async()=>{
  let g=geometry({escape_down:true});const ui=setup({view:'pet',getGeometry:()=>g});await tick();
  ui.nodes.get('pet').emit('click',{detail:1});await tick();
  ui.nodes.get('draft').emit('compositionstart');
  ui.document.emit('keydown',{key:'Escape',isComposing:true,keyCode:229});
  ui.flushMenuTimer();await tick();assert.equal(ui.nodes.get('pet-composer').hidden,false);
  ui.nodes.get('draft').emit('compositionend');g=geometry();
  ui.document.emit('keydown',{key:'Escape'});await tick();assert.equal(ui.nodes.get('pet-composer').hidden,true);
  ui.window.emit('pagehide');
});

function toggleReading(ui) {
  const button=ui.nodes.get('pet-auto-read');button.dataset.petCommand='auto-read';
  ui.nodes.get('assistant-root').emit('click',{target:button});
}
const spokenAnswer=(id='a',text='你好，我在呢。')=>({id,role:'assistant',text,status:'completed'});

test('PET speech preferences subscribe before read, reject older replies and update live volume',async()=>{
 const pending=deferred();const ui=setup({view:'pet',speechSupported:true,getSpeechPreferences:()=>pending.promise});await tick();
 assert.equal(ui.nodes.get('pet-auto-read').disabled,true);assert.equal(ui.nodes.get('pet-auto-read').getAttribute('aria-checked'),'false');
 assert.ok(ui.events.includes('launcher-speech-preferences'));assert.ok(ui.events.includes('launcher-speech-stop'));
 ui.emitEvent('launcher-speech-preferences',{revision:10,initialized:true,auto_read:true,volume:24});pending.resolve({revision:1,initialized:false,auto_read:false,volume:100});await tick();
 assert.equal(ui.nodes.get('pet-auto-read').getAttribute('aria-checked'),'true');assert.equal(ui.narration.volume,24);
 ui.emitEvent('launcher-speech-preferences',{revision:9,initialized:true,auto_read:false,volume:90});assert.equal(ui.narration.volume,24);
 ui.emitEvent('launcher-speech-preferences',{revision:11,initialized:true,auto_read:false,volume:0});assert.equal(ui.nodes.get('pet-auto-read').getAttribute('aria-checked'),'false');assert.equal(ui.narration.volume,0);ui.window.emit('pagehide');
});
test('legacy Qwen opt-in migrates once only when native preferences are uninitialized',async()=>{
 const ui=setup({view:'pet',speechSupported:true,autoRead:true});await tick();
 const writes=ui.calls.filter(c=>c.name==='set_speech_preferences');assert.equal(writes.length,1);assert.deepEqual(JSON.parse(JSON.stringify(writes[0].args)),{patch:{auto_read:true,volume:100,migrate:true}});assert.equal(ui.preferences.has('dsh-assistant:qwen-auto-read'),false);ui.window.emit('pagehide');
 const explicit=setup({view:'pet',speechSupported:true,autoRead:true,getSpeechPreferences:()=>({revision:4,initialized:true,auto_read:false,volume:35})});await tick();assert.equal(explicit.calls.some(c=>c.name==='set_speech_preferences'),false);assert.equal(explicit.nodes.get('pet-auto-read').getAttribute('aria-checked'),'false');assert.equal(explicit.narration.volume,35);explicit.window.emit('pagehide');
});
test('new native choice received during legacy read cannot be overwritten by migration',async()=>{
 const gate=deferred();const ui=setup({view:'pet',speechSupported:true,autoRead:true,getSpeechPreferences:()=>gate.promise});await tick();ui.emitEvent('launcher-speech-preferences',{revision:8,initialized:true,auto_read:false,volume:40});gate.resolve({revision:0,initialized:false,auto_read:false,volume:100});await tick();assert.equal(ui.calls.some(c=>c.name==='set_speech_preferences'),false);assert.equal(ui.nodes.get('pet-auto-read').getAttribute('aria-checked'),'false');ui.window.emit('pagehide');
});
test('native preference write failure retains old value and never creates session-only truth',async()=>{
 const failure=deferred();const ui=setup({view:'pet',speechSupported:true,setSpeechPreferences:()=>failure.promise});await tick();toggleReading(ui);toggleReading(ui);assert.equal(ui.calls.filter(c=>c.name==='set_speech_preferences').length,1);assert.equal(ui.nodes.get('pet-auto-read').getAttribute('aria-checked'),'false');failure.reject(Error('secret detail'));await tick();assert.equal(ui.nodes.get('pet-auto-read').getAttribute('aria-checked'),'false');assert.equal(ui.nodes.get('pet-auto-read').getAttribute('data-state'),'error');assert.match(ui.nodes.get('pet-auto-read').getAttribute('aria-description'),/保存失败/);assert.doesNotMatch(ui.nodes.get('pet-auto-read').getAttribute('aria-description'),/仅本次|secret/);ui.window.emit('pagehide');
});
test('native volume updates while auto-read is off preserve manual playback',async()=>{
 const ui=setup({view:'pet',speechSupported:true});await tick();ui.emit(ready(2,{messages:[spokenAnswer()]}));ui.nodes.get('pet-read').emit('click');ui.narration.engine.publish('speaking');const stops=ui.narration.stops;
 ui.emitEvent('launcher-speech-preferences',{revision:4,initialized:true,auto_read:false,volume:20});assert.equal(ui.narration.engine.state.phase,'speaking');assert.equal(ui.narration.stops,stops);assert.equal(ui.narration.volume,20);ui.window.emit('pagehide');
});
test('PET targeted stops pass opaque request id and late preferences cannot render after disposal',async()=>{
 const ui=setup({view:'pet',speechSupported:true});await tick();ui.emitEvent('launcher-speech-stop',{request_id:'request-old'});assert.deepEqual(ui.narration.stopRequests,['request-old']);ui.window.emit('pagehide');const before=ui.nodes.get('pet-auto-read').textContent;ui.emitEvent('launcher-speech-preferences',{revision:99,initialized:true,auto_read:true,volume:1});ui.emitEvent('launcher-speech-stop',{request_id:'request-new'});assert.equal(ui.nodes.get('pet-auto-read').textContent,before);assert.deepEqual(ui.narration.stopRequests,['request-old']);
});
test('Qwen auto-read does not inherit legacy system-voice opt-in',async()=>{
  const ui=setup({view:'pet',speechSupported:true,legacyAutoRead:true});await tick();
  ui.emit(ready(2,{messages:[spokenAnswer()]}));
  assert.equal(ui.nodes.get('pet-auto-read').getAttribute('aria-checked'),'false');
  assert.deepEqual(ui.narration.played,[]);ui.window.emit('pagehide');
});

test('automatic narration defaults off and enabling it never reads the current answer',async()=>{
  const ui=setup({view:'pet',speechSupported:true});await tick();
  ui.emit(ready(2,{messages:[spokenAnswer()]}));
  assert.equal(ui.nodes.get('pet-auto-read').getAttribute('aria-checked'),'false');
  assert.deepEqual(ui.narration.played,[]);
  toggleReading(ui);await tick();assert.equal(ui.nodes.get('pet-auto-read').getAttribute('aria-checked'),'true');
  assert.deepEqual(ui.narration.played,[]);
  ui.emit(ready(3,{messages:[spokenAnswer()]}));assert.deepEqual(ui.narration.played,[]);
  ui.emit(ready(4,{messages:[spokenAnswer(),{id:'u',role:'user',text:'再说一句'},spokenAnswer('b','新的回复')]}));
  assert.deepEqual(ui.narration.played,['新的回复']);
  toggleReading(ui);await tick();assert.equal(ui.nodes.get('pet-read').textContent,'朗读');
  assert.equal(ui.nodes.get('pet-auto-read').getAttribute('aria-checked'),'false');ui.window.emit('pagehide');
});

test('stored opt-in reads only a new completed reply once, not history, stream chunks or renders',async()=>{
  const ui=setup({view:'pet',speechSupported:true,autoRead:true,getSnapshot:()=>ready(1,{messages:[spokenAnswer('history','历史回复')]})});await tick();
  assert.deepEqual(ui.narration.played,[]);
  ui.nodes.get('pet').emit('click',{detail:1});await tick();assert.deepEqual(ui.narration.played,[]);
  const user={id:'u',role:'user',text:'问题'};
  ui.emit(ready(2,{running:true,messages:[user,{...spokenAnswer(),text:'你好',status:'streaming'}]}));
  assert.deepEqual(ui.narration.played,[]);assert.equal(ui.nodes.get('pet-read').disabled,true);
  ui.emit(ready(3,{messages:[user,spokenAnswer()]}));assert.deepEqual(ui.narration.played,['你好，我在呢。']);
  ui.emit(ready(4,{messages:[user,spokenAnswer()]}));ui.nodes.get('draft').emit('input');
  assert.equal(ui.narration.played.length,1);ui.window.emit('pagehide');
});

test('manual narration cleans markdown without changing reply text and pins its bubble while playing',async()=>{
  const ui=setup({view:'pet',speechSupported:true});await tick();
  const text='**你好**，看[说明](https://example.com)\n\n'+String.fromCharCode(96).repeat(3)+'js\nsecret()\n'+String.fromCharCode(96).repeat(3);
  ui.emit(ready(2,{messages:[spokenAnswer('a',text)]}));ui.nodes.get('pet-read').emit('click');
  assert.deepEqual(ui.narration.played,['你好，看说明']);
  assert.equal(ui.nodes.get('pet-read-status').textContent,'正在生成本地语音，首次加载可能较慢，可随时停止…');
  assert.doesNotMatch(ui.nodes.get('pet-read-status').textContent,/CPU|系统音色/);
  assert.equal(ui.nodes.get('pet-speech-text').textContent,text);assert.equal(ui.speechTimers.size,0);
  ui.narration.engine.publish('speaking');assert.equal(ui.nodes.get('assistant-root').dataset.speaking,'true');
  assert.equal(ui.nodes.get('pet-read').textContent,'停止朗读');
  ui.nodes.get('pet-read').emit('click');assert.equal(ui.nodes.get('assistant-root').dataset.speaking,'false');
  assert.equal(ui.nodes.get('pet-read').textContent,'朗读');ui.window.emit('pagehide');
});

test('opening or closing input does not stop narration, but sending a new message does',async()=>{
  const ui=setup({view:'pet',speechSupported:true});await tick();ui.emit(ready(2,{messages:[spokenAnswer()]}));
  ui.nodes.get('pet-read').emit('click');ui.narration.engine.publish('speaking');
  ui.nodes.get('pet').emit('click',{detail:1});await tick();ui.nodes.get('pet-input-close').emit('click');await tick();
  assert.equal(ui.narration.engine.state.phase,'speaking');
  ui.nodes.get('pet').emit('click',{detail:1});await tick();
  ui.nodes.get('draft').value='新问题';ui.nodes.get('draft').emit('input');ui.nodes.get('send-form').emit('submit');await tick();
  assert.equal(ui.narration.engine.state.phase,'idle');assert.ok(ui.narration.stops>0);ui.window.emit('pagehide');
});

test('long replies require manual narration and code-only replies are not read',async()=>{
  const ui=setup({view:'pet',speechSupported:true,autoRead:true});await tick();
  const text='这是一条长回复。'.repeat(70);ui.emit(ready(2,{messages:[spokenAnswer('long',text)]}));
  assert.deepEqual(ui.narration.played,[]);assert.match(ui.nodes.get('pet-read-status').textContent,/回复较长/);
  ui.nodes.get('pet-read').emit('click');assert.equal(ui.narration.played[0],text);
  ui.narration.engine.publish('idle');const code=String.fromCharCode(96).repeat(3)+'js\nconsole.log(1)\n'+String.fromCharCode(96).repeat(3);
  ui.emit(ready(3,{messages:[{id:'u',role:'user',text:'代码'},spokenAnswer('code',code)]}));
  assert.equal(ui.narration.played.length,1);assert.equal(ui.nodes.get('pet-read').disabled,true);ui.window.emit('pagehide');
});

test('manual narration survives unchanged terminal chat status snapshots', async () => {
  for (const phase of ['cancelled', 'interrupted']) {
    const messages = [spokenAnswer()];
    const ui = setup({view:'pet', speechSupported:true, getSnapshot:()=>ready(1,{phase,messages})});
    await tick();
    ui.nodes.get('pet').emit('click',{detail:1}); await tick();
    ui.nodes.get('pet-read').emit('click');
    ui.emit(ready(2,{phase,messages}));
    assert.equal(ui.narration.engine.state.phase,'loading',phase + ' must not cancel explicit playback on a metadata refresh');
    assert.equal(ui.speechTimers.size,0);
    ui.narration.engine.publish('speaking');
    ui.emit(ready(3,{phase,messages}));
    assert.equal(ui.narration.engine.state.phase,'speaking');
    ui.emit(ready(4,{phase:'sending',messages}));
    assert.equal(ui.narration.engine.state.phase,'idle','a new operation still interrupts narration');
    assert.match(ui.nodes.get('pet-read-status').textContent,/朗读已停止/);
    ui.window.emit('pagehide');
  }
});

test('stable completed snapshots preserve synthesis and playback but new terminal transitions stop them', async () => {
  for (const phase of ['cancelled','interrupted']) {
    const ui=setup({view:'pet',speechSupported:true}); await tick();
    const messages=[spokenAnswer()]; ui.emit(ready(2,{messages}));
    ui.nodes.get('pet-read').emit('click');
    ui.emit(ready(3,{messages}));
    assert.equal(ui.narration.engine.state.phase,'loading');
    ui.narration.engine.publish('speaking'); ui.emit(ready(4,{messages}));
    assert.equal(ui.narration.engine.state.phase,'speaking');
    ui.emit(ready(5,{phase,messages}));
    assert.equal(ui.narration.engine.state.phase,'idle');
    assert.match(ui.nodes.get('pet-read-status').textContent,/朗读已停止/);
    ui.window.emit('pagehide');
  }
});

test('narration failures pin the bubble until retry or explicit dismissal', async () => {
  const ui=setup({view:'pet',speechSupported:true}); await tick();
  ui.emit(ready(2,{messages:[spokenAnswer()]}));
  ui.nodes.get('pet-read').emit('click');
  ui.narration.engine.publish('idle','本地千问朗读失败：测试服务错误');
  assert.equal(ui.speechTimers.size,0,'failure must not start an auto-dismiss timer');
  ui.nodes.get('pet-dialogue').emit('pointerleave'); ui.flushSpeechTimer();
  assert.equal(ui.nodes.get('pet-dialogue').hidden,false);
  assert.match(ui.nodes.get('pet-read-status').textContent,/测试服务错误/);
  ui.nodes.get('pet-read').emit('click');
  assert.equal(ui.narration.engine.state.phase,'loading');
  assert.doesNotMatch(ui.nodes.get('pet-read-status').textContent,/测试服务错误/);
  ui.nodes.get('pet-speech-close').emit('click');
  assert.equal(ui.nodes.get('pet-dialogue').hidden,true);
  ui.window.emit('pagehide');
});

test('speech errors remain inline and never replace the answer or affect chat sending',async()=>{
  const ui=setup({view:'pet',speechSupported:true});await tick();ui.emit(ready(2,{messages:[spokenAnswer()]}));
  ui.nodes.get('pet-read').emit('click');ui.narration.engine.publish('idle','本地千问语音服务未启动');
  assert.equal(ui.nodes.get('pet-speech-text').textContent,'你好，我在呢。');
  assert.match(ui.nodes.get('pet-read-status').textContent,/本地千问语音服务未启动/);
  assert.equal(ui.nodes.get('pet-read').disabled,false);
  ui.nodes.get('pet-read').emit('click');assert.equal(ui.narration.played.length,2);ui.window.emit('pagehide');
});

test('hidden pet suppresses new auto speech and does not queue it for a later show',async()=>{
  const ui=setup({view:'pet',speechSupported:true,autoRead:true});await tick();
  ui.emitEvent('pet-visibility',{visible:false,revision:10});ui.emit(ready(2,{messages:[spokenAnswer()]}));
  assert.deepEqual(ui.narration.played,[]);
  ui.emitEvent('pet-visibility',{visible:true,revision:11});ui.emit(ready(3,{messages:[spokenAnswer()]}));
  assert.deepEqual(ui.narration.played,[]);ui.window.emit('pagehide');
});

test('disconnects, session switches and approvals stop speech without reading restored history',async()=>{
  const ui=setup({view:'pet',speechSupported:true,autoRead:true});await tick();
  ui.emit(ready(2,{messages:[spokenAnswer()]}));ui.narration.engine.publish('speaking');
  ui.emit(ready(3,{connected:false,messages:[spokenAnswer()]}));assert.equal(ui.narration.engine.state.phase,'idle');
  ui.emit(ready(4,{messages:[spokenAnswer('restored','恢复的历史')]}));assert.equal(ui.narration.played.length,1);
  ui.emit(ready(5,{session_id:'other',messages:[spokenAnswer('other','其他会话的历史')]}));assert.equal(ui.narration.played.length,1);
  ui.emit(ready(6,{session_id:'other',messages:[spokenAnswer('new','新回复')]}));assert.equal(ui.narration.played.length,2);
  ui.emitEvent('pet-interactions-state',interactionState(1,[interactionCard()]));assert.equal(ui.narration.engine.state.phase,'idle');
  ui.window.emit('pagehide');
});

test('unsupported speech keeps chat usable and cannot auto-read even with stored opt-in',async()=>{
  const ui=setup({view:'pet',speechSupported:false,autoRead:true});await tick();
  ui.emit(ready(2,{messages:[spokenAnswer()]}));
  assert.equal(ui.nodes.get('pet-read').disabled,true);assert.equal(ui.nodes.get('pet-auto-read').disabled,true);
  assert.deepEqual(ui.narration.played,[]);ui.nodes.get('pet').emit('click',{detail:1});await tick();
  assert.equal(ui.nodes.get('pet-composer').hidden,false);ui.window.emit('pagehide');
});

test('local storage failure does not create a second truth beside native preferences',async()=>{
  const ui=setup({view:'pet',speechSupported:true,storageDenied:true});await tick();
  assert.equal(ui.nodes.get('pet-auto-read').getAttribute('aria-checked'),'false');toggleReading(ui);await tick();
  assert.equal(ui.nodes.get('pet-auto-read').getAttribute('aria-checked'),'true');assert.doesNotMatch(ui.nodes.get('pet-auto-read').textContent,/仅本次/);
  ui.emit(ready(2,{messages:[spokenAnswer()]}));assert.equal(ui.narration.played.length,1);ui.window.emit('pagehide');
});

test('action submenu lists renderer actions and selecting an action stops movement then closes the menu', async () => {
  const ui = setup({view:'pet'}); await tick();
  const list = ui.nodes.get('pet-animation-list');
  const group = list.children[0];
  assert.equal(group.getAttribute('aria-label'), '待机');
  const button = group.children[1];
  assert.equal(button.getAttribute('role'), 'menuitem');
  assert.equal(button.textContent, '待机呼吸休闲');
  ui.nodes.get('pet').emit('contextmenu');
  assert.equal(ui.nodes.get('pet-menu').hidden, false);
  const before = ui.petEvents.length;
  button.emit('click');
  assert.deepEqual(ui.petEvents.slice(before, before + 2), [['motion-stop'], ['trigger', '待机呼吸休闲']]);
  assert.equal(ui.nodes.get('pet-menu').hidden, true);
  assert.equal(ui.nodes.get('pet-animation').hidden, true);
  ui.window.emit('pagehide');
  assert.equal(button.handlers.get('click').length, 0);
});

test('pet narration passes continuation guard separately from strict synthesis request JSON', async () => {
 const ui=setup({view:'pet',speechSupported:true});await tick();
 const synthesize=ui.narration.engine.options.synthesize;
 await synthesize({request_id:'request-first',text:'第一段'});
 await synthesize({request_id:'request-next1',text:'下一段',previous_request_id:'request-first'});
 const calls=ui.calls.filter(c=>c.name==='assistant_speech_synthesize');
 assert.deepEqual(JSON.parse(JSON.stringify(calls.map(c=>c.args))),[
  {request:{request_id:'request-first',text:'第一段'},previousRequestId:null},
  {request:{request_id:'request-next1',text:'下一段'},previousRequestId:'request-first'},
 ]);
 ui.window.emit('pagehide');
});

test('closing the speech bubble silences narration without cancelling the model task',async()=>{
  const ui=setup({view:'pet',speechSupported:true});await tick();ui.emit(ready(2,{messages:[spokenAnswer()]}));
  ui.nodes.get('pet-read').emit('click');ui.nodes.get('pet-speech-close').emit('click');
  assert.equal(ui.narration.engine.state.phase,'idle');assert.equal(ui.nodes.get('pet-dialogue').hidden,true);
  assert.equal(ui.calls.some(c=>c.args?.request?.action==='cancel'),false);ui.window.emit('pagehide');
  assert.equal(ui.narration.disposed,true);
});
