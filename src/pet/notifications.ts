/** Plain-text notifications for the existing 360 × 320 pet window. */
export interface PetNotification {
  id: string;
  kind: 'completed' | 'failed' | 'waiting';
  /** Session/task name; status and action labels are derived from kind. */
  title: string;
  body: string;
}

export interface PetNotificationClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(handle: number): void;
}

export interface PetNotificationsOptions {
  onOpen(id: string): Promise<void>;
  onDismiss(id: string): void;
  /** Whether a bubble is rendered; obscuring it only pauses its clock. */
  onChange?(visible: boolean): void;
  clock?: PetNotificationClock;
}

const LIFETIME_MS = 12_000;
const MAX_PENDING = 5;
const MAX_RECENT = 256;

function notification(value: unknown): PetNotification | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const { id, kind, title, body } = value as Record<string, unknown>;
    if (typeof id !== 'string' || !id.trim() || id.length > 128 ||
        typeof title !== 'string' || !title.trim() || Array.from(title).length > 80 ||
        typeof body !== 'string' || Array.from(body).length > 180 ||
        (kind !== 'completed' && kind !== 'failed' && kind !== 'waiting')) return null;
    return { id, kind, title, body };
  } catch { return null; }
}

/**
 * One current bubble + five FIFO pending items. Overflow drops the oldest pending.
 * onDismiss is called once per accepted item removed by timeout, close, overflow,
 * clear (including setActive(false)), or successful onOpen. Rejected/duplicate
 * inputs and dispose never call onDismiss. Recent IDs survive clear/hiding.
 * dispose intentionally leaves native unread state alone for HMR remounts.
 */
export class PetNotifications {
  private readonly clock: PetNotificationClock;
  private readonly openButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly status: HTMLElement;
  private readonly action: HTMLElement;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;
  private readonly error: HTMLElement;
  private readonly listeners: Array<() => void> = [];
  private readonly recent = new Set<string>();
  private pending: PetNotification[] = [];
  private current: PetNotification | null = null;
  private active = true;
  private obscured = false;
  private hovered = false;
  private focused = false;
  private disposed = false;
  private visible = false;
  private opening: object | null = null;
  private remaining = LIFETIME_MS;
  private startedAt = 0;
  private timer: number | null = null;

  constructor(private readonly root: HTMLElement, private readonly options: PetNotificationsOptions) {
    const document = root.ownerDocument;
    const view = document.defaultView!;
    this.clock = options.clock ?? {
      now: () => view.performance.now(),
      setTimeout: (callback, delay) => view.setTimeout(callback, delay),
      clearTimeout: handle => view.clearTimeout(handle),
    };
    root.classList.add('pet-notifications');
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');
    root.setAttribute('aria-atomic', 'true');
    this.openButton = document.createElement('button');
    this.openButton.type = 'button';
    this.openButton.className = 'pet-notification-open';
    this.status = document.createElement('span');
    this.status.className = 'pet-notification-status';
    this.action = document.createElement('span');
    this.action.className = 'pet-notification-action';
    this.title = document.createElement('span');
    this.title.className = 'pet-notification-title';
    this.body = document.createElement('span');
    this.body.className = 'pet-notification-body';
    this.error = document.createElement('span');
    this.error.className = 'pet-notification-error';
    this.error.textContent = '打开失败，点击重试';
    this.error.hidden = true;
    this.openButton.append(this.status, this.title, this.body, this.action, this.error);
    this.closeButton = document.createElement('button');
    this.closeButton.type = 'button';
    this.closeButton.className = 'pet-notification-close';
    this.closeButton.setAttribute('aria-label', '关闭通知');
    this.closeButton.textContent = '×';
    root.replaceChildren(this.openButton, this.closeButton);
    this.listen(this.openButton, 'click', () => { void this.open(); });
    this.listen(this.closeButton, 'click', () => this.dismissCurrent());
    // Do not let bubble interactions start the underlying pet's drag/click action.
    this.listen(root, 'pointerdown', event => event.stopPropagation());
    this.listen(root, 'click', event => event.stopPropagation());
    this.listen(root, 'mouseenter', () => { this.hovered = true; this.updateTimer(); });
    this.listen(root, 'mouseleave', () => { this.hovered = false; this.updateTimer(); });
    this.listen(root, 'focusin', () => { this.focused = true; this.updateTimer(); });
    this.listen(root, 'focusout', event => {
      const next = (event as FocusEvent).relatedTarget;
      this.focused = next instanceof view.Node && root.contains(next);
      this.updateTimer();
    });
    root.hidden = true;
  }

  enqueue(value: unknown): void {
    if (this.disposed || !this.active) return;
    const item = notification(value);
    if (!item || this.recent.has(item.id) || this.current?.id === item.id ||
        this.pending.some(pending => pending.id === item.id)) return;
    this.recent.add(item.id);
    if (this.recent.size > MAX_RECENT) this.recent.delete(this.recent.values().next().value!);
    let overflow: PetNotification | undefined;
    if (!this.current) {
      this.current = item;
      this.render();
    } else {
      this.pending.push(item);
      if (this.pending.length > MAX_PENDING) overflow = this.pending.shift();
    }
    if (overflow) this.notifyDismiss(overflow.id);
  }

