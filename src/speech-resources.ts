import './speech-resources.css';

export type Bridge = {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(name: string, callback: (event: { payload: T }) => void): Promise<() => void>;
};
export type SpeechInstallStatus = {
  id: number; status: 'idle' | 'installing' | 'completed' | 'cancelled' | 'error';
  stage: string; downloaded_bytes: number; total_bytes: number | null; error: string | null;
};
export type SpeechPrerequisites = {
  ready: boolean;
  checks: { id: 'platform' | 'python' | 'tools' | 'gpu'; status: 'ready' | 'action' | 'unsupported'; detail: string }[];
  install_command: string | null;
};
const systemInstallCommand = 'sudo apt-get update && sudo apt-get install -y python3 python3-venv git build-essential coreutils bash';
export function isSpeechPrerequisites(value: unknown): value is SpeechPrerequisites {
  if (!value || typeof value !== 'object') return false;
  const s = value as SpeechPrerequisites;
  const ids = ['platform', 'python', 'tools', 'gpu'];
  return typeof s.ready === 'boolean' && Array.isArray(s.checks) && s.checks.length === ids.length
    && s.checks.every(c => c && ids.includes(c.id) && ['ready', 'action', 'unsupported'].includes(c.status)
      && typeof c.detail === 'string' && c.detail.length > 0 && c.detail.length <= 500)
    && new Set(s.checks.map(c => c.id)).size === ids.length
    && s.ready === s.checks.every(c => c.status === 'ready')
    && (s.install_command === null || !s.ready && s.install_command === systemInstallCommand);
}
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export function isSpeechInstallStatus(v: unknown): v is SpeechInstallStatus {
  if (!v || typeof v !== 'object') return false;
  const s = v as SpeechInstallStatus;
  return integer(s.id) && ['idle', 'installing', 'completed', 'cancelled', 'error'].includes(s.status)
    && typeof s.stage === 'string' && s.stage.length <= 1000
    && integer(s.downloaded_bytes) && (s.total_bytes === null || integer(s.total_bytes))
    && (s.total_bytes === null || s.downloaded_bytes <= s.total_bytes)
    && (s.error === null || typeof s.error === 'string');
}
const terminal = (s: SpeechInstallStatus): boolean => ['completed', 'cancelled', 'error'].includes(s.status);
const safeText = (text: string): string => text.replace(/[\r\n\t]+/g, ' ').slice(0, 400);
const bytes = (value: number): string => value >= 1024 ** 3 ? (value / 1024 ** 3).toFixed(2) + ' GB' : (value / 1024 ** 2).toFixed(1) + ' MB';
const stageHints: Readonly<Record<string, string>> = {
  '准备安装': '正在启动安装任务，接下来会检查已有环境和可复用的资源。',
  '检查已有语音配置': '正在检查已有环境和模型，可用资源会直接复用，无需重复下载。',
  '准备默认语音环境': '正在准备 Python 环境和安装工具，所有目录由程序自动管理。',
  '识别可用显卡': '正在检测显卡，确认适合本机的语音运行环境。',
  '安装固定版本依赖': '正在下载并安装运行依赖和显卡工具包，体积较大，请耐心等待。',
  '获取固定版本源码': '正在获取语音引擎源码，下载完成后会自动开始编译。',
  '编译原生语音库': '正在为本机编译语音引擎，这一步可能较久，暂时无法计算百分比。',
  '下载并校验模型': '正在下载并校验模型文件，已有且校验通过的文件会直接复用。',
  '检测并保存语音配置': '正在检测环境与模型完整性，通过后自动保存配置；这还不是安装完成。',
  '正在取消并清理': '正在停止安装任务并清理临时文件，请等待取消完成后再重试。',
};
const markup = `<div class="speech-resource-panel"><h3>安装本地语音</h3>
<ol class="speech-install-steps" aria-label="安装步骤">
<li><div class="speech-step-heading"><strong>检查系统环境</strong><span id="speech-resource-step-environment" class="setting-help"></span></div>
<div id="speech-resource-prerequisites" hidden><p id="speech-resource-prerequisite-platform" class="setting-help" hidden></p><p id="speech-resource-prerequisite-python" class="setting-help" hidden></p><p id="speech-resource-prerequisite-tools" class="setting-help" hidden></p><p id="speech-resource-prerequisite-gpu" class="setting-help" hidden></p></div>
<div id="speech-resource-system-install" hidden><p class="setting-help">在当前 WSL 终端执行以下命令，完成后重新检查。</p><pre id="speech-resource-command" tabindex="0"></pre><button type="button" id="speech-resource-copy-command" class="button secondary" disabled>复制安装命令</button><span id="speech-resource-copy-message" class="setting-help" role="status"></span></div>
<button type="button" id="speech-resource-check" class="button secondary" disabled>检查环境</button></li>
<li><div class="speech-step-heading"><strong>安装语音组件</strong><span id="speech-resource-step-components" class="setting-help"></span></div></li>
<li><div class="speech-step-heading"><strong>下载并校验模型</strong><span id="speech-resource-step-models" class="setting-help"></span></div></li></ol>
<div class="speech-actions"><button type="button" id="speech-resource-install" class="button primary" disabled>安装语音组件与模型</button><button type="button" id="speech-resource-cancel" class="button secondary" hidden disabled>取消安装</button></div>
<p id="speech-resource-message" class="setting-help" role="status" aria-live="polite"></p>
<p id="speech-resource-detail" class="setting-help" hidden></p>
<progress id="speech-resource-progress" max="100" aria-label="本地语音安装进度" aria-describedby="speech-resource-detail speech-resource-progress-label" hidden></progress><p id="speech-resource-progress-label" class="setting-help"></p></div>`;

