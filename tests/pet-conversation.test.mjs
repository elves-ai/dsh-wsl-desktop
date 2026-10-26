import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const load=async path=>import('data:text/javascript;base64,'+Buffer.from(ts.transpileModule(await readFile(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText).toString('base64'));
const {conversationCue,speechReadingTime}=await load('../src/pet/conversation.ts');
const {initialSnapshot}=await load('../src/assistant-model.ts');
const ready=patch=>({...initialSnapshot(),enabled:true,connected:true,session_id:'s',workspace_id:'w',phase:'ready',...patch});
test('text bubble never reuses an answer before the newest user message',()=>{
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
