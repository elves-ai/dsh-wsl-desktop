import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { apply, boundedText, checkBudget, callHelper } from '../index.js';
const fixture = fileURLToPath(new URL('./fixture.py', import.meta.url));
const base = { enabled: true, helperPath: fixture, scope: 'a'.repeat(64), expectedWorkspaceId: 'workspace-pet' };
export function harness(systemPrompt) {
  const hooks = new Map(), sections = [];
  const ctx = { systemPrompt: systemPrompt ?? { section: section => sections.push(section) },
    tokenMeter: { measure: () => ({ totalTokens: 100 }) },
    sessionProjections: { stateOf: session => ['a', 'b'].includes(session.id) ? 'desktop-pet' : 'standard' },
    workspaceRegistry: { get: id => id === 'workspace-pet' ? { sessionIds: ['a', 'b'] } : undefined },
    on: (name, listener) => hooks.set(name, listener), effect: () => {}, logger: { warn: () => {} } };
  apply(ctx, base);
  return { ctx, hooks, sections };
}
const message = text => ({ id: 'm', source: { kind: 'user' }, content: [{ type: 'text', text }] });
export const step = (hooks, agent, text) => hooks.get('agent/pre-step')({ agent, messages: [message(text)], signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }));

test('UTF-8 bounds do not split a code point', () => {
  assert.equal(boundedText('中😀文', 7), '中😀');
});
test('helper protocol validates identity and does not accept shell command paths', async () => {
  assert.equal((await callHelper(base, { action: 'context', query: '中文' })).enabled, true);
  await assert.rejects(callHelper({ ...base, helperPath: 'relative.py' }, {}), /invalid/);
  await assert.rejects(callHelper({ ...base, scope: 'bad' }, {}), /invalid/);
});
test('per-Agent snapshot replacement, disable and helper failure never reuse stale facts', async () => {
  const { hooks, sections } = harness();
  const a = { session: { id: 'a' } }, b = { session: { id: 'b' } };
  const memory = sections.find(row => row.name === 'desktop-pet:memory-data');
  assert.equal((await step(hooks, a, 'SNAP-A')).startsRequestSeries, true);
  await step(hooks, b, 'SNAP-B');
  assert.match(memory.text({ agent: a }), /SNAP-A/);
  assert.doesNotMatch(memory.text({ agent: a }), /SNAP-B/);
  await step(hooks, a, 'SNAP-NEW');
  assert.doesNotMatch(memory.text({ agent: a }), /SNAP-A/);
  await step(hooks, a, 'disable');
  assert.doesNotMatch(memory.text({ agent: a }), /SNAP-NEW/);
  assert.match(memory.text({ agent: a }), /关闭/);
  await step(hooks, a, 'fail');
  assert.match(memory.text({ agent: a }), /不可读取/);
  assert.equal(memory.text({ agent: { session: { id: 'other' } } }), '');
});
test('retrieval uses current user input even after a huge old turn and tool output', async () => {
  const { hooks, sections } = harness();
  const agent = { session: { id: 'a' } };
  await hooks.get('agent/pre-step')({ agent, messages: [message('OLD'.repeat(5000)), message('CURRENT-TOPIC'), { source: {kind:'tool'}, content: [{type:'text',text:'TOOL-NOISE'}] }], signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }));
  const text = sections.find(row => row.name === 'desktop-pet:memory-data').text({agent});
  assert.match(text, /CURRENT-TOPIC/);
  assert.doesNotMatch(text, /OLD|TOOL-NOISE/);
});
test('another workspace is rejected before touching helper', async () => {
  const { hooks, ctx } = harness();
  ctx.sessionProjections.stateOf = () => 'desktop-pet';
  await assert.rejects(step(hooks, { session: { id: 'other' } }, 'test'), /workspace/);
});
test('ordinary tasks in the same workspace keep prompts, options, steps and dispatch unchanged', async () => {
  const { hooks, ctx, sections } = harness();
  ctx.workspaceRegistry.get = () => ({sessionIds:['a','coding']});
  const agent = { session: {id:'coding'} };
  const proposal = {kind:'enter',messages:[message('普通编程任务')]};
  assert.equal(await hooks.get('agent/pre-step')({agent,messages:[message('记住：普通项目事实')],signal:new AbortController().signal},async()=>proposal),proposal);
  for (const section of sections) assert.equal(section.text({agent}),'');
  const options = {provider:'coding-model',temperature:0.3};
  assert.equal(await hooks.get('agent/request')({agent},async()=>options),options);
  assert.equal(options.maxTokens,undefined);
  assert.doesNotThrow(()=>hooks.get('session/event')(agent.session,{type:'user/message',data:message('记住：普通项目事实')}));
  ctx.tokenMeter.measure = () => {throw new Error('must not meter ordinary tasks');};
  let calls=0;
  for await (const value of hooks.get('llm/stream')({sessionId:'coding'},async function*(){calls++;yield 'unchanged';})) assert.equal(value,'unchanged');
  assert.equal(calls,1);
});
test('a stale pet cache cannot affect a session that is no longer the pet preset', async () => {
  const {hooks,ctx,sections}=harness();
  const agent={session:{id:'a'}};
  await step(hooks,agent,'PRIVATE-PET-FACT');
  ctx.sessionProjections.stateOf=()=> 'standard';
  for(const section of sections) assert.equal(section.text({agent}),'');
  const options={model:'unchanged'};
  assert.equal(await hooks.get('agent/request')({agent},async()=>options),options);
  ctx.tokenMeter.measure=()=>{throw new Error('stale state must not apply pet budget');};
  for await(const value of hooks.get('llm/stream')({sessionId:'a'},async function*(){yield 'normal';})) assert.equal(value,'normal');
});
test('budget includes complete measurement, actual route window, reserve and safety', () => {
  const session = { requestContext: () => ({ provider: 'p', model: 'm', contextWindow: 10000 }), requestHeader: () => ({ config: { provider: 'p', model: 'm' }, tools: [{ name: 'tool' }] }) };
  const config = { maxInputTokens: 24000, outputReserveTokens: 4096, safetyTokens: 1000 };
  assert.equal(checkBudget(session, { provider: 'p', model: 'm', maxTokens: 2000 }, { measure: () => ({ totalTokens: 7000 }) }, config).limit, 7000);
  assert.throws(() => checkBudget(session, { provider: 'p', model: 'm', maxTokens: 2000 }, { measure: () => ({ totalTokens: 7001 }) }, config), /budget exceeded/);
  assert.throws(() => checkBudget(session, { provider: 'new', model: 'm' }, {}, config), /unavailable/);
  for (const maxTokens of [undefined, NaN, -1, Infinity]) {
    assert.throws(() => checkBudget(session, { provider: 'p', model: 'm', maxTokens }, { measure: () => ({ totalTokens: 1 }) }, config), /output cap/);
  }
  const hugeTools = [{ name: 'huge', description: 'x'.repeat(100000) }];
  assert.throws(() => checkBudget(session, { provider: 'p', model: 'm', maxTokens: 2000, tools: hugeTools }, { measure: (_session, effective) => ({ totalTokens: JSON.stringify(effective.tools).length }) }, config), /budget exceeded/);
});
test('stream gate blocks before provider; non-pet session is not affected', async () => {
  const { hooks, ctx } = harness();
  const session = { id: 'a', requestContext: () => ({ provider: 'p', model: 'm', contextWindow: 32000 }), requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) };
  await step(hooks, { session }, 'hello');
  ctx.tokenMeter.measure = () => ({ totalTokens: 25000 });
  let dispatched = 0;
  const next = async function* () { dispatched++; yield 'ok'; };
  await assert.rejects(async () => { for await (const value of hooks.get('llm/stream')({ sessionId: 'a', provider: 'p', model: 'm', maxTokens: 4096 }, next)) void value; }, /budget exceeded/);
  assert.equal(dispatched, 0);
  for await (const value of hooks.get('llm/stream')({ sessionId: 'coding' }, next)) assert.equal(value, 'ok');
  assert.equal(dispatched, 1);
});