/** The backend owns installation and persistence; this view only requests and observes it. */
export class SpeechResources {
  private visible = false;
  private blocked = false;
  private disposed = false;
  private epoch = 0;
  private events = 0;
  private connection = 0;
  private serial = 0;
  private pending = 0;
  private cancelling = 0;
  private ready = false;
  private connecting = false;
  private state?: SpeechInstallStatus;
  private stops: (() => void)[] = [];
  private lastBusy = false;
  private completedId?: number;
  private message = '';
  private prerequisites?: SpeechPrerequisites;
  private checking = false;
  private prerequisiteError = '';
  private copyMessage = '';
  private readonly cleanup = new AbortController();
  constructor(private readonly root: HTMLElement, private readonly view: Window, private readonly native: boolean, private readonly bridge: Bridge) {
    root.innerHTML = markup;
    this.button('install').addEventListener('click', () => {
      if (!this.ready) { if (this.native && this.visible && !this.disposed && !this.connecting) void this.connect(this.epoch); }
      else void this.install();
    }, { signal: this.cleanup.signal });
    this.button('check').addEventListener('click', () => { void this.checkPrerequisites(this.epoch); }, { signal: this.cleanup.signal });
    this.button('copy-command').addEventListener('click', () => { void this.copyInstallCommand(); }, { signal: this.cleanup.signal });
    this.button('cancel').addEventListener('click', () => { void this.cancel(); }, { signal: this.cleanup.signal });
    this.render();
  }
  private node(id: string): HTMLElement { return this.root.querySelector<HTMLElement>('#speech-resource-' + id)!; }
  private button(id: string): HTMLButtonElement { return this.node(id) as HTMLButtonElement; }
  private live(epoch: number): boolean { return !this.disposed && this.visible && epoch === this.epoch; }
  isBusy(): boolean { return this.native && this.visible && (!this.ready || !!this.pending || !!this.cancelling || this.state?.status === 'installing'); }
  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible; this.epoch++;
    this.ready = false; this.pending = 0; this.cancelling = 0; this.connecting = false; this.message = '';
    this.prerequisites = undefined; this.checking = false; this.prerequisiteError = ''; this.copyMessage = '';
    this.stops.splice(0).forEach(stop => stop());
    if (visible && this.native) void this.connect(this.epoch);
    this.render();
  }
  setBlocked(blocked: boolean): void {
    if (this.disposed || this.blocked === blocked) return;
    this.blocked = blocked; this.render();
  }
  private async connect(epoch: number): Promise<void> {
    this.connecting = true; this.message = ''; this.render();
    const version = this.events, connection = ++this.connection;
    try {
      this.stops.splice(0).forEach(stop => stop());
      const stop = await this.bridge.listen<unknown>('launcher-speech-install', event => {
        if (!this.live(epoch) || connection !== this.connection || !isSpeechInstallStatus(event.payload)) return;
        if (this.accept(event.payload)) { this.events++; this.message = ''; }
        this.render();
      });
      if (!this.live(epoch)) { stop(); return; }
      this.stops.push(stop);
      const result = await this.bridge.invoke<unknown>('get_speech_install');
      if (!this.live(epoch)) return;
      this.acceptReply(result, version); this.ready = true;
      if (this.state?.status !== 'installing' && this.state?.status !== 'completed') void this.checkPrerequisites(epoch);
    } catch {
      if (this.live(epoch)) { this.connection++; this.message = '无法读取安装状态，请点击重试读取状态；不会自动安装。'; this.stops.splice(0).forEach(stop => stop()); }
    } finally { if (this.live(epoch)) { this.connecting = false; this.render(); } }
  }
  private accept(state: SpeechInstallStatus): boolean {
    const old = this.state;
    if (old && (state.id < old.id || state.id === old.id && (terminal(old) || old.status !== 'idle' && state.status === 'idle'))) return false;
    this.state = state;
    if (terminal(state)) this.pending = 0;
    if (state.status === 'error' || state.status === 'cancelled') void this.checkPrerequisites(this.epoch);
    if (state.status === 'completed' && this.completedId !== state.id) {
      this.completedId = state.id;
      this.root.dispatchEvent(new Event('speech-resources-completed'));
    }
    return true;
  }
  private acceptReply(value: unknown, version: number): void {
    if (!isSpeechInstallStatus(value)) throw Error('invalid installation status');
    // A response sampled before a newer event must not rewind its stage or byte count.
    if (version === this.events || !this.state || value.id > this.state.id || terminal(value)) this.accept(value);
  }
  private async checkPrerequisites(epoch: number): Promise<void> {
    if (!this.live(epoch) || !this.native || !this.ready || this.checking || this.pending || this.state?.status === 'installing' || this.state?.status === 'completed') return;
    this.checking = true; this.prerequisites = undefined; this.prerequisiteError = ''; this.copyMessage = ''; this.render();
    try {
      const result = await this.bridge.invoke<unknown>('check_speech_prerequisites');
      if (!this.live(epoch)) return;
      if (!isSpeechPrerequisites(result)) throw Error('invalid prerequisites');
      this.prerequisites = result;
    } catch {
      if (this.live(epoch)) this.prerequisiteError = '检查失败，请确认当前 WSL 可用后重新检查。';
    } finally { if (this.live(epoch)) { this.checking = false; this.render(); } }
  }
  private async copyInstallCommand(): Promise<void> {
    const command = this.prerequisites?.install_command, epoch = this.epoch;
    if (!this.live(epoch) || !this.native || this.checking || !command || this.state?.status === 'installing' || this.pending) return;
    try {
      await this.view.navigator.clipboard.writeText(command);
      if (this.live(epoch)) this.copyMessage = '已复制，请在当前 WSL 终端执行。';
    } catch {
      if (this.live(epoch)) this.copyMessage = '复制失败，请选中上方命令手动复制。';
    }
    if (this.live(epoch)) this.render();
  }
  private renderSteps(active: boolean, stage: string): void {
    const completed = this.state?.status === 'completed';
    const available = this.native && this.visible && !this.disposed && this.ready;
    this.button('check').disabled = !available || this.checking || active || completed;
    this.button('check').hidden = completed || active;
    this.button('check').textContent = this.checking ? '正在检查…' : this.prerequisites || this.prerequisiteError ? '重新检查' : '检查环境';
    this.node('step-environment').textContent = !this.native ? '需在桌面应用中检查' : completed ? '已完成' : active ? '已进入安装' : this.checking ? '正在检查…' : this.prerequisiteError || (this.prerequisites ? this.prerequisites.ready ? '已就绪' : '需处理以下项目' : '待检查');
    this.node('prerequisites').hidden = active || completed || !this.prerequisites || this.prerequisites.ready;
    for (const id of ['platform', 'python', 'tools', 'gpu']) {
      const check = this.prerequisites?.checks.find(c => c.id === id), node = this.node('prerequisite-' + id);
      node.hidden = !check || check.status === 'ready';
      node.textContent = check && check.status !== 'ready' ? safeText(check.detail) : '';
    }
    const command = !active && !completed ? this.prerequisites?.install_command : null;
    this.node('system-install').hidden = !command;
    this.node('command').textContent = command ?? '';
    this.button('copy-command').disabled = !available || this.checking || !command;
    this.node('copy-message').textContent = this.copyMessage;
    const models = stage === '下载并校验模型', validating = stage === '检测并保存语音配置';
    const failed = this.state?.status === 'error';
    const cancelled = this.state?.status === 'cancelled';
    const componentDone = completed || models || validating;
    this.node('step-components').textContent = completed ? '已完成' : componentDone ? '已完成' : active ? '进行中' : failed && stage ? '未完成，可重试' : cancelled ? '已暂停' : '等待开始';
    this.node('step-models').textContent = completed ? '已完成' : failed ? '待重试' : cancelled ? '已取消' : models || validating ? active ? validating ? '正在检测并保存' : '下载并校验中' : '等待继续' : '组件安装后自动继续';
  }
  private async install(): Promise<void> {
    if (!this.native || !this.visible || this.disposed || !this.ready || this.blocked || this.isBusy() || this.checking || !this.prerequisites?.ready || this.state?.status === 'completed') return;
    const epoch = this.epoch, token = ++this.serial, version = this.events;
    this.pending = token; this.message = ''; this.render();
    try {
      const result = await this.bridge.invoke<unknown>('install_speech');
      if (!this.live(epoch)) return;
      this.acceptReply(result, version);
    } catch {
      if (this.live(epoch) && this.pending === token) {
        // A transport failure does not prove that the backend did not start. Reconcile before retrying.
        this.ready = false; this.message = '未能确认安装状态，请重试读取状态后再操作。';
      }
    } finally { if (this.live(epoch) && this.pending === token) { this.pending = 0; this.render(); } else if (this.live(epoch)) this.render(); }
  }
  private async cancel(): Promise<void> {
    if (!this.native || !this.visible || this.disposed || this.cancelling || !(this.pending || this.state?.status === 'installing')) return;
    const epoch = this.epoch, token = ++this.serial, version = this.events;
    this.cancelling = token; this.message = ''; this.render();
    try {
      const result = await this.bridge.invoke<unknown>('cancel_speech_install');
      if (this.live(epoch)) this.acceptReply(result, version);
    } catch { if (this.live(epoch)) this.message = '取消安装未成功，请重试取消；安装可能仍在继续。'; }
    finally { if (this.live(epoch) && this.cancelling === token) { this.cancelling = 0; this.render(); } }
  }
  private render(): void {
    const enabled = this.native && this.visible && !this.disposed;
    const busy = this.isBusy(), active = !!this.pending || this.state?.status === 'installing';
    const status = this.state?.status;
    this.button('install').disabled = !enabled || this.connecting || (this.ready && (busy || this.blocked || this.checking || !this.prerequisites?.ready || status === 'completed'));
    this.button('install').textContent = !this.ready && this.message ? '重试读取状态' : this.connecting ? '正在读取状态…' : active ? '正在安装…' : status === 'completed' ? '已安装' : status === 'error' ? '重试安装' : status === 'cancelled' ? '重新安装' : '安装语音组件与模型';
    this.button('cancel').hidden = !active;
    this.button('cancel').disabled = !enabled || !active || !!this.cancelling;
    this.button('cancel').textContent = this.cancelling ? '正在取消…' : '取消安装';
    const stage = this.pending && status !== 'installing' ? '' : this.state?.stage ? safeText(this.state.stage) : '';
    this.node('message').textContent = !this.native ? '浏览器预览不连接 WSL，不能安装本地语音。' : this.message || (this.connecting ? '正在读取安装状态…' : this.cancelling ? '正在取消安装…' : active ? stage || '正在准备安装…' : status === 'completed' ? '安装完成，已检测并保存。可按需启动并加载模型，再试听；自动朗读保持原设置。' : status === 'error' ? '安装失败：' + safeText(this.state?.error || stage || '请检查网络与磁盘空间后重试。') : status === 'cancelled' ? '安装已取消，可重新安装；已下载的文件可能保留。' : this.blocked ? '请先停止语音服务或等待当前操作完成，再安装。' : this.prerequisites?.ready ? '环境已就绪，可安装语音组件与模型（需联网，可能占用数 GB）。' : '先完成系统环境检查，再继续安装。');
    this.renderSteps(active, stage);
    const confirming = this.connecting || !this.ready;
    const cancelling = !!this.cancelling || stage === '正在取消并清理';
    const detail = this.node('detail');
    detail.hidden = !active;
    detail.textContent = !active ? '' : confirming ? '正在确认后台任务状态；确认前不会重复启动安装。' : cancelling ? stageHints['正在取消并清理'] : stageHints[stage || '准备安装'] ?? '正在处理当前步骤，完成后会自动继续；耗时取决于网络和电脑性能。';
    const progress = this.node('progress') as HTMLProgressElement;
    progress.hidden = !active && status !== 'completed';
    // Bytes describe model downloads, not overall installation. Never reuse them for
    // validation, cancellation, a new attempt or an unconfirmed backend state.
    const downloading = active && !confirming && !cancelling && status === 'installing' && stage === '下载并校验模型';
    const total = downloading ? this.state?.total_bytes : null;
    const downloaded = downloading ? this.state?.downloaded_bytes ?? 0 : 0;
    if (!active && status === 'completed') progress.value = 100;
    else if (total != null && total > 0) progress.value = downloaded / total * 100;
    else progress.removeAttribute('value');
    this.node('progress-label').textContent = !active ? status === 'completed' ? '安装完成' : '' : confirming ? '正在确认进度…' : cancelling ? '正在取消，请稍候…' : total != null && total > 0 ? '模型文件 · ' + bytes(downloaded) + ' / ' + bytes(total) + ' · ' + Math.floor(downloaded / total * 100) + '%' : downloaded > 0 ? '模型文件已下载 ' + bytes(downloaded) + ' · 总大小待确定' : '当前阶段处理中，不代表整体完成比例';
    if (busy !== this.lastBusy) { this.lastBusy = busy; this.root.dispatchEvent(new Event('speech-resources-busy')); }
  }
  dispose(): void { if (this.disposed) return; this.setVisible(false); this.disposed = true; this.cleanup.abort(); }
}
