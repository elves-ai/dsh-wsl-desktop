import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setMaxListeners } from 'node:events';
import ts from 'typescript';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const source = read('src/pet-memory.ts');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { PetMemory, isPetMemorySnapshot } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const entry = (extra = {}) => ({ id: 'm1', kind: 'preference', content: '喜欢无糖茶', source_session_id: 'session-first', updated_at: '2026-10-25T06:00:00Z', ...extra });
const snapshot = (extra = {}) => ({ available: true, enabled: false, runtime_ready: true, pet_id: 'pet-one', name: '小鱼', persona: '温和简洁', entries: [entry()], total: 1, next_offset: null, message: null, mode: 'explicit', ...extra });
class Node extends EventTarget {
  constructor(doc) { super(); this.ownerDocument = doc; this.children = []; this.value = ''; this.textContent = ''; this.checked = false; this.disabled = false; this.hidden = false; this.dataset = {}; this.attributes = {}; }
  addEventListener(type, fn, options) { if (options?.signal) setMaxListeners(0, options.signal); super.addEventListener(type, fn, options); }
  setAttribute(key, value) { this.attributes[key] = value; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  focus() { this.ownerDocument.activeElement = this; }
}
function fixture({ native = true, invoke = () => snapshot() } = {}) {
  const doc = { createElement() { return new Node(doc); } }, root = new Node(doc), nodes = new Map(), calls = [];
  let markup = '', htmlWrites = 0;
  Object.defineProperty(root, 'innerHTML', { set(html) { markup = html; htmlWrites++; for (const m of html.matchAll(/id="(pet-memory-[^"]+)"/g)) nodes.set(m[1], new Node(doc)); } });
  root.querySelector = selector => nodes.get(selector.slice(1));
  const memory = new PetMemory(root, native, { async invoke(...args) { calls.push(args); return invoke(...args); } });
  const node = id => nodes.get('pet-memory-' + id);
  return { memory, root, doc, calls, node, get markup() { return markup; }, get htmlWrites() { return htmlWrites; }, click(id) { node(id).dispatchEvent(new Event('click')); }, fill(id, value) { node(id).value = value; node(id).dispatchEvent(new Event('input')); }, toggle(value) { node('enabled').checked = value; node('enabled').dispatchEvent(new Event('change')); }, row(index = 0) { return node('list').children[index]; }, rowAction(index, action) { node('list').children[index].children[2].children[action].dispatchEvent(new Event('click')); }, show() { memory.setVisible(true); }, hide() { memory.setVisible(false); } };
}

test('default-off consent, user-owned persona and privacy disclosures omit internal knobs', () => {
  const f = fixture({ native: false });
  assert.match(f.markup, /默认关闭/); assert.match(f.markup, /会随桌宠对话发送给当前 DSH 模型/);
  assert.match(f.markup, /停止对话中的记忆读取与写入，不删除已保存内容/);
  assert.match(f.markup, /不删除原始 DSH 对话历史；旧会话仍可能保留原文/);
  assert.match(f.markup, /仅从你明确说的“记住：…”/); assert.match(f.markup, /不额外调用后台模型/);
  for (const [id, limit] of [['name', 40], ['tone', 240], ['content', 1000]]) assert.match(f.markup, new RegExp('id="pet-memory-' + id + '"[^>]*maxlength="' + limit + '"'));
  assert.doesNotMatch(f.markup, /token|top.?k|embedding|向量|检索预算/i);
  assert.equal(f.node('enabled').checked, false); f.memory.dispose();
});

test('preview, hidden, unavailable and disposed views cannot write or claim enabled', async () => {
  for (const native of [false, true]) {
    const f = fixture({ native, invoke: () => snapshot({ available: false, enabled: true, message: '需安装 desktop-pet preset' }) });
    f.toggle(true); f.click('add'); f.click('refresh'); assert.equal(f.calls.length, 0);
    f.show(); await tick(); assert.equal(f.node('enabled').checked, false); assert.equal(f.node('add').disabled, true);
    assert.doesNotMatch(f.node('status').textContent, /^已启用/);
    const count = f.calls.length; f.toggle(true); f.click('add'); f.click('confirm-delete'); f.click('search-button'); await tick(); assert.equal(f.calls.length, count);
    f.memory.dispose(); f.show(); f.click('refresh'); await tick(); assert.equal(f.calls.length, count);
  }
});

test('malformed, oversized and duplicate snapshots fail closed', async () => {
  const invalid = [null, {}, snapshot({ available: 'yes' }), snapshot({ enabled: 1 }), snapshot({ runtime_ready: 'yes' }), snapshot({ pet_id: '' }), snapshot({ name: 'x'.repeat(41) }), snapshot({ persona: 'x'.repeat(241) }), snapshot({ entries: [entry({ content: 'x'.repeat(1001) })] }), snapshot({ entries: [entry(), entry()] }), snapshot({ entries: [null] }), snapshot({ entries: [entry({ source_session_id: {} })] }), snapshot({ total: -1 }), snapshot({ next_offset: -1 }), snapshot({ entries: Array.from({ length: 11 }, (_, i) => entry({ id: String(i) })), total: 11 }), snapshot({ total: 0 })];
  for (const reply of invalid) {
    assert.equal(isPetMemorySnapshot(reply), false);
    const f = fixture({ invoke: () => reply }); f.show(); await tick(); assert.equal(f.node('add').disabled, true); assert.match(f.node('message').textContent, /无法读取/); f.memory.dispose();
  }
  assert.equal(isPetMemorySnapshot(snapshot()), true);
});

test('toggle waits for backend confirmation and distinguishes preset readiness from saved consent', async () => {
  const change = deferred(); const f = fixture({ invoke: command => command === 'pet_memory_action' ? change.promise : snapshot() });
  f.show(); await tick(); assert.equal(f.node('enabled').checked, false);
  f.toggle(true); assert.equal(f.node('enabled').checked, false); assert.equal(f.node('enabled').disabled, true);
  f.toggle(true); assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls.at(-1), ['pet_memory_action', { request: { action: 'set_enabled', enabled: true } }]);
  change.resolve(snapshot({ enabled: true, runtime_ready: false, message: '需安装 desktop-pet preset' })); await tick();
  assert.equal(f.node('enabled').checked, true); assert.match(f.node('status').textContent, /尚未确认对话接入生效/); assert.doesNotMatch(f.node('status').textContent, /^已启用/); f.memory.dispose();
  for (const runtime_ready of [undefined, true]) {
    const g = fixture({ invoke: () => snapshot({ enabled: true, runtime_ready }) }); g.show(); await tick();
    assert.equal(g.node('status').textContent.startsWith('已启用'), runtime_ready === true); g.memory.dispose();
  }
});

test('disabled memory allows explicit persona edits and manual additions without enabling it', async () => {
  const f = fixture(); f.show(); await tick(); assert.equal(f.node('add').disabled, false);
  f.fill('name', '  团团  '); f.fill('tone', '  简短友好  '); f.click('save-persona'); await tick();
  assert.deepEqual(f.calls.at(-1), ['pet_memory_action', { request: { action: 'update_persona', name: '团团', persona: '简短友好' } }]);
  f.click('add'); assert.equal(f.node('editor').hidden, false); f.fill('content', '  喜欢绿茶  '); f.node('kind').value = 'preference'; f.click('save-entry'); await tick();
  assert.deepEqual(f.calls.at(-1), ['pet_memory_action', { request: { action: 'add', kind: 'preference', content: '喜欢绿茶' } }]);
  assert.equal(f.node('enabled').checked, false); assert.equal(f.node('editor').hidden, true); f.memory.dispose();
});

test('blank and overlong programmatic inputs do not bypass browser maxLength', async () => {
  const f = fixture(); f.show(); await tick();
  for (const value of ['', 'x'.repeat(41)]) { f.fill('name', value); f.click('save-persona'); await tick(); }
  f.fill('name', '小鱼'); f.fill('tone', 'x'.repeat(241)); f.click('save-persona'); await tick();
  f.click('add'); for (const value of ['  ', 'x'.repeat(1001)]) { f.fill('content', value); f.click('save-entry'); await tick(); }
  f.fill('search', 'x'.repeat(201)); f.click('search-button'); await tick(); assert.equal(f.calls.length, 1); f.memory.dispose();
});

test('server search and bounded pagination retain query and display provenance, then reset after mutation', async () => {
  const f = fixture({ invoke: (command, args) => args?.request.action === 'list' ? snapshot({ entries: [entry({ id: 'paged', source_session_id: 'session-second' })], total: 21, next_offset: args.request.offset ? null : 10 }) : snapshot({ total: 30, next_offset: 10 }) });
  f.show(); await tick(); assert.equal(f.node('next').disabled, false); assert.equal(f.node('first').disabled, true);
  f.fill('search', ' 无糖茶 '); assert.equal(f.calls.length, 1); f.click('search-button'); await tick();
  assert.deepEqual(f.calls.at(-1), ['pet_memory_action', { request: { action: 'list', offset: 0, query: '无糖茶' } }]); assert.match(f.node('count').textContent, /搜索结果共 21 条/); assert.match(f.row().children[1].textContent, /来源会话：session-second/);
  f.click('next'); await tick(); assert.deepEqual(f.calls.at(-1)[1].request, { action: 'list', offset: 10, query: '无糖茶' }); assert.equal(f.node('list').children.length, 1); assert.equal(f.node('next').disabled, true); assert.equal(f.node('first').disabled, false);
  f.click('first'); await tick(); assert.deepEqual(f.calls.at(-1)[1].request, { action: 'list', offset: 0, query: '无糖茶' });
  f.click('add'); f.fill('content', '新记录'); f.click('save-entry'); await tick(); assert.equal(f.node('search').value, ''); assert.match(f.node('count').textContent, /全部共 30 条/); f.memory.dispose();
});

test('empty search is recoverable and clear still refers to all records, not only matches', async () => {
  const f = fixture({ invoke: (command, args) => args?.request.action === 'list' ? snapshot({ entries: [], total: 0 }) : snapshot() });
  f.show(); await tick(); f.fill('search', '不存在'); f.click('search-button'); await tick(); assert.match(f.node('count').textContent, /没有匹配结果/); assert.equal(f.node('clear').disabled, false);
  f.click('clear'); assert.match(f.node('confirm-text').textContent, /全部长期记忆/); assert.match(f.node('confirm-text').textContent, /搜索或当前页未显示/); assert.equal(f.calls.length, 2); f.memory.dispose();
});

test('correction uses selected ID and does not mutate persona or provenance', async () => {
  const f = fixture(); f.show(); await tick(); f.rowAction(0, 0);
  assert.equal(f.node('content').value, '喜欢无糖茶'); assert.equal(f.node('kind').disabled, true);
  f.fill('content', '现在更喜欢白茶'); f.click('save-entry'); await tick();
  assert.deepEqual(f.calls.at(-1), ['pet_memory_action', { request: { action: 'correct', id: 'm1', content: '现在更喜欢白茶' } }]); assert.equal(f.node('name').value, '小鱼'); f.memory.dispose();
});

test('single forget and clear require explicit cancellable confirmations, without persona reset', async () => {
  const f = fixture(); f.show(); await tick(); f.rowAction(0, 1);
  assert.equal(f.calls.length, 1); assert.equal(f.node('confirm').hidden, false); assert.match(f.node('confirm-text').textContent, /喜欢无糖茶/);
  assert.equal(f.doc.activeElement, f.node('cancel-delete')); f.click('cancel-delete'); f.click('confirm-delete'); await tick(); assert.equal(f.calls.length, 1);
  f.rowAction(0, 1); f.click('confirm-delete'); await tick(); assert.deepEqual(f.calls.at(-1), ['pet_memory_action', { request: { action: 'forget', id: 'm1', confirm: true } }]);
  f.click('clear'); assert.match(f.node('confirm-text').textContent, /不会重置名字和语气/); f.click('confirm-delete'); await tick(); assert.deepEqual(f.calls.at(-1), ['pet_memory_action', { request: { action: 'clear', confirm: true } }]); f.memory.dispose();
});

test('failed writes preserve drafts and require reading uncertain outcome before explicit retry', async () => {
  let fail = true; const f = fixture({ invoke: command => { if (command === 'pet_memory_action' && fail) throw '<img src=x onerror=alert(1)>'; return snapshot(); } });
  f.show(); await tick(); f.fill('name', '我的名字'); f.click('add'); f.fill('content', '手动草稿'); f.click('save-entry'); await tick();
  assert.match(f.node('message').textContent, /操作结果未确认/); assert.match(f.node('message').textContent, /避免重复新增/); assert.equal(f.node('add').disabled, true); assert.equal(f.node('content').value, '手动草稿'); assert.equal(f.node('name').value, '我的名字');
  const count = f.calls.length; f.click('save-entry'); await tick(); assert.equal(f.calls.length, count);
  fail = false; f.click('refresh'); await tick(); assert.equal(f.node('content').value, '手动草稿'); assert.equal(f.node('name').value, '我的名字');
  f.click('save-entry'); await tick(); assert.equal(f.node('editor').hidden, true); f.memory.dispose();
});

test('read failure and unavailable backend recover without stale enabled indicators', async () => {
  let reply = () => { throw new Error('WSL 不可用'); }; const f = fixture({ invoke: () => reply() }); f.show(); await tick(); assert.equal(f.node('enabled').checked, false); assert.equal(f.node('refresh').disabled, false);
  reply = () => snapshot({ available: false, enabled: true, message: '请安装扩展' }); f.click('refresh'); await tick(); assert.equal(f.node('enabled').checked, false); assert.equal(f.node('add').disabled, true);
  reply = () => snapshot({ enabled: true }); f.click('refresh'); await tick(); assert.equal(f.node('enabled').checked, true); assert.equal(f.node('add').disabled, false); f.memory.dispose();
});

test('pending operations deduplicate, serialize re-entry and ignore stale replies or disposal', async () => {
  const old = deferred(); let n = 0; const f = fixture({ invoke: () => ++n === 1 ? old.promise : snapshot({ name: '新状态' }) });
  f.show(); f.click('refresh'); assert.equal(f.calls.length, 1); f.hide(); f.show(); assert.equal(f.calls.length, 1);
  old.resolve(snapshot({ name: '旧状态', enabled: true })); await tick(); assert.equal(f.calls.length, 2); assert.equal(f.node('name').value, '新状态'); assert.equal(f.node('enabled').checked, false);
  const write = deferred(); const g = fixture({ invoke: command => command === 'pet_memory_action' ? write.promise : snapshot() }); g.show(); await tick(); g.toggle(true); g.toggle(true); g.click('add'); assert.equal(g.calls.length, 2);
  g.memory.dispose(); write.resolve(snapshot({ enabled: true })); await tick(); assert.equal(g.node('enabled').checked, false); assert.equal(g.node('add').disabled, true); f.memory.dispose();
});

test('identity changes discard old identity drafts and destructive confirmations', async () => {
  let pet_id = 'first'; const f = fixture({ invoke: () => snapshot({ pet_id }) }); f.show(); await tick(); f.fill('name', 'old draft'); f.click('add'); f.fill('content', 'old entry draft'); f.click('clear');
  pet_id = 'second'; f.hide(); f.show(); await tick(); assert.equal(f.node('name').value, '小鱼'); assert.equal(f.node('content').value, ''); assert.equal(f.node('editor').hidden, true); assert.equal(f.node('confirm').hidden, true);
  const count = f.calls.length; f.click('confirm-delete'); await tick(); assert.equal(f.calls.length, count); f.memory.dispose();
});

test('untrusted content, names, provenance and error messages render only as plain text or field values', async () => {
  const payload = '<img src=x onerror=alert(1)>'; const f = fixture({ invoke: () => snapshot({ name: payload, persona: payload, message: payload, entries: [entry({ content: payload, source_session_id: payload, updated_at: payload })] }) });
  f.show(); await tick(); assert.equal(f.node('name').value, payload); assert.equal(f.node('tone').value, payload); assert.equal(f.node('message').textContent, payload); assert.equal(f.row().children[0].textContent, payload); assert.ok(f.row().children[1].textContent.includes(payload));
  f.rowAction(0, 1); assert.ok(f.node('confirm-text').textContent.includes(payload)); assert.equal(f.htmlWrites, 1);
  assert.equal((source.match(/innerHTML\s*=/g) || []).length, 1); assert.match(source, /root.innerHTML = markup/); assert.doesNotMatch(source, /insertAdjacentHTML|outerHTML|eval\(/); f.memory.dispose();
});

test('memory mounts only within revealed pet settings and follows visibility/disposal hooks', () => {
  const main = read('src/main.ts'); assert.match(main, /new PetMemory\(document.getElementById\('settings-pet-memory'\)/);
  assert.match(main, /petMemory\?\.setVisible\(selected === 'pet' && !document.hidden && settingsPageRevealed\)/);
  assert.match(main, /petMemory\?\.setVisible\(settingsSection === 'pet' && !document.hidden && settingsPageRevealed\)/); assert.match(main, /petMemory\?\.dispose\(\)/);
});


// Actual PetMemory markup and shared styles, rendered from file:// without an app server.
export function petMemoryVisualFixture() {
  const css = read('src/ui-tokens.css') + '\n' + read('src/style.css').replace(/^@import .*;$/gm, '');
  const script = compiled.replace(/^export /gm, '');
  const data = snapshot({ entries: Array.from({ length: 10 }, (_, i) => entry({ id: 'long-' + i, content: '<img src=x onerror=alert(1)> ' + '很长的中文记忆与偏好'.repeat(50), source_session_id: 'session-' + 'a'.repeat(180) })), total: 25, next_offset: 10 });
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>' + css + '</style><body><main class="settings-shell"><aside class="settings-sidebar"><button class="settings-back">← 返回</button><nav><button class="settings-nav" data-active="true">桌面宠物</button></nav></aside><div class="settings-content"><header class="settings-heading"><h1>桌面宠物</h1><p id="settings-description">管理桌面宠物的显示、人格记忆与本地语音。</p></header><div id="settings-pet-memory" class="setting-group" role="region" aria-label="人格与长期记忆"></div><pre id="visual-result" class="setting-help"></pre></div></main><script>' + script + ';(' + (async function(data) {
    const failures = [], root = document.getElementById('settings-pet-memory'), result = document.getElementById('visual-result');
    try {
      const memory = new PetMemory(root, true, { async invoke() { return data; } }); memory.setVisible(true); await Promise.resolve(); await Promise.resolve();
      const node = id => document.getElementById('pet-memory-' + id);
      if (root.querySelector('img, script')) failures.push('untrusted content became markup');
      if (node('list').children.length !== 10) failures.push('page length differs from backend');
      if (node('enabled').checked) failures.push('default-off unexpectedly checked');
      node('persona').open = true; node('add').click(); node('content').value = '手动记忆草稿'.repeat(60); node('content').dispatchEvent(new Event('input'));
      if (node('content').maxLength !== 1000) failures.push('manual maxLength missing');
      node('clear').click();
      if (node('confirm').hidden || !node('confirm-text').textContent.includes('搜索或当前页未显示')) failures.push('clear confirmation missing');
      if (document.activeElement !== node('cancel-delete')) failures.push('safe cancel focus missing');
      for (const element of root.querySelectorAll('button, input, textarea, select, .pet-memory-confirm, .pet-memory-entry, .pet-memory-heading')) {
        if (!element.getClientRects().length) continue; const r = element.getBoundingClientRect();
        if (r.width <= 0 || r.left < -1 || r.right > innerWidth + 1) failures.push(['horizontal clipping', element.id || element.className, r.left, r.right, innerWidth]);
      }
      const content = document.querySelector('.settings-content');
      if (content.scrollWidth > content.clientWidth + 1) failures.push(['content horizontal overflow', content.scrollWidth, content.clientWidth]);
      node('confirm').scrollIntoView({ block: 'center' }); const confirm = node('confirm-delete').getBoundingClientRect();
      if (confirm.top < 0 || confirm.bottom > innerHeight) failures.push(['confirmation inaccessible', confirm.top, confirm.bottom, innerHeight]);
      result.textContent = JSON.stringify({ failures, width: innerWidth, height: innerHeight, pageEntries: node('list').children.length }); result.dataset.passed = String(failures.length === 0); content.scrollTop = 0;
    } catch(error) { result.textContent = JSON.stringify({ failures: [String(error)] }); result.dataset.passed = 'false'; }
  }).toString() + ')(' + JSON.stringify(data).replaceAll('<', '\u003c') + ');</script></body></html>';
}

test('real HTML memory settings fit narrow/wide windows, long content and destructive confirmation', { timeout: 30000 }, async t => {
  if (process.env.PET_MEMORY_NO_BROWSER === '1') { t.skip('Browser verification delegated to Agent Window'); return; }
  const { existsSync } = await import('node:fs');
  const chrome = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(path => path && existsSync(path));
  if (!chrome) { t.skip('Chrome/Chromium not installed'); return; }
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join, resolve } = await import('node:path');
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util'); const temp = await mkdtemp(join(tmpdir(), 'dsh-memory-visual-'));
  try {
    // An iframe gives a real 360px CSS viewport even when headless Chrome clamps window width.
    const inner = petMemoryVisualFixture().replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    for (const width of [360, 560, 960]) {
      const fixture = join(temp, 'memory-settings-' + width + '.html');
      const wrapper = '<!doctype html><style>body{margin:0}iframe{border:0;display:block}</style><iframe id="visual-frame" width="' + width + '" height="900" srcdoc="' + inner + '"></iframe><pre id="visual-result"></pre><script>window.addEventListener("load",()=>{const r=document.getElementById("visual-frame").contentDocument.getElementById("visual-result");const out=document.getElementById("visual-result");out.textContent=r.textContent;out.dataset.passed=String(r.dataset.passed==="true" && JSON.parse(r.textContent).width===' + width + ');});</script>';
      await writeFile(fixture, wrapper);
      const { stdout } = await promisify(execFile)(chrome, ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-dev-shm-usage', '--allow-file-access-from-files', '--window-size=1000,1000', '--virtual-time-budget=1000', '--user-data-dir=' + join(temp, 'profile-' + width), '--dump-dom', 'file://' + fixture], { timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
      assert.match(stdout, /id="visual-result"[^>]*data-passed="true"/, 'Width ' + width + ': ' + (stdout.match(/<pre id="visual-result"[\s\S]*?<\/pre>/)?.[0] ?? stdout.slice(-1200)));
    }
  } finally {
    const cleanupTarget = resolve(temp);
    assert.ok(cleanupTarget.startsWith(join(resolve(tmpdir()), 'dsh-memory-visual-')), 'Refuse cleanup outside the intended temporary fixture prefix');
    await rm(cleanupTarget, { recursive: true, force: true });
  }
});
