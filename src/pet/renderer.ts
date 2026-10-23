/**
 * dsh-pet renderer port, MIT. Copyright (c) 2026 PC2005-cloud.
 * Source: https://github.com/PC2005-cloud/dsh-pet @ bbf9dd800c8e5d4dc8cd2209c537b28808465c52
 * Full MIT permission/warranty notice: third-party/dsh-pet/LICENSE.
 * Animation assets have separate non-commercial terms; see third-party/dsh-pet/NOTICE.md.
 * Ported from runtime/electron-helper/sprite.js: switchTo/playOnce (492–591),
 * playIdle/handleEnded/resumeWorkStatusAnim (674–791), startSquash (1133–1162),
 * onPointerMove/onPointerUp/onClick/onMenuAction (1273–1343, 1572–1595, 1730–1748).
 * Selection and squash physics deliberately import upstream's unmodified shared code.
 * Native positioning/throwing and input capture belong to the host, not this renderer.
 */
import { pick, pickSlot, rollKind, pickCategoryAction, isEventAnim, nextWorkStatusAnim } from '../vendor/dsh-pet/pickers';
import { SQ_DURATION_MS, SQ_SQUASH, squashScale } from '../vendor/dsh-pet/physics';
import { WORK_STATUS_INDEX, type WorkStatusState } from '../vendor/dsh-pet/work-status';
import type { Animations, Weights, MoveSpec } from '../vendor/dsh-pet/types';
import { PET_ANIMATIONS, PET_ANIMATION_WEIGHTS, resolveAnimationUrl } from './config';

export interface PetState {
  phase?: string;
  running?: boolean;
  waiting?: boolean;
  connected?: boolean;
  enabled?: boolean;
  workStatus?: WorkStatusState | null;
  session_id?: string | null;
  [key: string]: unknown;
}
export interface PetAction { name: string; group: string; noMirror?: boolean }
export interface PetMovePlayback {
  /** Native drive should use this video's currentTime, not wall-clock time. */
  video: HTMLVideoElement;
  facing: 'left' | 'right';
}
export interface PetRendererOptions {
  animations?: Animations;
  weights?: Weights;
  assetBase?: string;
  fixed?: boolean;
  loadTimeoutMs?: number;
  reducedMotion?: boolean;
  canMove?: (name: string, params: Record<string, number>) => boolean;
  /** Called only after first video frame/play success. false rejects random roaming. */
  onMove?: (name: string, params: Record<string, number>, playback: PetMovePlayback) => boolean | void;
  onMoveEnd?: () => void;
  onError?: (error: Error) => void;
}
interface Playback { name: string; once: boolean; video: HTMLVideoElement; move?: MoveSpec; randomMove?: boolean; squash?: boolean }
interface Pending extends Playback { generation: number; cancel: () => void }
const instances = new Set<PetRenderer>();
const rootOwner = Symbol.for('dsh-wsl-desktop.pet-renderer');
type OwnedRoot = HTMLElement & { [rootOwner]?: PetRenderer };

/** Normalize DSH's snapshot to the original six workStatus slots (not new pools). */
export function toPetWorkStatus(state: PetState): WorkStatusState | null {
  if (state.enabled === false) return null;
  if (state.workStatus !== undefined) return state.workStatus;
  const phase = state.phase ?? '';
  if (['error', 'failed'].includes(phase)) return 'error';
  if (state.connected === false) return null;
  if (state.waiting || ['waiting', 'approval'].includes(phase)) return 'waiting';
  if (['completed', 'success'].includes(phase)) return 'success';
  if (['working', 'tool', 'tool-call', 'cancelling'].includes(phase)) return 'working';
  if (['result', 'tool-result'].includes(phase)) return 'result';
  if (state.running || ['thinking', 'sending'].includes(phase)) return 'thinking';
  return null;
}

/**
 * Host contract: root is a dedicated transparent 16:9 media slot, width set by host
 * (360px => 202.5px high). Both videos fill it; no CSS character/fallback is created.
 * Hit testing uses upstream HIT_BOX in a separate host overlay. Host calls click(),
 * dragStart() after DRAG_THRESHOLD and dragEnd(); no duplicate pointer listeners here.
 */
