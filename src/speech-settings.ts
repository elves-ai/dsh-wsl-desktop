import { QwenSpeech, type QwenAudio } from './pet/qwen-speech';

export type SpeechConfig = { python_path: string; model_dir: string; native_lib: string };
export type SpeechPreferences = { revision: number; initialized: boolean; auto_read: boolean; volume: number };
export type SpeechSnapshot = {
  revision: number; configured: boolean; config: SpeechConfig; distribution: string | null;
  busy: boolean; operation: string | null; environment_state: string; models_state: string;
  model_progress: number | null; service_state: string; ownership: string; model_state: string;
  gpu_name: string | null; message: string; error: string | null; logs: string[];
};
const defaultPythonSuffix = '/.dsh-wsl-desktop/speech/runtime/venv/bin/python';
type Action = 'refresh' | 'check' | 'cancel_check' | 'start' | 'stop';
type ResourceControls = { setVisible(visible: boolean): void; setBlocked(blocked: boolean): void; isBusy(): boolean; dispose(): void };
type ResourceFactory = (root: HTMLElement, onSelect: (patch: Partial<SpeechConfig>) => void, getDraft: () => SpeechConfig) => ResourceControls;
type Bridge = {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(name: string, callback: (event: { payload: T }) => void): Promise<() => void>;
};
const envStates = ['unknown', 'checking', 'passed', 'error'];
const serviceStates = ['unknown', 'stopped', 'starting', 'running', 'stopping', 'error'];
const modelStates = ['unknown', 'unloaded', 'loading', 'ready', 'generating', 'error'];
const owners = ['none', 'managed', 'external', 'unknown'];
const validRevision = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
export function isSpeechPreferences(v: unknown): v is SpeechPreferences {
  if (!v || typeof v !== 'object') return false;
  const s = v as SpeechPreferences;
  return validRevision(s.revision) && typeof s.initialized === 'boolean' && typeof s.auto_read === 'boolean'
    && Number.isInteger(s.volume) && s.volume >= 0 && s.volume <= 100;
}
export function isSpeechSnapshot(v: unknown): v is SpeechSnapshot {
  if (!v || typeof v !== 'object') return false;
  const s = v as SpeechSnapshot;
  return validRevision(s.revision) && typeof s.configured === 'boolean' && typeof s.busy === 'boolean'
    && !!s.config && ['python_path', 'model_dir', 'native_lib'].every(k => typeof s.config[k as keyof SpeechConfig] === 'string')
    && (s.distribution === null || typeof s.distribution === 'string') && (s.operation === null || typeof s.operation === 'string')
    && envStates.includes(s.environment_state) && envStates.includes(s.models_state)
    && serviceStates.includes(s.service_state) && modelStates.includes(s.model_state) && owners.includes(s.ownership)
    && (s.model_progress === null || Number.isFinite(s.model_progress) && s.model_progress >= 0 && s.model_progress <= 100)
    && (s.gpu_name === null || typeof s.gpu_name === 'string') && typeof s.message === 'string'
    && (s.error === null || typeof s.error === 'string') && Array.isArray(s.logs) && s.logs.every(l => typeof l === 'string');
}
/** Copy only typed state, never paths, prompts, arbitrary errors or subprocess output. */
export function speechDiagnostics(s?: SpeechSnapshot, p?: SpeechPreferences): string {
  return JSON.stringify({ revision: s?.revision ?? null, configured: s?.configured ?? false,
    environment_state: s?.environment_state ?? 'unknown', models_state: s?.models_state ?? 'unknown',
    model_progress: s?.model_progress ?? null, service_state: s?.service_state ?? 'unknown',
    ownership: s?.ownership ?? 'unknown', model_state: s?.model_state ?? 'unknown',
    busy: s?.busy ?? false, error_present: !!s?.error, preferences_revision: p?.revision ?? null }, null, 2);
}
export const speechSettingsMarkup = `<div class="setting-group"><div class="toggle-row"><div><h2>自动朗读回复</h2><p>默认关闭。与桌宠右键菜单同步，仅朗读以后新完成的短回复。</p></div>
<label class="switch"><input id="speech-auto" type="checkbox" aria-label="自动朗读回复" disabled><span></span></label></div>
<label class="speech-volume-label" for="speech-volume">音量 <span id="speech-volume-label">100%</span></label><input id="speech-volume" type="range" min="0" max="100" step="1" value="100" disabled>
<div class="speech-actions"><button id="speech-test" class="button secondary" disabled>试听固定文本</button><button id="speech-cancel_test" class="button secondary" disabled>停止试听</button></div>
<p class="setting-help">试听仅允许本页播放，不代表桌宠已获得自动播放权限；请在桌宠点击朗读或开启自动朗读。</p>
<p id="speech-audio-message" class="setting-help" role="status"></p></div>
<div class="setting-group"><h2>本地千问语音</h2>
<p class="setting-help">使用 WSL 中的 Q8 模型和固定音色朗读，需要匹配显卡后端的运行依赖。可选择已有模型或手动确认下载；打开本页、刷新状态或切换自动朗读均不会隐式安装、创建环境或加载模型；仅显式点击“初始化语音环境”才准备离线环境与本地配置。</p>
<dl class="connection-info"><div><dt>当前 WSL 发行版</dt><dd id="speech-distribution">未知</dd></div></dl>
<label for="speech-model_dir">模型目录（WSL 绝对路径）</label><input id="speech-model_dir" type="text" maxlength="4096" autocomplete="off" spellcheck="false" readonly aria-readonly="true" disabled>
<label for="speech-python_path">Python（托管默认路径，只读）</label><input id="speech-python_path" type="text" maxlength="4096" autocomplete="off" spellcheck="false" readonly aria-readonly="true" disabled>
<p class="setting-help">固定使用 ~/.dsh-wsl-desktop/speech/runtime/venv/bin/python，不支持手动指定 Python；旧外置路径将忽略。首次使用请点击“初始化语音环境”准备默认路径。</p>
<div id="speech-resources"></div>
<details class="speech-paths"><summary>高级：原生库路径</summary>
<label for="speech-native_lib">原生库文件</label><input id="speech-native_lib" type="text" maxlength="4096" autocomplete="off" spellcheck="false" readonly aria-readonly="true" disabled>
<p class="setting-help">需使用匹配显卡后端的 Q8 原生库：AMD 使用 ROCm，NVIDIA 使用 CUDA；自动模式优先 CUDA0，再尝试 ROCm0，仍需实际 GPU 验证。下载模型不会安装 Python 依赖或编译此库。</p></details>
<p id="speech-draft" class="setting-help"></p><button id="speech-save" class="button primary" disabled>保存并检测候选路径</button></div>
<div class="setting-group"><h2>运行状态</h2><dl class="connection-info">
<div><dt>环境</dt><dd id="speech-environment_state">未知</dd></div><div><dt>模型文件</dt><dd id="speech-models_state">未知</dd></div>
<div><dt>语音服务</dt><dd id="speech-service_state">未知</dd></div><div><dt>模型</dt><dd id="speech-model_state">未知</dd></div>
<div><dt>进程归属</dt><dd id="speech-ownership">未知</dd></div><div><dt>GPU</dt><dd id="speech-gpu">未知</dd></div></dl>
<progress id="speech-progress" max="100" hidden></progress><span id="speech-progress-label" class="setting-help"></span>
<p id="speech-message" class="setting-help" role="status" aria-live="polite"></p><div class="speech-actions">
<button id="speech-refresh" class="button secondary" disabled>刷新状态</button><button id="speech-check" class="button secondary" disabled>检测环境与模型</button>
<button id="speech-cancel_check" class="button secondary" disabled>取消检测</button><button id="speech-start" class="button primary" disabled>启动并加载模型</button>
<button id="speech-stop" class="button secondary" disabled>停止并释放显存</button></div>
<p class="setting-help">停止会取消生成并释放托管模型；外部服务只能到其原终端停止。</p></div>
<details class="setting-group"><summary>安全诊断摘要</summary><pre id="speech-diagnostics" tabindex="0"></pre>
<button id="speech-copy" class="button secondary" disabled>复制诊断</button><p id="speech-copy-message" class="setting-help" role="status"></p></details>`;

