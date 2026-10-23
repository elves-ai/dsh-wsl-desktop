import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/assistant-markdown.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { parseInline, parseMarkdown, renderMarkdown } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const backtick = String.fromCharCode(96);
const fence = backtick.repeat(3);
test('paragraphs, line breaks and mixed list types parse without executing HTML', () => {
  assert.deepEqual(parseMarkdown('你好\r\n世界\n\n- 第一项\n- 第二项\n\n1. 有序项'), [
    { type: 'paragraph', text: '你好\n世界' },
    { type: 'list', ordered: false, items: ['第一项', '第二项'] },
    { type: 'list', ordered: true, items: ['有序项'] },
  ]);
});
test('bold and inline code parse while unclosed streaming delimiters remain literal', () => {
  assert.deepEqual(parseInline('这是**重点**和' + backtick + 'code' + backtick), [
    { type: 'text', text: '这是' }, { type: 'strong', text: '重点' }, { type: 'text', text: '和' }, { type: 'code', text: 'code' },
  ]);
  assert.equal(parseInline('**未完成').map(p => p.text).join(''), '**未完成');
});
test('code fences preserve exact text including hostile markup and incomplete streaming fences', () => {
  const text = '<script>alert(1)</script>\n**not bold**';
  assert.deepEqual(parseMarkdown(fence + 'html\n' + text + '\n' + fence), [{ type: 'code', text }]);
  assert.deepEqual(parseMarkdown(fence + '\n' + text), [{ type: 'code', text }]);
});
test('renderer creates only allowlisted elements, never links, images, raw HTML or attributes', () => {
  const nodes = [];
  const make = tag => { const node = { tag, textContent: '', children: [], append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; } }; nodes.push(node); return node; };
  const doc = { createElement: make, createDocumentFragment: () => make('fragment') };
  const root = make('root');
  const hostile = '<img src=x onerror=alert(1)> [点此](javascript:alert(1)) https://example.com';
  renderMarkdown(root, hostile + '\n\n**加粗**\n\n- 列表\n\n' + fence + '\n<script>x</script>\n' + fence, doc);
  assert.equal(nodes.every(n => ['root', 'fragment', 'p', 'span', 'strong', 'code', 'pre', 'ul', 'ol', 'li'].includes(n.tag)), true);
  assert.equal(nodes.some(n => n.textContent === hostile), true);
  assert.equal(nodes.some(n => n.textContent === '<script>x</script>'), true);
  assert.equal(/innerHTML|setAttribute|href\s*=/.test(source), false);
});
