export interface PetMemoryEntry {
  id: string;
  kind: string;
  content: string;
  source_session_id: string | null;
  updated_at: string;
}
export interface PetMemorySnapshot {
  available: boolean;
  enabled: boolean;
  pet_id: string;
  name: string;
  persona: string;
  entries: PetMemoryEntry[];
  message: string | null;
  mode?: string;
  runtime_ready?: boolean;
  total?: number;
  next_offset?: number | null;
}
export const PET_MEMORY_LIMITS = { name: 40, persona: 240, content: 1000 } as const;
export function isPetMemorySnapshot(value: unknown): value is PetMemorySnapshot {
  if (!value || typeof value !== 'object') return false;
  const s = value as PetMemorySnapshot;
  const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !/[\u0000\u000b\u000c]/.test(v);
  if (typeof s.available !== 'boolean' || typeof s.enabled !== 'boolean' || !text(s.pet_id, 256)
      || (s.available && !s.pet_id.trim()) || !text(s.name, PET_MEMORY_LIMITS.name) || !text(s.persona, PET_MEMORY_LIMITS.persona)
      || !(s.message === null || text(s.message, 2000)) || !(s.mode === undefined || text(s.mode, 80))
      || !(s.runtime_ready === undefined || typeof s.runtime_ready === 'boolean')
      || !(s.total === undefined || (Number.isSafeInteger(s.total) && s.total >= 0))
      || !(s.next_offset === undefined || s.next_offset === null || (Number.isSafeInteger(s.next_offset) && s.next_offset > 0))
      || !Array.isArray(s.entries) || s.entries.length > 10
      || (s.total !== undefined && s.total < s.entries.length)) return false;
  const ids = new Set<string>();
  return s.entries.every(e => {
    if (!e || !text(e.id, 256) || !e.id.trim() || ids.has(e.id) || !text(e.kind, 80)
        || !text(e.content, PET_MEMORY_LIMITS.content) || !e.content.trim() || !(e.source_session_id === null || text(e.source_session_id, 256))
        || !text(e.updated_at, 80)) return false;
    ids.add(e.id); return true;
  });
}
type MemoryAction = { action: 'list'; offset: number; query: string }
  | { action: 'set_enabled'; enabled: boolean }
  | { action: 'update_persona'; name: string; persona: string }
  | { action: 'add'; kind: 'fact' | 'preference'; content: string }
  | { action: 'correct'; id: string; content: string }
  | { action: 'forget'; id: string; confirm: true }
  | { action: 'clear'; confirm: true };
