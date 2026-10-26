import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source=await readFile(new URL('../src/pet/qwen-speech.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {QwenSpeech,qwenChunks,qwenWav}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function wav(frames=2400){const b=Buffer.alloc(44+frames*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVE',8);b.write('fmt ',12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(frames*2,40);return b;}
const encoded=()=>wav().toString('base64');
function fixture(options={}){
 let clock=0,serial=0,now=0;const timers=new Map(),requests=[],cancelled=[],states=[],sources=[],timings=[];
 const context={state:options.suspended?'suspended':'running',destination:{},closes:0,resumes:0,
  resume(){this.resumes++;if(options.resume)return options.resume(this);this.state='running';return Promise.resolve();},
  close(){this.closes++;this.state='closed';return Promise.resolve();},
  createGain(){const gain={gain:{value:1},connected:null,connect(node){this.connected=node;},disconnect(){this.connected=null;}};this.gainNode=gain;return gain;},
  decodeAudioData(bytes){if(options.decode)return options.decode(bytes);return Promise.resolve({duration:0.1});},
  createBufferSource(){const s={onended:null,stops:0,disconnected:0,started:false,connect(){if(options.connectThrow)throw Error('connect');},start(){if(options.startThrow)throw Error('start');this.started=true;},stop(){this.stops++;},disconnect(){this.disconnected++;},end(){this.onended?.();}};sources.push(s);return s;}};
 const view={AudioContext:class{constructor(){return context;}},atob:value=>Buffer.from(value,'base64').toString('binary'),crypto:{getRandomValues(bytes){for(let i=0;i<bytes.length;i++)bytes[i]=(serial+i)%256;return bytes;}},setTimeout(fn,delay){const id=++clock;timers.set(id,{fn,at:now+delay});return id;},clearTimeout(id){timers.delete(id);}};
 const speech=new QwenSpeech({view,enabled:options.enabled??true,now:()=>now,onTiming(t){timings.push(t);options.onTiming?.(t,speech);},newId:()=> (options.idPrefix??'request-')+(++serial).toString().padStart(8,'0'),onChange(s){states.push(s);options.onChange?.(s,speech);},synthesize(request){const d=deferred();requests.push({...request,...d});options.synthesize?.(request,d);return d.promise;},cancel(id){cancelled.push(id);return options.cancel?.(id)??Promise.resolve();}});
 const reply=(index=0,extra={})=>{const r=requests[index];r.resolve({request_id:r.request_id,voice_id:'pet-airhead-v1',wav_base64:encoded(),...extra});};
 const advance=ms=>{now+=ms;for(const[id,t]of [...timers])if(t.at<=now){timers.delete(id);t.fn();}};
 return{speech,context,view,timers,requests,cancelled,states,sources,timings,reply,advance};
}

test('targeted stop matches pending, decoding and playing IDs but ignores a late older stop',async()=>{
 const f=fixture();f.speech.play('第一句');const old=f.requests[0].request_id;f.speech.stopRequest('not-matching');assert.equal(f.speech.state.phase,'loading');
 f.speech.stopRequest(old);assert.equal(f.speech.state.phase,'idle');f.reply();await tick();assert.equal(f.sources.length,0);
 f.speech.play('第二句');const current=f.requests[1].request_id;f.reply(1);await tick();assert.equal(f.speech.state.phase,'speaking');
 f.speech.stopRequest(old);assert.equal(f.speech.state.phase,'speaking');f.speech.stopRequest(current);assert.equal(f.speech.state.phase,'idle');assert.ok(f.sources[0].stops>0);
 const decode=deferred(),g=fixture({decode:()=>decode.promise});g.speech.play('解码');g.reply();await tick();g.speech.stopRequest(g.requests[0].request_id);decode.resolve({duration:.1});await tick();assert.equal(g.sources.length,0);
});
test('volume uses a connected GainNode and applies live mute, clamping and disposal',async()=>{
 const f=fixture();f.speech.setVolume(37);f.speech.unlock();assert.equal(f.context.gainNode.gain.value,.37);assert.equal(f.context.gainNode.connected,f.context.destination);
 f.speech.play('音量');f.reply();await tick();f.speech.setVolume(0);assert.equal(f.context.gainNode.gain.value,0);f.speech.setVolume(150);assert.equal(f.context.gainNode.gain.value,1);f.speech.setVolume(-1);assert.equal(f.context.gainNode.gain.value,0);f.speech.setVolume(NaN);assert.equal(f.context.gainNode.gain.value,0);f.speech.dispose();assert.equal(f.context.gainNode.connected,null);
});
test('chunks bound synthesis requests and keep Unicode scalar values',()=>{for(const text of ['你好。'.repeat(150),'😀'.repeat(151),'a'.repeat(181),'中文，'+ '单词 '.repeat(70)]){const parts=qwenChunks(text);assert.ok(parts.every(p=>Array.from(p).length<=60));assert.equal(parts.join('').replace(/\s/g,''),text.replace(/\s/g,''));}assert.deepEqual(qwenChunks('  '),[]);});
test('WAV boundary accepts PCM16 mono 24k but rejects malformed data',()=>{assert.equal(qwenWav(encoded(),v=>Buffer.from(v,'base64').toString('binary')).byteLength,wav().length);for(const value of ['a','!!!!','A'.repeat(3_000_000)])assert.throws(()=>qwenWav(value,v=>Buffer.from(v,'base64').toString('binary')));for(const edit of [b=>b.writeUInt16LE(2,22),b=>b.writeUInt32LE(16000,24),b=>b.writeUInt32LE(0,40),b=>b.writeUInt32LE(999999,4),b=>b.write('JUNK',0)]){const b=wav();edit(b);assert.throws(()=>qwenWav(b.toString('base64'),v=>Buffer.from(v,'base64').toString('binary')));}});
test('large valid bounded WAV does not exhaust regexp stack',()=>{const b=wav(720000);assert.equal(qwenWav(b.toString('base64'),v=>Buffer.from(v,'base64').toString('binary')).byteLength,b.length);});
test('native-only support does not fall back to system speech',()=>{const f=fixture({enabled:false});f.speech.play('你好');assert.equal(f.requests.length,0);assert.equal(f.speech.state.supported,false);assert.match(f.speech.state.error,/桌面/);});
test('manual play generates then plays selected voice and cleans up',async()=>{const f=fixture();f.speech.play('你好');assert.equal(f.speech.state.phase,'loading');assert.equal(f.requests.length,1);f.reply();await tick();assert.equal(f.speech.state.phase,'speaking');assert.equal(f.sources.length,1);assert.ok(f.sources[0].started);f.sources[0].end();await tick();assert.equal(f.speech.state.phase,'idle');assert.equal(f.timers.size,0);assert.equal(f.sources[0].disconnected,1);});
test('stop during generation cancels the exact request and ignores late audio',async()=>{const f=fixture();f.speech.play('旧回复');const id=f.requests[0].request_id;f.speech.stop();assert.deepEqual(f.cancelled,[id]);assert.equal(f.speech.state.phase,'idle');f.reply();await tick();assert.equal(f.sources.length,0);assert.equal(f.timers.size,0);});
test('new play supersedes old request even when old result arrives last',async()=>{const f=fixture();f.speech.play('旧');f.speech.play('新');assert.equal(f.requests.length,2);assert.notEqual(f.requests[0].request_id,f.requests[1].request_id);f.reply(1);await tick();f.reply(0);await tick();assert.equal(f.sources.length,1);f.speech.stop();assert.ok(f.sources[0].stops>0);});
test('stop after decode has started prevents source creation',async()=>{const decode=deferred();const f=fixture({decode:()=>decode.promise});f.speech.play('你好');f.reply();await tick();f.speech.stop();decode.resolve({duration:0.1});await tick();assert.equal(f.sources.length,0);assert.equal(f.timers.size,0);});
test('long replies prefetch at most one segment while playing, never in parallel with synthesis', async () => {
 const f=fixture(), text='这是一段很长的回复。'.repeat(20), parts=qwenChunks(text);
 f.speech.play(text); assert.equal(f.requests.length,1);
 f.reply(0); await tick();
 for(let i=0;i<parts.length;i++) {
  assert.equal(f.speech.state.phase,'speaking');
  assert.equal(f.sources.length,i+1);
  assert.equal(f.requests.length,Math.min(i+2,parts.length));
  if(i+1<parts.length) {
   const stateCount=f.states.length;
   f.reply(i+1); await tick();
   assert.equal(f.sources.length,i+1,'lookahead does not play over current audio');
   assert.equal(f.requests.length,i+2,'ready lookahead does not pull a third segment');
   assert.equal(f.states.length,stateCount,'background work does not change speaking state');
  }
  f.sources[i].end(); await tick();
 }
 assert.equal(f.speech.state.phase,'idle');
 assert.deepEqual(f.requests.map(r=>r.text),parts);
 assert.equal(f.states.filter(s=>s.phase==='loading').length,2,'no loading flicker for buffered segments');
 assert.equal(f.timers.size,0);
});
test('wrong identity, bad WAV and backend errors stay inline and retryable',async()=>{for(const extra of [{voice_id:'other'},{request_id:'other-request'},{wav_base64:'AAAA'}]){const f=fixture();f.speech.play('你好');f.reply(0,extra);await tick();assert.equal(f.speech.state.phase,'idle');assert.ok(f.speech.state.error);assert.equal(f.sources.length,0);f.speech.play('重试');assert.equal(f.requests.length,2);f.speech.dispose();}const f=fixture();f.speech.play('你好');f.requests[0].reject('请先启动本地千问服务');await tick();assert.match(f.speech.state.error,/启动本地千问/);});
test('synthesis timeout cancels worker and late result never speaks',async()=>{const f=fixture();f.speech.play('你好');f.advance(210000);await tick();assert.match(f.speech.state.error,/超时/);assert.equal(f.cancelled.length,1);f.reply();await tick();assert.equal(f.sources.length,0);});
test('playback watchdog and synchronous device failures never leave speaking stuck',async()=>{for(const mode of ['watchdog','start','connect']){const f=fixture({startThrow:mode==='start',connectThrow:mode==='connect'});f.speech.play('你好');f.reply();await tick();if(mode==='watchdog'){f.advance(10101);await tick();}assert.equal(f.speech.state.phase,'idle');assert.ok(f.speech.state.error);assert.equal(f.timers.size,0);}});
test('opt-in unlock primes AudioContext without loading a model',async()=>{const f=fixture({suspended:true});f.speech.unlock();await tick();assert.equal(f.context.state,'running');assert.equal(f.requests.length,0);f.speech.play('你好');assert.equal(f.requests.length,1);f.speech.dispose();});
test('stored opt-in without audio permission fails before expensive synthesis',async()=>{const f=fixture({suspended:true,resume:()=>new Promise(()=>{})});f.speech.play('你好');f.advance(5000);await tick();assert.match(f.speech.state.error,/点击.*朗读/);assert.equal(f.requests.length,0);assert.equal(f.timers.size,0);});
test('reentrant stop in loading and speaking callbacks prevents orphaned audio',async()=>{let stopped=false;const f=fixture({onChange(s,speech){if(s.phase==='speaking'&&!stopped){stopped=true;speech.stop();}}});f.speech.play('你好');f.reply();await tick();assert.equal(f.speech.state.phase,'idle');assert.equal(f.timers.size,0);assert.ok(f.sources[0].stops>0);let stopLoading=false;const g=fixture({onChange(s,speech){if(s.phase==='loading'&&!stopLoading){stopLoading=true;speech.stop();}}});g.speech.play('你好');await tick();assert.equal(g.requests.length,0);});
test('dispose releases pending waits, device and late callbacks',async()=>{const f=fixture();f.speech.play('你好');f.speech.dispose();const states=f.states.length;f.reply();await tick();f.speech.play('不应再播');assert.equal(f.sources.length,0);assert.equal(f.states.length,states);assert.equal(f.timers.size,0);assert.equal(f.context.closes,1);});

test('first segment is short and natural, short replies stay whole, later segments remain larger', () => {
 const first='今天也要一起加油呀！', text=first+'接下来继续认真做事情'.repeat(12);
 const parts=qwenChunks(text);
 assert.equal(parts[0],first);
 assert.deepEqual(qwenChunks('Excellent extraordinarily useful advice'),['Excellent','extraordinarily useful advice']);
 assert.ok(parts.slice(1).some(p=>Array.from(p).length>24));
 assert.equal(parts.join(''),text);
 for(const length of [1,20,21,24,25,60,61,200]) {
  const text='鲸'.repeat(length), chunks=qwenChunks(text);
  assert.equal(chunks[0].length,length<=24?length:20);
  assert.ok(chunks.every(p=>Array.from(p).length<=60));
  assert.equal(chunks.join(''),text);
 }
 assert.deepEqual(qwenChunks('鲸'.repeat(20)+'！'),['鲸'.repeat(20)+'！']);
 const emoji=qwenChunks('😀'.repeat(81));
 assert.equal(Array.from(emoji[0]).length,20);
 assert.equal(emoji.join(''),'😀'.repeat(81));
});

test('slow lookahead shows loading only after current playback ends and never duplicates synthesis', async () => {
 const f=fixture(); f.speech.play('鲸'.repeat(80)); f.reply(); await tick();
 assert.equal(f.requests.length,2); assert.equal(f.speech.state.phase,'speaking');
 f.sources[0].end(); await tick();
 assert.equal(f.speech.state.phase,'loading'); assert.equal(f.requests.length,2);
 f.advance(400); f.reply(1); await tick();
 assert.equal(f.sources.length,2); assert.equal(f.speech.state.phase,'speaking');
 assert.equal(f.timings.find(t=>t.segment===1&&t.phase==='playback_started').gap_ms,400);
 f.sources[1].end(); await tick(); assert.equal(f.speech.state.phase,'idle');
});

test('stop and disposal cancel both playing and lookahead IDs at every prefetch stage', async () => {
 for(const stage of ['pending','decoding','ready']) for(const action of ['stop','dispose','playing-id','lookahead-id']) {
  const decode=deferred(); let calls=0;
  const f=fixture({decode(){return ++calls===2&&stage==='decoding'?decode.promise:Promise.resolve({duration:.1});}});
  f.speech.play('鲸'.repeat(100)); f.reply(); await tick();
  assert.equal(f.requests.length,2);
  if(stage!=='pending'){f.reply(1); await tick();}
  const ids=f.requests.map(r=>r.request_id);
  if(action==='stop')f.speech.stop();
  else if(action==='dispose')f.speech.dispose();
  else f.speech.stopRequest(ids[action==='playing-id'?0:1]);
  assert.deepEqual(f.cancelled,ids,stage+' '+action);
  assert.ok(f.sources[0].stops>0); assert.equal(f.timers.size,0);
  if(stage==='pending') f.reply(1);
  if(stage==='decoding')decode.resolve({duration:.1});
  await tick(); assert.equal(f.sources.length,1); assert.equal(f.requests.length,2);
 }
});

test('new narration invalidates playing and prefetched audio, including late cross-window stops', async () => {
 const f=fixture();f.speech.play('鲸'.repeat(100));f.reply();await tick();
 const old=f.requests.map(r=>r.request_id);
 f.speech.play('新的回复'); assert.deepEqual(f.cancelled,old);
 f.reply(2);await tick();assert.equal(f.sources.length,2);
 f.reply(1);await tick();assert.equal(f.sources.length,2);
 old.forEach(id=>f.speech.stopRequest(id));
 assert.equal(f.speech.state.phase,'speaking');assert.equal(f.sources[1].stops,0);
 f.speech.stopRequest(f.requests[2].request_id);
 assert.equal(f.speech.state.phase,'idle'); assert.equal(f.timers.size,0);
});

test('lookahead errors are observed immediately but reported after the current segment, then remain retryable', async () => {
 for(const failure of ['reject','identity','wav']) {
  const f=fixture();f.speech.play('鲸'.repeat(100));f.reply();await tick();
  if(failure==='reject')f.requests[1].reject(Error('合成失败'));
  else f.reply(1,failure==='identity'?{request_id:'wrong-id'}:{wav_base64:'AAAA'});
  await tick();assert.equal(f.speech.state.phase,'speaking');assert.equal(f.sources[0].stops,0);
  assert.equal(f.requests.length,2);
  f.sources[0].end();await tick();
  assert.equal(f.speech.state.phase,'idle');assert.ok(f.speech.state.error);assert.equal(f.sources.length,1);
  assert.ok(f.cancelled.includes(f.requests[1].request_id));assert.equal(f.timers.size,0);
  f.speech.play('重试');assert.equal(f.requests.length,3);f.reply(2);await tick();
  assert.equal(f.speech.state.phase,'speaking');f.speech.dispose();
 }
});

test('lookahead synthesis and decode timeouts never play late audio', async () => {
 for(const mode of ['synthesis','decode']) {
  const decode=deferred();let calls=0;
  const f=fixture({decode(){return ++calls===2&&mode==='decode'?decode.promise:Promise.resolve({duration:.1});}});
  f.speech.play('鲸'.repeat(100));f.reply();await tick();
  if(mode==='decode'){f.reply(1);await tick();}
  f.sources[0].end();await tick();
  f.advance(mode==='decode'?10000:210000);await tick();
  assert.equal(f.speech.state.phase,'idle');assert.match(f.speech.state.error,/超时/);
  assert.ok(f.cancelled.includes(f.requests[1].request_id));assert.equal(f.timers.size,0);
  if(mode==='decode')decode.resolve({duration:.1});else f.reply(1);
  await tick();assert.equal(f.sources.length,1);
 }
});

test('playback watchdog also retires a pending lookahead and its timer', async () => {
 const f=fixture();f.speech.play('鲸'.repeat(100));f.reply();await tick();
 assert.equal(f.timers.size,2);f.advance(10101);await tick();
 assert.match(f.speech.state.error,/播放/);assert.equal(f.timers.size,0);
 assert.deepEqual(f.cancelled,f.requests.map(r=>r.request_id));
 f.reply(1);await tick();assert.equal(f.sources.length,1);
});

test('timings distinguish synthesis, decoding, first audio and buffered playback without text or audio', async () => {
 const decodes=[];const f=fixture({decode(){const d=deferred();decodes.push(d);return d.promise;}});
 const native={readiness_ms:100,synthesis_ms:1000,encode_ms:1,total_ms:1105};
 f.speech.play('鲸'.repeat(80));f.advance(1200);f.reply(0,{timings:{...native,text:'private',wav_base64:'private'}});await tick();
 f.advance(25);decodes[0].resolve({duration:1});await tick();
 assert.deepEqual(f.timings[0],{request_id:f.requests[0].request_id,segment:0,phase:'prepared',synthesis_ms:1200,decode_ms:25,audio_ms:1000,elapsed_ms:1225,native});
 assert.equal(f.timings[1].phase,'playback_started');assert.equal(f.timings[1].first_audio_ms,1225);
 f.advance(200);f.reply(1);await tick();decodes[1].resolve({duration:1});await tick();
 assert.equal(f.timings[2].segment,1);assert.equal(f.timings[2].phase,'prepared');assert.equal(f.timings[2].synthesis_ms,200);
 f.advance(800);f.sources[0].end();await tick();
 const played=f.timings[3];assert.equal(played.phase,'playback_started');assert.equal(played.gap_ms,0);
 assert.equal(played.elapsed_ms,2225);assert.equal(played.first_audio_ms,undefined);assert.equal(played.native,undefined);
 assert.doesNotMatch(JSON.stringify(f.timings),/鲸|private|wav_base64|voice_id/);
 f.speech.dispose();
});

test('malformed optional native timings do not break playback or enter diagnostics', async () => {
 for(const timings of [null,{readiness_ms:-1,synthesis_ms:2,encode_ms:0,total_ms:3},{readiness_ms:1,synthesis_ms:Infinity,encode_ms:0,total_ms:3},{readiness_ms:'private',synthesis_ms:2,encode_ms:0,total_ms:3},{}]) {
  const f=fixture();f.speech.play('你好');f.reply(0,{timings});await tick();
  assert.equal(f.speech.state.phase,'speaking');assert.equal(f.timings[0].native,undefined);f.speech.dispose();
 }
});

test('diagnostic observers cannot mutate timing snapshots or break playback', async () => {
 const observed=[];
 const f=fixture({onTiming(t){observed.push(structuredClone(t));if(t.native)t.native.total_ms=999;t.synthesis_ms=999;throw Error('observer');}});
 f.speech.play('你好');f.advance(10);f.reply(0,{timings:{readiness_ms:1,synthesis_ms:2,encode_ms:0,total_ms:3}});await tick();
 assert.equal(f.speech.state.phase,'speaking');assert.equal(f.timings.length,2);
 assert.equal(observed[1].synthesis_ms,10);assert.equal(observed[1].native.total_ms,3);
 f.speech.dispose();
});

test('reentrant diagnostic stops cannot orphan playback or launch more lookahead', async () => {
 for(const phase of ['prepared','playback_started']) {
  const f=fixture({onTiming(t,speech){if(t.phase===phase)speech.stop();}});
  f.speech.play('鲸'.repeat(100));f.reply();await tick();
  assert.equal(f.speech.state.phase,'idle');assert.equal(f.requests.length,1);assert.equal(f.timers.size,0);
  if(phase==='prepared')assert.equal(f.sources.length,0);else assert.ok(f.sources[0].stops>0);
 }
});

test('each background segment carries its immediate predecessor, new narration does not', async () => {
 const f=fixture();f.speech.play('鲸'.repeat(150));
 assert.equal(f.requests[0].previous_request_id,undefined);
 f.reply();await tick();assert.equal(f.requests[1].previous_request_id,f.requests[0].request_id);
 f.reply(1);await tick();f.sources[0].end();await tick();
 assert.equal(f.requests[2].previous_request_id,f.requests[1].request_id);
 f.speech.play('新一轮');assert.equal(f.requests[3].previous_request_id,undefined);f.speech.dispose();
});

test('a delayed cross-window stop cannot let old lookahead supersede the newest user audition', async () => {
 let current;const owners=new Map(),stops=[];
 const synthesize=owner=>(request,d)=>{
  if(request.previous_request_id&&request.previous_request_id!==current){d.reject('语音请求已取消');return;}
  if(current&&owners.get(current)!==owner)stops.push({owner:owners.get(current),id:current});
  owners.set(request.request_id,owner);current=request.request_id;
 };
 const cancel=id=>{if(current===id)current=undefined;return Promise.resolve();};
 const a=fixture({idPrefix:'pet-',synthesize:synthesize('pet'),cancel});
 const b=fixture({idPrefix:'settings-',synthesize:synthesize('settings'),cancel});
 a.speech.play('鲸'.repeat(150));a.reply();await tick();a.reply(1);await tick();
 assert.equal(current,a.requests[1].request_id);
 b.speech.play('新的试听');const newest=b.requests[0].request_id;
 assert.equal(current,newest);assert.equal(stops.length,1);
 // Intentionally withhold stop(a2); a2 is buffered, and a1 naturally ends first.
 a.sources[0].end();await tick();assert.equal(a.requests.length,3);
 assert.equal(a.requests[2].previous_request_id,a.requests[1].request_id);
 assert.equal(current,newest,'the stale continuation cannot reclaim native ownership');
 assert.deepEqual(stops,[{owner:'pet',id:a.requests[1].request_id}],'no stop event was sent to the newer audition');
 a.speech.stopRequest(stops[0].id);await tick();
 assert.equal(a.speech.state.phase,'idle');assert.equal(a.timers.size,0);
 assert.equal(current,newest);b.reply();await tick();
 assert.equal(b.speech.state.phase,'speaking');assert.equal(b.sources[0].stops,0);
 b.speech.dispose();
});
