import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/pet/speech.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { PetSpeech, toSpeechText } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const voice = (lang, isDefault = false) => ({ lang, default: isDefault, name: lang });

function browser(initialVoices = [voice('en-US', true), voice('zh-CN')], options = {}) {
  let now = 0, serial = 0;
  const timers = new Map(), listeners = new Set(), spoken = [], states = [];
  const faults = {};
  const synthesis = {
    voices: initialVoices, cancels: 0, reads: 0, onvoiceschanged: null,
    getVoices() { this.reads++; if (faults.voices) throw Error('voices'); return this.voices; },
    speak(utterance) {
      if (faults.speak) throw Error('speak');
      spoken.push(utterance);
      options.speak?.(utterance);
    },
    cancel() { this.cancels++; options.cancel?.(); if (faults.cancel) throw Error('cancel'); },
    addEventListener(type, listener) { assert.equal(type, 'voiceschanged'); listeners.add(listener); if (faults.listen) throw Error('listen'); },
    removeEventListener(type, listener) { assert.equal(type, 'voiceschanged'); listeners.delete(listener); },
  };
  const view = {
    speechSynthesis: synthesis,
    SpeechSynthesisUtterance: class {
      constructor(text) {
        if (faults.construct) throw Error('constructor');
        this.text = text; this.onstart = null; this.onend = null; this.onerror = null;
      }
    },
    setTimeout(callback, delay) { const id = ++serial; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  options.configure?.(view);
  const speech = new PetSpeech({ view, onChange(state) { states.push(state); options.onChange?.(state, speech); } });
  return {
    speech, synthesis, view, timers, listeners, spoken, states, faults,
    voicesChanged() { for (const listener of [...listeners]) listener({}); synthesis.onvoiceschanged?.({}); },
    tick(delay) {
      const until = now + delay;
      let steps = 0;
      while (true) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        assert.ok(++steps < 10000, 'timer loop remains bounded');
        now = due[1].at; timers.delete(due[0]); due[1].callback();
      }
      now = until;
    },
  };
}
const events = utterance => ({ start: utterance.onstart, end: utterance.onend, error: utterance.onerror });
const idle = fixture => {
  assert.equal(fixture.speech.state.phase, 'idle');
  assert.equal(fixture.timers.size, 0);
  assert.equal(fixture.listeners.size, 0);
};

test('narration removes closed and unclosed fenced code without changing display text', () => {
  const markdown = '# 说明\n先说 `secret()` 再说。\n```js\nconst hidden = 1;\n```\n保留。\n~~~python\nprivate()\n~~~\n结尾。';
  const original = markdown;
  assert.equal(toSpeechText(markdown), '说明 先说 再说。 保留。 结尾。');
  assert.equal(markdown, original);
  assert.equal(toSpeechText('前文\n````js\nsecret\n```\nstill secret'), '前文');
  assert.equal(toSpeechText('前文\n~~~\nsecret'), '前文');
  assert.equal(toSpeechText('before ``code ` nested`` after'), 'before after');
  assert.equal(toSpeechText('```js\nsecret'), '');
  assert.equal(toSpeechText('保留\n> ```js\n> secret\n> ```\n结尾'), '保留 结尾');
  assert.equal(toSpeechText('保留\n- ~~~js\n  secret'), '保留');
});

test('Markdown prose and link labels survive while URLs and formatting do not', () => {
  const markdown = [
    '## 标题', '> 引用 **加粗** 和 _强调_ ~~旧词~~', '- [x] 完成', '1. 条目',
    '[帮助](https://example.com/a_(b) "title") [参考][docs] ![图示](image.png)',
    '[docs]: https://example.com/docs', '访问 https://example.com/path。 以及 <https://example.com> www.example.com',
    '| 名称 | 值 |', '| --- | :---: |', '| 内容 | 正文 |', '<b>HTML</b> &amp; 文本', '---',
  ].join('\n');
  assert.equal(toSpeechText(markdown), '标题 引用 加粗 和 强调 旧词 完成 条目 帮助 参考 图示 访问 。 以及 名称 值 内容 正文 HTML & 文本');
  assert.equal(toSpeechText('Use [relative](./readme) and [collapsed][] labels.'), 'Use relative and collapsed labels.');
  assert.equal(toSpeechText('a <!-- private --> b'), 'a b');
  assert.equal(toSpeechText('### 你**好**呀 ###\n> - 嵌套项目'), '你好呀 嵌套项目');
  assert.equal(toSpeechText('网址https://example.com，保留正文。'), '网址，保留正文。');
});

test('unsupported APIs and inaccessible browser features fail safely in Chinese', () => {
  for (const configure of [
    view => { delete view.speechSynthesis; },
    view => { delete view.SpeechSynthesisUtterance; },
    view => { view.speechSynthesis.speak = null; },
    view => { Object.defineProperty(view, 'speechSynthesis', { get() { throw Error('denied'); } }); },
  ]) {
    const fixture = browser([], { configure });
    assert.deepEqual(fixture.speech.state, { supported: false, phase: 'idle', error: '' });
    assert.doesNotThrow(() => fixture.speech.play('你好'));
    assert.match(fixture.speech.state.error, /不支持/);
    fixture.speech.stop(); fixture.speech.dispose(); idle(fixture);
    assert.equal(fixture.synthesis.cancels, 0);
  }
});

test('construction is silent and state snapshots cannot mutate the controller', () => {
  const fixture = browser();
  assert.deepEqual(fixture.speech.state, { supported: true, phase: 'idle', error: '' });
  assert.equal(fixture.synthesis.reads, 0);
  fixture.voicesChanged(); fixture.tick(100000);
  assert.equal(fixture.spoken.length, 0);
  fixture.speech.state.phase = 'speaking';
  assert.equal(fixture.speech.state.phase, 'idle');
  fixture.speech.stop(); fixture.speech.dispose();
  assert.equal(fixture.synthesis.cancels, 0);
});

test('Chinese prefers zh-CN, then any zh, and never silently uses English', () => {
  for (const [voices, expected] of [
    [[voice('en-US', true), voice('zh-TW'), voice('zh-CN')], 'zh-CN'],
    [[voice('en-US', true), voice('ZH_cn')], 'ZH_cn'],
    [[voice('en-US', true), voice('zh-HK')], 'zh-HK'],
    [[voice('en-US', true), voice('fr-FR')], null],
  ]) {
    const fixture = browser(voices); fixture.speech.play('Hello，中文。');
    if (expected) {
      assert.equal(fixture.spoken[0].voice.lang, expected);
      assert.equal(fixture.spoken[0].lang, expected);
    } else {
      assert.match(fixture.speech.state.error, /中文语音/); assert.equal(fixture.spoken.length, 0); idle(fixture);
    }
    fixture.speech.dispose();
  }
});

test('English prefers en then the default voice', () => {
  for (const [voices, expected] of [
    [[voice('fr-FR', true), voice('en-GB'), voice('en-US')], 'en-GB'],
    [[voice('zh-CN'), voice('fr-FR', true)], 'fr-FR'],
    [[voice('fr-FR'), voice('de-DE')], 'fr-FR'],
  ]) {
    const fixture = browser(voices); fixture.speech.play('Hello world.');
    assert.equal(fixture.spoken[0].voice.lang, expected); fixture.speech.dispose();
  }
});

test('lazy voices wait for an event and speak only the valid explicit request once', () => {
  const fixture = browser([]);
  fixture.speech.play('你好');
  assert.equal(fixture.speech.state.phase, 'loading');
  assert.equal(fixture.listeners.size, 1);
  const delayedVoiceEvent = [...fixture.listeners][0];
  fixture.voicesChanged(); assert.equal(fixture.spoken.length, 0);
  fixture.tick(500); fixture.synthesis.voices = [voice('zh-CN')]; fixture.voicesChanged();
  assert.equal(fixture.spoken.length, 1); assert.equal(fixture.listeners.size, 0);
  delayedVoiceEvent(); fixture.voicesChanged(); assert.equal(fixture.spoken.length, 1);
  fixture.spoken[0].onstart(); fixture.spoken[0].onend(); idle(fixture);
  delayedVoiceEvent(); fixture.voicesChanged(); fixture.tick(100000);
  assert.equal(fixture.spoken.length, 1);
});

test('voice wait is bounded at 1500ms and late updates cannot resurrect old text', () => {
  const fixture = browser([]); fixture.speech.play('你好');
  const oldEvent = [...fixture.listeners][0];
  fixture.tick(1499); assert.equal(fixture.speech.state.phase, 'loading');
  fixture.tick(1); idle(fixture); assert.match(fixture.speech.state.error, /未找到.*语音/);
  fixture.synthesis.voices = [voice('zh-CN')]; oldEvent(); fixture.voicesChanged();
  assert.equal(fixture.spoken.length, 0); assert.equal(fixture.synthesis.cancels, 0);
  fixture.speech.play('新文本'); assert.equal(fixture.spoken[0].text, '新文本'); fixture.speech.dispose();
});

test('voices silently populated by the deadline can satisfy a still-pending play', () => {
  const fixture = browser([]); fixture.speech.play('Hello');
  fixture.synthesis.voices = [voice('en-US')]; fixture.tick(1500);
  assert.equal(fixture.spoken.length, 1); assert.equal(fixture.listeners.size, 0); fixture.speech.dispose();
});

test('stop and dispose remove pending voice listeners without canceling foreign audio', () => {
  for (const action of ['stop', 'dispose']) {
    const fixture = browser([]); fixture.speech.play('旧文本');
    const oldEvent = [...fixture.listeners][0], oldTimeout = [...fixture.timers.values()][0].callback;
    fixture.speech[action](); idle(fixture);
    fixture.synthesis.voices = [voice('zh-CN')]; oldEvent(); oldTimeout(); fixture.voicesChanged(); fixture.tick(100000);
    assert.equal(fixture.spoken.length, 0); assert.equal(fixture.synthesis.cancels, 0);
  }
});

test('replacing a pending play invalidates even already-queued voice callbacks', () => {
  const fixture = browser([]); fixture.speech.play('旧文本');
  const oldEvent = [...fixture.listeners][0];
  fixture.speech.play('新文本'); fixture.synthesis.voices = [voice('zh-CN')];
  oldEvent(); assert.equal(fixture.spoken.length, 0); fixture.voicesChanged();
  assert.equal(fixture.spoken.length, 1); assert.equal(fixture.spoken[0].text, '新文本'); fixture.speech.dispose();
});

test('legacy voiceschanged property handlers are chained and restored', () => {
  let externalCalls = 0; const external = () => { externalCalls++; };
  const fixture = browser([], { configure(view) {
    delete view.speechSynthesis.addEventListener; delete view.speechSynthesis.removeEventListener;
    view.speechSynthesis.onvoiceschanged = external;
  } });
  fixture.speech.play('你好'); fixture.voicesChanged();
  assert.equal(externalCalls, 1); assert.equal(fixture.spoken.length, 0);
  fixture.synthesis.voices = [voice('zh-CN')]; fixture.voicesChanged();
  assert.equal(fixture.spoken.length, 1); assert.equal(fixture.synthesis.onvoiceschanged, external);
  fixture.speech.dispose(); idle(fixture);
});

test('normal start/end retains the native utterance and releases callbacks and timers', () => {
  const fixture = browser(); fixture.speech.play('已经清理好的中文。');
  const utterance = fixture.spoken[0];
  assert.equal(utterance.text, '已经清理好的中文。');
  assert.equal(fixture.speech.state.phase, 'loading');
  utterance.onstart(); assert.equal(fixture.speech.state.phase, 'speaking');
  fixture.states.at(-1).phase = 'idle'; assert.equal(fixture.speech.state.phase, 'speaking');
  utterance.onend(); idle(fixture); assert.equal(fixture.speech.state.error, '');
  assert.equal(utterance.onstart, null); assert.equal(utterance.onend, null); assert.equal(utterance.onerror, null);
  fixture.speech.stop(); assert.equal(fixture.synthesis.cancels, 0);
});

test('new play cancels the old utterance and stale cancel/end/error/start/timers cannot reset it', () => {
  let old;
  const fixture = browser(undefined, { cancel() { old?.end(); old?.error({ error: 'canceled' }); } });
  fixture.speech.play('旧回复'); old = events(fixture.spoken[0]); old.start();
  const oldTimers = [...fixture.timers.values()].map(timer => timer.callback);
  fixture.speech.play('新回复'); const current = fixture.spoken[1]; current.onstart();
  assert.equal(fixture.synthesis.cancels, 1);
  old.start(); old.end(); old.error({ error: 'interrupted' }); for (const callback of oldTimers) callback();
  assert.equal(fixture.speech.state.phase, 'speaking'); assert.equal(fixture.speech.state.error, '');
  assert.equal(fixture.spoken.length, 2); current.onend(); idle(fixture);
});

test('long replies serialize bounded sentence chunks, ignoring duplicate ends from earlier chunks', () => {
  const fixture = browser(); const sentence = '文'.repeat(99) + '。'; const text = sentence.repeat(7);
  fixture.speech.play(text); assert.equal(fixture.spoken.length, 1);
  for (let index = 0; index < 4; index++) {
    const utterance = fixture.spoken[index], callbacks = events(utterance);
    assert.ok(Array.from(utterance.text).length <= 220); assert.ok(utterance.text.endsWith('。'));
    if (index < 3) assert.equal(utterance.text.length, 200);
    callbacks.start(); callbacks.end(); assert.equal(fixture.spoken.length, index + 1);
    fixture.tick(0);
    const count = fixture.spoken.length; callbacks.end(); callbacks.error({});
    assert.equal(fixture.spoken.length, count);
  }
  assert.equal(fixture.spoken.map(utterance => utterance.text).join(''), text); idle(fixture);
});

test('oversized unbroken text is bounded without splitting Unicode code points', () => {
  const fixture = browser(); const text = '😀'.repeat(500); fixture.speech.play(text);
  for (let i = 0; i < 3; i++) {
    const utterance = fixture.spoken[i];
    assert.ok(Array.from(utterance.text).length <= 220); assert.doesNotMatch(utterance.text, /\uFFFD/u);
    utterance.onend(); fixture.tick(0);
  }
  assert.equal(fixture.spoken.map(utterance => utterance.text).join(''), text); idle(fixture);
});

test('stop between chunks removes continuation and never starts the remaining text', () => {
  const fixture = browser(); fixture.speech.play(('中'.repeat(99) + '。').repeat(5));
  fixture.spoken[0].onend(); const continuation = [...fixture.timers.values()][0].callback;
  fixture.speech.stop(); continuation(); fixture.tick(0);
  assert.equal(fixture.spoken.length, 1); idle(fixture); assert.equal(fixture.synthesis.cancels, 0);
});

test('native onerror stops the whole reply and allows an explicit retry', () => {
  const fixture = browser(); fixture.speech.play('中'.repeat(500));
  const old = events(fixture.spoken[0]); old.start(); old.error({ error: 'not-allowed' });
  idle(fixture); assert.match(fixture.speech.state.error, /朗读失败/); assert.equal(fixture.synthesis.cancels, 1);
  fixture.tick(100000); assert.equal(fixture.spoken.length, 1);
  fixture.speech.play('重试'); fixture.spoken[1].onstart();
  old.end(); assert.equal(fixture.speech.state.phase, 'speaking');
  assert.equal(fixture.speech.state.error, ''); fixture.speech.dispose();
});

test('synchronous native failures are contained and release every pending resource', () => {
  for (const fault of ['voices', 'construct', 'speak', 'listen']) {
    const fixture = browser(fault === 'listen' ? [] : undefined); fixture.faults[fault] = true;
    assert.doesNotThrow(() => fixture.speech.play('你好')); idle(fixture);
    assert.match(fixture.speech.state.error, /失败/);
  }
  const fixture = browser(); fixture.speech.play('你好'); fixture.faults.cancel = true;
  assert.doesNotThrow(() => fixture.speech.stop()); idle(fixture);
});

test('asynchronous voice enumeration failure is contained without uncaught rejection', () => {
  const fixture = browser([]); fixture.speech.play('你好'); fixture.faults.voices = true;
  assert.doesNotThrow(() => fixture.voicesChanged()); idle(fixture); assert.match(fixture.speech.state.error, /失败/);
});

test('missing onstart has a bounded watchdog, and a late start cannot revive it', () => {
  const fixture = browser(); fixture.speech.play('你好'); const old = events(fixture.spoken[0]);
  fixture.tick(3999); assert.equal(fixture.speech.state.phase, 'loading');
  fixture.tick(1); idle(fixture); assert.match(fixture.speech.state.error, /未能启动/);
  old.start(); old.end(); idle(fixture); assert.equal(fixture.synthesis.cancels, 1);
});

test('missing completion callbacks have a bounded length-based speaking watchdog', () => {
  for (const length of [2, 200]) {
    const fixture = browser(); fixture.speech.play('中'.repeat(length)); fixture.spoken[0].onstart();
    const deadline = Math.max(10000, length * 350 + 5000);
    fixture.tick(deadline - 1); assert.equal(fixture.speech.state.phase, 'speaking');
    fixture.tick(1); idle(fixture); assert.match(fixture.speech.state.error, /超时/);
    assert.equal(fixture.synthesis.cancels, 1);
  }
});

test('a completion without onstart still finishes cleanly', () => {
  const fixture = browser(); fixture.speech.play('你好'); fixture.spoken[0].onend();
  fixture.tick(100000); idle(fixture); assert.equal(fixture.speech.state.error, '');
});

test('dispose is idempotent and ignores delayed native events, timers, and later plays', () => {
  const fixture = browser(); fixture.speech.play('中'.repeat(500)); const old = events(fixture.spoken[0]); old.start();
  const callbacks = [...fixture.timers.values()].map(timer => timer.callback);
  fixture.speech.dispose(); const stateCount = fixture.states.length;
  old.start(); old.end(); old.error({}); for (const callback of callbacks) callback();
  fixture.speech.play('不应朗读'); fixture.speech.stop(); fixture.speech.dispose(); fixture.voicesChanged(); fixture.tick(100000);
  idle(fixture); assert.equal(fixture.states.length, stateCount);
  assert.equal(fixture.spoken.length, 1); assert.equal(fixture.synthesis.cancels, 1);
});

test('empty text cancels this instance only and does not construct another utterance', () => {
  const fixture = browser(); fixture.speech.play('你好'); fixture.speech.play('  \n  ');
  idle(fixture); assert.equal(fixture.spoken.length, 1); assert.equal(fixture.synthesis.cancels, 1);
});

test('onChange reentrancy and throwing UI callbacks cannot break cancellation or cleanup', () => {
  const fixture = browser(undefined, { onChange(state, speech) { if (state.phase === 'loading') speech.stop(); } });
  fixture.speech.play('你好'); idle(fixture); assert.equal(fixture.spoken.length, 0);
  const throwing = browser(undefined, { onChange() { throw Error('view gone'); } });
  assert.doesNotThrow(() => throwing.speech.play('你好'));
  throwing.spoken[0].onstart(); throwing.spoken[0].onend(); idle(throwing);
});
