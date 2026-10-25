import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/assistant.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/assistant.css', import.meta.url), 'utf8');
const root = {};
vm.runInNewContext(source.slice(source.indexOf('const face ='), source.indexOf('function el<')), { root, view: 'pet' });
const menu = root.innerHTML.match(/<section id="pet-menu"[\s\S]*?<\/section>/)[0];
const ast = ts.createSourceFile('assistant.ts', source, ts.ScriptTarget.Latest, true);
const render = name => ts.transpileModule(ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === name).getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

// Parse the evaluated HTML, not the source literal: template delimiters and
// concatenation must not hide visible text between rows. JSX shares this markup's
// element/text structure once HTML's void separators are made self-closing.
function unexpectedMenuText(markup) {
  const parsed = ts.createSourceFile('pet-menu.tsx', markup.replace(/<hr\b([^>]*)>/g, '<hr$1 />'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.deepEqual(parsed.parseDiagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
  const element = parsed.statements[0].expression;
  assert.ok(ts.isJsxElement(element));
  return element.children
    .filter(node => !ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node))
    .map(node => ts.isJsxText(node) ? node.text : node.getText(parsed))
    .filter(text => text.trim());
}

// Unlike the integration mock, these nodes reject destructive textContent writes:
// SVG icons and the stable label must survive every async state render.
function toggleNode() {
  return {
    attributes: new Map(), disabled: false, title: '',
    set textContent(_) { throw new Error('Toggle render replaced its icon and stable label'); },
    setAttribute(key, value) { this.attributes.set(key, String(value)); },
    removeAttribute(key) { this.attributes.delete(key); },
    getAttribute(key) { return this.attributes.get(key); },
  };
}

test('pet menu groups existing actions, exposes an action submenu and uses uniform decorative line icons', () => {
  const groups = menu.split('<hr class="pet-menu-separator">');
  assert.equal(groups.length, 3);
  const actions = group => [...group.matchAll(/data-(?:pet-command|action)="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(actions(groups[0]), ['close-menu','talk','replay','toggle_chat','open_dsh']);
  assert.deepEqual(actions(groups[1]), ['auto-read','slingshot','topmost']);
  assert.deepEqual(actions(groups[2]), ['pet_settings','hide']);
  assert.ok(groups[1].includes('aria-haspopup="menu" aria-controls="pet-animation" aria-expanded="false"'));
  assert.ok(root.innerHTML.includes('id="pet-animation" class="pet-menu pet-submenu" role="menu"'));
  assert.doesNotMatch(menu, /<select/);
  assert.ok(menu.includes('class="pet-menu-label">自动朗读</span>'));
  assert.ok(menu.includes('class="pet-menu-label">窗口置顶</span>'));
  const icons = [...menu.matchAll(/<svg [^>]*>/g)];
  assert.equal(icons.length, 12); // Ten action rows, close, submenu chevron.
  for (const [icon] of icons) {
    for (const attribute of ['viewBox="0 0 24 24"','stroke-width="1.5"','stroke-linecap="round"','aria-hidden="true"','focusable="false"']) assert.ok(icon.includes(attribute));
  }
});

test('evaluated menu markup contains only whitespace text nodes between menu elements', () => {
  assert.deepEqual(unexpectedMenuText(menu), [], 'stray text becomes visible punctuation or extra menu rows');
});

test('menu text regression guard rejects punctuation and words at every row boundary', () => {
  // Cover header/button, button/button, button/separator and separator/button gaps.
  const boundaries = [...menu.matchAll(/(?:<\/header>|<\/button>|<hr\b[^>]*>)(\s*)(?=<(?:button|hr)\b)/g)];
  assert.ok(boundaries.length >= 10, 'must exercise the actual evaluated menu rows');
  for (const boundary of boundaries) {
    const offset = boundary.index + boundary[0].length;
    const prefix = menu.slice(0, offset);
    const suffix = menu.slice(offset);
    assert.deepEqual(unexpectedMenuText(`${prefix} \t\n${suffix}`), []);
    for (const stray of ["'\n'", '.', 'unexpected text', '。', '{stray}']) {
      assert.deepEqual(unexpectedMenuText(`${prefix}${stray}${suffix}`).map(text => text.trim()), [stray]);
    }
  }
});

test('menu styles import shared tokens and constrain dimensions without moving the pet', () => {
  assert.ok(css.includes('@import "./ui-tokens.css"'));
  const panel = css.match(/\.pet-menu \{([^}]+)\}/)[1];
  for (const rule of ['width: 196px', 'max-height: calc(100% - 12px)', 'overflow: auto', 'background: var(--ui-bg)', 'font: 12px/18px var(--ui-font)']) assert.ok(panel.includes(rule), rule);
  assert.doesNotMatch(panel, /gradient|backdrop-filter|transform/);
  assert.match(css, /\.pet-menu > button, \.pet-submenu \[role="menuitem"\] \{[^}]*height: 26px/);
  assert.ok(css.includes('.pet-menu:not(.pet-submenu) > button { height: 24px; }'));
  assert.match(css, /\.pet-menu-icon \{[^}]*width: 16px; height: 16px/);
  assert.ok(css.includes(`.pet-menu [aria-checked="true"] .pet-menu-indicator::after { content: '开'; }`));
  assert.ok(css.includes(`.pet-menu [aria-checked="false"] .pet-menu-indicator::after { content: '关'; }`));
  assert.doesNotMatch(menu, /pet-menu-indicator[^>]*><svg/);
  assert.ok(css.includes('.pet-menu button:focus-visible { outline: 2px solid var(--ui-accent)'));
  assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'));
  assert.ok(css.includes("content: '保存失败'"), 'save failure remains visible alongside the stable label');
});

test('topmost keeps stable children and distinguishes unknown, pending, checked and unavailable states', () => {
  const button = toggleNode();
  const context = vm.createContext({ disposed: false, native: true, petTopmostPending: false, petTopmost: undefined, el: () => button });
  vm.runInContext(render('renderPetTopmost'), context);
  context.renderPetTopmost();
  assert.equal(button.getAttribute('aria-checked'), undefined);
  assert.equal(button.getAttribute('data-state'), 'unknown');
  assert.match(button.getAttribute('aria-description'), /重新读取/);
  context.petTopmost = true;
  context.petTopmostPending = true;
  context.renderPetTopmost();
  assert.equal(button.getAttribute('aria-checked'), 'true');
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(button.disabled, true);
  context.petTopmostPending = false;
  context.petTopmost = false;
  context.renderPetTopmost();
  assert.equal(button.getAttribute('aria-checked'), 'false');
  assert.equal(button.disabled, false);
  context.native = false;
  context.renderPetTopmost();
  assert.equal(button.getAttribute('data-state'), 'unavailable');
  assert.equal(button.disabled, true);
});

test('slingshot preserves its icon and label across unknown, pending, checked and preview states', () => {
  const button = toggleNode();
  const context = vm.createContext({ disposed: false, native: true, slingshotPending: false, slingshotKnown: false, slingshotEnabled: false, el: () => button });
  vm.runInContext(render('renderPetSlingshot'), context);
  context.renderPetSlingshot();
  assert.equal(button.getAttribute('data-state'), 'unknown');
  assert.equal(button.getAttribute('aria-checked'), undefined);
  assert.match(button.getAttribute('aria-description'), /重新读取/);
  context.slingshotKnown = true; context.slingshotEnabled = true;
  context.renderPetSlingshot();
  assert.equal(button.getAttribute('aria-checked'), 'true');
  context.slingshotPending = true; context.renderPetSlingshot();
  assert.equal(button.disabled, true); assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(button.getAttribute('aria-checked'), 'true');
  context.slingshotPending = false; context.slingshotEnabled = false; context.renderPetSlingshot();
  assert.equal(button.disabled, false); assert.equal(button.getAttribute('aria-checked'), 'false');
  context.native = false; context.renderPetSlingshot();
  assert.equal(button.disabled, true); assert.equal(button.getAttribute('data-state'), 'unavailable');
  assert.match(menu, /id="pet-slingshot"[^>]+role="switch"[^>]+aria-label="允许弹弓"/);
});

test('auto-read retains confirmed check state and stable children through save failures and pending states', () => {
  const button = toggleNode();
  const context = vm.createContext({
    view: 'pet', disposed: false, narrationState: { phase: 'idle', supported: true, error: '' },
    root: { dataset: {} }, autoRead: false, speechPreferences: {}, unlistenSpeechPreferences: () => {},
    speechPreferencesPending: false, autoReadSaveFailed: false, narrationNote: '',
    el: id => id === 'pet-auto-read' ? button : null, scheduleHitRegions() {},
  });
  vm.runInContext(render('renderPetNarration'), context);
  context.renderPetNarration();
  assert.equal(button.getAttribute('aria-checked'), 'false');
  context.speechPreferencesPending = true;
  context.renderPetNarration();
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(button.getAttribute('aria-checked'), 'false');
  context.speechPreferencesPending = false;
  context.autoReadSaveFailed = true;
  context.renderPetNarration();
  assert.equal(button.getAttribute('data-state'), 'error');
  assert.match(button.getAttribute('aria-description'), /保存失败，请重试/);
  assert.equal(button.getAttribute('aria-checked'), 'false');
  context.autoReadSaveFailed = false;
  context.autoRead = true;
  context.renderPetNarration();
  assert.equal(button.getAttribute('aria-checked'), 'true');
  context.narrationState.supported = false;
  context.renderPetNarration();
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('data-state'), 'unavailable');
});
