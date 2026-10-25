import type { SpeechConfig } from './speech-settings';
import './speech-resources.css';

export type Bridge = {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(name: string, callback: (event: { payload: T }) => void): Promise<() => void>;
};
type PathKind = keyof SpeechConfig;
const pythonStatusLabels = {
  ready: 'Python 版本与包元数据就绪',
  python_too_old: 'Python 版本过低，需要 ≥ 3.10',
  missing_rocm_sdk: '未检测到 rocm-sdk（AMD ROCm）',
  missing_cuda_runtime: '未检测到匹配的 CUDA / cuBLAS 运行库',
  missing_gpu_runtime: '未检测到可用的 ROCm / CUDA GPU 运行库',
  unsupported_backend: '后端依赖需要重新检测',
  gpu_unknown: '显卡未识别，暂不判断 GPU 依赖',
  unsupported_gpu: '当前语音后端暂不支持此显卡',
  probe_failed: 'Python 检测失败或超时',
} as const;
type GpuVendor = 'amd' | 'nvidia' | 'mixed' | 'intel' | 'unknown';
export type SpeechResourcesFound = {
  python_environments: { path: string; version: string; ready: boolean; status: keyof typeof pythonStatusLabels }[];
  model_dir: string; native_lib: string;
  gpu: { vendor: GpuVendor; names: string[] };
};
const gpuGuidance: Record<GpuVendor, string> = {
  amd: 'AMD 环境：使用支持该显卡的 Windows AMD / WSL 驱动、Python ≥ 3.10、匹配的 rocm-sdk 和 Q8 / ROCm 原生库。包元数据就绪不代表 GPU 可用，仍需保存并检测。',
  nvidia: 'NVIDIA 环境：需要支持 WSL2 的 Windows NVIDIA 驱动；CUDA 驱动 / 工具包或匹配的 CUDA 与 cuBLAS wheel，以及 Q8 / CUDA 原生库。请在 WSL 中用 nvidia-smi 确认可见。包元数据就绪不代表 GPU 或 ABI 实测通过，仍需保存并检测。',
  mixed: '检测到 AMD 与 NVIDIA 显卡。AMD 使用 ROCm，NVIDIA 使用 CUDA 驱动 / 工具包或匹配的 CUDA 与 cuBLAS wheel；自动模式优先 CUDA0，再尝试 ROCm0；两者均可用时原生库需匹配优先使用的 CUDA 后端。包元数据发现不代表硬件已实测，必须保存并进行实际 GPU / ABI 验证。',
  intel: '检测到 Intel 显卡，当前语音后端暂不支持；不要求安装 AMD ROCm 依赖。',
  unknown: '未能识别显卡类型（可能未暴露硬件信息、WSL 互操作被禁用或检测超时）。不会据此判定缺少 ROCm / CUDA；请检查 Windows 显卡驱动与 WSL GPU 可见性后重新检测。',
};
export type SpeechInitializationResult = {
  config: SpeechConfig; config_path: string; reused_python: boolean; created_venv: boolean;
};
export type SpeechDownloadStatus = {
  id: number; status: 'idle' | 'downloading' | 'completed' | 'cancelled' | 'error';
  model_dir: string; file: string | null; downloaded_bytes: number;
  total_bytes: number | null; error: string | null;
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
const pathValid = (v: string): boolean => v.startsWith('/') && !v.startsWith('//') && !/[\\\x00-\x1f\x7f]/.test(v) && v.length <= 4096;
export function isSpeechInitializationResult(v: unknown): v is SpeechInitializationResult {
  return object(v) && object(v.config)
    && typeof v.config.python_path === 'string' && pathValid(v.config.python_path)
    && typeof v.config.model_dir === 'string' && pathValid(v.config.model_dir)
    && typeof v.config.native_lib === 'string' && (v.config.native_lib === '' || pathValid(v.config.native_lib))
    && typeof v.config_path === 'string' && pathValid(v.config_path) && v.config_path.endsWith('/.dsh-wsl-desktop/speech/config.json')
    && typeof v.reused_python === 'boolean' && typeof v.created_venv === 'boolean'
    && v.reused_python !== v.created_venv;
}
export function isSpeechResourcesFound(v: unknown): v is SpeechResourcesFound {
  if (!object(v) || !object(v.gpu)) return false;
  const gpu = v.gpu;
  return typeof v.model_dir === 'string' && typeof v.native_lib === 'string'
    && ['amd', 'nvidia', 'mixed', 'intel', 'unknown'].includes(typeof gpu.vendor === 'string' ? gpu.vendor : '')
    && Array.isArray(gpu.names) && gpu.names.length <= 16 && gpu.names.every(n => typeof n === 'string' && n.length <= 200)
    && Array.isArray(v.python_environments) && v.python_environments.length <= 500
    && v.python_environments.every(p => object(p) && typeof p.path === 'string' && typeof p.version === 'string' && typeof p.ready === 'boolean'
      && typeof p.status === 'string' && Object.prototype.hasOwnProperty.call(pythonStatusLabels, p.status)
      && p.ready === (p.status === 'ready') && (!p.ready || gpu.vendor === 'amd' || gpu.vendor === 'nvidia' || gpu.vendor === 'mixed'));
}
export function isSpeechDownloadStatus(v: unknown): v is SpeechDownloadStatus {
  return object(v) && typeof v.id === 'number' && Number.isSafeInteger(v.id) && v.id >= 0 && typeof v.status === 'string' && ['idle', 'downloading', 'completed', 'cancelled', 'error'].includes(v.status)
    && typeof v.model_dir === 'string' && (v.file === null || typeof v.file === 'string')
    && typeof v.downloaded_bytes === 'number' && Number.isFinite(v.downloaded_bytes) && v.downloaded_bytes >= 0
    && (v.total_bytes === null || typeof v.total_bytes === 'number' && Number.isFinite(v.total_bytes) && v.total_bytes >= 0)
    && (v.error === null || typeof v.error === 'string');
}
const markup = "<div class=\"speech-resource-panel\"><h3>语音资源</h3>\n<p class=\"setting-help\">打开或刷新仅发现已有资源，不会隐式安装或创建语音环境。仅点击“初始化语音环境”才离线创建 ~/.dsh-wsl-desktop/ 下的环境与本地配置；优先复用可用 Python，不重装 ROCm、不联网 pip、不下载模型，缺少依赖仍需后续配置。</p>\n<div class=\"speech-actions\"><button type=\"button\" id=\"speech-resource-initialize\" class=\"button primary\" disabled>初始化语音环境</button><button type=\"button\" id=\"speech-resource-initialize-cancel\" class=\"button secondary\" disabled>取消初始化</button></div>\n<p id=\"speech-resource-gpu\" class=\"setting-help\" role=\"status\" aria-live=\"polite\"></p>\n<label for=\"speech-resource-python\">已发现的 Python</label><select id=\"speech-resource-python\" disabled><option value=\"\">尚未检测</option></select>\n<div class=\"speech-actions\"><button type=\"button\" id=\"speech-resource-discover\" class=\"button secondary\" disabled>重新检测显卡与 Python</button><button type=\"button\" id=\"speech-resource-python-browse\" class=\"button secondary\" disabled>选择 Python 文件…</button></div>\n<p id=\"speech-resource-found\" class=\"setting-help\"></p><div class=\"speech-actions\"><button type=\"button\" id=\"speech-resource-defaults\" class=\"button secondary\" disabled>使用检测结果填充空路径</button><button type=\"button\" id=\"speech-resource-model-browse\" class=\"button secondary\" disabled>选择模型文件夹…</button><button type=\"button\" id=\"speech-resource-native-browse\" class=\"button secondary\" disabled>选择原生库…</button></div>\n<p id=\"speech-resource-message\" class=\"setting-help\" role=\"status\" aria-live=\"polite\"></p>\n<div class=\"speech-actions\"><button type=\"button\" id=\"speech-resource-download\" class=\"button secondary\" disabled>下载模型…</button><button type=\"button\" id=\"speech-resource-download-cancel\" class=\"button secondary\" disabled>取消下载</button><button type=\"button\" id=\"speech-resource-download-retry\" class=\"button secondary\" hidden disabled>重试下载…</button></div>\n<section id=\"speech-resource-confirm\" class=\"speech-resource-box\" aria-labelledby=\"speech-resource-confirm-title\" hidden><h3 id=\"speech-resource-confirm-title\">确认下载模型</h3><p class=\"setting-help\">来源：<span id=\"speech-resource-source\"></span></p><p class=\"setting-help\">目标目录：<span id=\"speech-resource-target\"></span></p><p class=\"setting-help\">两个固定 Q8 GGUF 模型可能占用数 GB；实际体积以下载进度为准。请确认网络流量和 WSL 磁盘空间充足。不会下载或编译原生库，不安装依赖、不加载模型、不自动保存配置。</p><div class=\"speech-actions\"><button type=\"button\" id=\"speech-resource-confirm-yes\" class=\"button primary\" disabled>确认并开始下载</button><button type=\"button\" id=\"speech-resource-confirm-no\" class=\"button secondary\" disabled>取消</button></div></section>\n<progress id=\"speech-resource-progress\" max=\"100\" hidden></progress><p id=\"speech-resource-download-message\" class=\"setting-help\" role=\"status\" aria-live=\"polite\"></p></div>";

/** Resource choices are drafts only; the owner alone persists SpeechConfig. */
export class SpeechResources {
  private visible = false;
  private blocked = false;
  private disposed = false;
  private epoch = 0;
  private pickerEpoch = 0;
  private stops: (() => void)[] = [];
  private cleanup = new AbortController();
  private discovered = false;
  private discovering = false;
  private found?: SpeechResourcesFound;
  private picking = false;
  private confirming?: string;
  private download?: SpeechDownloadStatus;
  private downloadPending = false;
  private cancelPending = false;
  private downloadEvents = 0;
  private downloadReady = false;
  private initiatedTarget?: string;
  private completedId?: number;
  private initialization?: { cancelled: boolean; settled: boolean };
  private initializationCancelling = false;
  private lastBusy = false;
  private message = '';
  constructor(private readonly root: HTMLElement, private readonly view: Window, private readonly native: boolean,
    private readonly bridge: Bridge, private readonly onSelect: (patch: Partial<SpeechConfig>) => void,
    private readonly getDraft: () => SpeechConfig) {
    root.innerHTML = markup;
    const click = (id: string, handler: () => void) => this.node(id).addEventListener('click', handler, { signal: this.cleanup.signal });
    click('initialize', () => { void this.initialize(); });
    click('initialize-cancel', () => { void this.cancelInitialization(); });
    click('discover', () => { void this.discover(); });
    this.select().addEventListener('change', () => {
      if (!this.usable() || this.discovering) return;
      const path = this.select().value;
      if (pathValid(path) && this.found?.python_environments.some(p => p.path === path)) this.choose({ python_path: path });
    }, { signal: this.cleanup.signal });
    click('defaults', () => this.useDefaults());
    click('python-browse', () => { void this.pickPath('python_path'); });
    click('model-browse', () => { void this.pickPath('model_dir'); });
    click('native-browse', () => { void this.pickPath('native_lib'); });
    click('download', () => this.confirmDownload());
    click('download-retry', () => this.confirmDownload());
    click('confirm-no', () => { if (!this.usable()) return; this.confirming = undefined; this.render(); });
    click('confirm-yes', () => { void this.startDownload(); });
    click('download-cancel', () => { void this.cancelDownload(); });
    this.render();
  }
  private node(id: string): HTMLElement { return this.root.querySelector<HTMLElement>('#speech-resource-' + id)!; }
  private button(id: string): HTMLButtonElement { return this.node(id) as HTMLButtonElement; }
  private select(): HTMLSelectElement { return this.node('python') as HTMLSelectElement; }
  private live(epoch: number): boolean { return !this.disposed && this.visible && epoch === this.epoch; }
  private usable(): boolean { return this.native && this.visible && !this.disposed && !this.blocked && !this.initialization && !this.picking; }
  private downloadBusy(): boolean { return this.downloadPending || this.download?.status === 'downloading'; }
  isBusy(): boolean { return !!this.initialization || this.picking || this.downloadBusy(); }
  setVisible(visible: boolean): void {
    if (this.disposed || visible === this.visible) return;
    this.visible = visible; this.epoch++;
    if (!visible) {
      if (this.initialization) {
        // Invalidate before cancelling: neither the original reply nor cancellation can affect a later visit.
        this.initialization = undefined; this.initializationCancelling = false;
        this.message = '初始化已取消；已完成的本地文件可能保留，路径草稿不变。';
        void this.bridge.invoke('cancel_speech_initialization').catch(() => {});
      }
      this.stops.splice(0).forEach(stop => stop());
      this.downloadReady = false; this.discovering = false; this.downloadPending = false; this.cancelPending = false;
      this.confirming = undefined; this.invalidatePicker();
    } else if (this.native) {
      void this.connect(this.epoch);
      if (!this.discovered && !this.blocked) void this.discover();
    }
    this.render();
  }
  setBlocked(blocked: boolean): void {
    if (this.disposed || blocked === this.blocked) return;
    this.blocked = blocked;
    if (blocked) { this.confirming = undefined; this.invalidatePicker(); }
    else if (this.native && this.visible && !this.discovered && !this.discovering) void this.discover();
    this.render();
  }
  private async connect(epoch: number): Promise<void> {
    const version = this.downloadEvents;
    try {
      const stop = await this.bridge.listen<unknown>('launcher-speech-download', event => {
        if (!this.live(epoch) || !isSpeechDownloadStatus(event.payload)) return;
        this.downloadEvents++; this.acceptDownload(event.payload); this.render();
      });
      if (!this.live(epoch)) { stop(); return; }
      this.stops.push(stop);
      const state = await this.bridge.invoke<unknown>('get_speech_download');
      if (!this.live(epoch)) return;
      if (!isSpeechDownloadStatus(state)) throw Error('invalid status');
      if (version === this.downloadEvents || !this.download || state.id > this.download.id) this.acceptDownload(state);
      this.downloadReady = true;
    } catch {
      if (this.live(epoch)) this.message = '无法读取下载状态；请重新进入本页重试。仍可选择本地路径。';
    } finally { if (this.live(epoch)) this.render(); }
  }
  private async initialize(): Promise<void> {
    if (!this.usable() || this.isBusy() || this.discovering || this.picking) return;
    const epoch = this.epoch, draft = { ...this.getDraft() };
    const operation = { cancelled: false, settled: false };
    this.initialization = operation; this.confirming = undefined; this.invalidatePicker();
    this.message = '正在离线初始化语音环境与本地配置；优先复用已有 Python，不联网安装依赖、不重装 ROCm、不下载或加载模型…';
    this.render();
    try {
      const result = await this.bridge.invoke<unknown>('initialize_speech_environment', { config: draft });
      if (!this.live(epoch) || this.initialization !== operation || operation.cancelled) return;
      if (!isSpeechInitializationResult(result)) throw Error('invalid initialization');
      const current = this.getDraft(), patch: Partial<SpeechConfig> = {};
      for (const key of ['python_path', 'model_dir', 'native_lib'] as const) {
        if (current[key] === draft[key]) patch[key] = result.config[key];
      }
      if (Object.keys(patch).length) this.onSelect(patch);
      const python = result.created_venv ? '已离线创建 Python venv' : result.reused_python ? '已复用现有 Python' : 'Python 路径已准备';
      this.message = python + '。本地配置存储于：' + result.config_path
        + '。仅填充路径草稿，未保存为应用有效配置；更晚编辑的路径已保留。创建或复用 Python 不代表依赖、GPU、ABI 或模型检测通过；缺少依赖请继续配置，再手动保存并检测。不会自动启动或开启自动朗读。';
    } catch {
      if (this.live(epoch) && this.initialization === operation && !operation.cancelled)
        this.message = '初始化未完成。路径草稿保持不变；请检查本地 Python、目录权限和磁盘空间后重试。不会联网安装依赖。';
    } finally {
      operation.settled = true;
      if (this.live(epoch) && this.initialization === operation && !this.initializationCancelling) {
        this.initialization = undefined; this.render();
      }
    }
  }
  private async cancelInitialization(): Promise<void> {
    if (!this.native || !this.visible || this.disposed || !this.initialization || this.initializationCancelling) return;
    const epoch = this.epoch, operation = this.initialization;
    operation.cancelled = true; this.initializationCancelling = true;
    this.message = '正在取消初始化…'; this.render();
    try {
      await this.bridge.invoke('cancel_speech_initialization');
      if (!this.live(epoch) || this.initialization !== operation) return;
      this.initialization = undefined;
      this.message = '初始化已取消；已完成的本地文件可能保留，路径草稿不变。';
    } catch {
      if (this.live(epoch) && this.initialization === operation) {
        if (operation.settled) this.initialization = undefined;
        this.message = '取消初始化未成功，请重试或关闭本页；不会应用已取消操作的返回路径。';
      }
    } finally {
      if (this.live(epoch) && (!this.initialization || this.initialization === operation)) {
        this.initializationCancelling = false; this.render();
      }
    }
  }
  private async discover(): Promise<void> {
    if (!this.usable() || this.discovering) return;
    const epoch = this.epoch;
    this.discovering = true; this.message = '正在识别显卡并轻量发现已有 Python，不安装依赖或加载模型…'; this.render();
    try {
      const found = await this.bridge.invoke<unknown>('discover_speech_resources');
      if (!this.live(epoch)) return;
      if (!isSpeechResourcesFound(found)) throw Error('invalid discovery');
      this.found = found; this.discovered = true; this.populatePython();
      this.message = found.python_environments.length ? '发现完成。仅识别显卡并检测 Python 版本与包元数据，不代表 GPU 或 ABI 验证通过。选择只修改草稿，请另行保存并检测。' : '未发现 Python。可使用系统选择窗口选择已安装的 Python 可执行文件。';
    } catch { if (this.live(epoch)) this.message = '发现失败。可重新检测，或通过系统窗口选择已有的 WSL 路径。'; }
    finally { if (this.live(epoch)) { this.discovering = false; this.render(); } }
  }
  private populatePython(): void {
    const select = this.select(), document = this.root.ownerDocument;
    select.replaceChildren();
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '选择 Python（仅修改草稿）'; select.append(placeholder);
    for (const python of this.found?.python_environments ?? []) {
      const option = document.createElement('option'); option.value = python.path;
      option.textContent = python.path + ' · ' + python.version + ' · ' + pythonStatusLabels[python.status]; select.append(option);
    }
    const current = this.getDraft().python_path;
    select.value = this.found?.python_environments.some(p => p.path === current) ? current : '';
  }
  private choose(patch: Partial<SpeechConfig>): void {
    if (!this.usable()) return;
    this.onSelect(patch); this.message = '已更新路径草稿，尚未保存。'; this.render();
  }
  private useDefaults(): void {
    if (!this.usable() || !this.found || this.discovering) return;
    const draft = this.getDraft(), patch: Partial<SpeechConfig> = {};
    const python = this.found.python_environments.find(p => p.ready) ?? this.found.python_environments[0];
    if (!draft.python_path && python && pathValid(python.path)) patch.python_path = python.path;
    if (!draft.model_dir && pathValid(this.found.model_dir)) patch.model_dir = this.found.model_dir;
    if (!draft.native_lib && pathValid(this.found.native_lib)) patch.native_lib = this.found.native_lib;
    if (Object.keys(patch).length) this.choose(patch);
    else { this.message = '没有可填充的空路径；已有草稿保持不变。'; this.render(); }
  }
  private invalidatePicker(): void { this.pickerEpoch++; this.picking = false; }
  private async pickPath(kind: PathKind): Promise<void> {
    if (!this.usable() || this.isBusy() || this.discovering) return;
    const epoch = this.epoch, serial = ++this.pickerEpoch, draft = { ...this.getDraft() };
    this.picking = true; this.confirming = undefined;
    this.message = '请在 Windows 系统窗口中选择已配置 WSL 发行版内的路径；取消不会修改草稿。'; this.render();
    try {
      const path = await this.bridge.invoke<unknown>('pick_settings_path', { kind, currentPath: draft[kind] || null });
      if (!this.live(epoch) || serial !== this.pickerEpoch || this.blocked) return;
      if (path === null) { this.message = '已取消选择，路径草稿保持不变。'; return; }
      if (typeof path !== 'string' || !pathValid(path)) throw Error('invalid picker result');
      const current = this.getDraft();
      if ((['model_dir', 'python_path', 'native_lib'] as const).some(key => current[key] !== draft[key])) {
        this.message = '草稿已更新，已忽略旧选择结果。'; return;
      }
      this.onSelect({ [kind]: path }); this.message = '已更新路径草稿，尚未保存。';
    } catch {
      if (this.live(epoch) && serial === this.pickerEpoch) this.message = '无法选择该路径。仅支持已配置发行版内的 WSL 文件或目录，请重试。';
    } finally {
      if (this.live(epoch) && serial === this.pickerEpoch) { this.picking = false; this.render(); }
    }
  }
  private confirmDownload(): void {
    if (!this.usable() || !this.downloadReady || this.downloadPending || this.download?.status === 'downloading') return;
    const target = this.getDraft().model_dir.trim();
    if (!pathValid(target) || target === '/') { this.message = '请先选择用于下载模型的 WSL 绝对目录（不能是根目录）。'; this.render(); return; }
    this.invalidatePicker(); this.confirming = target; this.render();
  }
  private async startDownload(): Promise<void> {
    if (!this.usable() || !this.downloadReady || !this.confirming || this.downloadPending || this.download?.status === 'downloading') return;
    const target = this.confirming;
    // Confirmed target must still be the user's current draft when the action starts.
    if (this.getDraft().model_dir.trim() !== target) { this.confirming = undefined; this.message = '目标路径已改变，请重新确认下载。'; this.render(); return; }
    const epoch = this.epoch, version = this.downloadEvents;
    this.confirming = undefined; this.initiatedTarget = target; this.downloadPending = true; this.message = ''; this.render();
    try {
      const state = await this.bridge.invoke<unknown>('download_speech_model', { modelDir: target });
      if (!this.live(epoch)) return;
      if (!isSpeechDownloadStatus(state)) throw Error('invalid download');
      if (version === this.downloadEvents || !this.download || state.id > this.download.id) this.acceptDownload(state);
    } catch { if (this.live(epoch)) this.message = '下载未能开始。请检查目标目录和网络后，重新确认并重试。'; }
    finally { if (this.live(epoch)) { this.downloadPending = false; this.render(); } }
  }
  private async cancelDownload(): Promise<void> {
    if (!this.usable() || this.cancelPending || !(this.downloadPending || this.download?.status === 'downloading')) return;
    const epoch = this.epoch, version = ++this.downloadEvents;
    this.cancelPending = true; this.render();
    try {
      const state = await this.bridge.invoke<unknown>('cancel_speech_download');
      if (!this.live(epoch)) return;
      if (!isSpeechDownloadStatus(state)) throw Error('invalid download');
      if (version === this.downloadEvents || !this.download || state.id > this.download.id) this.acceptDownload(state);
    } catch { if (this.live(epoch)) this.message = '取消下载未成功，请重试；不会自动重启下载。'; }
    finally { if (this.live(epoch)) { this.cancelPending = false; this.render(); } }
  }
  private acceptDownload(state: SpeechDownloadStatus): void {
    if (this.download && state.id < this.download.id) return;
    if (this.download?.id === state.id) {
      if (this.download.status !== 'idle' && this.download.status !== 'downloading' && state.status !== this.download.status) return;
      if (this.download.status === 'downloading' && state.status === 'downloading' && state.downloaded_bytes < this.download.downloaded_bytes) return;
    }
    this.download = state;
    if (state.status === 'completed' && this.initiatedTarget === state.model_dir && this.completedId !== state.id) {
      this.completedId = state.id;
      if (this.usable() && this.getDraft().model_dir.trim() === state.model_dir) this.onSelect({ model_dir: state.model_dir });
    }
  }
  private render(): void {
    const usable = this.usable(), active = this.downloadBusy(), busy = this.isBusy();
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('button')) button.disabled = !usable;
    this.button('initialize').disabled = !usable || busy || this.discovering || this.picking;
    this.button('initialize-cancel').disabled = !this.native || !this.visible || this.disposed || !this.initialization || this.initializationCancelling;
    this.button('discover').disabled = !usable || this.discovering;
    this.select().disabled = !usable || this.discovering || !this.found?.python_environments.length;
    this.button('defaults').disabled = !usable || this.discovering || !this.found;
    for (const id of ['python-browse', 'model-browse', 'native-browse']) this.button(id).disabled = !usable || busy || this.discovering;
    this.node('gpu').textContent = this.found ? '检测到的显卡：' + (this.found.gpu.names.join('、') || '未知') + '。' + gpuGuidance[this.found.gpu.vendor] : this.discovering ? '正在识别显卡类型…' : '';
    this.node('found').textContent = this.found ? '检测推荐模型目录：' + (this.found.model_dir || '未发现') + '；原生库：' + (this.found.native_lib || '未发现，请使用系统窗口选择') : '';
    this.node('message').textContent = !this.native ? '浏览器预览：初始化、资源检测、路径浏览和下载均不可用，不会调用本机。' : this.blocked ? '当前操作期间暂停资源选择，请先完成检测或停止语音服务。' : this.message;
    this.button('download').disabled = !usable || !this.downloadReady || active;
    this.button('download-cancel').disabled = !usable || !active || this.cancelPending;
    const retry = this.download?.status === 'error' || this.download?.status === 'cancelled';
    this.button('download-retry').hidden = !retry;
    this.button('download-retry').disabled = !usable || !this.downloadReady || active;
    this.node('confirm').hidden = !this.confirming;
    this.node('target').textContent = this.confirming ?? '';
    this.node('source').textContent = 'Hugging Face · Serveurperso/Qwen3-TTS-GGUF（Q8，固定版本 b7ee2e8c7459c3bea99da23e3d178125a7d1713c）';
    const progress = this.node('progress') as HTMLProgressElement, state = this.download;
    progress.hidden = !active;
    if (state?.total_bytes && state.total_bytes > 0) progress.value = Math.min(100, 100 * state.downloaded_bytes / state.total_bytes);
    else progress.removeAttribute('value');
    const bytes = (n: number) => (n / 1024 / 1024).toFixed(1) + ' MiB';
    const labels = { idle: '尚未下载', downloading: '下载中', completed: '下载完成，尚需保存并检测路径', cancelled: '下载已取消，可重试', error: '下载失败，可重试' };
    this.node('download-message').textContent = state ? labels[state.status] + (state.status === 'idle' ? '' : ' · ' + bytes(state.downloaded_bytes) + (state.total_bytes === null ? ' / 总体积未知' : ' / ' + bytes(state.total_bytes))) + (state.file ? ' · ' + state.file.slice(0, 300) : '') + (state.error ? ' · ' + state.error.slice(0, 400) : '') : '';
    // The owner can lock its save/start/check buttons without coupling resource internals.
    if (busy !== this.lastBusy) { this.lastBusy = busy; this.root.dispatchEvent(new Event('speech-resources-busy')); }
  }
  dispose(): void {
    if (this.disposed) return;
    this.setVisible(false); this.disposed = true; this.epoch++; this.cleanup.abort(); this.render();
  }
}
