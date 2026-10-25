// Native coordinates, cursor samples, window sizes and work areas are physical px.
// Only gravity (a logical configuration value) is converted by scale, exactly once.
import {
  DEFAULT_PHYSICS, MAX_STEP_DT, springStep, trimTrail, estimateReleaseVelocity,
  throwStep, throwSubsteps, slingshotVelocity, slingshotPower, pullAngle,
} from '../vendor/dsh-pet/physics.ts';
import type { DragSample, ThrowState } from '../vendor/dsh-pet/physics.ts';
import { planMove } from '../vendor/dsh-pet/motion.ts';
import { resolveRect } from '../vendor/dsh-pet/displays.ts';
import { PET_REF_WIDTH } from '../vendor/dsh-pet/constants.ts';
import type { PhysicsParams, Rect } from '../vendor/dsh-pet/types.ts';

export interface Geometry {
  position: { x: number; y: number };
  size: { width: number; height: number };
  cursor: { x: number; y: number };
  scale: number;
  /** Physical transparent padding on each horizontal side of the native window. */
  horizontal_inset?: number;
  areas: Rect[];
  cursor_down: boolean;
}

/** Native bridge alias for hosts importing its geometry contract. */
export type PetGeometry = Geometry;

export interface MotionClock {
  now(): number;
  schedule(callback: () => void, delay: number): unknown;
  cancel(handle: unknown): void;
}
export interface PetMotionOptions {
  getGeometry: () => Promise<Geometry>;
  move: (x: number, y: number) => Promise<Geometry>;
  /** Native cursor sample + direct drag in one IPC; optional for non-native adapters. */
  drag?: (grabX: number, grabY: number) => Promise<Geometry>;
  /** true only while dragging: force native pointer passthrough off. */
  setActive: (active: boolean) => Promise<void> | void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onBounce?: () => void;
  onError?: (error: unknown) => void;
  physics?: PhysicsParams;
  clock?: MotionClock;
}
const INTERVAL_MS = 1000 / 60;
const clock: MotionClock = {
  now: () => performance.now(),
  schedule: (callback, delay) => setTimeout(callback, delay),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
type Mode = 'idle' | 'pending' | 'drag' | 'throw' | 'roam';

/** Thin scheduler/IPC adapter. All physical integration lives in vendored shared-core. */
export class PetMotion {
  private readonly clock: MotionClock;
  private readonly physics: PhysicsParams;
  private geometry?: Geometry;
  private mode: Mode = 'idle';
  private token = 0;
  private disposed = false;
  private timer: unknown;
  // A single queue covers geometry, movement AND active-state writes across generations.
  private queue: Promise<void> = Promise.resolve();
  private released = false;
  private draggingAnimation = false;
  private activeRequested = false;
  private sling = false;
  private slingshotEnabled = true;
  private origin = { x: 0, y: 0 };
  private grab = { x: 0, y: 0 };
  private trail: DragSample[] = [];
  private state: ThrowState = { x: 0, y: 0, vx: 0, vy: 0 };
  private last = 0;
  private roam?: { start: number; target: number; y: number; since: number; lead: number; end: number; travel: number; video?: Pick<HTMLVideoElement, 'currentTime' | 'duration'> };

  constructor(private readonly options: PetMotionOptions) {
    this.clock = options.clock ?? clock;
    this.physics = { ...(options.physics ?? DEFAULT_PHYSICS) };
    const token = this.token;
    this.enqueue(token, async () => {
      const g = await options.getGeometry();
      if (this.valid(token)) this.adopt(g);
    });
  }

  get isActive(): boolean { return this.mode !== 'idle' && !this.disposed; }

  /** Disable immediately, including a pending pull or an already released sling. */
  setSlingshotEnabled(enabled: boolean): void {
    this.slingshotEnabled = enabled;
    if (!enabled && this.sling && this.isActive && this.mode !== 'roam') this.stop();
  }

  begin(slingshot = false): void {
    if (this.disposed) return;
    this.stop();
    const token = this.token;
    this.mode = 'pending';
    this.released = false;
    this.sling = slingshot && this.slingshotEnabled;
    this.draggingAnimation = true;
    this.call(this.options.onDragStart);
    this.enqueue(token, async () => {
      this.activeRequested = true; // mark before awaiting: failed/late RPC still needs false.
      await this.options.setActive(true);
      if (!this.valid(token)) return;
      const g = await this.options.getGeometry();
      if (!this.valid(token)) return;
      this.adopt(g);
      this.origin = { ...g.cursor };
      this.grab = { x: g.cursor.x - g.position.x, y: g.cursor.y - g.position.y };
      this.trail = [{ ...g.cursor, t: this.clock.now() }];
      this.state = { ...g.position, vx: 0, vy: 0 };
      this.last = this.clock.now();
      this.mode = 'drag';
      if (this.released || !g.cursor_down) await this.release(token);
      else this.schedule(token);
    });
  }

  /** Works even if pointerup arrives while begin's geometry RPC is unresolved. */
  end(): void {
    if (this.disposed || (this.mode !== 'pending' && this.mode !== 'drag')) return;
    this.released = true;
    if (this.mode === 'pending') return;
    this.cancelTimer();
    const token = this.token;
    this.enqueue(token, async () => {
      if (this.mode !== 'drag') return;
      const g = await this.options.getGeometry();
      if (!this.valid(token)) return;
      this.adopt(g);
      this.sample(g);
      await this.release(token);
    });
  }

  /** duration/leadSec/tailSec use seconds, like the upstream video movement driver. */
  startRoam(_name: string, params: Record<string, number>, facing: 'left' | 'right' = 'right', duration?: number, video?: Pick<HTMLVideoElement, 'currentTime' | 'duration'>): boolean {
    if (this.disposed || this.mode !== 'idle' || !this.geometry) return false;
    const g = this.geometry;
    const area = this.area(g);
    if (!area) return false;
    const scale = g.size.width / PET_REF_WIDTH;
    const minDist = params.minDist * scale;
    const maxDist = params.maxDist * scale;
    const lead = params.leadSec ?? 0;
    const tail = params.tailSec ?? 0;
    const mediaDuration = video?.duration;
    const seconds = mediaDuration && Number.isFinite(mediaDuration) && mediaDuration > 0
      ? mediaDuration : (duration ?? params.durationSec ?? 4);
    if (![minDist, maxDist, seconds, lead, tail, params.margin ?? 0].every(Number.isFinite) ||
        minDist < 0 || maxDist < minDist || lead < 0 || tail < 0 || seconds <= 0) return false;
    // Local coordinates preserve planMove's ratio semantics with negative monitor origins.
    // Roam/throw stay on one work area; native cursor dragging is free to cross screens.
    const plan = planMove({
      cx: g.position.x - area.x + g.size.width / 2,
      cy: g.position.y - area.y + g.size.height / 2,
      W: area.width, H: area.height, dir: facing === 'right' ? 1 : -1,
      minDist, maxDist, margin: params.margin ?? 0, halfW: g.size.width / 2 - (g.horizontal_inset ?? 0),
    });
    if (!plan) return false;
    this.mode = 'roam';
    this.roam = {
      start: g.position.x, target: area.x + plan.targetRatio * area.width - g.size.width / 2,
      y: g.position.y, since: this.clock.now(), lead: lead * 1000, end: (seconds - tail) * 1000,
      travel: Math.max(0.1, seconds - lead - tail) * 1000, video,
    };
    this.schedule(this.token);
    return true;
  }

  /** Renderer onMoveEnd calls this; never calls renderer again (no recursive move-end). */
  stopRoam(): void { if (this.mode === 'roam') this.stop(); }

  stop(): void {
    ++this.token;
    this.cancelTimer();
    this.mode = 'idle';
    this.sling = false;
    this.roam = undefined;
    this.trail = [];
    this.state.vx = this.state.vy = 0;
    this.finishAnimation();
    // Not token-gated: an already issued setActive(true) must be undone, even on dispose.
    this.queue = this.queue.then(async () => {
      if (!this.activeRequested) return;
      this.activeRequested = false;
      await this.options.setActive(false);
    }).catch((error) => this.report(error));
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
  }

  private valid(token: number): boolean { return !this.disposed && token === this.token; }
  private enqueue(token: number, work: () => Promise<void>): void {
    this.queue = this.queue.then(async () => {
      if (this.valid(token)) await work();
    }).catch((error) => {
      if (this.valid(token)) { this.stop(); this.report(error); }
    });
  }
  private report(error: unknown): void {
    try { this.options.onError?.(error); } catch { /* error observers cannot resurrect the loop */ }
  }
  private call(callback?: () => void): void {
    try { callback?.(); } catch (error) { this.report(error); }
  }
  private finishAnimation(): void {
    if (!this.draggingAnimation) return;
    this.draggingAnimation = false;
    this.call(this.options.onDragEnd);
  }
  private cancelTimer(): void {
    if (this.timer !== undefined) this.clock.cancel(this.timer);
    this.timer = undefined;
  }
  private schedule(token: number, deadline = this.clock.now() + INTERVAL_MS): void {
    if (!this.valid(token) || this.mode === 'idle' || this.timer !== undefined) return;
    // IPC consumes the frame budget. Schedule only after it settles, never queue missed frames.
    const delay = Math.max(0, deadline - this.clock.now());
    this.timer = this.clock.schedule(() => {
      this.timer = undefined;
      this.enqueue(token, () => this.tick(token));
    }, delay);
  }
  private adopt(g: Geometry): void {
    if (!g || ![g.position?.x, g.position?.y, g.size?.width, g.size?.height,
      g.cursor?.x, g.cursor?.y, g.scale].every(Number.isFinite) ||
      g.size.width <= 0 || g.size.height <= 0 || g.scale <= 0 || typeof g.cursor_down !== 'boolean' ||
      (g.horizontal_inset !== undefined && (!Number.isFinite(g.horizontal_inset) ||
        g.horizontal_inset < 0 || g.horizontal_inset >= g.size.width / 2)) ||
      !Array.isArray(g.areas) || !g.areas.every((a) => [a.x, a.y, a.width, a.height].every(Number.isFinite) && a.width > 0 && a.height > 0)) {
      throw new Error('Invalid native pet geometry');
    }
    this.geometry = g;
    // Never integrate from a speculative requested position: native full-window clamp is final.
    this.state.x = g.position.x;
    this.state.y = g.position.y;
  }
  private area(g: Geometry): Rect | null {
    return resolveRect(g.areas, g.position.x + g.size.width / 2, g.position.y + g.size.height / 2);
  }
  private sample(g: Geometry): void {
    const now = this.clock.now();
    const last = this.trail.at(-1);
    // Repeated stationary polling must NOT refresh the last moving sample's timestamp.
    if (!last || last.x !== g.cursor.x || last.y !== g.cursor.y) this.trail.push({ ...g.cursor, t: now });
    this.trail = trimTrail(this.trail, now);
  }
  private async release(token: number): Promise<void> {
    if (this.mode !== 'drag') return;
    const g = this.geometry!;
    let velocity;
    if (this.sling) {
      const dx = g.cursor.x - this.origin.x, dy = g.cursor.y - this.origin.y;
      velocity = slingshotVelocity(pullAngle(dx, dy), slingshotPower(Math.hypot(dx, dy), g.size.width), this.physics.throwPower);
    } else velocity = estimateReleaseVelocity(this.trail, this.clock.now(), this.physics);
    this.mode = 'throw'; // no further drag tick/end may release twice
    await this.options.setActive(false);
    this.activeRequested = false;
    if (!this.valid(token)) return;
    if (!velocity || (!velocity.vx && !velocity.vy) || !this.area(g)) {
      this.mode = 'idle';
      this.finishAnimation();
      return;
    }
    this.state = { ...g.position, ...velocity };
    this.last = this.clock.now();
    this.schedule(token);
  }
  private async tick(token: number): Promise<void> {
    const deadline = this.clock.now() + INTERVAL_MS;
    if (this.mode === 'drag') {
      const fused = !this.sling && !this.released && !!this.options.drag;
      const g = fused
        ? await this.options.drag!(this.grab.x, this.grab.y)
        : await this.options.getGeometry();
      if (!this.valid(token)) return;
      this.adopt(g);
      this.sample(g);
      if (this.released || !g.cursor_down) { await this.release(token); return; }
      if (!fused) {
        const now = this.clock.now();
        const dt = Math.min(Math.max((now - this.last) / 1000, 0), MAX_STEP_DT);
        this.last = now;
        // Preserve the elastic slingshot and adapters without native fused dragging.
        let x = g.cursor.x - this.grab.x, y = g.cursor.y - this.grab.y;
        if (this.sling) {
          this.state.vx = springStep(this.state.vx, this.state.x, x, dt, this.physics.throwPower);
          this.state.vy = springStep(this.state.vy, this.state.y, y, dt, this.physics.throwPower);
          x = this.state.x + this.state.vx * dt;
          y = this.state.y + this.state.vy * dt;
        }
        await this.move(token, x, y);
      }
      if (!this.valid(token)) return;
      if (this.released || !this.geometry!.cursor_down) {
        this.sample(this.geometry!);
        await this.release(token);
        return;
      }
    } else if (this.mode === 'throw') {
      const g = this.geometry!, a = this.area(g);
      if (!a) { this.stop(); return; }
      // Do not use upstream throwBoundsIn: its 16:9 stage height is NOT the native window height.
      const inset = g.horizontal_inset ?? 0;
      const bounds = { minX: a.x - inset, minY: a.y,
        maxX: Math.max(a.x - inset, a.x + a.width - g.size.width + inset),
        maxY: Math.max(a.y, a.y + a.height - g.size.height) };
      const now = this.clock.now();
      const dt = Math.min(Math.max((now - this.last) / 1000, 0), MAX_STEP_DT);
      this.last = now;
      const physics = { ...this.physics, gravity: this.physics.gravity * g.scale };
      const count = throwSubsteps(this.state.vx, this.state.vy, dt);
      let result = throwStep(this.state, dt / count, bounds, physics);
      let bounced = result.bounced;
      for (let i = 1; i < count && !result.atRest; i++) {
        result = throwStep(result, dt / count, bounds, physics);
        bounced ||= result.bounced;
      }
      this.state = { x: result.x, y: result.y, vx: result.vx, vy: result.vy };
      await this.move(token, result.x, result.y);
      if (!this.valid(token)) return;
      if (bounced) this.call(this.options.onBounce);
      if (!this.valid(token)) return;
      if (result.atRest) { this.mode = 'idle'; this.finishAnimation(); return; }
    } else if (this.mode === 'roam' && this.roam) {
      const r = this.roam;
      const elapsed = r.video ? (r.video.currentTime || 0) * 1000 : this.clock.now() - r.since;
      const progress = elapsed <= r.lead ? 0 : elapsed >= r.end ? 1
        : Math.min(1, Math.max(0, (elapsed - r.lead) / r.travel));
      if (progress > 0) await this.move(token, r.start + (r.target - r.start) * progress, r.y);
      if (!this.valid(token)) return;
      if (progress === 1) { this.mode = 'idle'; this.roam = undefined; return; }
    }
    this.schedule(token, deadline);
  }
  private async move(token: number, x: number, y: number): Promise<void> {
    if (!this.valid(token)) return;
    const g = await this.options.move(x, y);
    if (this.valid(token)) this.adopt(g);
  }
}
