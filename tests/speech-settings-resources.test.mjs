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
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

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
      child.readOnly = /[ ]readonly(?:[ >])/.test(match[0]);
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

const installState = (extra={}) => ({ id:0,status:'idle',stage:'',downloaded_bytes:0,total_bytes:null,error:null,...extra });
async function fixture({ initial=installState(), invoke:custom, snapshot:initialSnapshot={} }={}) {
  const document={nodes:new Map(),createElement(tag){return new Node(tag,this);}};
  const root=new Node('div',document),listeners=new Map(),calls=[],timers=new Map();let timer=0,resources;
  let snapshot={revision:0,configured:false,config:{model_dir:'',python_path:'',native_lib:''},distribution:'Ubuntu',busy:false,operation:null,environment_state:'unknown',models_state:'unknown',model_progress:null,service_state:'stopped',ownership:'none',model_state:'unloaded',gpu_name:null,message:'',error:null,logs:[],...initialSnapshot};
  let install=initial;
  const node=id=>document.nodes.get(id);
  const publish=patch=>{snapshot={...snapshot,...patch,revision:snapshot.revision+1};listeners.get('launcher-speech-state')?.({payload:snapshot});};
  const publishInstall=patch=>{install={...install,...patch};listeners.get('launcher-speech-install')?.({payload:install});};
  const fallback=(name,args)=>{
    if(name==='get_speech_settings')return snapshot;
    if(name==='get_speech_preferences')return{revision:0,initialized:true,auto_read:false,volume:100};
    if(name==='get_speech_install')return install;
    if(name==='install_speech'){install=installState({id:install.id+1,status:'installing',stage:'准备运行环境'});return install;}
    if(name==='cancel_speech_install'){install={...install,status:'cancelled',stage:'已取消'};return install;}
    if(name==='speech_action')return snapshot;
    throw Error('Unexpected RPC: '+name);
  };
  const bridge={async listen(name,callback){listeners.set(name,callback);return()=>{if(listeners.get(name)===callback)listeners.delete(name);};},async invoke(name,args){calls.push({name,args});return custom?custom(name,args,fallback):fallback(name,args);}};
  const view={setTimeout(callback){timers.set(++timer,callback);return timer;},clearTimeout(id){timers.delete(id);}};
  const settings=new SpeechSettings(root,view,true,bridge,mount=>{resources=new SpeechResources(mount,view,true,bridge);return resources;});
  settings.setVisible(true);await tick();
  return{settings,resources,node,calls,publish,publishInstall,listeners,timers,async poll(){const tasks=[...timers.values()];timers.clear();tasks.forEach(task=>task());await tick();}};
}

