import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const css = read('src/assistant.css');
const tokens = read('src/ui-tokens.css');
const notifications = read('src/pet/notifications.css');
const interactions = read('src/pet/interactions.css');
const host = read('src/assistant.ts');
const layout = read('src/pet/bubble-positioner.ts');

test('pet surfaces share neutral tokens instead of independent gradient themes', () => {
  assert.ok(tokens.includes('.pet-shell, .pet-menu, .pet-notifications, .pet-interactions {'));
  const speech = css.slice(css.indexOf('.pet-dialogue {'));
  for (const styles of [speech, notifications, interactions]) {
    assert.ok(styles.includes('var(--ui-bg'));
    assert.ok(styles.includes('var(--ui-border'));
    assert.ok(styles.includes('var(--ui-font'));
    assert.doesNotMatch(styles, /linear-gradient|backdrop-filter|font-size: 9px/);
  }
});

test('speech and composer preserve readable text and keyboard focus with bounded scroll', () => {
  assert.match(css, /\.pet-speech-text \{[^}]*overflow-wrap: anywhere[^}]*line-height: 20px[^}]*font-size: 12px/);
  assert.ok(css.includes('.pet-dialogue[data-expanded=true] .pet-speech-text { display: block; overflow: auto;'));
  assert.match(css, /\.pet-composer #draft \{[^}]*min-height: 36px[^}]*height: auto[^}]*max-height: 72px[^}]*overflow-y: auto/);
  assert.match(css, /\.pet-composer #draft-hint \{[^}]*font-size: 11px; line-height: 16px/);
  assert.ok(css.includes('.pet-composer #draft:focus-visible { outline: 2px solid var(--ui-accent)'));
  assert.doesNotMatch(css, /outline: none !important/);
  assert.ok(host.includes('aria-controls="pet-speech-text"'));
  assert.ok(layout.includes('text.scrollHeight > text.clientHeight + 1'));
  assert.ok(layout.includes("text.setAttribute('tabindex', '0')"));
});

test('confirmation keeps full body scrollable with accessible keyboard entry and fixed actions', () => {
  const source = read('src/pet/interactions.ts');
  assert.ok(source.includes("scroll.setAttribute('aria-label', '请求正文')"));
  assert.ok(source.includes('scroll.tabIndex = 0'));
  assert.match(interactions, /\.pet-interactions-scroll \{[^}]*min-height: 0[^}]*overflow: auto/);
  assert.match(interactions, /\.pet-interactions-footer \{[^}]*flex-shrink: 0/);
  assert.match(interactions, /\.pet-interactions-actions \{[^}]*flex-wrap: wrap/);
  assert.ok(interactions.includes('.pet-interactions-scroll:focus-visible'));
  assert.doesNotMatch(interactions, /line-clamp/);
});