type Bridge = { invoke<T>(command: string, args?: { request: MemoryAction }): Promise<T> };
// Static developer-owned markup only. All saved/user/native content is assigned via textContent/value.
const markup = '<div class="toggle-row"><div><h2>人格与长期记忆</h2><p id="pet-memory-consent">默认关闭。仅用于宠物对话，不影响 DSH 普通任务。开启后，人格与相关记忆会随桌宠对话发送给当前 DSH 模型。记忆不是工具授权，也不会自动共享其他知识库。</p></div><label class="switch"><input id="pet-memory-enabled" type="checkbox" aria-label="启用人格与长期记忆" aria-describedby="pet-memory-consent pet-memory-status pet-memory-message" disabled><span></span></label></div>'
  + '<p id="pet-memory-status" class="setting-help">尚未读取，未确认启用。</p><p id="pet-memory-message" class="setting-help" role="status" aria-live="polite"></p>'
  + '<button id="pet-memory-refresh" class="button secondary" type="button" disabled>重新读取记忆</button>'
  + '<p class="setting-help">仅从你明确说的“记住：…”保存信息，不自动推断，也不额外调用后台模型。关闭后停止对话中的记忆读取与写入，不删除已保存内容；仍可在此手动管理。</p>'
  + '<details class="setting-details" id="pet-memory-persona"><summary>宠物人格 · 由你设定</summary><p class="setting-help">保持简短、稳定。名字和语气只由你修改，记忆内容不能改变身份、权限或安全边界。</p>'
  + '<label for="pet-memory-name">名字</label><input id="pet-memory-name" type="text" maxlength="40" autocomplete="off" disabled>'
  + '<label for="pet-memory-tone">语气与表达习惯</label><textarea id="pet-memory-tone" maxlength="240" rows="3" placeholder="例如：温和、简洁，不替我作决定。" disabled></textarea>'
  + '<div class="setting-actions"><button id="pet-memory-save-persona" class="button secondary" type="button" disabled>保存人格</button></div></details>'
  + '<div class="pet-memory-heading"><h3>已保存的记忆</h3><div class="setting-actions"><button id="pet-memory-add" class="button secondary" type="button" disabled>手动新增</button><button id="pet-memory-clear" class="button secondary pet-memory-danger" type="button" disabled>忘记全部…</button></div></div>'
  + '<label class="visually-hidden" for="pet-memory-search">搜索记忆或来源会话</label><div class="setting-path"><input id="pet-memory-search" type="text" maxlength="200" placeholder="搜索内容、类型或来源会话" disabled><button id="pet-memory-search-button" class="button secondary" type="button" disabled>搜索</button></div>'
  + '<p id="pet-memory-count" class="setting-help"></p><ul id="pet-memory-list" class="pet-memory-list" aria-label="已保存的长期记忆"></ul><div class="setting-actions"><button id="pet-memory-first" class="button secondary" type="button" disabled>返回首页</button><button id="pet-memory-next" class="button secondary" type="button" disabled>下一页</button></div>'
  + '<div id="pet-memory-editor" class="pet-memory-editor" role="region" aria-labelledby="pet-memory-editor-title" hidden><h3 id="pet-memory-editor-title">手动新增记忆</h3><label for="pet-memory-kind">类型</label><select id="pet-memory-kind"><option value="fact">事实</option><option value="preference">偏好</option></select><label for="pet-memory-content">记忆内容（最多 1000 字）</label><textarea id="pet-memory-content" rows="3" maxlength="1000" placeholder="仅保存你希望宠物长期记住的信息，勿填密码或密钥。"></textarea><div class="setting-actions"><button id="pet-memory-save-entry" class="button primary" type="button">保存记忆</button><button id="pet-memory-cancel-edit" class="button secondary" type="button">取消</button></div></div>'
  + '<div id="pet-memory-confirm" class="pet-memory-confirm" role="region" aria-labelledby="pet-memory-confirm-title" hidden><h3 id="pet-memory-confirm-title">确认忘记</h3><p id="pet-memory-confirm-text"></p><p class="setting-help">此操作不可撤销。不删除原始 DSH 对话历史；旧会话仍可能保留原文。</p><div class="setting-actions"><button id="pet-memory-confirm-delete" class="button secondary pet-memory-danger" type="button">确认忘记</button><button id="pet-memory-cancel-delete" class="button secondary" type="button">取消</button></div></div>'
  + '<p class="setting-help">忘记只管理长期记忆，不会删除原始 DSH 历史；旧会话仍可能含有原文。不要保存密码、密钥或不希望发给模型的敏感信息。</p>';

