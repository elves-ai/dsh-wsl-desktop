import type { SpeechConfig } from './speech-settings';
import './speech-resources.css';

export type Bridge = {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(name: string, callback: (event: { payload: T }) => void): Promise<() => void>;
};
type PathKind = keyof SpeechConfig;
export type SpeechResourcesFound = {
  python_environments: { path: string; version: string; ready: boolean }[];
  model_dir: string; native_lib: string;
};
export type SpeechPathListing = {
  path: string; parent: string | null;
  entries: { name: string; path: string; directory: boolean }[]; truncated: boolean;
};
export type SpeechDownloadStatus = {
  id: number; status: 'idle' | 'downloading' | 'completed' | 'cancelled' | 'error';
  model_dir: string; file: string | null; downloaded_bytes: number;
  total_bytes: number | null; error: string | null;
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
const pathValid = (v: string): boolean => v.startsWith('/') && !v.startsWith('//') && !/[\\\x00-\x1f\x7f]/.test(v) && v.length <= 4096;
export function isSpeechResourcesFound(v: unknown): v is SpeechResourcesFound {
  return object(v) && typeof v.model_dir === 'string' && typeof v.native_lib === 'string'
    && Array.isArray(v.python_environments) && v.python_environments.length <= 500
    && v.python_environments.every(p => object(p) && typeof p.path === 'string' && typeof p.version === 'string' && typeof p.ready === 'boolean');
}
export function isSpeechPathListing(v: unknown): v is SpeechPathListing {
  return object(v) && typeof v.path === 'string' && pathValid(v.path)
    && (v.parent === null || typeof v.parent === 'string' && pathValid(v.parent)) && typeof v.truncated === 'boolean'
    && Array.isArray(v.entries) && v.entries.length <= 5000
    && v.entries.every(p => object(p) && typeof p.name === 'string' && typeof p.path === 'string' && pathValid(p.path) && typeof p.directory === 'boolean');
}
export function isSpeechDownloadStatus(v: unknown): v is SpeechDownloadStatus {
  return object(v) && typeof v.id === 'number' && Number.isSafeInteger(v.id) && v.id >= 0 && typeof v.status === 'string' && ['idle', 'downloading', 'completed', 'cancelled', 'error'].includes(v.status)
    && typeof v.model_dir === 'string' && (v.file === null || typeof v.file === 'string')
    && typeof v.downloaded_bytes === 'number' && Number.isFinite(v.downloaded_bytes) && v.downloaded_bytes >= 0
    && (v.total_bytes === null || typeof v.total_bytes === 'number' && Number.isFinite(v.total_bytes) && v.total_bytes >= 0)
    && (v.error === null || typeof v.error === 'string');
}
const markup = "<div class=\"speech-resource-panel\"><h3>语音资源</h3>\n<p class=\"setting-help\">仅发现现有 Python 和浏览 WSL 路径，不保存配置、不安装依赖、不加载模型。</p>\n<label for=\"speech-resource-python\">已发现的 Python</label><select id=\"speech-resource-python\" disabled><option value=\"\">尚未检测</option></select>\n<div class=\"speech-actions\"><button type=\"button\" id=\"speech-resource-discover\" class=\"button secondary\" disabled>重新检测 Python</button><button type=\"button\" id=\"speech-resource-python-browse\" class=\"button secondary\" disabled>浏览 Python 文件</button></div>\n<p id=\"speech-resource-found\" class=\"setting-help\"></p><div class=\"speech-actions\"><button type=\"button\" id=\"speech-resource-defaults\" class=\"button secondary\" disabled>使用检测结果填充空路径</button><button type=\"button\" id=\"speech-resource-model-browse\" class=\"button secondary\" disabled>浏览模型文件夹</button><button type=\"button\" id=\"speech-resource-native-browse\" class=\"button secondary\" disabled>浏览原生库</button></div>\n<p id=\"speech-resource-message\" class=\"setting-help\" role=\"status\" aria-live=\"polite\"></p>\n<section id=\"speech-resource-browser\" class=\"speech-resource-box\" aria-labelledby=\"speech-resource-browser-title\" hidden><h3 id=\"speech-resource-browser-title\">浏览 WSL 路径</h3>\n<label for=\"speech-resource-path\">WSL 绝对路径</label><input id=\"speech-resource-path\" type=\"text\" maxlength=\"4096\" autocomplete=\"off\" spellcheck=\"false\" disabled>\n<div class=\"speech-actions\"><button type=\"button\" id=\"speech-resource-parent\" class=\"button secondary\" disabled>父目录</button><button type=\"button\" id=\"speech-resource-go\" class=\"button secondary\" disabled>跳转</button></div>\n<ul id=\"speech-resource-entries\" class=\"speech-resource-entries\" aria-label=\"目录内容\"></ul><p id=\"speech-resource-browser-message\" class=\"setting-help\" role=\"status\"></p><p id=\"speech-resource-selected\" class=\"setting-help\"></p>\n<div class=\"speech-actions\"><button type=\"button\" id=\"speech-resource-choose\" class=\"button primary\" disabled>选择当前目录</button><button type=\"button\" id=\"speech-resource-browser-cancel\" class=\"button secondary\" disabled>取消</button></div></section>\n<div class=\"speech-actions\"><button type=\"button\" id=\"speech-resource-download\" class=\"button secondary\" disabled>下载模型…</button><button type=\"button\" id=\"speech-resource-download-cancel\" class=\"button secondary\" disabled>取消下载</button><button type=\"button\" id=\"speech-resource-download-retry\" class=\"button secondary\" hidden disabled>重试下载…</button></div>\n<section id=\"speech-resource-confirm\" class=\"speech-resource-box\" aria-labelledby=\"speech-resource-confirm-title\" hidden><h3 id=\"speech-resource-confirm-title\">确认下载模型</h3><p class=\"setting-help\">来源：<span id=\"speech-resource-source\"></span></p><p class=\"setting-help\">目标目录：<span id=\"speech-resource-target\"></span></p><p class=\"setting-help\">两个固定 Q8 GGUF 模型可能占用数 GB；实际体积以下载进度为准。请确认网络流量和 WSL 磁盘空间充足。不会下载或编译原生库，不安装依赖、不加载模型、不自动保存配置。</p><div class=\"speech-actions\"><button type=\"button\" id=\"speech-resource-confirm-yes\" class=\"button primary\" disabled>确认并开始下载</button><button type=\"button\" id=\"speech-resource-confirm-no\" class=\"button secondary\" disabled>取消</button></div></section>\n<progress id=\"speech-resource-progress\" max=\"100\" hidden></progress><p id=\"speech-resource-download-message\" class=\"setting-help\" role=\"status\" aria-live=\"polite\"></p></div>";

/** Resource choices are drafts only; the owner alone persists SpeechConfig. */
export class SpeechResources {
  private visible = false;
  private blocked = false;
  private disposed = false;
  private epoch = 0;
  private browseEpoch = 0;
  private stops: (() => void)[] = [];
  private cleanup = new AbortController();
  private discovered = false;
  private discovering = false;
  private found?: SpeechResourcesFound;
  private browser?: { kind: PathKind; listing?: SpeechPathListing; selected?: string };
  private browsing = false;
  private confirming?: string;
  private download?: SpeechDownloadStatus;
  private downloadPending = false;
  private cancelPending = false;
  private downloadEvents = 0;
  private downloadReady = false;
  private initiatedTarget?: string;
  private completedId?: number;
  private lastBusy = false;
  private message = '';
  constructor(private readonly root: HTMLElement, private readonly view: Window, private readonly native: boolean,
    private readonly bridge: Bridge, private readonly onSelect: (patch: Partial<SpeechConfig>) => void,
    private readonly getDraft: () => SpeechConfig) {
    root.innerHTML = markup;
    const click = (id: string, handler: () => void) => this.node(id).addEventListener('click', handler, { signal: this.cleanup.signal });
    click('discover', () => { void this.discover(); });
    this.select().addEventListener('change', () => {
      if (!this.usable() || this.discovering) return;
      const path = this.select().value;
      if (pathValid(path) && this.found?.python_environments.some(p => p.path === path)) this.choose({ python_path: path });
    }, { signal: this.cleanup.signal });
    click('defaults', () => this.useDefaults());
    click('python-browse', () => this.openBrowser('python_path'));
    click('model-browse', () => this.openBrowser('model_dir'));
    click('native-browse', () => this.openBrowser('native_lib'));
    click('parent', () => { if (this.usable() && this.browser?.listing?.parent && !this.browsing) void this.browse(this.browser.listing.parent); });
    click('go', () => this.go());
    this.input().addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); this.go(); } }, { signal: this.cleanup.signal });
    click('choose', () => this.chooseBrowser());
    click('browser-cancel', () => { if (!this.usable()) return; this.closeBrowser(); this.render(); });
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
  private input(): HTMLInputElement { return this.node('path') as HTMLInputElement; }
  private live(epoch: number): boolean { return !this.disposed && this.visible && epoch === this.epoch; }
  private usable(): boolean { return this.native && this.visible && !this.disposed && !this.blocked; }
  isBusy(): boolean { return this.downloadPending || this.download?.status === 'downloading'; }
  setVisible(visible: boolean): void {
    if (this.disposed || visible === this.visible) return;
    this.visible = visible; this.epoch++;
    if (!visible) {
      this.stops.splice(0).forEach(stop => stop());
      this.downloadReady = false; this.discovering = false; this.downloadPending = false; this.cancelPending = false;
      this.confirming = undefined; this.closeBrowser();
    } else if (this.native) {
      void this.connect(this.epoch);
      if (!this.discovered && !this.blocked) void this.discover();
    }
    this.render();
  }
  setBlocked(blocked: boolean): void {
    if (this.disposed || blocked === this.blocked) return;
    this.blocked = blocked;
    if (blocked) { this.confirming = undefined; this.closeBrowser(); }
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
  private async discover(): Promise<void> {
    if (!this.usable() || this.discovering) return;
    const epoch = this.epoch;
    this.discovering = true; this.message = '正在轻量发现已有 Python，不安装依赖或加载模型…'; this.render();
    try {
      const found = await this.bridge.invoke<unknown>('discover_speech_resources');
      if (!this.live(epoch)) return;
      if (!isSpeechResourcesFound(found)) throw Error('invalid discovery');
      this.found = found; this.discovered = true; this.populatePython();
      this.message = found.python_environments.length ? '发现完成。仅检测 Python 版本与包元数据，不代表 GPU 或 ABI 验证通过。选择只修改草稿，请另行保存并检测。' : '未发现 Python。可浏览已安装的 Python 可执行文件，或手动填写路径。';
    } catch { if (this.live(epoch)) this.message = '发现失败。可重新检测，或浏览并选择已有的 WSL 路径。'; }
    finally { if (this.live(epoch)) { this.discovering = false; this.render(); } }
  }
  private populatePython(): void {
    const select = this.select(), document = this.root.ownerDocument;
    select.replaceChildren();
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '选择 Python（仅修改草稿）'; select.append(placeholder);
    for (const python of this.found?.python_environments ?? []) {
      const option = document.createElement('option'); option.value = python.path;
      option.textContent = python.path + ' · ' + python.version + (python.ready ? ' · 版本与包元数据就绪' : ' · 版本或依赖不满足'); select.append(option);
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
  private openBrowser(kind: PathKind): void {
    if (!this.usable()) return;
    this.confirming = undefined; this.closeBrowser(); this.browser = { kind };
    const current = this.getDraft()[kind];
    // File selections start at their parent, avoiding a file-as-directory RPC.
    const path = current && pathValid(current) ? kind === 'model_dir' ? current : current.slice(0, current.lastIndexOf('/')) || '/' : null;
    this.input().value = path ?? ''; void this.browse(path);
  }
  private closeBrowser(): void { this.browseEpoch++; this.browser = undefined; this.browsing = false; this.node('entries').replaceChildren(); }
  private go(): void {
    if (!this.usable() || !this.browser || this.browsing) return;
    const path = this.input().value.trim();
    if (!pathValid(path)) { this.node('browser-message').textContent = '请输入 WSL 绝对路径，例如 /home/user/models。'; return; }
    void this.browse(path);
  }
  private async browse(path: string | null): Promise<void> {
    if (!this.usable() || !this.browser) return;
    const epoch = this.epoch, serial = ++this.browseEpoch, browser = this.browser;
    this.browsing = true; browser.selected = undefined; browser.listing = undefined; this.node('entries').replaceChildren();
    this.node('browser-message').textContent = '正在读取目录…'; this.render();
    try {
      const listing = await this.bridge.invoke<unknown>('browse_speech_path', { path, kind: browser.kind });
      if (!this.live(epoch) || serial !== this.browseEpoch || this.browser !== browser || this.blocked) return;
      if (!isSpeechPathListing(listing)) throw Error('invalid listing');
      browser.listing = listing; this.input().value = listing.path; this.populateEntries();
      this.node('browser-message').textContent = listing.truncated ? '目录项目较多，仅显示部分内容。可输入更具体的路径继续浏览。' : listing.entries.length ? '点击文件夹进入；选择文件后点击下方确认。' : '此目录没有可显示的项目。';
    } catch {
      if (this.live(epoch) && serial === this.browseEpoch) this.node('browser-message').textContent = '无法读取该目录。请检查 WSL 路径和访问权限后重试。';
    } finally { if (this.live(epoch) && serial === this.browseEpoch) { this.browsing = false; this.render(); } }
  }
  private populateEntries(): void {
    const list = this.node('entries'), browser = this.browser;
    list.replaceChildren();
    if (!browser) return;
    for (const entry of browser?.listing?.entries ?? []) {
      if (browser?.kind === 'model_dir' && !entry.directory) continue;
      const li = this.root.ownerDocument.createElement('li'), button = this.root.ownerDocument.createElement('button');
      button.type = 'button'; button.className = 'button secondary'; button.textContent = (entry.directory ? '文件夹 · ' : '文件 · ') + entry.name;
      button.addEventListener('click', () => {
        if (!this.usable() || this.browsing || this.browser !== browser) return;
        if (entry.directory) void this.browse(entry.path);
        else { browser.selected = entry.path; this.render(); }
      }, { signal: this.cleanup.signal });
      li.append(button); list.append(li);
    }
  }
  private chooseBrowser(): void {
    if (!this.usable() || this.browsing || !this.browser) return;
    const browser = this.browser, path = browser.kind === 'model_dir' ? browser.listing?.path : browser.selected;
    if (!path || !pathValid(path)) return;
    this.closeBrowser(); this.choose({ [browser.kind]: path });
  }
  private confirmDownload(): void {
    if (!this.usable() || !this.downloadReady || this.downloadPending || this.download?.status === 'downloading') return;
    const target = this.getDraft().model_dir.trim();
    if (!pathValid(target) || target === '/') { this.message = '请先填写或选择用于下载模型的 WSL 绝对目录（不能是根目录）。'; this.render(); return; }
    this.closeBrowser(); this.confirming = target; this.render();
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
    const usable = this.usable(), active = this.isBusy();
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('button')) button.disabled = !usable;
    this.button('discover').disabled = !usable || this.discovering;
    this.select().disabled = !usable || this.discovering || !this.found?.python_environments.length;
    this.button('defaults').disabled = !usable || this.discovering || !this.found;
    this.node('found').textContent = this.found ? '检测推荐模型目录：' + (this.found.model_dir || '未发现') + '；原生库：' + (this.found.native_lib || '未发现，请手动选择或填写') : '';
    this.node('message').textContent = !this.native ? '浏览器预览：资源检测、路径浏览和下载均不可用，不会调用本机。' : this.blocked ? '当前操作期间暂停资源选择，请先完成检测或停止语音服务。' : this.message;
    this.node('browser').hidden = !this.browser;
    this.input().disabled = !usable || this.browsing;
    this.button('go').disabled = !usable || this.browsing;
    this.button('parent').disabled = !usable || this.browsing || !this.browser?.listing?.parent;
    this.node('browser-title').textContent = this.browser?.kind === 'model_dir' ? '选择 WSL 模型文件夹' : this.browser?.kind === 'python_path' ? '选择 WSL Python 可执行文件' : '选择 WSL 原生库文件';
    this.button('choose').textContent = this.browser?.kind === 'model_dir' ? '选择当前目录' : '选择此文件';
    this.button('choose').disabled = !usable || this.browsing || !(this.browser?.kind === 'model_dir' ? this.browser.listing : this.browser?.selected);
    this.node('selected').textContent = this.browser?.selected ? '已选文件：' + this.browser.selected : '';
    for (const button of this.node('entries').querySelectorAll<HTMLButtonElement>('button')) button.disabled = !usable || this.browsing;
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
    if (active !== this.lastBusy) { this.lastBusy = active; this.root.dispatchEvent(new Event('speech-resources-busy')); }
  }
  dispose(): void {
    if (this.disposed) return;
    this.setVisible(false); this.disposed = true; this.epoch++; this.cleanup.abort(); this.render();
  }
}
