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

  constructor(private readonly menu: HTMLElement, private readonly options: PetMenuOptions) {
    this.clock = options.clock ?? clock;
    this.document = menu.ownerDocument;
    this.view = this.document.defaultView;
    this.menu.hidden = true;
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
  }

  dispose(): void {
    if (this.disposed) return;
    const wasOpen = this.opened;
    this.disposed = true;
    this.opened = false;
    ++this.token;
    this.cancelTimer();
    this.menu.hidden = true;
    this.document.removeEventListener('pointerdown', this.onPointerDown, true);
    this.document.removeEventListener('keydown', this.onKeyDown, true);
    this.view?.removeEventListener('blur', this.onBlur);
    if (wasOpen) this.notify(false);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    // A pet right-click must reach contextmenu/toggle, not close then immediately reopen.
    if (event.button === 0 && !(this.options.dismissBoundary ?? this.menu).contains(event.target as Node | null)) this.close();
  };
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) this.close();
  };
  private readonly onBlur = (event: Event): void => {
    if (!event.target || event.target === this.view) this.close();
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
      const rect = (this.options.dismissBoundary ?? this.menu).getBoundingClientRect();
      if (![x, y, rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return;
      if (x < rect.left || x >= rect.left + rect.width || y < rect.top || y >= rect.top + rect.height) this.close();
    } catch { /* Native reads may fail transiently. DOM and explicit close remain available. */ }
    finally {
      this.inFlight = false;
      // A new generation may have opened while this RPC was in flight; do not reuse its result.
      this.schedule();
    }
  }
}