test('actual parent and resource component single click installs without selecting paths or saving manually',async()=>{
 const f=await fixture();assert.deepEqual(f.calls.map(c=>c.name),['get_speech_settings','get_speech_preferences','get_speech_install']);
 for(const name of ['speech-python_path','speech-model_dir','speech-native_lib','speech-save','speech-resource-model-browse','speech-resource-native-browse'])assert.equal(f.node(name),undefined,name);
 assert.equal(f.node('speech-resource-install').disabled,false);f.node('speech-resource-install').click();f.node('speech-resource-install').emit('click');
 assert.equal(f.calls.filter(c=>c.name==='install_speech').length,1);assert.deepEqual(f.calls.at(-1),{name:'install_speech',args:undefined});
 for(const name of ['refresh','check','start','stop','test','auto','volume'])assert.equal(f.node('speech-'+name).disabled,true,name);
 await tick();await f.poll();assert.equal(f.calls.some(c=>c.name==='speech_action'),false);
 f.publish({configured:true,environment_state:'passed',models_state:'passed'});f.publishInstall({status:'completed',stage:'安装完成'});await tick();
 assert.equal(f.calls.at(-1).name,'get_speech_settings');assert.equal(f.node('speech-start').disabled,false);assert.equal(f.node('speech-auto').checked,false);assert.equal(f.node('speech-resource-install').textContent,'已安装');
 assert.equal(f.calls.some(c=>c.name==='save_speech_config'||c.name==='pick_settings_path'||c.name==='set_speech_preferences'||c.name==='speech_action'),false);f.settings.dispose();
});
test('install completion before its RPC reply cannot rewind state or invoke implicit check/start',async()=>{
 const pending=deferred();const f=await fixture({invoke:(name,args,fallback)=>name==='install_speech'?pending.promise:fallback(name,args)});
 f.node('speech-resource-install').click();f.publish({configured:true,environment_state:'passed',models_state:'passed'});f.publishInstall({id:1,status:'completed'});await tick();
 assert.equal(f.node('speech-start').disabled,false);pending.resolve(installState({id:1,status:'installing',stage:'旧阶段'}));await tick();
 assert.equal(f.node('speech-resource-install').textContent,'已安装');assert.equal(f.calls.some(c=>c.name==='speech_action'),false);f.settings.dispose();
});
test('parent follows already-running installation through cancellation, error and retry',async()=>{
 const f=await fixture({initial:installState({id:4,status:'installing',stage:'下载模型'}),snapshot:{configured:true}});
 assert.equal(f.node('speech-resource-cancel').disabled,false);assert.equal(f.node('speech-start').disabled,true);
 f.node('speech-start').emit('click');f.node('speech-check').emit('click');f.node('speech-resource-cancel').click();await tick();
 assert.equal(f.node('speech-start').disabled,false);assert.equal(f.node('speech-resource-install').textContent,'重新安装');
 f.node('speech-resource-install').click();await tick();f.publishInstall({status:'error',error:'磁盘空间不足'});
 assert.match(f.node('speech-resource-message').textContent,/磁盘空间不足/);assert.equal(f.node('speech-start').disabled,false);assert.equal(f.node('speech-resource-install').textContent,'重试安装');
 f.node('speech-resource-install').click();await tick();assert.equal(f.node('speech-start').disabled,true);assert.equal(f.calls.filter(c=>c.name==='install_speech').length,2);assert.equal(f.calls.some(c=>c.name==='speech_action'),false);f.settings.dispose();
});
test('leave during installer validation never cancels its check and reentry restores busy',async()=>{
 const f=await fixture();f.node('speech-resource-install').click();await tick();f.publish({busy:true,operation:'check',environment_state:'checking'});
 const old=f.listeners.get('launcher-speech-install');f.settings.setVisible(false);assert.equal(f.listeners.size,0);assert.equal(f.timers.size,0);
 assert.equal(f.calls.some(c=>c.name==='cancel_speech_install'||c.args?.action==='cancel_check'),false);
 f.settings.setVisible(true);await tick();assert.equal(f.node('speech-resource-cancel').disabled,false);assert.equal(f.node('speech-start').disabled,true);
 old({payload:installState({id:999,status:'completed'})});assert.notEqual(f.node('speech-resource-install').textContent,'已安装');
 f.publish({configured:true,busy:false,operation:null,environment_state:'passed',models_state:'passed'});f.publishInstall({status:'completed'});await tick();assert.equal(f.node('speech-start').disabled,false);f.settings.dispose();
});
test('install status read gate prevents conflicts on reentry even with a cached configured snapshot',async()=>{
 let gate;const f=await fixture({snapshot:{configured:true},invoke:(name,args,fallback)=>name==='get_speech_install'&&gate?gate.promise:fallback(name,args)});
 f.settings.setVisible(false);gate=deferred();f.settings.setVisible(true);await tick();
 for(const name of ['start','check','auto'])assert.equal(f.node('speech-'+name).disabled,true,name);
 f.node('speech-start').emit('click');f.node('speech-resource-install').emit('click');assert.equal(f.calls.some(c=>c.name==='install_speech'||c.args?.action==='start'),false);
 gate.resolve(installState({id:3,status:'installing',stage:'正在安装'}));await tick();assert.equal(f.node('speech-start').disabled,true);assert.equal(f.node('speech-resource-cancel').disabled,false);f.settings.dispose();
});
test('running and external service prevent installation, but read-only refresh does not',async()=>{
 for(const ownership of ['managed','external']){
  const f=await fixture({snapshot:{configured:true,ownership,service_state:'running',model_state:'ready'}});
  assert.equal(f.node('speech-resource-install').disabled,true);f.node('speech-resource-install').emit('click');assert.equal(f.calls.some(c=>c.name==='install_speech'),false);f.settings.dispose();
 }
 const f=await fixture();f.publish({busy:true,operation:'refresh'});assert.equal(f.node('speech-resource-install').disabled,false);f.node('speech-resource-install').click();await tick();assert.equal(f.calls.at(-1).name,'install_speech');f.settings.dispose();
});
test('completed installation discovered on reopen only reads saved configuration',async()=>{
 const f=await fixture();f.node('speech-resource-install').click();await tick();f.settings.setVisible(false);
 f.publish({configured:true,environment_state:'passed',models_state:'passed'});f.publishInstall({status:'completed'});
 f.settings.setVisible(true);await tick();assert.equal(f.node('speech-resource-install').textContent,'已安装');assert.equal(f.node('speech-start').disabled,false);assert.equal(f.node('speech-auto').checked,false);
 assert.equal(f.calls.filter(c=>c.name==='install_speech').length,1);assert.equal(f.calls.some(c=>c.name==='speech_action'||c.name==='save_speech_config'||c.name==='set_speech_preferences'),false);f.settings.dispose();
});