/** Mounted in the existing settings section; all service traffic goes through native IPC. */
export class SpeechSettings {
  private resources?: ResourceControls;
  private snapshot?: SpeechSnapshot;
  private preferences?: SpeechPreferences;
  private visible = false;
  private disposed = false;
  private epoch = 0;
  private stops: (() => void)[] = [];
  private subscribed = false;
  private pending = 0;
  private pendingAction: string | undefined;
  private serial = 0;
  private prefPending = false;
  private dirty = false;
  private draftRevision = 0;
  private candidate?: { config: SpeechConfig; draft: number; revision: number };
  private error = '';
  private poll?: number;
  private refreshing = false;
  private player?: QwenSpeech;
  private audition: 'unplayed' | 'generating' | 'playing' | 'completed' | 'stopped' | 'failed' = 'unplayed';
  private readonly cleanup = new AbortController();
  constructor(private readonly root: HTMLElement, private readonly view: Window, private readonly native: boolean, private readonly bridge: Bridge, resourceFactory?: ResourceFactory) {
    root.innerHTML = speechSettingsMarkup;
    for (const key of ['model_dir', 'python_path', 'native_lib']) this.input(key).addEventListener('input', () => {
      this.dirty = true; this.draftRevision++; this.render();
    }, { signal: this.cleanup.signal });
    for (const action of ['refresh', 'check', 'cancel_check', 'start', 'stop'] as Action[]) this.button(action).addEventListener('click', () => { void this.action(action); }, { signal: this.cleanup.signal });
    this.button('save').addEventListener('click', () => { void this.save(); }, { signal: this.cleanup.signal });
    this.button('test').addEventListener('click', () => {
      if (this.button('test').disabled) return;
      // No await before unlock: permission is local to THIS page, not the PET webview.
      this.player?.unlock();
      this.error = '';
      this.player?.play('试听');
      this.render();
    }, { signal: this.cleanup.signal });
    this.button('cancel_test').addEventListener('click', () => this.player?.stop(), { signal: this.cleanup.signal });
    this.input('auto').addEventListener('change', () => { void this.setPreferences({ auto_read: this.input('auto').checked }); }, { signal: this.cleanup.signal });
    this.input('volume').addEventListener('input', () => {
      this.player?.setVolume(Number(this.input('volume').value));
      this.node('volume-label').textContent = this.input('volume').value + '%';
    }, { signal: this.cleanup.signal });
    this.input('volume').addEventListener('change', () => { void this.setPreferences({ volume: Number(this.input('volume').value) }); }, { signal: this.cleanup.signal });
    this.button('copy').addEventListener('click', () => { void this.copyDiagnostics(); }, { signal: this.cleanup.signal });
    this.resources = resourceFactory?.(this.node('resources'), patch => {
      if (!this.visible || this.disposed) return;
      let changed = false;
      for (const key of ['model_dir', 'python_path', 'native_lib'] as const) {
        if (typeof patch[key] === 'string' && this.input(key).value !== patch[key]) { this.input(key).value = patch[key]; changed = true; }
      }
      if (changed) { this.dirty = true; this.draftRevision++; this.render(); }
    }, () => this.getDraft());
    this.node('resources').addEventListener('speech-resources-busy', () => this.render(), { signal: this.cleanup.signal });
    this.render();
  }
  private node(id: string): HTMLElement { return this.root.querySelector<HTMLElement>('#speech-' + id)!; }
  private getDraft(): SpeechConfig {
    return { model_dir: this.input('model_dir').value.trim(), python_path: this.input('python_path').value.trim(), native_lib: this.input('native_lib').value.trim() };
  }
  private input(id: string): HTMLInputElement { return this.node(id) as HTMLInputElement; }
  private button(id: string): HTMLButtonElement { return this.node(id) as HTMLButtonElement; }
  private live(epoch: number): boolean { return this.visible && !this.disposed && this.epoch === epoch; }
  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible; this.epoch++;
    if (!visible) {
      this.resources?.setVisible(false);
      this.view.clearTimeout(this.poll); this.poll = undefined;
      this.stops.splice(0).forEach(stop => stop()); this.subscribed = false;
      if (this.player && this.player.state.phase !== 'idle') this.audition = 'stopped';
      this.player?.dispose(); this.player = undefined;
      if (this.pendingAction === 'check' || this.pendingAction === 'save' || this.candidate || this.snapshot?.operation === 'check' || this.snapshot?.environment_state === 'checking') {
        if (this.native) void this.bridge.invoke('speech_action', { action: 'cancel_check' }).catch(() => {});
      }
      this.candidate = undefined;
      this.pending = 0; this.pendingAction = undefined; this.prefPending = false; this.refreshing = false;
      return;
    }
    if (this.native) void this.connect(this.epoch);
    this.render();
  }
  private async connect(epoch: number): Promise<void> {
    try {
      const state = await this.bridge.listen<unknown>('launcher-speech-state', event => { if (this.live(epoch)) { this.acceptSnapshot(event.payload); this.render(); } });
      if (!this.live(epoch)) { state(); return; } this.stops.push(state);
      const prefs = await this.bridge.listen<unknown>('launcher-speech-preferences', event => { if (this.live(epoch)) { this.acceptPreferences(event.payload); this.render(); } });
      if (!this.live(epoch)) { prefs(); return; } this.stops.push(prefs);
      const stop = await this.bridge.listen<{ request_id: string }>('launcher-speech-stop', event => {
        if (this.live(epoch) && typeof event.payload?.request_id === 'string') this.player?.stopRequest(event.payload.request_id);
      });
      if (!this.live(epoch)) { stop(); return; } this.stops.push(stop);
      this.subscribed = true;
      this.player = new QwenSpeech({ view: this.view, enabled: true,
        synthesize: request => this.bridge.invoke<QwenAudio>('test_speech', { requestId: request.request_id }),
        cancel: requestId => this.bridge.invoke('cancel_speech_test', { requestId }),
        onComplete: () => { if (this.live(epoch)) this.audition = 'completed'; },
        onChange: state => {
          if (!this.live(epoch)) return;
          if (state.error) this.audition = 'failed';
          else if (state.phase === 'loading') this.audition = 'generating';
          else if (state.phase === 'speaking') this.audition = 'playing';
          else if (this.audition === 'generating' || this.audition === 'playing') this.audition = 'stopped';
          this.render();
        } });
      if (this.preferences) this.player.setVolume(this.preferences.volume);
      await Promise.all([this.readSnapshot(epoch), this.bridge.invoke<unknown>('get_speech_preferences').then(p => { if (this.live(epoch)) this.acceptPreferences(p); })]);
      if (this.live(epoch)) { this.error = ''; this.schedulePoll(epoch); }
    } catch {
      if (this.live(epoch)) { this.error = '无法读取语音设置。请重新进入本页重试；不会启动服务。'; this.stops.splice(0).forEach(stop => stop()); this.subscribed = false; this.player?.dispose(); this.player = undefined; }
    } finally { if (this.live(epoch)) this.render(); }
  }
  private acceptSnapshot(value: unknown): void {
    if (!isSpeechSnapshot(value) || this.snapshot && value.revision <= this.snapshot.revision) return;
    this.snapshot = value;
    const candidate = this.candidate;
    if (candidate && value.revision > candidate.revision && !value.busy) {
      const matches = Object.keys(candidate.config).every(key => value.config[key as keyof SpeechConfig] === candidate.config[key as keyof SpeechConfig]);
      if (!value.error && value.configured && matches) {
        if (candidate.draft === this.draftRevision) this.dirty = false;
        this.candidate = undefined;
      } else if (value.error) {
        this.candidate = undefined;
        this.error = '候选路径检测失败。草稿与原有效配置均保留；请修正路径后重试。';
      }
    }
    if (!this.dirty) {
      for (const key of ['model_dir', 'python_path', 'native_lib'] as const) this.input(key).value = value.config[key];
      // Do not revive legacy external Python via status polling or save it with other edits.
      if (!value.config.python_path.endsWith(defaultPythonSuffix)) this.input('python_path').value = '';
    }
  }
  private acceptPreferences(value: unknown): void {
    if (!isSpeechPreferences(value) || this.preferences && value.revision <= this.preferences.revision) return;
    this.preferences = value; this.player?.setVolume(value.volume);
  }
  private async readSnapshot(epoch: number): Promise<void> {
    const result = await this.bridge.invoke<unknown>('get_speech_settings');
    if (this.live(epoch)) this.acceptSnapshot(result);
  }
  private schedulePoll(epoch: number): void {
    if (!this.live(epoch)) return;
    this.poll = this.view.setTimeout(() => {
      if (!this.live(epoch)) return;
      void this.action('refresh').finally(() => { if (this.live(epoch)) this.schedulePoll(epoch); });
    }, 2500);
  }
  private async action(action: Action): Promise<void> {
    const interrupt = action === 'stop' || action === 'cancel_check';
    if (!this.native || !this.visible || !this.subscribed || this.disposed) return;
    if (action === 'refresh') {
      // The native manager rejects refresh during an operation; polling must not turn real loading into an error.
      if (this.refreshing || this.pending || this.snapshot?.busy || this.resources?.isBusy()) return;
      this.refreshing = true;
    }
    else if (!interrupt && (this.pending || this.operationBusy() || this.resources?.isBusy() || this.player?.state.phase !== 'idle')) return;
    if (interrupt && this.pendingAction === action) return;
    if (action === 'stop' && !this.canStop()) return;
    if (action === 'start' && (!this.snapshot?.configured || this.snapshot.ownership === 'external')) return;
    if (action === 'check' && !this.snapshot?.configured) return;
    if (interrupt) this.candidate = undefined;
    if (action === 'stop') this.player?.stop();
    const epoch = this.epoch, token = ++this.serial;
    if (action !== 'refresh') { this.pending = token; this.pendingAction = action; this.error = ''; }
    this.render();
    try {
      const result = await this.bridge.invoke<unknown>('speech_action', { action });
      if (this.live(epoch)) this.acceptSnapshot(result);
    } catch { if (this.live(epoch) && (action !== 'refresh' || this.serial === token)) this.error = '语音操作未完成。请刷新状态后重试；外部服务请到原终端管理。'; }
    finally { if (this.live(epoch)) { if (this.pending === token) { this.pending = 0; this.pendingAction = undefined; } if (action === 'refresh') this.refreshing = false; this.render(); } }
  }
  /** A periodic read-only status probe must not lock path editors or dismiss resource panels. */
  private operationBusy(): boolean {
    return !!this.snapshot?.busy && this.snapshot.operation !== 'refresh';
  }
  private canStop(): boolean {
    return this.snapshot?.ownership === 'managed' || this.pendingAction === 'start'
      || !!this.snapshot?.busy && this.snapshot.operation === 'start';
  }
  private pathsLocked(): boolean {
    const s = this.snapshot;
    return !!s && (s.service_state === 'running' || s.ownership === 'managed')
      && (['model_dir', 'python_path', 'native_lib'] as const).some(key => this.input(key).value.trim() !== s.config[key]);
  }
  private async save(): Promise<void> {
    if (!this.native || !this.visible || !this.subscribed || this.pending || this.operationBusy() || this.resources?.isBusy() || this.player?.state.phase !== 'idle' || !this.dirty) return;
    if (this.pathsLocked()) { this.error = '请先停止语音服务，再保存修改后的路径；草稿会保留。'; this.render(); return; }
    const config = this.getDraft();
    if (!config.python_path.endsWith(defaultPythonSuffix)) {
      this.error = 'Python 固定使用托管默认路径，请先点击“初始化语音环境”准备。'; this.render(); return;
    }
    if (Object.values(config).some(path => !path.startsWith('/') || path.startsWith('//') || path.includes(String.fromCharCode(92)) || Array.from(path).some(char => char.charCodeAt(0) < 32))) {
      this.error = '请填写三个已有文件或目录的 WSL 绝对路径，再保存并检测。'; this.render(); return;
    }
    const epoch = this.epoch, token = ++this.serial, draft = this.draftRevision;
    this.candidate = { config, draft, revision: this.snapshot?.revision ?? -1 };
    this.pending = token; this.pendingAction = 'save'; this.error = ''; this.render();
    try {
      const result = await this.bridge.invoke<unknown>('save_speech_config', { config });
      if (!this.live(epoch)) return;
      if (!isSpeechSnapshot(result)) throw new Error('invalid snapshot');
      this.acceptSnapshot(result);
      // save returns an initial busy snapshot. Only a matching final event clears the draft.
      if (result.error && this.candidate) {
        this.candidate = undefined;
        this.error = '候选路径检测失败。草稿与原有效配置均保留；请检查路径后重试。';
      }
    } catch { if (this.live(epoch) && this.candidate) { this.candidate = undefined; this.error = '路径检测或保存失败。草稿与原有效配置均保留；请修正路径后重试。'; } }
    finally { if (this.live(epoch) && this.pending === token) { this.pending = 0; this.pendingAction = undefined; this.render(); } }
  }
  private async setPreferences(patch: { auto_read?: boolean; volume?: number }): Promise<void> {
    if (!this.native || !this.visible || !this.subscribed || !this.preferences || this.prefPending) { this.render(); return; }
    const epoch = this.epoch; this.prefPending = true; this.error = ''; this.render();
    try { const p = await this.bridge.invoke('set_speech_preferences', { patch }); if (this.live(epoch)) this.acceptPreferences(p); }
    catch { if (this.live(epoch)) { this.error = '偏好保存失败，仍使用原设置。请重试。'; if (this.preferences) this.player?.setVolume(this.preferences.volume); } }
    finally { if (this.live(epoch)) { this.prefPending = false; this.render(); } }
  }
  private async copyDiagnostics(): Promise<void> {
    if (!this.native || !this.visible) return;
    try { await this.view.navigator.clipboard.writeText(speechDiagnostics(this.snapshot, this.preferences)); this.node('copy-message').textContent = '已复制状态摘要（不含路径、对话或原始日志）。'; }
    catch { this.node('copy-message').textContent = '无法访问剪贴板，请查看下方状态摘要。'; }
  }
  private render(): void {
    const s = this.snapshot, p = this.preferences;
    const enabled = this.native && this.visible && this.subscribed && !this.disposed;
    const active = !!this.player && this.player.state.phase !== 'idle';
    const externalBusy = !!this.pending || this.operationBusy() || active;
    const busy = externalBusy || !!this.resources?.isBusy();
    this.resources?.setBlocked(externalBusy || s?.service_state === 'running' || s?.ownership === 'managed');
    this.resources?.setVisible(enabled);
    const labels: Record<string, string> = { unknown: '未知', checking: '检测中', passed: '通过', error: '异常', stopped: '已停止', starting: '启动中', running: '运行中', stopping: '停止中', unloaded: '未加载', loading: '加载中', ready: '就绪', generating: '生成中' };
    for (const key of ['environment_state', 'models_state', 'service_state', 'model_state'] as const) this.node(key).textContent = labels[s?.[key] ?? 'unknown'];
    this.node('distribution').textContent = s?.distribution || '未知（沿用启动器配置）';
    this.node('ownership').textContent = ({ managed: '由启动器托管', external: '外部服务 · 不可在此停止', none: '无托管服务', unknown: '未知 · 不可停止' })[s?.ownership ?? 'unknown'] ?? '未知 · 不可停止';
    this.node('gpu').textContent = s?.gpu_name || '未知（检测后显示）';
    const progress = this.node('progress') as HTMLProgressElement;
    progress.hidden = s?.model_progress == null;
    if (s?.model_progress != null) progress.value = s.model_progress;
    this.node('progress-label').textContent = s?.model_progress == null ? '' : '模型校验 ' + Math.round(s.model_progress) + '%';
    this.node('draft').textContent = this.pathsLocked() ? '路径草稿已保留。请先停止语音服务，再保存并检测；外部服务请到原终端停止。' : this.dirty ? '未保存的路径草稿；检测通过后才替换原配置。' : s?.configured ? '当前使用已保存的配置。' : '尚未配置语音运行路径。';
    // Native snapshot errors are static safe diagnostics; raw RPC exceptions never reach this sink.
    const nativeError = s?.error?.replace(/[\r\n\t]+/g, ' ').slice(0, 400) || '';
    const problem = this.error ? this.error + (nativeError ? ' ' + nativeError : '') : nativeError ? nativeError + ' 请修正后重新检测。' : '';
    this.node('message').textContent = !this.native ? '浏览器预览不连接 WSL，不读取或更改本机语音配置。' : problem || (this.operationBusy() ? '正在执行语音操作；可取消检测或停止托管服务。' : active ? '正在试听，可随时停止。' : '先检测路径，再启动并加载模型，最后试听。');
    this.node('message').dataset.error = String(!!this.error || !!s?.error);
    this.node('audio-message').textContent = ({ unplayed: '最近试听：未试听', generating: '最近试听：生成中', playing: '最近试听：播放中', completed: '最近试听：播放完成', stopped: '最近试听：已停止', failed: '最近试听：失败。请点击试听允许本页音频，并检查服务状态。' })[this.audition];
    for (const key of ['model_dir', 'python_path', 'native_lib']) this.input(key).disabled = !enabled;
    this.button('save').disabled = !enabled || busy || !this.dirty || this.pathsLocked();
    this.button('refresh').disabled = !enabled || this.refreshing || !!this.pending || !!s?.busy || !!this.resources?.isBusy();
    this.button('check').disabled = !enabled || busy || !s?.configured;
    this.button('start').disabled = !enabled || busy || !s?.configured || s.ownership === 'external' || s.service_state === 'running' && s.model_state === 'ready';
    this.button('stop').disabled = !enabled || !this.canStop() || s?.service_state === 'stopping' || this.pendingAction === 'stop';
    this.button('cancel_check').disabled = !enabled || !(this.pendingAction === 'check' || this.pendingAction === 'save' || this.candidate || s?.environment_state === 'checking' || s?.models_state === 'checking');
    this.button('test').disabled = !enabled || busy || !this.player?.state.supported || !p || s?.model_state !== 'ready' || s?.service_state !== 'running';
    this.button('cancel_test').disabled = !enabled || !active;
    this.input('auto').checked = p?.auto_read ?? false;
    this.input('auto').disabled = this.input('volume').disabled = !enabled || !p || this.prefPending;
    this.input('volume').value = String(p?.volume ?? 100);
    this.node('volume-label').textContent = (p?.volume ?? 100) + '%';
    this.button('copy').disabled = !this.native || !s;
    this.node('diagnostics').textContent = speechDiagnostics(s, p);
  }
  dispose(): void { if (this.disposed) return; this.setVisible(false); this.disposed = true; this.resources?.dispose(); this.cleanup.abort(); }
}
