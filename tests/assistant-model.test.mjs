import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/assistant-model.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { initialSnapshot, mergeSnapshot, canSend, statusLabel, movedBeyondThreshold } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const snapshot = (revision = 1, extra = {}) => ({ ...initialSnapshot(), enabled: true, phase: 'ready', connected: true, session_id: 'a', workspace_id: 'w', revision, ...extra });
const message = (id, text, role = 'assistant') => ({ id, text, role });

test('a newer subscribed event wins against late initial snapshot and equal revision replay', () => {
  const current = mergeSnapshot(initialSnapshot(), snapshot(12, { running: true }));
  assert.strictEqual(mergeSnapshot(current, snapshot(11)), current);
  assert.strictEqual(mergeSnapshot(current, snapshot(12)), current);
  assert.equal(current.running, true);
});
test('same-revision and older delta cannot append or roll streaming text back', () => {
  const current = snapshot(5, { messages: [message('m', '你好')] });
  const delta = { kind: 'delta', revision: 6, session_id: 'a', messages: [message('m', '你好，世界', 'assistant')] };
  const next = mergeSnapshot(current, delta);
  assert.equal(next.messages.length, 1);
  assert.equal(next.messages[0].text, '你好，世界');
  assert.strictEqual(mergeSnapshot(next, delta), next);
  assert.strictEqual(mergeSnapshot(next, { ...delta, revision: 4 }), next);
  assert.equal(current.messages[0].text, '你好');
});
test('incremental messages deduplicate id and retain original message order', () => {
  const current = snapshot(1, { messages: [message('a', 'a'), message('b', 'b')] });
  const next = mergeSnapshot(current, { kind: 'delta', revision: 2, session_id: 'a', messages: [message('b', 'B'), message('c', 'c'), message('c', 'C')] });
  assert.deepEqual(next.messages.map(m => [m.id, m.text]), [['a', 'a'], ['b', 'B'], ['c', 'C']]);
});
test('full snapshots are authoritative and switching session does not leak old messages', () => {
  const current = snapshot(1, { messages: [message('old', 'private')] });
  const next = mergeSnapshot(current, snapshot(2, { session_id: 'b', messages: [message('new', 'new')] }));
  assert.deepEqual(next.messages.map(m => m.id), ['new']);
  assert.deepEqual(mergeSnapshot(next, snapshot(3, { session_id: 'b', messages: [] })).messages, []);
});
test('a delta from a different session is rejected without consuming revision', () => {
  const current = snapshot(10);
  assert.strictEqual(mergeSnapshot(current, { kind: 'delta', revision: 11, session_id: 'b', messages: [message('foreign', 'x')] }), current);
  assert.equal(mergeSnapshot(current, snapshot(11, { session_id: 'b' })).session_id, 'b');
});
test('invalid payloads never overwrite valid state', () => {
  const current = snapshot();
  for (const bad of [null, {}, snapshot(NaN), snapshot(Infinity), snapshot(2.5), snapshot(2, { messages: [{ id: 'a', role: 'script', text: 'x' }] }), snapshot(2, { connected: 'true' }), snapshot(2, { sessions: [{}] }), { kind: 'delta', revision: 2, messages: [] }]) {
    assert.strictEqual(mergeSnapshot(current, bad), current);
  }
});
test('snapshot deduplication clones input and preserves text verbatim, including hostile markup', () => {
  const hostile = '<img src=x onerror=alert(1)><script>x</script>';
  const incoming = snapshot(2, { messages: [message('m', 'old'), message('m', hostile)] });
  const next = mergeSnapshot(snapshot(), incoming);
  assert.equal(next.messages.length, 1);
  assert.equal(next.messages[0].text, hostile);
  incoming.messages[1].text = 'mutated';
  assert.equal(next.messages[0].text, hostile);
});
test('send gate blocks disconnected, running, waiting, missing session, empty and pending states', () => {
  assert.equal(canSend(snapshot(), '你好'), true);
  for (const patch of [{ enabled: false }, { connected: false }, { running: true }, { waiting: true }, { session_id: null }, { phase: 'sending' }, { phase: 'cancelling' }]) assert.equal(canSend(snapshot(1, patch), '你好'), false);
  assert.equal(canSend(snapshot(), '  ' ), false);
  assert.equal(canSend(snapshot(), 'hi', true), false);
});
test('status labels distinguish disabled, disconnected, waiting, running and idle', () => {
  assert.equal(statusLabel(initialSnapshot()), '连接中');
  for (const [patch, label] of [[{ enabled: false }, '待启用'], [{ connected: false }, '连接已断开'], [{ waiting: true }, '等待你的确认'], [{ running: true }, '正在思考'], [{ phase: 'error' }, '需要重试'], [{}, '随时聊聊']]) assert.equal(statusLabel(snapshot(1, patch)), label);
});
test('drag threshold is Euclidean and tiny pointer jitter is still a click', () => {
  assert.equal(movedBeyondThreshold(3, 4, 0, 0), false);
  assert.equal(movedBeyondThreshold(6, 0, 0, 0), true);
  assert.equal(movedBeyondThreshold(-4, -5, 0, 0), true);
});
