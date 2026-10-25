import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const compile = value => ts.transpileModule(value, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const moduleUrl = value => 'data:text/javascript;base64,' + Buffer.from(value).toString('base64');
const qwen = moduleUrl(compile(await readFile(new URL('../src/pet/qwen-speech.ts', import.meta.url), 'utf8')));
const raw = await readFile(new URL('../src/speech-settings.ts', import.meta.url), 'utf8');
const { SpeechSettings, speechSettingsMarkup, speechDiagnostics, isSpeechSnapshot, isSpeechPreferences } = await import(moduleUrl(compile(raw).replace("'./pet/qwen-speech'", JSON.stringify(qwen))));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
const config = { model_dir:'/models/q8', python_path:'/home/user/.dsh-wsl-desktop/speech/runtime/venv/bin/python', native_lib:'/lib/qwen.so' };
const prefs = (extra={}) => ({ revision:0, initialized:true, auto_read:false, volume:100, ...extra });
const snapshot = (extra={}) => ({ revision:0, configured:true, config, distribution:'Ubuntu', busy:false, operation:null, environment_state:'unknown', models_state:'unknown', model_progress:null, service_state:'unknown', ownership:'unknown', model_state:'unknown', gpu_name:null, message:'', error:null, logs:[], ...extra });
const ready = (extra={}) => snapshot({ service_state:'running', model_state:'ready', ownership:'managed', ...extra });
function wav() {
 const b=Buffer.alloc(48);b.write('RIFF');b.writeUInt32LE(40,4);b.write('WAVE',8);b.write('fmt ',12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(4,40);return b.toString('base64');
}
class Node {
 constructor(){this.value='';this.checked=false;this.disabled=false;this.hidden=false;this.textContent='';this.dataset={};this.handlers=new Map();}
 addEventListener(name,fn){this.handlers.set(name,fn);}
 emit(name){this.handlers.get(name)?.({target:this});}
}
function fixture({ native=true, initial=snapshot(), initialPrefs=prefs(), invoke:custom, listen:customListen, resources:resourceFactory }={}) {
 const nodes=new Map(), listeners=new Map(), calls=[], order=[], timers=new Map(), sources=[];let serial=0,clock=0,copied;
 const root={set innerHTML(html){for(const m of html.matchAll(/id="(speech-[^"]+)"/g))nodes.set(m[1],new Node());},querySelector(selector){return nodes.get(selector.slice(1));}};
 const context={state:'suspended',destination:{},resume(){order.push('resume');this.state='running';return Promise.resolve();},close(){order.push('close');return Promise.resolve();},createGain(){return{gain:{value:1},connect(){},disconnect(){}};},decodeAudioData(){return Promise.resolve({duration:.1});},createBufferSource(){const s={onended:null,connect(){},disconnect(){},start(){order.push('play');},stop(){order.push('stop');}};sources.push(s);return s;}};
 const view={AudioContext:class{constructor(){return context;}},crypto:{getRandomValues(bytes){bytes.fill(++serial);return bytes;}},atob:s=>Buffer.from(s,'base64').toString('binary'),setTimeout(fn){timers.set(++clock,fn);return clock;},clearTimeout(id){timers.delete(id);},navigator:{clipboard:{async writeText(value){copied=value;}}}};
 const bridge={async listen(name,fn){order.push('listen:'+name);listeners.set(name,fn);if(customListen)await customListen(name,fn);return()=>{listeners.delete(name);order.push('unlisten:'+name);};},async invoke(name,args){calls.push({name,args});order.push(name);if(custom)return custom(name,args,fallback);return fallback(name,args);}};
 function fallback(name,args){if(name==='get_speech_settings')return initial;if(name==='get_speech_preferences')return initialPrefs;if(name==='speech_action')return initial;if(name==='set_speech_preferences')return prefs({...initialPrefs,...args.patch,revision:initialPrefs.revision+1});if(name==='test_speech')return{request_id:args.requestId,voice_id:'pet-airhead-v1',wav_base64:wav()};if(name==='cancel_speech_test')return;throw Error('unexpected command '+name);}
 const settings=new SpeechSettings(root,view,native,bridge,resourceFactory);
 const node=id=>nodes.get('speech-'+id);
 return{settings,node,calls,order,listeners,timers,sources,context,get copied(){return copied;},show(){settings.setVisible(true);},hide(){settings.setVisible(false);},event(name,payload){listeners.get(name)?.({payload});},click(id){node(id).emit('click');},fill(id,value){node(id).value=value;node(id).emit('input');},async poll(){const jobs=[...timers.values()];timers.clear();jobs.forEach(fn=>fn());await tick();}};
}

test('preview stays unknown, disabled and entirely non-mutating even for synthetic events',async()=>{
 const f=fixture({native:false});f.show();for(const id of ['refresh','check','start','stop','test','copy']){assert.equal(f.node(id).disabled,true);f.click(id);}f.node('auto').checked=true;f.node('auto').emit('change');await tick();assert.deepEqual(f.calls,[]);assert.equal(f.listeners.size,0);assert.equal(f.timers.size,0);assert.equal(f.node('model_state').textContent,'未知');assert.match(f.node('message').textContent,/浏览器预览/);f.settings.dispose();
});
test('opening visible speech subscribes first then reads only lightweight state and preferences',async()=>{
 const f=fixture();assert.equal(f.calls.length,0);f.show();await tick();assert.deepEqual(f.calls.map(c=>c.name),['get_speech_settings','get_speech_preferences']);assert.equal(f.listeners.size,3);assert.ok(f.order.indexOf('listen:launcher-speech-stop')<f.order.indexOf('get_speech_settings'));assert.equal(f.node('test').disabled,true);assert.equal(f.node('model_state').textContent,'未知');assert.equal(f.node('progress').hidden,true);await f.poll();assert.deepEqual(f.calls.at(-1),{name:'speech_action',args:{action:'refresh'}});f.hide();assert.equal(f.listeners.size,0);assert.equal(f.timers.size,0);
});
test('opening, reopening and polling never dispatch discovery or Python runtime validation',async()=>{
 const f=fixture();f.show();await tick();await f.poll();f.hide();f.show();await tick();await f.poll();
 assert.deepEqual(f.calls.map(c=>c.name),['get_speech_settings','get_speech_preferences','speech_action','get_speech_settings','get_speech_preferences','speech_action']);
 assert.ok(f.calls.filter(c=>c.name==='speech_action').every(c=>c.args.action==='refresh'));
 assert.equal(f.calls.some(c=>c.name==='discover_speech_resources'||/python|runtime_check/.test(c.name)||['check','start'].includes(c.args?.action)),false);
 f.settings.dispose();
});
test('read-only polling never toggles resource locks or status guidance',async()=>{
 let blocked=false;const locks=[];
 const f=fixture({resources(){return{isBusy:()=>false,setVisible(){},setBlocked(value){blocked=value;locks.push(value);},dispose(){}};}});
 f.show();await tick();const message=f.node('message').textContent;const before=locks.length;
 for(let cycle=0;cycle<3;cycle++){
  f.event('launcher-speech-state',snapshot({revision:cycle*2+1,busy:true,operation:'refresh'}));
  assert.equal(blocked,false,'read-only refresh must not disable path browsing or close its panel');
  assert.equal(f.node('message').textContent,message);
  assert.equal(f.node('check').disabled,false);assert.equal(f.node('start').disabled,false);
  f.event('launcher-speech-state',snapshot({revision:cycle*2+2}));
 }
 assert.equal(locks.slice(before).includes(true),false);f.settings.dispose();
});
test('check and start are dispatchable while only a read-only refresh is busy',async()=>{
 for(const action of ['check','start']){
  const f=fixture({initial:snapshot({busy:true,operation:'refresh'})});f.show();await tick();
  if(action==='save')f.fill('model_dir','/candidate');
  assert.equal(f.node(action).disabled,false);f.click(action);await tick();
  assert.ok(f.calls.some(c=>c.args?.action===action));f.settings.dispose();
 }
});
test('an old refresh failure cannot replace guidance after a newer explicit operation',async()=>{
 const pending=deferred();
 const f=fixture({invoke(name,args,fallback){return name==='speech_action'&&args.action==='refresh'?pending.promise:fallback(name,args);}});f.show();await tick();
 await f.poll();f.click('start');await tick();pending.reject(Error('cancelled refresh'));await tick();
 assert.doesNotMatch(f.node('message').textContent,/未完成|失败/);f.settings.dispose();
});

test('poll skips native refresh during start, check and candidate validation without false errors',async()=>{
 for(const operation of ['start','check','save']){
  const f=fixture({initial:snapshot({busy:true,operation}),invoke(name,args,fallback){if(name==='speech_action'&&args.action==='refresh')throw Error('native busy');return fallback(name,args);}});f.show();await tick();await f.poll();assert.equal(f.calls.some(c=>c.args?.action==='refresh'),false);assert.equal(f.node('refresh').disabled,true);assert.doesNotMatch(f.node('message').textContent,/未完成|失败/);f.event('launcher-speech-state',snapshot({revision:2}));assert.equal(f.node('refresh').disabled,false);await f.poll();assert.equal(f.calls.filter(c=>c.args?.action==='refresh').length,1);f.settings.dispose();
 }
 const pending=deferred(),g=fixture({invoke(name,args,fallback){return name==='speech_action'&&args.action==='start'?pending.promise:fallback(name,args);}});g.show();await tick();g.click('start');await g.poll();assert.equal(g.calls.some(c=>c.args?.action==='refresh'),false);assert.doesNotMatch(g.node('message').textContent,/未完成|失败/);pending.resolve(snapshot({revision:1,busy:true,operation:'start'}));await tick();g.settings.dispose();
});
test('newer events during subscription beat stale initial queries and malformed snapshots',async()=>{
 const f=fixture({listen(name,fn){if(name==='launcher-speech-state')fn({payload:ready({revision:9})});if(name==='launcher-speech-preferences')fn({payload:prefs({revision:9,auto_read:true,volume:22})});}});f.show();await tick();assert.equal(f.node('model_state').textContent,'就绪');assert.equal(f.node('auto').checked,true);assert.equal(f.node('volume').value,'22');f.event('launcher-speech-state',snapshot({revision:8}));f.event('launcher-speech-state',{...ready({revision:99}),model_state:'fake-ready'});f.event('launcher-speech-preferences',prefs({revision:999,volume:101}));assert.equal(f.node('model_state').textContent,'就绪');assert.equal(f.node('volume').value,'22');f.settings.dispose();
});
test('busy actions suppress duplicates but allow cancel check and owned stop',async()=>{
 const pending=deferred();const f=fixture({initial:ready(),invoke(name,args,fallback){return name==='speech_action'&&args.action==='check'?pending.promise:fallback(name,args);}});f.show();await tick();f.click('check');f.click('check');f.click('start');assert.equal(f.calls.filter(c=>c.args?.action==='check').length,1);f.click('cancel_check');assert.equal(f.calls.at(-1).args.action,'cancel_check');await tick();f.click('stop');assert.equal(f.calls.at(-1).args.action,'stop');pending.resolve(snapshot({revision:0}));await tick();f.settings.dispose();
});
test('stop cancels a startup before ownership or its initial busy reply arrives',async()=>{
 const pending=deferred();const f=fixture({invoke(name,args,fallback){return name==='speech_action'&&args.action==='start'?pending.promise:fallback(name,args);}});f.show();await tick();assert.equal(f.node('stop').disabled,true);f.click('start');assert.equal(f.node('stop').disabled,false);f.click('stop');assert.equal(f.calls.at(-1).args.action,'stop');pending.resolve(snapshot({revision:1,busy:true,operation:'start'}));await tick();f.settings.dispose();
 const g=fixture({initial:snapshot({busy:true,operation:'start',ownership:'unknown'})});g.show();await tick();assert.equal(g.node('stop').disabled,false);g.click('stop');await tick();assert.equal(g.calls.at(-1).args.action,'stop');g.settings.dispose();
});
test('safe native errors show specific bounded text but raw RPC failures remain static',async()=>{
 const f=fixture({initial:snapshot({error:'缺少 codec 文件，请检查模型目录。'+ '诊断'.repeat(300)}),invoke(name,args,fallback){if(name==='speech_action')throw Error('raw secret /home/token');return fallback(name,args);}});f.show();await tick();assert.match(f.node('message').textContent,/缺少 codec 文件/);assert.ok(f.node('message').textContent.length<430);f.click('check');await tick();assert.match(f.node('message').textContent,/缺少 codec 文件/);assert.doesNotMatch(f.node('message').textContent,/raw secret|home|token/);f.settings.dispose();
});
test('recent audition distinguishes actual completion from generation, playback, cancellation and failure',async()=>{
 const f=fixture({initial:ready()});f.show();await tick();assert.match(f.node('audio-message').textContent,/未试听/);f.click('test');assert.match(f.node('audio-message').textContent,/生成中/);await tick();assert.match(f.node('audio-message').textContent,/播放中/);f.sources[0].onended();await tick();assert.match(f.node('audio-message').textContent,/播放完成/);
 f.click('test');await tick();f.click('cancel_test');assert.match(f.node('audio-message').textContent,/已停止/);f.hide();f.show();await tick();assert.match(f.node('audio-message').textContent,/已停止/);f.settings.dispose();
 const pending=deferred();const g=fixture({initial:ready(),invoke(name,args,fallback){return name==='test_speech'?pending.promise:fallback(name,args);}});g.show();await tick();g.click('test');g.click('cancel_test');pending.resolve({request_id:g.calls.find(c=>c.name==='test_speech').args.requestId,voice_id:'pet-airhead-v1',wav_base64:wav()});await tick();assert.match(g.node('audio-message').textContent,/已停止/);assert.doesNotMatch(g.node('audio-message').textContent,/完成/);g.settings.dispose();
 const h=fixture({initial:ready(),invoke(name,args,fallback){if(name==='test_speech')throw Error('raw secret');return fallback(name,args);}});h.show();await tick();h.click('test');await tick();assert.match(h.node('audio-message').textContent,/失败/);assert.doesNotMatch(h.node('audio-message').textContent,/raw secret/);h.settings.dispose();
});
test('external ownership is visible and cannot stop or take over even on synthetic click',async()=>{
 const f=fixture({initial:ready({ownership:'external'})});f.show();await tick();assert.match(f.node('ownership').textContent,/外部/);assert.equal(f.node('stop').disabled,true);assert.equal(f.node('start').disabled,true);f.click('stop');f.click('start');await tick();assert.equal(f.calls.some(c=>c.args?.action==='stop'||c.args?.action==='start'),false);f.settings.dispose();
});
test('audition unlock is synchronous before fixed-text-only IPC, guarded and cancelled on leave',async()=>{
 const pending=deferred();const f=fixture({initial:ready(),invoke(name,args,fallback){return name==='test_speech'?pending.promise:fallback(name,args);}});f.show();await tick();f.click('test');f.click('test');assert.ok(f.order.indexOf('resume')<f.order.indexOf('test_speech'));assert.equal(f.calls.filter(c=>c.name==='test_speech').length,1);const request=f.calls.find(c=>c.name==='test_speech');assert.deepEqual(Object.keys(request.args),['requestId']);assert.equal(f.node('cancel_test').disabled,false);f.hide();assert.ok(f.calls.some(c=>c.name==='cancel_speech_test'&&c.args.requestId===request.args.requestId));pending.resolve({request_id:request.args.requestId,voice_id:'pet-airhead-v1',wav_base64:wav()});await tick();assert.equal(f.sources.length,0);assert.equal(f.listeners.size,0);assert.equal(f.timers.size,0);f.settings.dispose();
});
test('targeted stop handles current playback while late old stop cannot cancel newer audition',async()=>{
 const f=fixture({initial:ready()});f.show();await tick();f.click('test');await tick();const first=f.calls.find(c=>c.name==='test_speech').args.requestId;f.event('launcher-speech-stop',{request_id:first});assert.equal(f.node('cancel_test').disabled,true);f.click('test');await tick();const second=f.calls.filter(c=>c.name==='test_speech').at(-1).args.requestId;f.event('launcher-speech-stop',{request_id:first});assert.equal(f.node('cancel_test').disabled,false);f.event('launcher-speech-stop',{request_id:second});assert.equal(f.node('cancel_test').disabled,true);f.settings.dispose();
});
test('preferences wait for native confirmation and older replies cannot override a newer PET event',async()=>{
 const pending=deferred();const f=fixture({invoke(name,args,fallback){return name==='set_speech_preferences'?pending.promise:fallback(name,args);}});f.show();await tick();f.node('auto').checked=true;f.node('auto').emit('change');assert.equal(f.node('auto').checked,false);assert.equal(f.node('auto').disabled,true);f.event('launcher-speech-preferences',prefs({revision:9,auto_read:true,volume:15}));pending.resolve(prefs({revision:1,auto_read:false,volume:80}));await tick();assert.equal(f.node('auto').checked,true);assert.equal(f.node('volume').value,'15');assert.deepEqual(f.calls.find(c=>c.name==='set_speech_preferences').args,{patch:{auto_read:true}});f.settings.dispose();
});
test('safe diagnostics exclude all path, prompt, GPU arbitrary text and raw logs/errors',async()=>{
 const s=ready({config:{model_dir:'/secret',python_path:'/token',native_lib:'/private'},error:'secret-token',logs:['user prompt'],gpu_name:'private gpu'});const text=speechDiagnostics(s,prefs());assert.doesNotMatch(text,/secret|token|private|prompt/);const f=fixture({initial:s});f.show();await tick();f.click('copy');await tick();assert.equal(f.copied,text);f.settings.dispose();
});
test('leaving during subscription releases its late listener and starts no query or poll',async()=>{
 const gate=deferred();const f=fixture({listen:()=>gate.promise});f.show();f.hide();gate.resolve();await tick();assert.equal(f.listeners.size,0);assert.equal(f.calls.length,0);assert.equal(f.timers.size,0);f.settings.dispose();
});
test('leaving an explicit check cancels helper and ignores late results',async()=>{
 const pending=deferred();const f=fixture({invoke(name,args,fallback){return name==='speech_action'&&args.action==='check'?pending.promise:fallback(name,args);}});f.show();await tick();f.click('check');f.hide();assert.ok(f.calls.some(c=>c.args?.action==='cancel_check'));const before=f.node('model_state').textContent;pending.resolve(ready({revision:20}));await tick();assert.equal(f.node('model_state').textContent,before);assert.equal(f.timers.size,0);f.settings.dispose();
});
test('DTO validation refuses unknown readiness and malformed shared preference values',()=>{
 assert.ok(isSpeechSnapshot(snapshot()));assert.ok(isSpeechPreferences(prefs()));assert.equal(isSpeechSnapshot({...snapshot(),ownership:'port-guessed'}),false);assert.equal(isSpeechSnapshot({...snapshot(),model_progress:101}),false);assert.equal(isSpeechPreferences(prefs({volume:NaN})),false);assert.equal(isSpeechPreferences(prefs({revision:-1})),false);assert.doesNotMatch(raw,/fetch\(|XMLHttpRequest|https?:\/\//);
});

test('resource mount lifecycle follows visibility and completion only refreshes saved state', async()=>{
 let visible=false,disposed=false;
 const f=fixture({resources(){return{isBusy:()=>false,setVisible:v=>{visible=v;},setBlocked(){},dispose(){disposed=true;}};}});
 assert.equal(visible,false);f.show();await tick();assert.equal(visible,true);
 f.node('resources').emit('speech-resources-completed');await tick();assert.equal(f.calls.at(-1).name,'get_speech_settings');
 assert.equal(f.calls.some(c=>c.name==='save_speech_config'||c.args?.action==='check'||c.args?.action==='start'),false);
 f.hide();assert.equal(visible,false);const count=f.calls.length;f.node('resources').emit('speech-resources-completed');await tick();assert.equal(f.calls.length,count);f.settings.dispose();assert.equal(disposed,true);
});
test('resource busy blocks all conflicting service and preference operations, including synthetic clicks',async()=>{
 let busy=false;const f=fixture({initial:ready(),resources(){return{isBusy:()=>busy,setVisible(){},setBlocked(){},dispose(){}};}});f.show();await tick();
 busy=true;f.node('resources').emit('speech-resources-busy');
 for(const id of ['refresh','check','start','stop','cancel_check','test','auto','volume'])assert.equal(f.node(id).disabled,true,id);
 for(const id of ['refresh','check','start','stop','cancel_check','test'])f.click(id);
 f.node('auto').checked=true;f.node('auto').emit('change');f.node('volume').value='40';f.node('volume').emit('change');await f.poll();
 assert.deepEqual(f.calls.map(c=>c.name),['get_speech_settings','get_speech_preferences']);
 busy=false;f.node('resources').emit('speech-resources-busy');assert.equal(f.node('test').disabled,false);assert.equal(f.node('auto').disabled,false);f.settings.dispose();
});
test('local speech names the exact Base model, codec and quantization before installation controls',()=>{
 const introduction=speechSettingsMarkup.split('<div id="speech-resources">')[0];
 assert.match(introduction,/语音模型：<strong>Qwen3-TTS-12Hz-1\.7B-Base<\/strong>（GGUF · Q8_0）/);
 assert.match(introduction,/音频编解码模型：Qwen3-TTS-Tokenizer-12Hz（GGUF · Q8_0）/);
 assert.doesNotMatch(introduction,/<details|VoiceDesign|CustomVoice/);
 assert.match(introduction,/打开本页仅查看状态，不会安装、加载模型或开启朗读/);
});

test('local speech settings contain neither editable/read-only paths nor a manual save flow',()=>{
 assert.doesNotMatch(raw,/speech-(?:python_path|model_dir|native_lib|save|draft)|save_speech_config|pick_settings_path|getDraft|pathsLocked/);
 assert.match(raw,/打开本页仅查看状态/);assert.match(raw,/安装结束自动检测并保存/);
});
