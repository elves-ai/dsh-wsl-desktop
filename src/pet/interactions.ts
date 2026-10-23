/** Plain-text, explicit-consent interactions inside the existing pet window. */
export interface PetInteractionQuestion {
  id: string;
  question: string;
  header?: string;
  detail?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
  intent?: { kind: 'plan-review'; approve: string; callId?: string };
}
export interface PetInteractionCard {
  id: string;
  kind: 'questions' | 'approval';
  agent_label: string;
  questions?: PetInteractionQuestion[];
  tool_name?: string;
  reason?: string;
  details?: string;
  can_allow?: boolean;
  /** Timed native waits are display-only until their claim is ready. */
  answerable?: boolean;
  warning?: string;
}
export interface PetInteractionSnapshot {
  revision: number;
  connected: boolean;
  items: PetInteractionCard[];
}
export type PetInteractionReply =
  | { kind: 'questions'; answers: { id: string; selected: string[]; custom?: string }[] }
  | { kind: 'approval'; decision: 'allowed-once' | 'rejected' };
export interface PetInteractionsOptions {
  onSubmit(id: string, reply: PetInteractionReply): Promise<void>;
  onOpen(id: string): Promise<void>;
  onChange?(expanded: boolean): void;
}

type QuestionView = {
  question: PetInteractionQuestion;
  choices: HTMLInputElement[];
  custom: HTMLTextAreaElement;
  hint: HTMLElement;
  skipped: boolean;
};
type Entry = {
  card: PetInteractionCard;
  signature: string;
  generation: object;
  view?: HTMLElement;
  questions: QuestionView[];
  controls: (HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement)[];
  submit?: HTMLButtonElement;
  allow?: HTMLButtonElement;
  open?: HTMLButtonElement;
  drafts?: QuestionView[];
  status?: HTMLElement;
  message: string;
  pending: boolean;
  submitted: boolean;
};

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const optionalText = (value: unknown) => value === undefined || typeof value === 'string';

/** Validate atomically and copy untrusted input; never shorten risk/plan text. */
function parseSnapshot(value: unknown): PetInteractionSnapshot | null {
  try {
    if (!record(value) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 ||
        typeof value.connected !== 'boolean' || !Array.isArray(value.items)) return null;
    const ids = new Set<string>();
    const items: PetInteractionCard[] = [];
    for (const item of value.items) {
      if (!record(item) || typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id) ||
          (item.kind !== 'approval' && item.kind !== 'questions') || typeof item.agent_label !== 'string' ||
          !['tool_name', 'reason', 'details', 'warning'].every(key => optionalText(item[key])) ||
          (item.can_allow !== undefined && typeof item.can_allow !== 'boolean') ||
          (item.answerable !== undefined && typeof item.answerable !== 'boolean')) return null;
      ids.add(item.id);
      const card: PetInteractionCard = { id: item.id, kind: item.kind, agent_label: item.agent_label };
      for (const key of ['tool_name', 'reason', 'details', 'warning'] as const) {
        if (typeof item[key] === 'string') card[key] = item[key];
      }
      if (typeof item.can_allow === 'boolean') card.can_allow = item.can_allow;
      if (typeof item.answerable === 'boolean') card.answerable = item.answerable;
      if (item.kind === 'questions') {
        if (!Array.isArray(item.questions) || !item.questions.length) return null;
        const questionIds = new Set<string>();
        card.questions = [];
        for (const q of item.questions) {
          if (!record(q) || typeof q.id !== 'string' || !q.id.trim() || questionIds.has(q.id) ||
              typeof q.question !== 'string' || !optionalText(q.header) || !optionalText(q.detail) ||
              (q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean') ||
              (q.options !== undefined && !Array.isArray(q.options))) return null;
          questionIds.add(q.id);
          const question: PetInteractionQuestion = { id: q.id, question: q.question };
          if (typeof q.header === 'string') question.header = q.header;
          if (typeof q.detail === 'string') question.detail = q.detail;
          if (typeof q.multiSelect === 'boolean') question.multiSelect = q.multiSelect;
          if (Array.isArray(q.options)) {
            const labels = new Set<string>();
            question.options = [];
            for (const option of q.options) {
              if (!record(option) || typeof option.label !== 'string' || !option.label.trim() ||
                  labels.has(option.label) || !optionalText(option.description)) return null;
              labels.add(option.label);
              question.options.push({ label: option.label,
                ...(typeof option.description === 'string' ? { description: option.description } : {}) });
            }
          }
          if (q.intent !== undefined) {
            const intent = q.intent;
            if (!record(intent) || intent.kind !== 'plan-review' || typeof intent.approve !== 'string' ||
                !optionalText(intent.callId) || q.multiSelect === true ||
                !question.options?.some(option => option.label === intent.approve) || question.options.length < 2) return null;
            question.intent = { kind: 'plan-review', approve: intent.approve,
              ...(typeof intent.callId === 'string' ? { callId: intent.callId } : {}) };
          }
          card.questions.push(question);
        }
      }
      items.push(card);
    }
    return { revision: value.revision as number, connected: value.connected, items };
  } catch { return null; }
}

