/** A local action menu: no movement, native focus changes, or arbitrary window access. */
export interface PetMenuGeometry {
  position: { x: number; y: number };
  cursor: { x: number; y: number };
  scale: number;
  cursor_down: boolean;
  escape_down?: boolean;
}
export interface PetMenuClock {
  schedule(callback: () => void, delay: number): unknown;
  cancel(handle: unknown): void;
}
export interface PetMenuOptions {
  onChange(open: boolean): void;
  getGeometry?: () => Promise<PetMenuGeometry>;
  clock?: PetMenuClock;
  /** Keep adjacent speech actions stable while an inline composer is open. */
  dismissBoundary?: HTMLElement;
  /** Disable for input surfaces whose native focus handoff can emit a transient blur. */
  dismissOnBlur?: boolean;
  submenu?: { trigger: HTMLElement; panel: HTMLElement };
  /** Schedule positioning and native hit-region updates after submenu visibility changes. */
  onLayout?: () => void;
}
type Point = { x: number; y: number };
type Bounds = Point & { width: number; height: number };
const INTERVAL_MS = 80;
const clock: PetMenuClock = {
  schedule: (callback, delay) => setTimeout(callback, delay),
  cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
const finitePoint = (point: Point): boolean => !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
const finiteBounds = (bounds: Bounds): boolean => finitePoint(bounds) &&
  Number.isFinite(bounds.width) && bounds.width > 0 && Number.isFinite(bounds.height) && bounds.height > 0 &&
  Number.isFinite(bounds.x + bounds.width) && Number.isFinite(bounds.y + bounds.height);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Owns dismissal and positioning, including click-through desktop input absent from the DOM. */
export class PetMenuController {
  private readonly clock: PetMenuClock;
  private readonly document: Document;
  private readonly view: Window | null;
  private opened = false;
  private disposed = false;
  private token = 0;
  private timer: unknown;
  private inFlight = false;
  private pointer?: Point;
  private submenuOpenedByHover = false;

  constructor(private readonly menu: HTMLElement, private readonly options: PetMenuOptions) {
    this.clock = options.clock ?? clock;
    this.document = menu.ownerDocument;
    this.view = this.document.defaultView;
    this.menu.hidden = true;
    if (options.submenu) {
      const { trigger, panel } = options.submenu;
      panel.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      trigger.addEventListener('pointerenter', this.onTriggerEnter);
      trigger.addEventListener('click', this.onTriggerClick);
      this.menu.addEventListener('pointerover', this.onParentRow);
      this.menu.addEventListener('focusin', this.onParentRow);
      panel.addEventListener('click', this.onSubmenuClick);
    }
    this.document.addEventListener('pointerdown', this.onPointerDown, true);
    this.document.addEventListener('keydown', this.onKeyDown, true);
    this.view?.addEventListener('blur', this.onBlur);
  }

  toggle(clientX?: number, clientY?: number): void {
    if (this.disposed) return;
    if (this.opened) { this.close(); return; }
    this.pointer = Number.isFinite(clientX) && Number.isFinite(clientY)
      ? { x: clientX!, y: clientY! } : undefined;
    this.opened = true;
    ++this.token;
    this.menu.hidden = false;
    this.notify(true);
    this.schedule();
  }

  close(): void {
    if (this.disposed || !this.opened) return;
    this.opened = false;
    ++this.token;
    this.cancelTimer();
    this.menu.hidden = true;
    this.setSubmenu(false);
    this.notify(false);
  }

  /** All inputs are viewport CSS pixels; only the final writes are offset-parent relative. */
  position(bounds: Bounds, origin?: Point): void {
    if (this.disposed || !this.opened || this.menu.hidden || !finiteBounds(bounds)) return;
    if (origin && !finitePoint(origin)) return;
    if (!origin) {
      const parent = this.menu.offsetParent ?? this.menu.parentElement;
      const rect = parent?.getBoundingClientRect();
      origin = rect ? { x: rect.left, y: rect.top } : { x: 0, y: 0 };
      if (!finitePoint(origin)) return;
    }
    this.menu.style.maxWidth = bounds.width + 'px';
    this.menu.style.maxHeight = bounds.height + 'px';
    this.menu.style.right = 'auto';
    this.menu.style.bottom = 'auto';
    const rect = this.menu.getBoundingClientRect();
    if (![rect.width, rect.height].every(value => Number.isFinite(value) && value > 0)) return;
    const width = Math.min(rect.width, bounds.width), height = Math.min(rect.height, bounds.height);
    const point = this.pointer ?? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const x = clamp(point.x, bounds.x, bounds.x + bounds.width - width);
    const preferredY = point.y + height > bounds.y + bounds.height ? point.y - height : point.y;
    const y = clamp(preferredY, bounds.y, bounds.y + bounds.height - height);
    this.menu.style.left = (x - origin.x) + 'px';
    this.menu.style.top = (y - origin.y) + 'px';
    const submenu = this.options.submenu;
    if (!submenu || submenu.panel.hidden) return;
    const { panel, trigger } = submenu;
    panel.style.maxWidth = bounds.width + 'px';
    panel.style.maxHeight = bounds.height + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    const subRect = panel.getBoundingClientRect();
    if (![subRect.width, subRect.height].every(value => Number.isFinite(value) && value > 0)) return;
    const subWidth = Math.min(subRect.width, bounds.width), subHeight = Math.min(subRect.height, bounds.height);
    const right = bounds.x + bounds.width;
    let mainX = x, subX: number;
    if (width + subWidth <= bounds.width) {
      // Keep the main panel stationary if either side fits; otherwise move it the least possible.
      const withRight = clamp(x, bounds.x, right - width - subWidth);
      const withLeft = clamp(x, bounds.x + subWidth, right - width);
      const useRight = Math.abs(withRight - x) <= Math.abs(withLeft - x);
      mainX = useRight ? withRight : withLeft;
      subX = useRight ? mainX + width : mainX - subWidth;
    } else {
      // A narrow work area cannot hold both panels. Keep the parent stable and overlap it.
      const useRight = right - x - width >= x - bounds.x;
      subX = clamp(useRight ? x + width : x - subWidth, bounds.x, right - subWidth);
    }
    this.menu.style.left = (mainX - origin.x) + 'px';
    const triggerY = trigger.getBoundingClientRect().top;
    const subY = clamp(Number.isFinite(triggerY) ? triggerY : y, bounds.y, bounds.y + bounds.height - subHeight);
    panel.style.left = (subX - origin.x) + 'px';
    panel.style.top = (subY - origin.y) + 'px';
  }

  dispose(): void {
    if (this.disposed) return;
    const wasOpen = this.opened;
    this.disposed = true;
    this.opened = false;
    ++this.token;
    this.cancelTimer();
    this.menu.hidden = true;
    this.setSubmenu(false);
    if (this.options.submenu) {
      const { trigger, panel } = this.options.submenu;
      trigger.removeEventListener('pointerenter', this.onTriggerEnter);
      trigger.removeEventListener('click', this.onTriggerClick);
      this.menu.removeEventListener('pointerover', this.onParentRow);
      this.menu.removeEventListener('focusin', this.onParentRow);
      panel.removeEventListener('click', this.onSubmenuClick);
    }
    this.document.removeEventListener('pointerdown', this.onPointerDown, true);
    this.document.removeEventListener('keydown', this.onKeyDown, true);
    this.view?.removeEventListener('blur', this.onBlur);
    if (wasOpen) this.notify(false);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    // A pet right-click must reach contextmenu/toggle, not close then immediately reopen.
    const target = event.target as Node | null;
    const panel = this.options.submenu?.panel;
    if (event.button === 0 && !this.menu.contains(target) && !this.options.dismissBoundary?.contains(target) &&
        !(panel && !panel.hidden && panel.contains(target))) this.close();
  };
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { this.close(); return; }
    const submenu = this.options.submenu;
    if (!submenu || this.disposed || !this.opened || this.menu.hidden) return;
    const target = event.target as Node | null;
    if (submenu.trigger.contains(target) && (event.key === 'ArrowRight' || event.key === 'ArrowDown')) {
      event.preventDefault();
      this.setSubmenu(true);
      if (!submenu.panel.hidden) this.submenuItems()[0]?.focus();
    } else if (!submenu.panel.hidden && submenu.panel.contains(target)) {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        this.returnToTrigger();
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const items = this.submenuItems();
        const index = items.findIndex(item => item.contains(target));
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
          event.key === 'ArrowDown' ? (index + 1) % items.length : (index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length);
        items[next]?.focus();
      }
    }
  };
  private submenuItems(): HTMLElement[] {
    return Array.from(this.options.submenu!.panel.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .filter(item => !item.closest('[hidden]') && !item.matches(':disabled, [aria-disabled="true"]'));
  }
  private setSubmenu(open: boolean, hover = false): void {
    const submenu = this.options.submenu;
    if (!submenu || (open && (this.disposed || !this.opened || this.menu.hidden))) return;
    const changed = submenu.panel.hidden === open;
    if (changed || !hover) this.submenuOpenedByHover = open && hover;
    submenu.panel.hidden = !open;
    submenu.trigger.setAttribute('aria-expanded', String(open));
    if (changed) {
      try { this.options.onLayout?.(); } catch { /* Layout observers cannot interrupt cleanup. */ }
    }
  }
  private returnToTrigger(): void {
    this.setSubmenu(false);
    if (!this.disposed && this.opened) this.options.submenu?.trigger.focus();
  }
  private readonly onTriggerEnter = (): void => { this.setSubmenu(true, true); };
  private readonly onTriggerClick = (): void => {
    // Pointer entry precedes a mouse click: don't immediately undo that hover-open.
    const open = this.submenuOpenedByHover || !!this.options.submenu?.panel.hidden;
    this.setSubmenu(open);
    if (open && !this.options.submenu?.panel.hidden) this.submenuItems()[0]?.focus();
  };
  private readonly onParentRow = (event: Event): void => {
    const target = event.target as Element | null;
    const row = target?.closest?.('button, [role="menuitem"], [role="switch"]');
    if (row && this.menu.contains(row) && !this.options.submenu?.trigger.contains(row)) this.setSubmenu(false);
  };
  private readonly onSubmenuClick = (event: MouseEvent): void => {
    const back = (event.target as Element | null)?.closest?.('[data-submenu-back]');
    const panel = this.options.submenu?.panel;
    if (back && panel && !panel.hidden && panel.contains(back)) this.returnToTrigger();
  };
  private readonly onBlur = (event: Event): void => {
    if (this.options.dismissOnBlur !== false && (!event.target || event.target === this.view)) this.close();
  };
  private valid(token: number): boolean {
    return !this.disposed && this.opened && token === this.token;
  }
  private notify(open: boolean): void {
    try { this.options.onChange(open); } catch { /* Observers cannot strand native polling or disposal. */ }
  }
  private cancelTimer(): void {
    if (this.timer !== undefined) this.clock.cancel(this.timer);
    this.timer = undefined;
  }
  private schedule(): void {
    if (this.disposed || !this.opened || !this.options.getGeometry || this.inFlight || this.timer !== undefined) return;
    const token = this.token;
    this.timer = this.clock.schedule(() => {
      this.timer = undefined;
      if (this.valid(token)) void this.poll(token);
    }, INTERVAL_MS);
  }
  private async poll(token: number): Promise<void> {
    if (!this.valid(token) || this.inFlight) return;
    if (this.menu.hidden) { this.close(); return; }
    this.inFlight = true;
    try {
      const geometry = await this.options.getGeometry!();
      if (!this.valid(token)) return;
      if (this.menu.hidden) { this.close(); return; }
      if (geometry?.escape_down === true) { this.close(); return; }
      if (geometry?.cursor_down !== true || !finitePoint(geometry.position) ||
          !finitePoint(geometry.cursor) || !Number.isFinite(geometry.scale) || geometry.scale <= 0) return;
      const x = (geometry.cursor.x - geometry.position.x) / geometry.scale;
      const y = (geometry.cursor.y - geometry.position.y) / geometry.scale;
      const rect = this.menu.getBoundingClientRect();
      if (![x, y, rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return;
      if (x >= rect.left && x < rect.left + rect.width && y >= rect.top && y < rect.top + rect.height) return;
      const boundary = this.options.dismissBoundary;
      if (boundary && !boundary.hidden) {
        const extra = boundary.getBoundingClientRect();
        if (x >= extra.left && x < extra.left + extra.width && y >= extra.top && y < extra.top + extra.height) return;
      }
      const panel = this.options.submenu?.panel;
      if (panel && !panel.hidden) {
        const subRect = panel.getBoundingClientRect();
        if (![subRect.left, subRect.top, subRect.width, subRect.height].every(Number.isFinite) || subRect.width <= 0 || subRect.height <= 0) return;
        if (x >= subRect.left && x < subRect.left + subRect.width && y >= subRect.top && y < subRect.top + subRect.height) return;
      }
      this.close();
    } catch { /* Native reads may fail transiently. DOM and explicit close remain available. */ }
    finally {
      this.inFlight = false;
      // A new generation may have opened while this RPC was in flight; do not reuse its result.
      this.schedule();
    }
  }
}