export class PetRenderer {
  private readonly videos: [HTMLVideoElement, HTMLVideoElement];
  private readonly status: HTMLElement;
  private readonly view: Window;
  private readonly animations: Animations;
  private readonly weights: Weights;
  private active: Playback | null = null;
  private pending: Pending | null = null;
  private generation = 0;
  private disposed = false;
  private dragging = false;
  private fixed: boolean;
  private facing: 'left' | 'right' = 'left';
  private workState: WorkStatusState | null = null;
  private snapshot: PetState | null = null;
  private moving = false;
  private squashFrame: number | null = null;
  private squashVideo: HTMLVideoElement | null = null;
  private lastDragEnd = -Infinity;

  constructor(private readonly root: HTMLElement, private readonly options: PetRendererOptions = {}) {
    // Survives asynchronous HMR/import replacement: late callbacks from old instance
    // are invalidated before the replacement starts loading into the same root.
    (root as OwnedRoot)[rootOwner]?.dispose();
    (root as OwnedRoot)[rootOwner] = this;
    this.view = root.ownerDocument.defaultView!;
    this.animations = options.animations ?? PET_ANIMATIONS;
    this.weights = options.weights ?? PET_ANIMATION_WEIGHTS;
    this.fixed = options.fixed ?? false;
    Object.assign(root.style, { position: 'relative', width: '100%', aspectRatio: '16 / 9', background: 'transparent' });
    root.dataset.petRenderer = 'loading';
    const createVideo = () => {
      const video = root.ownerDocument.createElement('video');
      video.className = 'pet-video';
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      video.preload = 'auto'; // Only these two elements ever receive a URL; no asset-wide preload.
      video.setAttribute('muted', '');
      video.setAttribute('playsinline', '');
      video.setAttribute('aria-hidden', 'true');
      Object.assign(video.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'contain', opacity: '0', pointerEvents: 'none' });
      return video;
    };
    this.videos = [createVideo(), createVideo()];
    this.status = root.ownerDocument.createElement('div');
    this.status.className = 'pet-video-status';
    this.status.setAttribute('role', 'status');
    Object.assign(this.status.style, { position: 'absolute', inset: '0', display: 'grid', placeItems: 'center', color: '#c8d3e6', fontSize: '12px', textAlign: 'center', pointerEvents: 'none' });
    this.status.textContent = '正在加载宠物动画…';
    root.append(...this.videos, this.status);
    instances.add(this);
    this.playOnce(this.animations.idle[0]);
  }

  private get anim(): string { return this.pending?.name ?? this.active?.name ?? ''; }
  private terminal(): boolean { return this.workState === 'success' || this.workState === 'error'; }
  private mirror(): string { return this.facing === 'right' ? 'scaleX(-1)' : ''; }
  private url(name: string): string {
    return this.options.assetBase ? this.options.assetBase.replace(/\/?$/, '/') + encodeURIComponent(name) + '.webm' : resolveAnimationUrl(name);
  }
  private release(video: HTMLVideoElement): void {
    video.onended = null;
    video.onerror = null;
    video.pause();
    video.style.opacity = '0';
    video.classList.remove('is-front');
    video.removeAttribute('src');
    video.load(); // Release decoder/resource, rather than caching all 106 assets.
  }
  private cancelPending(): void {
    const pending = this.pending;
    this.pending = null;
    if (pending) { pending.cancel(); this.release(pending.video); }
  }
  private stopMove(): void {
    if (!this.moving) return;
    this.moving = false;
    this.options.onMoveEnd?.();
  }
  private fail(name: string, why: string): void {
    const error = new Error('宠物动画加载失败：' + name + '（' + why + '）');
    this.root.dataset.petRenderer = 'error';
    this.status.textContent = error.message;
    this.status.hidden = false;
    this.status.style.display = 'grid';
    this.status.setAttribute('role', 'alert');
    this.options.onError?.(error);
  }

  // Upstream switchTo; tightened generation guard covers error/dispose and play()
  // settlement too. Unlike upstream, keep old frame until play + first frame succeed.
  private switchTo(name: string, once: boolean, extra: Partial<Playback> = {}): void {
    if (this.disposed) return;
    if (!name) { this.fail('(empty pool)', '没有可用动画'); return; }
    if (this.pending?.name === name && this.pending.once === once) {
      if (extra.squash) this.pending.squash = true;
      return;
    }
    this.stopMove();
    this.cancelPending();
    const generation = ++this.generation;
    const video = this.videos.find(v => v !== this.active?.video)!;
    let timer: number;
    let frame: number | null = null;
    let readyStarted = false;
    const valid = () => !this.disposed && this.pending?.generation === generation && this.generation === generation;
    const cleanup = () => {
      this.view.clearTimeout(timer);
      video.removeEventListener('loadeddata', ready);
      video.onerror = null;
      if (frame !== null) video.cancelVideoFrameCallback?.(frame);
    };
    const failed = (why: string) => {
      if (!valid()) return;
      this.pending = null;
      cleanup();
      this.release(video);
      this.fail(name, why);
    };
    const commit = () => {
      if (!valid()) return;
      cleanup();
      const next = this.pending!;
      const old = this.active;
      this.pending = null;
      this.stopSquash();
      this.active = next;
      video.style.transform = this.mirror();
      video.style.opacity = '1';
      video.classList.add('is-front');
      video.onended = once ? () => {
        if (this.active?.video !== video || this.active !== next || this.pending || this.disposed) return;
        video.onended = null; // Ended can only advance the chain once.
        this.handleEnded();
      } : null;
      video.onerror = () => { if (!this.disposed && this.active === next) { this.stopMove(); this.fail(name, 'video error'); } };
      if (old && old.video !== video) this.release(old.video);
      this.root.dataset.petRenderer = 'ready';
      this.root.dataset.petAnimation = name;
      this.root.dataset.petFacing = this.facing;
      this.status.hidden = true;
      this.status.style.display = 'none';
      if (next.squash) this.startSquash();
      if (next.move && this.options.onMove) {
        const params = { ...this.animations.moves.default, ...next.move.params, direction: this.facing === 'right' ? 1 : -1, durationSec: Number.isFinite(video.duration) ? video.duration : 10.09 };
        this.moving = true;
        const accepted = this.options.onMove(name, params, { video, facing: this.facing });
        if (accepted === false) {
          this.moving = false;
          if (next.randomMove) this.playCategory();
        }
      }
    };
    const ready = () => {
      if (!valid() || readyStarted) return;
      readyStarted = true;
      video.removeEventListener('loadeddata', ready);
      // Catch synchronous browser/fake failures and rejected autoplay promises.
      try {
        Promise.resolve(video.play()).then(() => {
          if (!valid()) return;
          if (typeof video.requestVideoFrameCallback === 'function') frame = video.requestVideoFrameCallback(commit);
          else commit(); // loadeddata guarantees a decoded frame on older WebViews.
        }, () => failed('play rejected'));
      } catch { failed('play rejected'); }
    };
    this.pending = { name, once, video, ...extra, generation, cancel: cleanup };
    timer = this.view.setTimeout(() => failed('加载超时'), this.options.loadTimeoutMs ?? 10_000);
    video.loop = !once;
    video.onended = null;
    video.onerror = () => failed('video error');
    video.addEventListener('loadeddata', ready);
    try {
      video.src = this.url(name);
      video.load();
      if (video.readyState >= 2) ready();
    } catch { failed('invalid asset'); }
  }
  private playOnce(name: string, extra: Partial<Playback> = {}): void { this.switchTo(name, true, extra); }
  private playCategory(): void {
    this.playOnce(pickCategoryAction(this.animations.categories, this.animations.idle, this.facing, this.anim).name);
  }
  // Port of playIdle (674–707), using the SAME rollKind, pick/category selector.
  private playIdle(): void {
    if (this.disposed || this.dragging) return;
    const kind = rollKind(Math.random(), this.weights, { fixed: this.fixed });
    if (kind === 'idle') this.playOnce(pick(this.animations.idle, this.anim));
    else if (kind === 'turn' && this.animations.turn.length) this.playOnce(pick(this.animations.turn, this.anim));
    else if (kind === 'move') {
      if (!this.tryMove()) this.playCategory();
    } else this.playCategory();
  }
  private tryMove(name?: string): boolean {
    const move = name ? this.animations.moves.actions.find(a => a.name === name) : pick(this.animations.moves.actions);
    if (!move || !this.options.onMove) return false;
    const params = { ...this.animations.moves.default, ...move.params };
    if (this.options.canMove?.(move.name, params) === false) return false;
    this.playOnce(move.name, { move, randomMove: !name });
    return true;
  }
  // Port of handleEnded (709–765): events -> work pool, turn -> mirror,
  // click/drag -> work pool/idle, ordinary animation -> weighted random chain.
  private handleEnded(): void {
    this.stopMove();
    if (this.dragging || this.disposed || !this.active) return;
    const anim = this.active.name;
    if (isEventAnim(this.animations.events, anim)) {
      const next = this.workState && !this.terminal() ? nextWorkStatusAnim(this.animations.events.workStatus ?? [], anim) : null;
      if (next !== null) { this.playOnce(next); return; }
      if (!this.resumeWorkStatusAnim()) this.playOnce(pick(this.animations.idle, anim));
      return;
    }
    if (this.animations.turn.includes(anim)) {
      this.facing = this.facing === 'left' ? 'right' : 'left';
      this.active.video.style.transform = this.mirror();
      this.root.dataset.petFacing = this.facing;
    }
    if (this.animations.drag.includes(anim) || this.animations.clicks.includes(anim)) {
      if (!this.resumeWorkStatusAnim()) this.playOnce(pick(this.animations.idle, anim));
      return;
    }
    // Explicit category/menu interruption must also return to a live work status.
    if (!this.resumeWorkStatusAnim()) this.playIdle();
  }
  private playWorkStatus(): boolean {
    if (!this.workState) return false;
    const slot = this.animations.events.workStatus?.[WORK_STATUS_INDEX[this.workState]];
    if (slot === undefined || (Array.isArray(slot) && !slot.length)) return false;
    const rotating = Array.isArray(slot) && slot.length > 1;
    this.switchTo(pickSlot(slot, this.anim), this.terminal() || rotating);
    return true;
  }
  private resumeWorkStatusAnim(): boolean {
    return !this.dragging && !this.terminal() && this.playWorkStatus();
  }

  updateState(state: PetState): void {
    if (this.disposed) return;
    let next = toPetWorkStatus(state);
    // Desktop snapshots expose running rather than an explicit turn/end event.
    // Only a connected same-session running->idle edge synthesizes completion.
    if (!next && state.connected !== false && state.enabled !== false && this.snapshot?.running && !state.running &&
      this.snapshot.session_id === state.session_id && !['loading', 'disconnected', 'cancelling'].includes(state.phase ?? '')) next = 'success';
    // Preserve one-shot completion/error across unrelated ready snapshots. The
    // next busy status, explicit workStatus:null, disconnect or session switch clears it.
    if (!next && this.terminal() && state.workStatus === undefined && state.connected !== false && state.enabled !== false &&
      this.snapshot?.session_id === state.session_id) next = this.workState;
    this.snapshot = { ...state };
    if (next === this.workState) return; // streaming/revision snapshots never restart video.
    this.workState = next;
    this.root.dataset.petWorkStatus = next ?? 'idle';
    if (this.dragging) return;
    if (!this.playWorkStatus()) this.playOnce(pick(this.animations.idle, this.anim));
  }
  click(): void {
    if (this.disposed || this.dragging || this.view.performance.now() - this.lastDragEnd < 100) return;
    if (this.animations.clicks.length) this.playOnce(pick(this.animations.clicks), { squash: true });
    else this.startSquash();
  }
  dragStart(): void {
    if (this.disposed || this.dragging) return;
    this.dragging = true;
    this.stopMove();
    this.stopSquash();
    if (this.animations.drag.length) this.playOnce(pick(this.animations.drag));
  }
  dragEnd(): void {
    if (this.disposed || !this.dragging) return;
    this.dragging = false;
    this.lastDragEnd = this.view.performance.now();
    if (!this.resumeWorkStatusAnim()) this.playOnce(pick(this.animations.idle, this.anim));
  }
  listActions(): PetAction[] {
    const result: PetAction[] = [];
    const add = (names: string[], group: string, noMirror?: boolean) => names.forEach(name => result.push({ name, group, noMirror }));
    add(this.animations.idle, 'idle'); add(this.animations.turn, 'turn');
    add(this.animations.clicks, 'clicks'); add(this.animations.drag, 'drag');
    add(this.animations.moves.actions.map(a => a.name), 'move');
    this.animations.categories.forEach(c => add(c.actions, c.id, c.noMirror));
    Object.entries(this.animations.events).forEach(([group, slots]) => add(slots.flatMap(s => typeof s === 'string' ? [s] : s), group));
    return result.filter((item, index) => result.findIndex(a => a.name === item.name) === index);
  }
  trigger(action: string | { name?: string; anim?: string }): boolean {
    if (this.disposed || this.dragging) return false;
    const name = typeof action === 'string' ? action : action.name ?? action.anim;
    const spec = this.listActions().find(a => a.name === name);
    if (!spec) return false; // no arbitrary paths/URLs accepted by menu API.
    if (spec.noMirror) this.facing = 'left';
    if (!this.tryMove(spec.name)) this.playOnce(spec.name);
    return true;
  }
  toggleFixed(force?: boolean): boolean {
    this.fixed = force ?? !this.fixed;
    if (this.fixed) {
      this.stopMove();
      if (this.pending?.move) {
        this.cancelPending();
        if (!this.resumeWorkStatusAnim()) this.playOnce(pick(this.animations.idle, this.anim));
      }
    }
    return this.fixed;
  }
  /** Public also for native landing callback; depth can use shared landingSquash. */
  startSquash(depth = SQ_SQUASH): void {
    if (this.disposed || !this.active || (this.options.reducedMotion ?? this.view.matchMedia?.('(prefers-reduced-motion: reduce)').matches)) return;
    this.stopSquash();
    const video = this.active.video;
    this.squashVideo = video;
    video.style.transformOrigin = 'bottom';
    const start = this.view.performance.now();
    const step = () => {
      if (this.disposed || this.squashVideo !== video) return;
      const u = Math.min((this.view.performance.now() - start) / SQ_DURATION_MS, 1);
      video.style.transform = this.mirror() + ' scaleY(' + squashScale(u, depth) + ')';
      if (u < 1) this.squashFrame = this.view.requestAnimationFrame(step);
      else this.stopSquash();
    };
    this.squashFrame = this.view.requestAnimationFrame(step);
  }
  private stopSquash(): void {
    if (this.squashFrame !== null) this.view.cancelAnimationFrame(this.squashFrame);
    if (this.squashVideo) { this.squashVideo.style.transformOrigin = ''; this.squashVideo.style.transform = this.mirror(); }
    this.squashFrame = null;
    this.squashVideo = null;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    ++this.generation;
    this.cancelPending();
    this.stopMove();
    this.stopSquash();
    this.videos.forEach(video => { this.release(video); video.remove(); });
    this.status.remove();
    this.active = null;
    instances.delete(this);
    if ((this.root as OwnedRoot)[rootOwner] === this) {
      delete (this.root as OwnedRoot)[rootOwner];
      delete this.root.dataset.petRenderer;
      delete this.root.dataset.petAnimation;
      delete this.root.dataset.petWorkStatus;
      delete this.root.dataset.petFacing;
    }
  }
}

if (import.meta.hot) import.meta.hot.dispose(() => { for (const instance of [...instances]) instance.dispose(); });
