import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const load=async path=>import('data:text/javascript;base64,'+Buffer.from(ts.transpileModule(await readFile(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText).toString('base64'));
const {conversationCue,speechReadingTime,CompletedReplyTracker}=await load('../src/pet/conversation.ts');
const {initialSnapshot}=await load('../src/assistant-model.ts');
const ready=patch=>({...initialSnapshot(),enabled:true,connected:true,session_id:'s',workspace_id:'w',phase:'ready',...patch});
test('speech never reuses an answer before the newest user message',()=>{
  const state=ready({running:true,messages:[{id:'a1',role:'assistant',text:'旧回复'},{id:'u2',role:'user',text:'新问题'}]});
  assert.equal(conversationCue(state).kind,'thinking');
  state.messages.push({id:'tool',role:'system',text:'private progress'},{id:'a2',role:'assistant',text:'新回复'});
  assert.equal(conversationCue(state).text,'新回复');assert.equal(conversationCue(state).busy,true);
});
test('setup, disconnection, waiting and cancellation have explicit public cues',()=>{
  assert.equal(conversationCue(initialSnapshot()).kind,'thinking');
  assert.match(conversationCue({...initialSnapshot(),phase:'setup'}).text,/设置.*初始化/);
  assert.match(conversationCue({...initialSnapshot(),phase:'loading',message:'等待 DSH 服务就绪'}).text,/等待 DSH/);
  assert.match(conversationCue({...initialSnapshot(),phase:'error',message:'请先登录 DSH'}).text,/初始化未完成.*登录/);
  assert.match(conversationCue(ready({phase:'workspace_missing',connected:false})).text,/目录.*丢失.*初始化/);
  assert.equal(conversationCue(ready({connected:false,message:'重连中'})).text,'重连中');
  assert.equal(conversationCue(ready({waiting:true})).kind,'waiting');
  assert.equal(conversationCue(ready({phase:'cancelling'})).busy,true);
  assert.equal(conversationCue(ready({phase:'error',message:'失败'})).text,'失败');
});
test('reply identity stays stable across stream updates, but changes across sessions',()=>{
  const state=ready({messages:[{id:'a',role:'assistant',text:'你'}]});const first=conversationCue(state);
  state.messages[0].text='你好';assert.equal(conversationCue(state).key,first.key);
  state.session_id='other';assert.notEqual(conversationCue(state).key,first.key);
});
test('long answers never auto-dismiss and short answers allow reading time',()=>{
  assert.equal(speechReadingTime('你好'),8000);assert.ok(speechReadingTime('字'.repeat(100))>=18000);
  assert.equal(speechReadingTime('字'.repeat(181)),null);
});

test('completed reply tracking primes saved history and emits a streamed final reply once',()=>{
  const tracker=new CompletedReplyTracker();const old={id:'old',role:'assistant',text:'历史'};
  assert.equal(tracker.observe(ready({messages:[old]})),null);
  const user={id:'u',role:'user',text:'新问题'};const answer={id:'a',role:'assistant',text:'回答',status:'completed'};
  assert.equal(tracker.observe(ready({running:true,messages:[old,user,{...answer,text:'回',status:'streaming'}]})),null);
  assert.deepEqual(tracker.observe(ready({messages:[old,user,answer]})),{key:'w:s:answer:a',text:'回答'});
  assert.equal(tracker.observe(ready({messages:[old,user,answer]})),null);
});

test('an idle snapshot cannot consume a reply whose stream has not settled yet',()=>{
  const tracker=new CompletedReplyTracker();tracker.observe(ready({messages:[]}));
  const answer={id:'a',role:'assistant',text:'已经完整',status:'streaming'};
  assert.equal(tracker.observe(ready({messages:[answer]})),null);
  assert.deepEqual(tracker.observe(ready({messages:[{...answer,status:'completed'}]})),{key:'w:s:answer:a',text:'已经完整'});
  assert.equal(tracker.observe(ready({messages:[{...answer,status:'completed'}]})),null);
});

test('new reply tracking skips thinking, tool commentary, stopped and failed output',()=>{
  const tracker=new CompletedReplyTracker();tracker.observe(ready({messages:[]}));
  const user={id:'u',role:'user',text:'问题'};
  const commentary={id:'c',role:'assistant',text:'我先看看',status:'completed'};
  assert.equal(tracker.observe(ready({running:true,messages:[user,commentary]})),null);
  assert.equal(tracker.observe(ready({waiting:true,messages:[user,commentary]})),null);
  assert.equal(tracker.observe(ready({phase:'cancelled',messages:[user,{...commentary,status:'interrupted'}]})),null);
  assert.equal(tracker.observe(ready({messages:[user,commentary]})),null,'a stopped message cannot replay on a later ready snapshot');
  assert.equal(tracker.observe(ready({phase:'failed',messages:[user,{id:'failed',role:'assistant',text:'片段',status:'completed'}]})),null);
});

test('reconnection, session changes and off-mode consumption never replay saved replies',()=>{
  const tracker=new CompletedReplyTracker();tracker.observe(ready({messages:[]}));
  const a={id:'a',role:'assistant',text:'新回答'};
  assert.ok(tracker.observe(ready({messages:[a]})));
  assert.equal(tracker.observe(ready({messages:[a]})),null);
  assert.equal(tracker.observe(ready({connected:false,messages:[a]})),null);
  const b={id:'b',role:'assistant',text:'断线期间的历史'};
  assert.equal(tracker.observe(ready({messages:[a,b]})),null);
  assert.equal(tracker.observe(ready({session_id:'other',messages:[a,b]})),null);
  assert.equal(tracker.observe(ready({session_id:'other',messages:[a,b]})),null);
});

test('completed tracking ignores an answer before the latest user and baselines connecting snapshots',()=>{
  const tracker=new CompletedReplyTracker();tracker.observe(ready({phase:'connecting',messages:[]}));
  const old={id:'old',role:'assistant',text:'旧回复'};
  assert.equal(tracker.observe(ready({messages:[old]})),null);
  assert.equal(tracker.observe(ready({messages:[old,{id:'u',role:'user',text:'新问题'}]})),null);
  assert.equal(tracker.observe(ready({messages:[old,{id:'u',role:'user',text:'新问题'},{id:'system',role:'system',text:'工具执行中'}]})),null);
});