export class PetMemory {
  private visible = false;
  private disposed = false;
  private epoch = 0;
  private pending = false;
  private state?: PetMemorySnapshot;
  private failed = false;
  private message = '';
  private personaDirty = false;
  private draftPetId?: string;
  private query = '';
  private offset = 0;
  private editor: 'add' | string | null = null;
  private confirmation: { id: string | null; petId: string } | null = null;
  private readonly cleanup = new AbortController();
  constructor(private readonly root: HTMLElement, private readonly native: boolean, private readonly bridge: Bridge) {
    root.innerHTML = markup;
    this.on('refresh', 'click', () => { void this.refresh(); });
    this.on('enabled', 'change', () => { void this.action({ action: 'set_enabled', enabled: this.input('enabled').checked }); });
    for (const id of ['name', 'tone']) this.on(id, 'input', () => { this.personaDirty = true; this.renderControls(); });
    this.on('save-persona', 'click', () => { void this.savePersona(); });
    this.on('search-button', 'click', () => this.search());
    this.node('search').addEventListener('keydown', event => { if ((event as KeyboardEvent).key === 'Enter') this.search(); }, { signal: this.cleanup.signal });
    this.on('first', 'click', () => { void this.action({ action: 'list', offset: 0, query: this.query }); });
    this.on('next', 'click', () => { const next = this.state?.next_offset; if (next !== null && next !== undefined && next > this.offset) void this.action({ action: 'list', offset: next, query: this.query }); });
    this.on('add', 'click', () => this.edit());
    this.on('content', 'input', () => this.renderControls());
    this.on('save-entry', 'click', () => { void this.saveEntry(); });
    this.on('cancel-edit', 'click', () => { if (!this.pending) { this.editor = null; this.render(); this.button('add').focus(); } });
    this.on('clear', 'click', () => this.askForget(null));
    this.on('cancel-delete', 'click', () => { this.confirmation = null; this.render(); this.button('clear').focus(); });
    this.on('confirm-delete', 'click', () => {
      const c = this.confirmation;
      if (!c || c.petId !== this.state?.pet_id || !this.writable()) return;
      void this.action(c.id === null ? { action: 'clear', confirm: true } : { action: 'forget', id: c.id, confirm: true });
    });
    this.render();
  }
  private node(id: string): HTMLElement { return this.root.querySelector<HTMLElement>('#pet-memory-' + id)!; }
  private input(id: string): HTMLInputElement { return this.node(id) as HTMLInputElement; }
  private button(id: string): HTMLButtonElement { return this.node(id) as HTMLButtonElement; }
  private on(id: string, event: string, fn: () => void): void { this.node(id).addEventListener(event, fn, { signal: this.cleanup.signal }); }
  private writable(): boolean { return this.native && this.visible && !this.disposed && !this.pending && !this.failed && this.state?.available === true; }
  setVisible(visible: boolean): void {
    if (this.disposed) return;
    this.visible = visible; this.epoch++; this.confirmation = null; this.state = undefined; this.failed = false; this.message = '';
    if (visible) void this.refresh();
    this.render();
  }
  async refresh(): Promise<void> {
    if (!this.native || !this.visible || this.disposed || this.pending) return;
    this.confirmation = null;
    await this.request();
  }
  private async action(request: MemoryAction): Promise<void> {
    if (!this.writable()) { this.renderControls(); return; }
    await this.request(request);
  }
  private async request(request?: MemoryAction): Promise<void> {
    const epoch = this.epoch;
    this.pending = true; this.failed = false;
    this.message = request?.action === 'list' ? '正在查询记忆…' : request ? '正在提交，请等待后端确认…' : '正在读取人格与长期记忆…';
    if (!request) this.state = undefined;
    this.render();
    try {
      const result = request
        ? await this.bridge.invoke<unknown>('pet_memory_action', { request })
        : await this.bridge.invoke<unknown>('get_pet_memory');
      if (this.disposed || epoch !== this.epoch || !this.visible) return;
      if (!isPetMemorySnapshot(result)) throw new Error('记忆状态格式无效，请更新服务后重试。');
      this.state = result;
      this.message = result.message || (result.available ? '已读取当前记忆状态。' : '记忆服务不可用，请恢复服务后重新读取。');
      if (result.available) {
        if (request?.action === 'list') { this.query = request.query; this.offset = request.offset; }
        else { this.query = ''; this.offset = 0; this.input('search').value = ''; }
        if (this.draftPetId && this.draftPetId !== result.pet_id) {
          this.personaDirty = false; this.editor = null; this.input('content').value = ''; this.input('search').value = '';
        }
        this.draftPetId = result.pet_id;
        if (request?.action === 'update_persona') this.personaDirty = false;
        if (!this.personaDirty) { this.input('name').value = result.name; this.input('tone').value = result.persona; }
        if (request?.action === 'add' || request?.action === 'correct') { this.editor = null; this.input('content').value = ''; }
        this.confirmation = null;
      }
    } catch (error) {
      if (this.disposed || epoch !== this.epoch || !this.visible) return;
      this.state = undefined; this.failed = true; this.confirmation = null;
      const detail = (typeof error === 'string' ? error : error instanceof Error ? error.message : '').replace(/[\r\n\t]+/g, ' ').slice(0, 300);
      this.message = (request?.action === 'list' ? '无法查询记忆，已禁止修改。草稿已保留，请重新读取后重试。'
        : request ? '操作结果未确认，请先重新读取，核对结果后再操作，避免重复新增。草稿已保留。'
        : '无法读取记忆，已禁止修改。请检查 DSH / WSL 服务后重新读取。') + (detail ? ' ' + detail : '');
    } finally {
      this.pending = false;
      if (!this.disposed && epoch !== this.epoch && this.visible) void this.refresh();
      else if (!this.disposed) this.render();
    }
  }
  private search(): void {
    const query = this.input('search').value.trim();
    if (query.length > 200) { this.message = '搜索最多 200 字。'; this.renderControls(); return; }
    this.confirmation = null;
    void this.action({ action: 'list', offset: 0, query });
  }
  private async savePersona(): Promise<void> {
    const name = this.input('name').value.trim(), persona = this.input('tone').value.trim();
    if (!name || name.length > PET_MEMORY_LIMITS.name || persona.length > PET_MEMORY_LIMITS.persona) { this.message = '请填写名字（最多 40 字），语气最多 240 字。'; this.renderControls(); return; }
    await this.action({ action: 'update_persona', name, persona });
  }
  private edit(entry?: PetMemoryEntry): void {
    if (!this.writable()) return;
    this.confirmation = null; this.editor = entry?.id ?? 'add';
    this.input('content').value = entry?.content ?? '';
    this.input('kind').value = entry?.kind === 'preference' ? 'preference' : 'fact';
    this.render(); this.node('content').focus();
  }
  private async saveEntry(): Promise<void> {
    if (!this.editor || !this.writable()) return;
    const content = this.input('content').value.trim();
    if (!content || content.length > PET_MEMORY_LIMITS.content) { this.message = '请填写记忆内容，最多 1000 字。'; this.renderControls(); return; }
    if (this.editor === 'add') await this.action({ action: 'add', kind: this.input('kind').value === 'preference' ? 'preference' : 'fact', content });
    else if (this.state?.entries.some(e => e.id === this.editor)) await this.action({ action: 'correct', id: this.editor, content });
    else { this.message = '这条记忆已不存在，请取消编辑后重新选择。'; this.renderControls(); }
  }
  private askForget(id: string | null): void {
    if (!this.writable() || !this.state || (id === null ? !(this.state.entries.length || this.query) : !this.state.entries.some(e => e.id === id))) return;
    this.confirmation = { id, petId: this.state.pet_id };
    this.render(); this.button('cancel-delete').focus();
  }
  private renderControls(): void {
    const writable = this.writable(), inactive = !this.native || !this.visible || this.disposed;
    this.input('enabled').checked = !!this.state?.available && this.state.enabled;
    for (const id of ['enabled', 'name', 'tone', 'add', 'kind', 'content', 'save-entry', 'confirm-delete']) this.input(id).disabled = !writable;
    this.button('save-persona').disabled = !writable || !this.personaDirty;
    this.button('save-entry').disabled = !writable || !this.input('content').value.trim();
    this.button('clear').disabled = !writable || !(this.state?.entries.length || this.query);
    this.button('search-button').disabled = !writable;
    this.button('first').disabled = !writable || this.offset === 0;
    this.button('next').disabled = !writable || this.state?.next_offset == null || this.state.next_offset <= this.offset;
    this.button('refresh').disabled = inactive || this.pending;
    this.button('cancel-edit').disabled = this.pending;
    this.button('cancel-delete').disabled = this.pending;
    this.input('search').disabled = !this.state?.available || inactive;
    this.node('status').textContent = !this.native ? '浏览器预览 · 未启用，不读取或修改实际记忆。'
      : !this.state ? '状态未确认 · 暂不允许修改。'
      : !this.state.available ? '记忆服务不可用 · 未确认启用，暂不允许修改。'
      : this.state.enabled && this.state.runtime_ready === true ? '已启用 · 人格与相关记忆会随桌宠对话发送给当前 DSH 模型。'
      : this.state.enabled ? '开关已打开 · 尚未确认对话接入生效。请检查 desktop-pet 专属扩展，并开始新对话后重新读取。'
      : '已关闭 · 不在桌宠对话中读取或写入记忆，已保存内容仍保留。';
    this.node('message').textContent = this.message;
    this.node('message').dataset.error = String(this.failed || (!!this.state && !this.state.available));
    this.node('editor').hidden = this.editor === null;
    this.node('editor-title').textContent = this.editor === 'add' ? '手动新增记忆' : '纠正记忆';
    this.input('kind').disabled = !writable || this.editor !== 'add';
    this.node('confirm').hidden = this.confirmation === null;
    if (this.confirmation && this.state) {
      const entry = this.state.entries.find(e => e.id === this.confirmation?.id);
      this.node('confirm-text').textContent = this.confirmation.id === null
        ? '确认忘记全部长期记忆？包括搜索或当前页未显示的记忆，不会重置名字和语气。'
        : '确认忘记这条长期记忆？“' + (entry?.content ?? '') + '”';
    }
    this.root.setAttribute('aria-busy', String(this.pending));
  }
  private renderList(): void {
    const list = this.node('list'); list.replaceChildren();
    const entries = this.state?.available ? this.state.entries : [];
    const filtered = entries;
    const total = this.state?.total ?? entries.length;
    this.node('count').textContent = !this.state?.available ? '读取成功后可查看和搜索记忆。'
      : !entries.length ? (this.query ? '没有匹配结果。可修改搜索内容后重试。' : '还没有长期记忆。可手动新增，或开启后在对话中明确说“记住：…”。')
      : '本页 ' + filtered.length + ' 条 · ' + (this.query ? '搜索结果' : '全部') + '共 ' + total + ' 条 · 从第 ' + (this.offset + 1) + ' 条开始';
    for (const entry of filtered) {
      const doc = this.root.ownerDocument, row = doc.createElement('li'); row.className = 'pet-memory-entry';
      const content = doc.createElement('p'); content.className = 'pet-memory-entry-content'; content.textContent = entry.content;
      const source = doc.createElement('p'); source.className = 'setting-help pet-memory-source';
      const kind = new Map([['fact', '事实'], ['preference', '偏好'], ['episode', '共同经历']]).get(entry.kind) ?? entry.kind;
      source.textContent = kind + ' · ' + (entry.source_session_id ? '来源会话：' + entry.source_session_id : '来源：手动添加') + ' · 更新：' + (entry.updated_at || '未知');
      const actions = doc.createElement('div'); actions.className = 'setting-actions';
      for (const [label, fn] of [['纠正', () => this.edit(entry)], ['忘记…', () => this.askForget(entry.id)]] as const) {
        const button = doc.createElement('button'); button.type = 'button'; button.className = 'button secondary'; button.textContent = label;
        button.disabled = !this.writable(); button.addEventListener('click', fn); actions.append(button);
      }
      row.append(content, source, actions); list.append(row);
    }
  }
  private render(): void { this.renderControls(); this.renderList(); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.epoch++; this.confirmation = null; this.state = undefined; this.cleanup.abort(); this.render();
  }
}
