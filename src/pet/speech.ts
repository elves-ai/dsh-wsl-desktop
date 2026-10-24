/** A separate narration projection: never use this to replace the displayed reply. */
export function toSpeechText(markdown: string): string {
  let fence: { marker: string; length: number } | undefined;
  const prose: string[] = [];
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const marker = /^\s*(?:>\s*)*(?:(?:[-+*]|\d+[.)])\s+)?(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (marker) { fence = { marker: marker[1][0], length: marker[1].length }; continue; }
    prose.push(line);
  }
  return prose.join('\n')
    .replace(/(`+)[\s\S]*?\1(?!`)/g, ' ')
    .replace(/<!--[^]*?(?:-->|$)/g, ' ')
    .replace(/^ {0,3}\[[^\]\n]+\]:[^\n]*$/gm, '')
    .replace(/!?\[([^\]\n]*)\]\(\s*(?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/!?\[([^\]\n]+)\]\s*\[[^\]\n]*\]/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/(?:https?:\/\/|ftp:\/\/|mailto:|www\.)[^\s<>，。！？；：、（）【】「」『』]+/gi, url => url.match(/[.,!?;:…]+$/)?.[0] ?? '')
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, '')
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, '')
    .replace(/^ {0,3}(?:>\s*)+/gm, '')
    .replace(/^\s*(?:#{1,6}\s+|(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?)/gm, '')
    .replace(/[ \t]+#+[ \t]*$/gm, '')
    .replace(/^[ \t]*[=-]{2,}[ \t]*$/gm, '')
    .replace(/\\([\\`*_{}\[\]()#+.!>~-])/g, '$1')
    .replace(/[*_~\[\]{}]/g, '')
    .replace(/\|/g, ' ')
    .replace(/`/g, '')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' })[entity] ?? entity)
    .replace(/\s+/g, ' ').trim();
}

export type PetSpeechState = {
  supported: boolean;
  phase: 'idle' | 'loading' | 'speaking';
  error: string;
};

type SpeechWindow = Window & { SpeechSynthesisUtterance?: new (text: string) => SpeechSynthesisUtterance };
const hasChinese = (text: string): boolean => /\p{Script=Han}/u.test(text);

/** Keep native utterances small, without splitting Unicode characters or normal sentences. */
function chunks(text: string): string[] {
  const result: string[] = [];
  let rest = Array.from(text);
  while (rest.length > 220) {
    const head = rest.slice(0, 220);
    let end = 0;
    for (let i = 0; i < head.length; i++) {
      if (/[。！？!?；;\n]/.test(head[i]) || (head[i] === '.' && (i === head.length - 1 || /\s/.test(head[i + 1])))) end = i + 1;
    }
    if (end < 100) {
      end = 220;
      for (let i = 219; i >= 179; i--) { if (/\s/.test(head[i])) { end = i + 1; break; } }
    }
    result.push(rest.slice(0, end).join('').trim());
    rest = rest.slice(end);
  }
  if (rest.join('').trim()) result.push(rest.join('').trim());
  return result;
}

/** Explicit-play only. The caller waits for a completed reply before passing cleaned text. */
export class PetSpeech {
  private readonly view: Window;
  private readonly onChange: (state: PetSpeechState) => void;
  private readonly synthesis?: SpeechSynthesis;
  private readonly Utterance?: new (text: string) => SpeechSynthesisUtterance;
  private current: PetSpeechState;
  private generation = 0;
  private disposed = false;
  // Strong reference is important: some implementations otherwise lose callbacks to GC.
  private utterance?: SpeechSynthesisUtterance;
  private readonly timers = new Set<number>();
  private removeVoiceListener?: () => void;

  constructor(options: { view: Window; onChange(state: PetSpeechState): void }) {
    this.view = options.view;
    this.onChange = options.onChange;
    try {
      const synthesis = options.view.speechSynthesis;
      const Utterance = (options.view as SpeechWindow).SpeechSynthesisUtterance;
      if (synthesis && typeof synthesis.speak === 'function' && typeof synthesis.cancel === 'function' && typeof synthesis.getVoices === 'function' && typeof Utterance === 'function') {
        this.synthesis = synthesis;
        this.Utterance = Utterance;
      }
    } catch { /* Feature access itself can fail in restricted browser contexts. */ }
    this.current = { supported: !!this.synthesis, phase: 'idle', error: '' };
  }

  get state(): PetSpeechState { return { ...this.current }; }

  play(text: string): void {
    if (this.disposed) return;
    const generation = this.reset();
    if (!text.trim()) { this.publish('idle'); return; }
    if (!this.synthesis || !this.Utterance) { this.publish('idle', '当前环境不支持语音朗读'); return; }
    this.publish('loading');
    if (!this.valid(generation)) return;
    try {
      const voices = this.synthesis.getVoices();
      if (voices.length) this.begin(text.trim(), voices, generation);
      else this.waitForVoices(text.trim(), generation);
    } catch { this.fail(generation, '语音朗读失败，请重试'); }
  }

  stop(): void {
    if (this.disposed) return;
    this.reset();
    this.publish('idle');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.reset();
    this.publish('idle');
  }

  private publish(phase: PetSpeechState['phase'], error = ''): void {
    this.current = { supported: this.current.supported, phase, error };
    try { this.onChange(this.state); } catch { /* A view callback cannot break native cleanup. */ }
  }

  private valid(generation: number): boolean { return !this.disposed && generation === this.generation; }

  private later(callback: () => void, delay: number): number {
    const timer = this.view.setTimeout(() => { this.timers.delete(timer); callback(); }, delay);
    this.timers.add(timer);
    return timer;
  }

  private clearTimer(timer: number): void { this.view.clearTimeout(timer); this.timers.delete(timer); }

  private releaseUtterance(): void {
    if (!this.utterance) return;
    this.utterance.onstart = this.utterance.onend = this.utterance.onerror = null;
    this.utterance = undefined;
  }

  private reset(): number {
    const generation = ++this.generation; // Invalidate before cancel(), which may fire events synchronously.
    this.clearVoiceWait();
    for (const timer of this.timers) this.view.clearTimeout(timer);
    this.timers.clear();
    const active = !!this.utterance;
    this.releaseUtterance();
    // Never cancel the global browser queue merely for an idle instance or a voice wait.
    if (active) { try { this.synthesis?.cancel(); } catch { /* Best-effort native cancellation. */ } }
    return generation;
  }

  private clearVoiceWait(): void {
    const remove = this.removeVoiceListener;
    this.removeVoiceListener = undefined;
    try { remove?.(); } catch { /* The context may already have been torn down. */ }
  }

  private fail(generation: number, error: string): void {
    if (!this.valid(generation)) return;
    this.reset();
    this.publish('idle', error);
  }

  private waitForVoices(text: string, generation: number): void {
    const synthesis = this.synthesis!;
    let waiting = true;
    const check = (): void => {
      if (!waiting || !this.valid(generation)) return;
      try {
        const voices = synthesis.getVoices();
        if (!voices.length) return;
        this.clearVoiceWait();
        this.clearTimer(timeout);
        this.begin(text, voices, generation);
      } catch { this.fail(generation, '语音朗读失败，请重试'); }
    };
    const timeout = this.later(() => {
      if (!this.valid(generation)) return;
      // A final read covers engines that populate voices without dispatching an event.
      check();
      if (this.valid(generation) && this.removeVoiceListener) this.fail(generation, '未找到可用语音');
    }, 1500);
    if (typeof synthesis.addEventListener === 'function' && typeof synthesis.removeEventListener === 'function') {
      this.removeVoiceListener = () => { waiting = false; synthesis.removeEventListener('voiceschanged', check); };
      synthesis.addEventListener('voiceschanged', check);
    } else {
      const previous = synthesis.onvoiceschanged;
      const listener: SpeechSynthesis['onvoiceschanged'] = event => {
        try { previous?.call(synthesis, event); } catch { /* Preserve other consumers without inheriting their errors. */ }
        check();
      };
      this.removeVoiceListener = () => { waiting = false; if (synthesis.onvoiceschanged === listener) synthesis.onvoiceschanged = previous; };
      synthesis.onvoiceschanged = listener;
    }
    check(); // Close the gap between the first getVoices() and listener registration.
  }

  private begin(text: string, voices: SpeechSynthesisVoice[], generation: number): void {
    if (!this.valid(generation)) return;
    const language = (voice: SpeechSynthesisVoice): string => voice.lang.toLowerCase().replace(/_/g, '-');
    const chinese = hasChinese(text);
    const voice = chinese
      ? voices.find(voice => language(voice) === 'zh-cn') ?? voices.find(voice => /^zh(?:-|$)/.test(language(voice)))
      : voices.find(voice => /^en(?:-|$)/.test(language(voice))) ?? voices.find(voice => voice.default) ?? voices[0];
    if (!voice) { this.fail(generation, chinese ? '未找到中文语音' : '未找到可用语音'); return; }
    const queue = chunks(text);
    const next = (): void => {
      if (!this.valid(generation)) return;
      const part = queue.shift();
      if (!part) { this.publish('idle'); return; }
      try {
        const utterance = new this.Utterance!(part);
        utterance.voice = voice;
        utterance.lang = voice.lang;
        this.utterance = utterance;
        const current = (): boolean => this.valid(generation) && this.utterance === utterance;
        const startTimer = this.later(() => { if (current()) this.fail(generation, '语音未能启动，请重试'); }, 4000);
        const endTimer = this.later(() => { if (current()) this.fail(generation, '语音朗读超时，请重试'); }, Math.max(10000, Array.from(part).length * 350 + 5000));
        utterance.onstart = () => {
          if (!current()) return;
          this.clearTimer(startTimer);
          this.publish('speaking');
        };
        utterance.onerror = () => { if (current()) this.fail(generation, '语音朗读失败，请重试'); };
        utterance.onend = () => {
          if (!current()) return;
          this.clearTimer(startTimer);
          this.clearTimer(endTimer);
          this.releaseUtterance();
          if (queue.length) this.later(next, 0);
          else this.publish('idle');
        };
        this.synthesis!.speak(utterance);
      } catch { this.fail(generation, '语音朗读失败，请重试'); }
    };
    next();
  }
}