  withdraw(id: string): void {
    if (this.disposed || typeof id !== 'string' || !id || id.length > 128) return;
    // A withdrawal may arrive before its racing original payload or bootstrap snapshot.
    this.recent.add(id);
    if (this.recent.size > MAX_RECENT) this.recent.delete(this.recent.values().next().value!);
    if (this.current?.id === id) { this.dismissCurrent(); return; }
    const index = this.pending.findIndex(item => item.id === id);
    if (index >= 0) { this.pending.splice(index, 1); this.notifyDismiss(id); }
  }
  setActive(active: boolean): void {
    if (this.disposed) return;
    this.active = active;
    if (!active) this.clear();
  }

  setObscured(obscured: boolean): void {
    if (this.disposed) return;
    this.obscured = obscured;
    this.updateTimer();
  }

  clear(): void {
    if (this.disposed) return;
    const removed = this.current ? [this.current, ...this.pending] : this.pending;
    this.current = null;
    this.pending = [];
    this.render();
    for (const item of removed) this.notifyDismiss(item.id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTimer();
    this.opening = null;
    this.current = null;
    this.pending = [];
    this.recent.clear();
    this.listeners.splice(0).forEach(remove => remove());
    this.root.replaceChildren();
    this.root.hidden = true;
    this.setVisible(false);
  }

  private listen(target: HTMLElement, type: string, listener: EventListener): void {
    target.addEventListener(type, listener);
    this.listeners.push(() => target.removeEventListener(type, listener));
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.remaining = Math.max(0, this.remaining - Math.max(0, this.clock.now() - this.startedAt));
  }

  private updateTimer(): void {
    this.stopTimer();
    if (this.disposed || !this.active || !this.current || this.obscured ||
        this.hovered || this.focused || this.opening) return;
    this.startedAt = this.clock.now();
    const item = this.current;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (!this.disposed && this.current === item) this.dismissCurrent();
    }, this.remaining);
  }

  private render(): void {
    this.stopTimer();
    this.opening = null;
    this.remaining = LIFETIME_MS;
    this.openButton.removeAttribute('aria-busy');
    this.openButton.removeAttribute('aria-disabled');
    this.error.hidden = true;
    const item = this.current;
    const labels = item ? {
      completed: ['本轮已结束', '查看结果 →'],
      failed: ['本轮执行失败', '查看详情 →'],
      waiting: ['需要你回答', '前往回答 →'],
    }[item.kind] : ['', ''];
    this.status.textContent = labels[0];
    this.action.textContent = labels[1];
    this.title.textContent = item?.title ?? '';
    this.title.setAttribute('title', item?.title ?? '');
    this.body.textContent = item?.body ?? '';
    this.body.hidden = !item?.body;
    this.openButton.setAttribute('aria-label', item ? labels[0] + '：' + item.title + (item.body ? '。' + item.body : '') + '。' + labels[1] : '查看通知会话');
    this.root.hidden = !item;
    if (item) this.root.dataset.kind = item.kind;
    else delete this.root.dataset.kind;
    // Focus/hover can remain in this same bubble while FIFO advances.
    this.focused = this.root.contains(this.root.ownerDocument.activeElement);
    if (!item) this.hovered = false;
    this.updateTimer();
    this.setVisible(Boolean(item));
  }

  private setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    try { this.options.onChange?.(visible); } catch { /* Host errors cannot corrupt the queue. */ }
  }

  private dismissCurrent(): void {
    if (this.disposed || !this.current) return;
    const item = this.current;
    this.current = this.pending.shift() ?? null;
    this.render();
    this.notifyDismiss(item.id);
  }

  private notifyDismiss(id: string): void {
    try { this.options.onDismiss(id); } catch { /* Dismiss is an at-most-once signal, never retried. */ }
  }

  private async open(): Promise<void> {
    if (this.disposed || !this.active || this.obscured || !this.current || this.opening) return;
    const item = this.current;
    const attempt = {};
    this.opening = attempt;
    this.error.hidden = true;
    this.openButton.setAttribute('aria-busy', 'true');
    this.openButton.setAttribute('aria-disabled', 'true');
    this.updateTimer();
    try {
      await this.options.onOpen(item.id);
    } catch {
      if (this.disposed || this.current !== item || this.opening !== attempt) return;
      this.opening = null;
      this.openButton.removeAttribute('aria-busy');
      this.openButton.removeAttribute('aria-disabled');
      this.error.hidden = false;
      this.updateTimer();
      return;
    }
    if (!this.disposed && this.current === item && this.opening === attempt) this.dismissCurrent();
  }
}
