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

test('pet menu groups existing actions, preserves native select and uses uniform decorative line icons', () => {
  const groups = menu.split('<hr class="pet-menu-separator">');
  assert.equal(groups.length, 3);
  const actions = group => [...group.matchAll(/data-(?:pet-command|action)="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(actions(groups[0]), ['close-menu','talk','replay','toggle_chat','open_dsh']);
  assert.deepEqual(actions(groups[1]), ['auto-read','topmost']);
  assert.deepEqual(actions(groups[2]), ['pet_settings','hide']);
  assert.ok(groups[1].includes('<select id="pet-animation" aria-label="选择宠物动作"></select>'));
  assert.ok(menu.includes('class="pet-menu-label">自动朗读</span>'));
  assert.ok(menu.includes('class="pet-menu-label">窗口置顶</span>'));
  const icons = [...menu.matchAll(/<svg [^>]*>/g)];
  assert.equal(icons.length, 12); // Nine action rows, close, two checkmarks.
  for (const [icon] of icons) {
    for (const attribute of ['viewBox="0 0 24 24"','stroke-width="1.5"','stroke-linecap="round"','aria-hidden="true"','focusable="false"']) assert.ok(icon.includes(attribute));
  }
});

test('menu styles import shared tokens and constrain dimensions without moving the pet', () => {
  assert.ok(css.includes('@import "./ui-tokens.css"'));
  const panel = css.match(/\.pet-menu \{([^}]+)\}/)[1];
  for (const rule of ['width: 196px', 'max-height: calc(100% - 12px)', 'overflow: auto', 'background: var(--ui-bg)', 'font: 12px/18px var(--ui-font)']) assert.ok(panel.includes(rule), rule);
  assert.doesNotMatch(panel, /gradient|backdrop-filter|transform/);
  assert.match(css, /\.pet-menu > button, \.pet-menu-animation \{[^}]*height: 26px/);
  assert.match(css, /\.pet-menu-icon \{[^}]*width: 16px; height: 16px/);
  assert.ok(css.includes('.pet-menu [aria-checked="true"] .pet-menu-indicator > svg { visibility: visible'));
  assert.ok(css.includes('.pet-menu button:focus-visible, .pet-menu select:focus-visible { outline: 2px solid var(--ui-accent)'));
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
