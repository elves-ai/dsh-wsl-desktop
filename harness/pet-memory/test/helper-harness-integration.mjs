// Real helper + real Harness Agents, event dispatch and prompt surface; no adapters/model calls.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as Pet from '../index.js';
const root = process.env.DSH_CHECKOUT || process.cwd();
const load = path => import(pathToFileURL(root + '/' + path));
const { Context } = await load('vendor/cordis/src/index.ts');
const { default: SystemPrompt, renderPrompt } = await load('packages/core/system-prompt/src/index.ts');
const { default: SessionStore, SessionId } = await load('packages/core/session/src/index.ts');
const { SystemPromptProjection } = await load('packages/core/agent-loop/src/runtime-context.ts');
const { default: Projections } = await load('packages/session/session-projection/src/index.ts');
const { default: TokenMeter } = await load('packages/llm/token-meter/src/index.ts');
const { default: LlmRuntime, createUserMessage } = await load('packages/llm/llm/src/index.ts');
const { default: Tools } = await load('packages/core/tools/src/index.ts');
const { default: Agents, agentEvents, assembleContextFor } = await load('packages/core/agent/src/index.ts');
const { default: Loop } = await load('packages/core/agent-loop/src/index.ts');
const { agentPresetProjectionDefinition } = await load('packages/preset/agent-preset-registry/src/session.ts');
const temporaryHome = await mkdtemp(join(tmpdir(), 'pet-memory-integration-'));
const previousHome = process.env.HOME;
process.env.HOME = temporaryHome;
const helperPath = fileURLToPath(new URL('../../../src-tauri/helpers/pet_memory.py', import.meta.url));
const config = { enabled: true, helperPath, scope: 'b'.repeat(64), expectedWorkspaceId: 'test-workspace' };
const helper = request => Pet.callHelper(config, request);
const ctx = new Context();
const sessions = [];
try {
  await helper({ action: 'set_enabled', enabled: true });
  for (const Plugin of [LlmRuntime, SessionStore, Projections, TokenMeter, SystemPrompt, Tools, Agents]) await ctx.plugin(Plugin);
  ctx.sessionProjections.register(agentPresetProjectionDefinition);
  const sessionIds = ['pet-a', 'pet-b', 'coding'];
  ctx.provide('workspaceRegistry', { get: id => id === 'test-workspace' ? { sessionIds } : undefined });
  await ctx.plugin(Loop, { agents: [] });
  async function create(id, pet) {
    const handle = await ctx.agents.create({ sessionId: SessionId(id), meta: { agentPreset: pet ? 'desktop-pet' : 'standard' }, agentOptions: { provider: 'offline', model: 'offline' },
      setup: pet ? async agentCtx => { await agentCtx.plugin(Pet, config); } : undefined });
    sessions.push(handle);
    return handle;
  }
  const ordinary = await create('coding', false);
  ordinary.agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '请记住：不应保存普通会话' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  assert.equal((await helper({ action: 'get' })).entries.length, 0);
  const first = await create('pet-a', true);
  first.agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '请记住 ：我喜欢花茶' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  async function render(agent, query) {
    const messages = [createUserMessage({ content: [{ type: 'text', text: query }], source: { kind: 'user' } })];
    const decision = await agentEvents(ctx, agent).waterfall('agent/pre-step', { messages, turn: 0, step: 0, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages }));
    const rendered = renderPrompt(await ctx.systemPrompt.assemble(assembleContextFor(agent)));
    const projection = new SystemPromptProjection(agent.session);
    for (const { message, intent } of projection.project(rendered, { inHistory: true, startsSeries: decision.startsRequestSeries === true })) agent.session.append('system/message', { turn: 0, step: 0, message }, intent);
    return { rendered, system: agent.session.deriveMessages().filter(message => message.role === 'system').map(message => JSON.stringify(message)).join('') };
  }
  assert.match((await render(first.agent, '花茶')).rendered, /我喜欢花茶/);
  const stored = await helper({ action: 'get' });
  assert.equal(stored.entries.length, 1);
  await first.dispose(); // new Agent process-local cache; same durable helper scope.
  const second = await create('pet-b', true);
  assert.match((await render(second.agent, '花茶')).rendered, /我喜欢花茶/);
  await helper({ action: 'forget', id: stored.entries[0].id, confirm: true });
  const forgotten = await render(second.agent, '花茶');
  assert.doesNotMatch(forgotten.rendered, /我喜欢花茶/);
  assert.doesNotMatch(forgotten.system, /我喜欢花茶/);
  const normalPrompt = renderPrompt(await ctx.systemPrompt.assemble(assembleContextFor(ordinary.agent)));
  assert.doesNotMatch(normalPrompt, /桌面陪伴|花茶/);
  const normalConfig = {provider:'offline',model:'ordinary-model',temperature:0.2};
  const unchangedConfig = await agentEvents(ctx, ordinary.agent).waterfall('agent/request', {turn:0,step:0,signal:new AbortController().signal}, async()=>normalConfig);
  assert.equal(unchangedConfig,normalConfig);
  assert.equal(unchangedConfig.maxTokens,undefined);
  const ordinaryDecision={kind:'enter',messages:[]};
  assert.equal(await agentEvents(ctx,ordinary.agent).waterfall('agent/pre-step',{messages:[],turn:0,step:0,signal:new AbortController().signal},async()=>ordinaryDecision),ordinaryDecision);
  let ordinaryDispatches=0;
  for await(const value of ctx.waterfall(ctx.llm,'llm/stream',{provider:'offline',model:'ordinary-model',sessionId:ordinary.agent.session.id},async function*(){ordinaryDispatches++;yield 'ordinary';})) assert.equal(value,'ordinary');
  assert.equal(ordinaryDispatches,1,'ordinary task dispatch bypasses pet budget and metadata requirements');
  await helper({ action: 'set_enabled', enabled: false });
  assert.match((await render(second.agent, '花茶')).rendered, /关闭/);
  console.log('PASS real helper + actual Agent create + scoped committed message ingest + new-session recall + forget/system replacement + disable + normal-session isolation (temporary HOME; 0 model calls)');
} finally {
  for (const handle of sessions.toReversed()) await handle.dispose();
  await ctx.fiber.dispose();
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  // temporaryHome was minted above by mkdtemp, never derived from user paths.
  assert.ok(temporaryHome.startsWith(join(tmpdir(), 'pet-memory-integration-')));
  await rm(temporaryHome, { recursive: true, force: true });
}
