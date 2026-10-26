import type { PetSpeechState } from './speech';

export type QwenNativeTimings = { readiness_ms: number; synthesis_ms: number; encode_ms: number; total_ms: number };
export type QwenAudio = { request_id: string; voice_id: string; wav_base64: string; timings?: QwenNativeTimings };
/** Anonymous durations only: never include reply text, WAV data or reference assets. */
export type QwenSpeechTiming = {
  request_id: string; segment: number; phase: 'prepared' | 'playback_started';
  synthesis_ms: number; decode_ms: number; audio_ms: number; elapsed_ms: number;
  first_audio_ms?: number; gap_ms?: number; native?: QwenNativeTimings;
};
type PreparedAudio = { request_id: string; buffer: AudioBuffer; timing: QwenSpeechTiming };
type PreparedResult = { ok: true; audio: PreparedAudio } | { ok: false; error: unknown };
type PreparedJob = { settled: boolean; result: Promise<PreparedResult> };
type PlaybackWindow = Window & { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
const VOICE = 'pet-airhead-v1';
const MAX_WAV = 2 * 1024 * 1024;
class Cancelled extends Error {}

/** A short first clause reduces time to first audio; later chunks amortize TTS overhead. */
export function qwenChunks(text: string): string[] {
  const result: string[] = [];
  let rest = Array.from(text.trim());
  // Keep already short replies whole rather than leaving a tiny/punctuation-only tail.
  if (rest.length > 24) {
    let end = 0;
    // Prefer a natural 8–20 character boundary, then a word boundary, then a scalar-safe cut.
    for (let i = 7; i < 20; i++) if (/[。！？!?；;，,]/.test(rest[i])) end = i + 1;
    if (!end) for (let i = 19; i >= 7; i--) if (/\s/.test(rest[i])) { end = i + 1; break; }
    if (!end) end = 20;
    const first = rest.slice(0, end).join('').trim();
    if (first) result.push(first);
    rest = rest.slice(end);
  }
  while (rest.length > 60) {
    let end = 0;
    for (let i = 15; i < 60; i++) if (/[。！？!?；;，,]/.test(rest[i])) end = i + 1;
    if (!end) for (let i = 59; i >= 40; i--) if (/\s/.test(rest[i])) { end = i + 1; break; }
    if (!end) end = 60;
    const part = rest.slice(0, end).join('').trim();
    if (part) result.push(part);
    rest = rest.slice(end);
  }
  const last = rest.join('').trim();
  if (last) result.push(last);
  return result;
}

/** Validate again at the IPC boundary before asking the browser to decode bytes. */
export function qwenWav(encoded: string, decode: (value: string) => string): ArrayBuffer {
  if (typeof encoded !== 'string' || !encoded.length || encoded.length > Math.ceil(MAX_WAV / 3) * 4 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('合成音频格式无效');
  const binary = decode(encoded);
  if (binary.length < 44 || binary.length > MAX_WAV) throw new Error('合成音频大小无效');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const tag = (i: number) => String.fromCharCode(...bytes.subarray(i, i + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || view.getUint32(4, true) !== bytes.length - 8) throw new Error('合成音频不是完整 WAV');
  let format = false, data = false;
  for (let i = 12; i < bytes.length;) {
    if (i + 8 > bytes.length) throw new Error('合成音频已截断');
    const size = view.getUint32(i + 4, true), end = i + 8 + size;
    if (end > bytes.length) throw new Error('合成音频已截断');
    if (tag(i) === 'fmt ') {
      if (format || !(size === 16 || (size === 18 && view.getUint16(i + 24, true) === 0)) || view.getUint16(i + 8, true) !== 1 || view.getUint16(i + 10, true) !== 1 || view.getUint32(i + 12, true) !== 24000 || view.getUint32(i + 16, true) !== 48000 || view.getUint16(i + 20, true) !== 2 || view.getUint16(i + 22, true) !== 16) throw new Error('合成音频参数无效');
      format = true;
    } else if (tag(i) === 'data') {
      if (data || !format || !size || size % 2 || size > 30 * 48000) throw new Error('合成音频时长无效');
      data = true;
    }
    i = end + (size % 2);
    if (i > bytes.length) throw new Error('合成音频已截断');
  }
  if (!format || !data) throw new Error('合成音频缺少声音数据');
  return bytes.buffer;
}

/** Selected-reference narration. No system-voice fallback and no direct browser network access. */
export class QwenSpeech {
  private readonly options: {
    view: Window; enabled: boolean; onChange(state: PetSpeechState): void;
    synthesize(request: { request_id: string; text: string; previous_request_id?: string }): Promise<QwenAudio>;
    cancel(requestId: string): Promise<unknown>;
    newId?: () => string;
    onComplete?: () => void;
    onTiming?: (timing: QwenSpeechTiming) => void;
    now?: () => number;
  };
  private current: PetSpeechState;
  private generation = 0;
  private disposed = false;
  private context?: AudioContext;
  private source?: AudioBufferSourceNode;
  private gain?: GainNode;
  private volume = 100;
  // A generation is one narration; keep both playing and prefetched segment IDs cancellable.
  private readonly requestIds = new Set<string>();
  private readonly interrupts = new Set<() => void>();
  private readonly Context?: typeof AudioContext;

  constructor(options: QwenSpeech['options']) {
    this.options = options;
    try { this.Context = (options.view as PlaybackWindow).AudioContext ?? (options.view as PlaybackWindow).webkitAudioContext; } catch { /* Restricted contexts stay unsupported. */ }
    this.current = { supported: options.enabled && typeof this.Context === 'function', phase: 'idle', error: '' };
  }
  get state(): PetSpeechState { return { ...this.current }; }

  /** Call in the opt-in click too: Web Audio permission must not wait for synthesis. */
  unlock(): void {
    if (this.disposed || !this.current.supported) return;
    try { const ctx = this.getContext(); if (ctx.state !== 'running') void ctx.resume().catch(() => {}); } catch { /* play reports an actionable error. */ }
  }
  play(text: string): void {
    if (this.disposed) return;
    const generation = this.reset();
    if (!text.trim()) { this.publish('idle'); return; }
    if (!this.current.supported) { this.publish('idle', '本地千问朗读仅在桌面应用中可用'); return; }
    const startedAt = this.now();
    this.unlock();
    this.publish('loading');
    if (this.active(generation)) void this.run(generation, qwenChunks(text), startedAt);
  }
  stop(): void { if (!this.disposed) { this.reset(); this.publish('idle'); } }
  /** Ignore delayed cross-window stops for an older request, including during playback. */
  stopRequest(request_id: string): void {
    if (request_id && this.requestIds.has(request_id)) this.stop();
  }
  setVolume(volume: number): void {
    if (!Number.isFinite(volume)) return;
    this.volume = Math.max(0, Math.min(100, volume));
    if (this.gain) this.gain.gain.value = this.volume / 100;
  }
  dispose(): void {
    if (this.disposed) return;
    this.reset(); this.disposed = true;
    const ctx = this.context; this.context = undefined;
    try { this.gain?.disconnect(); } catch { /* Detached. */ }
    this.gain = undefined;
    try { void ctx?.close().catch(() => {}); } catch { /* Already closed. */ }
  }
  private getContext(): AudioContext {
    if (!this.context) {
      const context = new this.Context!();
      this.context = context;
      this.gain = context.createGain();
      this.gain.gain.value = this.volume / 100;
      this.gain.connect(context.destination);
    }
    if (!this.gain) throw new Error('音频音量控制不可用，请重新打开此窗口');
    return this.context;
  }
  private active(generation: number): boolean { return !this.disposed && this.generation === generation; }
  private publish(phase: PetSpeechState['phase'], error = ''): void {
    if (this.disposed) return;
    this.current = { supported: this.current.supported, phase, error };
    this.options.onChange(this.state);
  }
  private reset(): number {
    this.generation++;
    for (const interrupt of [...this.interrupts]) interrupt();
    this.interrupts.clear();
    const ids = [...this.requestIds]; this.requestIds.clear();
    for (const id of ids) try { void Promise.resolve(this.options.cancel(id)).catch(() => {}); } catch { /* Result guards still prevent stale playback. */ }
    this.releaseSource();
    return this.generation;
  }
  private releaseSource(): void {
    const source = this.source; this.source = undefined;
    if (!source) return;
    source.onended = null;
    try { source.stop(); } catch { /* A source may not have started. */ }
    try { source.disconnect(); } catch { /* Detached. */ }
  }
  private wait<T>(generation: number, task: Promise<T>, timeout: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true; this.options.view.clearTimeout(timer);
        this.interrupts.delete(cancel);
        callback();
      };
      const cancel = () => finish(() => reject(new Cancelled()));
      const timer = this.options.view.setTimeout(() => finish(() => reject(new Error(message))), timeout);
      this.interrupts.add(cancel);
      task.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
      if (!this.active(generation)) cancel();
    });
  }
  private id(): string {
    let value = this.options.newId?.();
    if (!value) {
      const bytes = new Uint8Array(16);
      this.options.view.crypto.getRandomValues(bytes);
      value = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    }
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(value)) throw new Error('无法创建朗读请求标识');
    return value;
  }
  private now(): number { return this.options.now?.() ?? performance.now(); }
  private timing(generation: number, timing: QwenSpeechTiming): void {
    if (!this.active(generation)) return;
    try { this.options.onTiming?.({ ...timing, ...(timing.native ? { native: { ...timing.native } } : {}) }); } catch { /* Diagnostics must never interrupt speech. */ }
  }
  private prefetch(generation: number, ctx: AudioContext, text: string, segment: number, startedAt: number, previous_request_id?: string): PreparedJob {
    // Attach rejection handling immediately, even while the previous segment is still playing.
    const job: PreparedJob = { settled: false, result: this.prepare(generation, ctx, text, segment, startedAt, previous_request_id).then(
      audio => { job.settled = true; return { ok: true, audio }; },
      error => { job.settled = true; return { ok: false, error }; },
    ) };
    return job;
  }
  private async prepare(generation: number, ctx: AudioContext, text: string, segment: number, startedAt: number, previous_request_id?: string): Promise<PreparedAudio> {
    if (!this.active(generation)) throw new Cancelled();
    const request_id = this.id(); this.requestIds.add(request_id);
    const requestedAt = this.now();
    const reply = await this.wait(generation, this.options.synthesize({ request_id, text, ...(previous_request_id ? { previous_request_id } : {}) }), 210000, '本地千问生成超时，请停止后重试');
    if (!this.active(generation)) throw new Cancelled();
    const receivedAt = this.now();
    if (reply.request_id !== request_id || reply.voice_id !== VOICE) throw new Error('本地语音服务返回了不匹配的音色或请求');
    const bytes = qwenWav(reply.wav_base64, value => this.options.view.atob(value));
    const buffer = await this.wait(generation, ctx.decodeAudioData(bytes), 10000, '本地音频解码超时');
    if (!this.active(generation)) throw new Cancelled();
    if (!Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.duration > 30.1) throw new Error('合成音频时长无效');
    const preparedAt = this.now();
    // Whitelist numeric metadata rather than logging arbitrary backend fields.
    let native: QwenNativeTimings | undefined;
    if (reply.timings) {
      const { readiness_ms, synthesis_ms, encode_ms, total_ms } = reply.timings;
      if ([readiness_ms, synthesis_ms, encode_ms, total_ms].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
        native = { readiness_ms, synthesis_ms, encode_ms, total_ms };
      }
    }
    const timing: QwenSpeechTiming = { request_id, segment, phase: 'prepared',
      synthesis_ms: receivedAt - requestedAt, decode_ms: preparedAt - receivedAt,
      audio_ms: buffer.duration * 1000, elapsed_ms: preparedAt - startedAt, ...(native ? { native } : {}) };
    this.timing(generation, timing);
    return { request_id, buffer, timing };
  }
  private async run(generation: number, parts: string[], startedAt: number): Promise<void> {
    try {
      const ctx = this.getContext();
      const running = () => ctx.state === 'running';
      if (!running()) {
        await this.wait(generation, ctx.resume(), 5000, '请点击「朗读」允许音频播放');
        if (!running()) throw new Error('请点击「朗读」允许音频播放');
      }
      if (!this.active(generation) || !parts.length) return;
      let pending = this.prefetch(generation, ctx, parts[0], 0, startedAt);
      let endedAt: number | undefined;
      for (let index = 0; index < parts.length; index++) {
        if (!this.active(generation)) return;
        if (!pending.settled) this.publish('loading');
        if (!this.active(generation)) return;
        const result = await pending.result;
        if (!this.active(generation)) return;
        if (!result.ok) throw result.error;
        const { request_id, buffer, timing } = result.audio;
        const source = ctx.createBufferSource(); this.source = source; source.buffer = buffer; source.connect(this.gain!);
        const ended = new Promise<void>(resolve => { source.onended = () => { endedAt = this.now(); resolve(); }; });
        // start() can throw; do not leave a rejecting watchdog without an awaiter.
        source.start();
        const playbackAt = this.now();
        const playback = this.wait(generation, ended, Math.ceil(buffer.duration * 1000) + 10000, '音频播放未正常结束，请重试');
        // Reentrant UI callbacks may stop playback; always observe watchdog rejection.
        void playback.catch(() => {});
        if (this.active(generation)) this.publish('speaking');
        this.timing(generation, { ...timing, phase: 'playback_started', elapsed_ms: playbackAt - startedAt,
          ...(index === 0 ? { first_audio_ms: playbackAt - startedAt } : { gap_ms: playbackAt - endedAt! }) });
        // Only one lookahead, after validated playback starts. The native predecessor check
        // prevents a background continuation from superseding a newer request in another window.
        if (this.active(generation) && index + 1 < parts.length) pending = this.prefetch(generation, ctx, parts[index + 1], index + 1, startedAt, request_id);
        await playback;
        if (!this.active(generation)) return;
        this.releaseSource();
        this.requestIds.delete(request_id);
      }
      if (this.active(generation)) {
        this.options.onComplete?.();
        if (this.active(generation)) this.publish('idle');
      }
    } catch (error) {
      if (!this.active(generation) || error instanceof Cancelled) return;
      this.reset();
      const detail = (typeof error === 'string' ? error : error instanceof Error ? error.message : '服务不可用').replace(/[\r\n\t]+/g, ' ').slice(0, 200);
      this.publish('idle', '本地千问朗读失败：' + detail);
    }
  }
}
