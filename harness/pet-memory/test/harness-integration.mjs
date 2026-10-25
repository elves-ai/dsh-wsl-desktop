// Run from the Harness checkout with tsx loaded; no providers/adapters or model calls.
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { apply } from '../index.js';
const root = process.env.DSH_CHECKOUT || process.cwd();
const load = path => import(pathToFileURL(root + '/' + path));
const { Context } = await load('vendor/cordis/src/index.ts');
const { default: SystemPrompt, renderPrompt } = await load('packages/core/system-prompt/src/index.ts');
const { default: SessionStore, SessionId } = await load('packages/core/session/src/index.ts');
const { createScope } = await load('packages/core/scope/src/index.ts');
const { SystemPromptProjection } = await load('packages/core/agent-loop/src/runtime-context.ts');
const { default: Projections } = await load('packages/session/session-projection/src/index.ts');
const { default: TokenMeter } = await load('packages/llm/token-meter/src/index.ts');
const { default: LlmRuntime, createUserMessage } = await load('packages/llm/llm/src/index.ts');
const { agentPresetProjectionDefinition } = await load('packages/preset/agent-preset-registry/src/session.ts');
const ctx = new Context();
await ctx.plugin(SystemPrompt, { personaPrefix: 'GLOBAL-CODING' });
await ctx.plugin(SessionStore);
await ctx.plugin(Projections);
await ctx.plugin(TokenMeter);
await ctx.plugin(LlmRuntime);
ctx.sessionProjections.register(agentPresetProjectionDefinition);
const session = ctx.sessions.create(SessionId('a'), { meta: { agentPreset: 'desktop-pet' } });
const agent = { session, id: session.id };
let scope;
const hooks = new Map();
await ctx.plugin({ inject: ['systemPrompt'], apply(inner) {
scope = createScope(inner, agent);
apply({ systemPrompt: scope.ctx.systemPrompt,
  workspaceRegistry: { get: () => ({ sessionIds: ['a'] }) },
  tokenMeter: ctx.tokenMeter, sessionProjections: ctx.sessionProjections, on: (name, callback) => { hooks.set(name, callback); scope.ctx.on(name, callback); }, effect: () => {}, logger: { warn: () => {} } },
  { enabled: true, helperPath: fileURLToPath(new URL('./fixture.py', import.meta.url)), scope: 'a'.repeat(64), expectedWorkspaceId: 'workspace-pet' });
} });
const projection = new SystemPromptProjection(session);
async function render(query) {
  const decision = await hooks.get('agent/pre-step')({ agent, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: query }] }], signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }));
  const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent });
  const rendered = renderPrompt(assembly);
  // Real loop's in-history route projection, not just a mocked registry/provider.
  for (const { message, intent } of projection.project(rendered, { inHistory: true, startsSeries: decision.startsRequestSeries === true })) {
    session.append('system/message', { turn: 0, step: 0, message }, intent);
  }
  return { rendered, visible: JSON.stringify(session.deriveMessages()) };
}
try {
  const first = await render('SNAP-OLD');
  assert.match(first.visible, /SNAP-OLD/);
  const second = await render('SNAP-NEW');
  assert.match(second.rendered, /SNAP-NEW/);
  assert.doesNotMatch(second.rendered, /SNAP-OLD/);
  assert.doesNotMatch(second.visible, /SNAP-OLD/);
  const disabled = await render('disable');
  assert.doesNotMatch(disabled.visible, /SNAP-NEW|SNAP-OLD/);
  assert.match(disabled.visible, /关闭/);
  const global = renderPrompt(await ctx.systemPrompt.assemble());
  assert.match(global, /GLOBAL-CODING/);
  assert.doesNotMatch(global, /桌面陪伴|SNAP/);
  assert.equal(session.deriveMessages().filter(message => message.role === 'system').length, 1);
  session.append('request/header', { header: { config: { provider: 'offline', model: 'offline', maxTokens: 4096 } }, reason: 'initial' });
  session.append('request/context', { provider: 'offline', model: 'offline', contextWindow: 32000 });
  const options = { provider: 'offline', model: 'offline', sessionId: 'a', maxTokens: 4096 };
  let providerDispatches = 0;
  const terminal = async function* () { providerDispatches++; yield 'offline'; };
  for await (const ignored of ctx.waterfall(ctx.llm, 'llm/stream', options, terminal)) void ignored;
  assert.equal(providerDispatches, 1);
  await assert.rejects(async () => {
    const largeTools = [{ name: 'huge', description: '中'.repeat(100000), parameters: { type: 'object' } }];
    for await (const ignored of ctx.waterfall(ctx.llm, 'llm/stream', { ...options, tools: largeTools }, terminal)) void ignored;
  }, /budget exceeded/);
  assert.equal(providerDispatches, 1, 'final tool definitions counted even when durable header tools are small');
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '中'.repeat(100000) }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  await assert.rejects(async () => {
    for await (const ignored of ctx.waterfall(ctx.llm, 'llm/stream', options, terminal)) void ignored;
  }, /budget exceeded/);
  assert.equal(providerDispatches, 1, 'oversize request blocked before provider dispatch by real TokenMeter + real event bus');
  console.log('PASS real Harness scoped assembly + in-history surface replacement + disable + global isolation + TokenMeter pre-provider gate (0 model calls)');
} finally { await scope.dispose(); await ctx.fiber.dispose(); }
