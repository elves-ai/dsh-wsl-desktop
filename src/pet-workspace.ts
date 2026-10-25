type WorkspaceStatus = 'ready' | 'unbound' | 'backend_changed' | 'invalid' | 'missing' | 'unavailable';
export interface WorkspaceSnapshot {
  status: WorkspaceStatus;
  distribution: string | null;
  path: string | null;
  message: string;
}
export function isWorkspaceSnapshot(value: unknown): value is WorkspaceSnapshot {
  if (!value || typeof value !== 'object') return false;
  const s = value as WorkspaceSnapshot;
  const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
  if (!['ready', 'unbound', 'backend_changed', 'invalid', 'missing', 'unavailable'].includes(s.status) || !text(s.message, 1000)) return false;
  if (s.status === 'unbound' || s.status === 'invalid') return s.path === null && s.distribution === null;
  return text(s.path, 4096) && s.path.startsWith('/') && !s.path.startsWith('//') && text(s.distribution, 256);
}
const markup = '<h2>对话工作目录</h2>'
  + '<p id="pet-workspace-help">桌面宠物对话固定使用 ~/.dsh-wsl-desktop/assistant，不能修改。开启宠物时会自动初始化；也可在这里手动初始化或修复缺失的目录。旧目录及其对话历史不搬移、不删除；真实对话历史仍由 DSH 保存，不是这个工作目录里的消息文件。</p>'
  + '<dl class="connection-info"><div><dt>WSL 发行版</dt><dd id="pet-workspace-distribution">尚未读取</dd></div></dl>'
  + '<label class="visually-hidden" for="pet-workspace-path">当前绑定的对话工作目录（只读）</label>'
  + '<div class="setting-path"><input id="pet-workspace-path" type="text" readonly aria-readonly="true" aria-describedby="pet-workspace-help pet-workspace-message" placeholder="尚未读取" spellcheck="false"><button id="pet-workspace-open" class="button secondary" type="button" disabled>打开目录查看</button></div>'
  + '<p id="pet-workspace-message" class="setting-help" role="status" aria-live="polite"></p>'
  + '<div class="setting-actions"><button id="pet-workspace-initialize" class="button primary" type="button" disabled>初始化宠物目录</button><button id="pet-workspace-refresh" class="button secondary" type="button" disabled>刷新工作目录</button></div>'
  + '<p class="setting-help">初始化会准备固定目录并连接宠物专用的 DSH 项目与会话，不会发送消息或调用付费模型；已有目录和历史不会被清空。读取或打开目录不会执行初始化。</p>';

type Bridge = { invoke<T>(command: string): Promise<T> };
/** No editable path or path argument: native code alone chooses and validates the bound folder. */
export class PetWorkspace {
  private visible = false;
  private disposed = false;
  private epoch = 0;
  private pending = false;
  private state?: WorkspaceSnapshot;
  private message = '';
  private failed = false;
  private readonly cleanup = new AbortController();
  constructor(private readonly root: HTMLElement, private readonly native: boolean, private readonly bridge: Bridge, private readonly onInitialized: () => void = () => {}) {
    root.innerHTML = markup;
    this.button('refresh').addEventListener('click', () => { void this.refresh(); }, { signal: this.cleanup.signal });
    this.button('open').addEventListener('click', () => { void this.open(); }, { signal: this.cleanup.signal });
    this.button('initialize').addEventListener('click', () => { void this.initialize(); }, { signal: this.cleanup.signal });
    this.render();
  }
  private node(id: string): HTMLElement { return this.root.querySelector<HTMLElement>('#pet-workspace-' + id)!; }
  private button(id: string): HTMLButtonElement { return this.node(id) as HTMLButtonElement; }
  private live(epoch: number): boolean { return !this.disposed && this.visible && epoch === this.epoch; }
  setVisible(visible: boolean): void {
    if (this.disposed) return;
    this.visible = visible;
    // A retained settings view can be re-entered without a visibilitychange event.
    this.epoch++; this.pending = false; this.state = undefined; this.message = ''; this.failed = false;
    if (visible) void this.refresh();
    this.render();
  }
  async refresh(): Promise<void> {
    if (!this.native || !this.visible || this.disposed || this.pending) return;
    await this.request('get_pet_workspace');
  }
  private async open(): Promise<void> {
    if (!this.native || !this.visible || this.disposed || this.pending || this.state?.status !== 'ready' || this.failed) return;
    await this.request('open_pet_workspace');
  }
  private async initialize(): Promise<void> {
    if (!this.native || !this.visible || this.disposed || this.pending) return;
    await this.request('initialize_pet_workspace');
  }
  private async request(command: 'get_pet_workspace' | 'open_pet_workspace' | 'initialize_pet_workspace'): Promise<void> {
    const epoch = this.epoch;
    this.pending = true; this.failed = false; this.message = command === 'get_pet_workspace' ? '正在读取工作目录…' : command === 'initialize_pet_workspace' ? '正在初始化宠物目录并连接会话…' : '正在打开目录…';
    // Never leave an old path looking authoritative while refreshing.
    if (command === 'get_pet_workspace') this.state = undefined;
    this.render();
    try {
      const result = await this.bridge.invoke<unknown>(command);
      if (!this.live(epoch)) return;
      if (!isWorkspaceSnapshot(result)) throw new Error('工作目录状态格式无效。');
      this.state = result;
      if (command === 'initialize_pet_workspace' && result.status === 'ready') this.onInitialized();
      this.message = result.status !== 'ready' ? result.message : command === 'open_pet_workspace' ? '已请求在资源管理器中打开目录。' : command === 'initialize_pet_workspace' ? '宠物目录已初始化，正在连接对话。' : result.message;
    } catch (error) {
      if (!this.live(epoch)) return;
      this.state = undefined; this.failed = true;
      const detail = (error instanceof Error ? error.message : typeof error === 'string' ? error : '').replace(/[\r\n\t]+/g, ' ').slice(0, 300);
      this.message = (command === 'get_pet_workspace' ? '无法读取工作目录，请刷新重试。' : command === 'initialize_pet_workspace' ? '初始化未完成，请检查 DSH 服务与 WSL 状态后重试。' : '打开目录未完成，请刷新工作目录后重试。') + detail;
    } finally {
      if (this.live(epoch)) { this.pending = false; this.render(); }
    }
  }
  private render(): void {
    const inactive = !this.native || !this.visible || this.disposed;
    const path = this.node('path') as HTMLInputElement;
    path.value = this.state?.path ?? '';
    path.placeholder = this.state?.status === 'unbound' ? '尚未绑定' : '尚未读取';
    this.node('distribution').textContent = this.state?.distribution ?? '—';
    this.button('open').disabled = inactive || this.pending || this.failed || this.state?.status !== 'ready';
    this.button('initialize').disabled = inactive || this.pending;
    this.button('refresh').disabled = inactive || this.pending;
    this.button('refresh').textContent = this.pending ? '处理中…' : '刷新工作目录';
    const message = this.node('message');
    message.textContent = !this.native ? '浏览器预览不读取、初始化或打开实际目录。' : this.message || '尚未读取工作目录。';
    message.dataset.error = String(this.failed || (!!this.state && !['ready', 'unbound'].includes(this.state.status)));
    this.root.setAttribute('aria-busy', String(this.pending));
  }
  dispose(): void {
    this.disposed = true; this.epoch++; this.pending = false; this.cleanup.abort(); this.render();
  }
}
