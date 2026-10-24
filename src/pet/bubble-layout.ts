/** Pure CSS-pixel bubble placement within the host's actual available screen span. */
export interface Rect { x: number; y: number; width: number; height: number }
export interface BubblePlacement extends Rect {
  side: 'above' | 'below' | 'left' | 'right' | 'overlay';
  /** Anchor center relative to this box, kept clear of rounded corners. */
  arrowX: number;
  arrowY: number;
}

const GAP = 8;
const ARROW_MARGIN = 14;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const validSize = (value: { width: number; height: number }): boolean =>
  !!value && Number.isFinite(value.width) && value.width > 0 && Number.isFinite(value.height) && value.height > 0;
const validRect = (value: Rect): boolean => validSize(value) && Number.isFinite(value.x) && Number.isFinite(value.y) &&
  Number.isFinite(value.x + value.width) && Number.isFinite(value.y + value.height);

/**
 * Above, below, then the roomier horizontal side (right wins a tie). If none fit,
 * return a bounded overlay with the least anchor overlap among stable candidates.
 * All inputs and outputs use host-relative CSS pixels; no DPI conversion is applied.
 */
export function placePetBubble(anchor: Rect, preferred: { width: number; height: number }, bounds: Rect): BubblePlacement | null {
  if (!validRect(anchor) || !validSize(preferred) || !validRect(bounds)) return null;
  const width = Math.min(preferred.width, bounds.width);
  const height = Math.min(preferred.height, bounds.height);
  const right = bounds.x + bounds.width, bottom = bounds.y + bounds.height;
  const anchorRight = anchor.x + anchor.width, anchorBottom = anchor.y + anchor.height;
  const centerX = anchor.x + anchor.width / 2, centerY = anchor.y + anchor.height / 2;
  const minX = bounds.x, maxX = right - width, minY = bounds.y, maxY = bottom - height;
  const x = clamp(centerX - width / 2, minX, maxX);
  const y = clamp(centerY - height / 2, minY, maxY);
  const above = anchor.y - GAP - height, below = anchorBottom + GAP;
  const left = anchor.x - GAP - width, sideRight = anchorRight + GAP;
  const placement = (px: number, py: number, side: BubblePlacement['side']): BubblePlacement => {
    const marginX = Math.min(ARROW_MARGIN, width / 2), marginY = Math.min(ARROW_MARGIN, height / 2);
    return { x: px, y: py, width, height, side,
      arrowX: clamp(centerX - px, marginX, width - marginX),
      arrowY: clamp(centerY - py, marginY, height - marginY) };
  };
  if (above >= minY && above <= maxY) return placement(x, above, 'above');
  if (below >= minY && below <= maxY) return placement(x, below, 'below');
  const sides: ('right' | 'left')[] = right - anchorRight >= anchor.x - minX ? ['right', 'left'] : ['left', 'right'];
  for (const side of sides) {
    const px = side === 'right' ? sideRight : left;
    if (px >= minX && px <= maxX) return placement(px, y, side);
  }

  // Above-first stable ordering resolves equal overlap without arbitrary frame jitter.
  const candidates = [
    { x, y: clamp(above, minY, maxY) },
    { x: minX, y: minY }, { x: maxX, y: minY },
    { x, y: clamp(below, minY, maxY) },
    { x: minX, y: maxY }, { x: maxX, y: maxY },
  ];
  const overlap = (candidate: { x: number; y: number }): number =>
    Math.max(0, Math.min(candidate.x + width, anchorRight) - Math.max(candidate.x, anchor.x)) *
    Math.max(0, Math.min(candidate.y + height, anchorBottom) - Math.max(candidate.y, anchor.y));
  let best = candidates[0], least = overlap(best);
  for (const candidate of candidates.slice(1)) {
    const area = overlap(candidate);
    if (area < least) { best = candidate; least = area; }
  }
  return placement(best.x, best.y, 'overlay');
}