/** Shared with cross-language wire-contract tests; this is the class validator. */
export { parseSnapshot as parsePetInteractionSnapshot };

/**
 * FIFO: new cards never replace the current draft. Only authoritative snapshots
 * remove requests. Collapse, hide, open-in-DSH and dispose never answer a request.
 * Import interactions.css in the host; no timers, window resizing or native RPCs.
 */
export class PetInteractions {
  private readonly summary: HTMLButtonElement;
  private readonly panel: HTMLElement;
  private readonly heading: HTMLElement;
  private readonly close: HTMLButtonElement;
  private readonly body: HTMLElement;
  private readonly listeners: (() => void)[] = [];
  private cardListeners: (() => void)[] = [];
  private entries = new Map<string, Entry>();
  private order: string[] = [];
  private current: Entry | null = null;
  private revision = -1;
  private connected = false;
  private active = true;
  private obscured = false;
  private collapsed = false;
  private expanded = false;
  private composing = false;
  private disposed = false;
  private radioGroup = 0;
  private readonly requests = new Map<string, object>();

  constructor(private readonly root: HTMLElement, private readonly options: PetInteractionsOptions) {
    root.classList.add('pet-interactions');
    this.summary = this.button('pet-interactions-summary', '', () => {
      if (!this.active || this.obscured || this.disposed) return;
      this.collapsed = false;
      this.refresh();
    });
    this.panel = this.element('section', 'pet-interactions-panel');
    this.panel.setAttribute('aria-label', '待处理请求');
    const header = this.element('header', 'pet-interactions-header');
    this.heading = this.element('strong', 'pet-interactions-heading');
    this.close = this.button('pet-interactions-close', '×', () => {
      if (!this.active || this.obscured || this.disposed) return;
      this.collapsed = true;
      this.refresh();
    });
    this.close.setAttribute('aria-label', '收起请求（不取消）');
    header.append(this.heading, this.close);
    this.body = this.element('div', 'pet-interactions-content');
    this.panel.append(header, this.body);
    root.replaceChildren(this.summary, this.panel);
    // Prevent the host pet's dragging, roaming and click actions, not text entry.
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'keydown', 'keyup']) {
      this.listen(root, type, event => event.stopPropagation());
    }
    this.listen(root, 'compositionstart', () => { this.composing = true; this.refreshControls(); });
    this.listen(root, 'compositionend', () => { this.composing = false; this.refreshControls(); });
    this.refresh();
  }

  update(value: unknown): void {
    if (this.disposed) return;
    // Equal/old revisions cannot resurrect an obsolete card or reconnect us.
    try {
      if (record(value) && Number.isSafeInteger(value.revision) && (value.revision as number) >= 0 &&
          (value.revision as number) <= this.revision) return;
    } catch { /* The validator below fails closed. */ }
    const snapshot = parseSnapshot(value);
    if (!snapshot) {
      this.connected = false;
      this.refresh();
      return;
    }
    this.revision = snapshot.revision;
    this.connected = snapshot.connected;
    const next = new Map<string, Entry>();
    for (const card of snapshot.items) {
      const signature = JSON.stringify(card);
      const old = this.entries.get(card.id);
      next.set(card.id, old?.signature === signature ? old : {
        card, signature, generation: old?.generation ?? {}, questions: [], controls: [], message: '',
        pending: false, submitted: old?.submitted ?? false,
        drafts: old?.questions,
      });
    }
    this.order = this.order.filter(id => next.has(id));
    for (const card of snapshot.items) if (!this.order.includes(card.id)) this.order.push(card.id);
    this.entries = next;
    this.refresh();
  }

  setActive(active: boolean): void {
    if (this.disposed) return;
    this.active = active;
    this.refresh();
  }

  setObscured(obscured: boolean): void {
    if (this.disposed) return;
    this.obscured = obscured;
    this.refresh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const remove of [...this.cardListeners, ...this.listeners]) remove();
    this.cardListeners = [];
    this.listeners.length = 0;
    this.entries.clear();
    this.requests.clear();
    this.order = [];
    this.current = null;
    this.root.replaceChildren();
    this.root.hidden = true;
    this.notify(false);
  }

  private element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = this.root.ownerDocument.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  private listen(node: HTMLElement, type: string, listener: (event: Event) => void, card = false): void {
    node.addEventListener(type, listener);
    (card ? this.cardListeners : this.listeners).push(() => node.removeEventListener(type, listener));
  }

  private button(className: string, text: string, callback: () => void, card = false): HTMLButtonElement {
    const button = this.element('button', className, text);
    button.type = 'button';
    this.listen(button, 'click', callback, card);
    return button;
  }

  private notify(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    // A host focus/roaming hook must not break consent-state cleanup.
    try { this.options.onChange?.(expanded); } catch { /* Host owns error reporting. */ }
  }

  private refresh(): void {
    if (this.disposed) return;
    const entry = this.entries.get(this.order[0]) ?? null;
    if (entry !== this.current) {
      for (const remove of this.cardListeners) remove();
      this.cardListeners = [];
      this.current = entry;
      this.composing = false;
      if (entry) this.build(entry);
      else this.body.replaceChildren();
    }
    const visible = this.active && !!entry;
    this.root.hidden = !visible;
    this.root.inert = this.obscured || !visible;
    this.panel.hidden = !visible || this.collapsed;
    this.summary.hidden = !visible || !this.collapsed;
    this.summary.textContent = '有' + this.order.length + '个待处理请求';
    this.summary.disabled = this.obscured || !visible;
    this.close.disabled = this.obscured || !visible;
    if (entry) this.heading.textContent = entry.card.agent_label + ' · ' +
      (entry.card.kind === 'approval' ? '授权确认' : '问题确认') + '（' + this.order.length + '）';
    this.refreshControls();
    this.notify(visible && !this.collapsed);
  }

  private build(entry: Entry): void {
    entry.questions = [];
    entry.controls = [];
    const view = this.element('div', 'pet-interactions-card');
    const scroll = this.element('div', 'pet-interactions-scroll');
    const text = (className: string, value?: string) => {
      if (value !== undefined) scroll.append(this.element('pre', className, value));
    };
    text('pet-interactions-tool', entry.card.tool_name);
    text('pet-interactions-reason', entry.card.reason);
    text('pet-interactions-warning', entry.card.warning);
    text('pet-interactions-details', entry.card.details);
    for (const question of entry.card.questions ?? []) {
      const section = this.element('fieldset', 'pet-interactions-question');
      section.append(this.element('legend', '', question.header ?? '问题 ' + (entry.questions.length + 1)));
      section.append(this.element('pre', 'pet-interactions-question-text', question.question));
      if (question.detail !== undefined) section.append(this.element('pre', 'pet-interactions-detail', question.detail));
      const q: QuestionView = { question, choices: [], custom: this.element('textarea', 'pet-interactions-custom'),
        hint: this.element('p', 'pet-interactions-hint'), skipped: false };
      const group = 'pet-interaction-' + ++this.radioGroup;
      for (const option of question.options ?? []) {
        const label = this.element('label', 'pet-interactions-option');
        const input = this.element('input', '');
        input.type = question.multiSelect ? 'checkbox' : 'radio';
        input.name = group;
        input.value = option.label;
        input.checked = false;
        label.append(input, this.element('span', 'pet-interactions-option-label', option.label));
        if (option.description !== undefined) label.append(this.element('pre', 'pet-interactions-option-description', option.description));
        this.listen(input, 'change', () => {
          if (!this.canAct(entry)) return;
          q.skipped = false;
          if (!question.multiSelect && input.checked) q.choices.forEach(choice => { if (choice !== input) choice.checked = false; });
          this.refreshControls();
        }, true);
        q.choices.push(input);
        entry.controls.push(input);
        section.append(label);
      }
      q.custom.rows = 3;
      q.custom.setAttribute('aria-label', question.intent ? '计划反馈（选择 Keep planning）' : '自定义回答');
      q.custom.placeholder = question.intent ? '反馈（请选择非批准选项后提交）' : '其他回答（可选）';
      this.listen(q.custom, 'input', () => { q.skipped = false; this.refreshControls(); }, true);
      const skip = this.button('pet-interactions-skip', '跳过', () => {
        if (!this.canAct(entry)) return;
        q.choices.forEach(choice => { choice.checked = false; });
        q.custom.value = '';
        q.skipped = true;
        this.refreshControls();
      }, true);
      entry.controls.push(skip);
      const draft = entry.drafts?.find(previous => JSON.stringify(previous.question) === JSON.stringify(question));
      if (draft) {
        q.custom.value = draft.custom.value;
        q.skipped = draft.skipped;
        q.choices.forEach(choice => { choice.checked = draft.choices.some(old => old.checked && old.value === choice.value); });
      }
      entry.controls.push(q.custom);
      section.append(q.custom, skip, q.hint);
      entry.questions.push(q);
      scroll.append(section);
    }
    if (entry.card.kind === 'approval' && entry.card.can_allow !== true) {
      scroll.append(this.element('p', 'pet-interactions-warning', '此请求不能在宠物中允许。可拒绝，或在 DSH 打开查看。'));
    }
    entry.status = this.element('p', 'pet-interactions-status');
    entry.status.setAttribute('role', 'status');
    scroll.append(entry.status);
    const actions = this.element('div', 'pet-interactions-actions');
    if (entry.card.kind === 'approval') {
      entry.allow = this.button('pet-interactions-allow', '允许一次', () => {
        void this.submit(entry, { kind: 'approval', decision: 'allowed-once' });
      }, true);
      const reject = this.button('pet-interactions-reject', '拒绝', () => {
        void this.submit(entry, { kind: 'approval', decision: 'rejected' });
      }, true);
      actions.append(entry.allow, reject);
      entry.controls.push(entry.allow, reject);
    } else {
      entry.submit = this.button('pet-interactions-submit', '提交', () => {
        const reply = this.answers(entry);
        if (reply) void this.submit(entry, reply);
      }, true);
      actions.append(entry.submit);
      entry.controls.push(entry.submit);
    }
    const open = this.button('pet-interactions-open', '在 DSH 打开', () => { void this.open(entry); }, true);
    actions.append(open);
    entry.open = open;
    entry.controls.push(open);
    entry.drafts = undefined;
    view.append(scroll, actions);
    entry.view = view;
    this.body.replaceChildren(view);
  }

  private canOpen(entry: Entry): boolean {
    return !this.disposed && this.active && !this.obscured && !this.collapsed &&
      this.current === entry && this.entries.get(entry.card.id) === entry &&
      !this.requests.has(entry.card.id) && !entry.pending;
  }

  private canAct(entry: Entry): boolean {
    return this.canOpen(entry) && this.connected && entry.card.answerable !== false && !entry.submitted;
  }

  private answers(entry: Entry): Extract<PetInteractionReply, { kind: 'questions' }> | null {
    const answers: Extract<PetInteractionReply, { kind: 'questions' }>['answers'] = [];
    for (const { question, choices, custom, skipped } of entry.questions) {
      const typed = custom.value.trim() ? custom.value : undefined;
      let selected = choices.filter(choice => choice.checked).map(choice => choice.value);
      if (question.intent && typed && selected.includes(question.intent.approve)) return null;
      if (typed && !question.multiSelect && !question.intent) selected = [];
      if (question.intent && selected.length !== 1 && !skipped) return null;
      if (!selected.length && !typed && !skipped) return null;
      answers.push({ id: question.id, selected, ...(typed !== undefined ? { custom: typed } : {}) });
    }
    return { kind: 'questions', answers };
  }

  private refreshControls(): void {
    const entry = this.current;
    if (!entry || this.disposed) return;
    const enabled = this.canAct(entry);
    for (const control of entry.controls) control.disabled = !enabled;
    if (entry.open) entry.open.disabled = !this.canOpen(entry) || this.composing;
    if (entry.allow) entry.allow.disabled = !enabled || entry.card.can_allow !== true || this.composing;
    if (entry.submit) entry.submit.disabled = !enabled || this.composing || !this.answers(entry);
    for (const q of entry.questions) {
      const conflict = q.question.intent && !!q.custom.value.trim() &&
        q.choices.some(choice => choice.checked && choice.value === q.question.intent!.approve);
      q.hint.textContent = conflict ? '有反馈时不能批准计划；请选择 Keep planning 后提交。' : q.skipped ? '已选择跳过此题。' : '';
      q.hint.hidden = !conflict && !q.skipped;
    }
    if (entry.status) entry.status.textContent = !this.connected ? '连接已断开，恢复连接前不能提交。' :
      entry.pending || this.requests.has(entry.card.id) ? '正在处理，请勿重复点击。' :
      entry.card.answerable === false ? '请求尚未就绪，请稍候；也可在 DSH 打开。' : entry.message;
  }

  private async submit(entry: Entry, reply: PetInteractionReply): Promise<void> {
    if (!this.canAct(entry) || this.composing) return;
    if (reply.kind === 'approval' && reply.decision === 'allowed-once' && entry.card.can_allow !== true) return;
    // Recompute immediately before sending: no stale answers or implicit approval.
    if (reply.kind === 'questions') {
      const current = this.answers(entry);
      if (!current) return;
      reply = current;
    }
    await this.request(entry, async () => this.options.onSubmit(entry.card.id, reply), true);
  }

  private async open(entry: Entry): Promise<void> {
    if (!this.canOpen(entry) || this.composing) return;
    await this.request(entry, async () => this.options.onOpen(entry.card.id), false);
  }

  private async request(entry: Entry, action: () => Promise<void>, submitted: boolean): Promise<void> {
    const token = {};
    this.requests.set(entry.card.id, token);
    entry.pending = true;
    entry.message = '';
    this.refreshControls();
    try {
      await action();
      const live = this.entries.get(entry.card.id);
      if (this.disposed || !live || live.generation !== entry.generation) return;
      // Metadata/readiness updates are not a new request: keep success locked
      // until the authoritative snapshot removes this request incarnation.
      if (submitted) {
        live.submitted = true;
        live.message = '已发送，等待请求状态更新。';
      } else if (live === entry) live.message = '';
    } catch {
      if (this.disposed || this.entries.get(entry.card.id) !== entry) return;
      entry.message = submitted ? '发送失败，回答已保留，请检查连接后点击重试。' : '打开失败，请点击重试。';
    } finally {
      if (!this.disposed && this.requests.get(entry.card.id) === token) {
        this.requests.delete(entry.card.id);
        entry.pending = false;
        this.refreshControls();
      }
    }
  }
}
