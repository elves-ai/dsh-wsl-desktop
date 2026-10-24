import { placePetBubble, type Rect } from './bubble-layout';

export interface BubbleInsets { left: number; right: number }
const setStyle = (node: HTMLElement, key: string, value: string) => {
  if (node.style.getPropertyValue(key) !== value) node.style.setProperty(key, value);
};

/** Measure in CSS pixels after rendering; native physical pixels are converted by the host. */
export function layoutPetBubbles(root: HTMLElement, anchor: HTMLElement, insets: BubbleInsets = { left: 0, right: 0 }): void {
  const host = root.querySelector<HTMLElement>('.pet-shell');
  if (!host || !anchor.getClientRects().length) return;
  const shell = host.getBoundingClientRect(), viewport = root.getBoundingClientRect();
  // Bottom controls live in the context menu; bubbles may now use the full viewport.
  const left = Math.max(shell.left, viewport.left + insets.left) + 6;
  const right = Math.min(shell.right, viewport.right - insets.right) - 6;
  const top = Math.max(shell.top, viewport.top) + 6;
  // The full native window is vertically constrained to its work area.
  const bottom = Math.min(shell.bottom, viewport.bottom) - 6;
  const bounds: Rect = { x: left - shell.left, y: top - shell.top, width: right - left, height: bottom - top };
  if (bounds.width <= 0 || bounds.height <= 0) return;
  // Reserve real, measured input height at the feet, only while typing. The native
  // transparent window stays unchanged; video and hit box move together without scaling.
  const composer = root.querySelector<HTMLElement>('#pet-composer');
  let composerTop = bottom;
  let reserved = 0;
  if (composer && !composer.hidden && composer.getClientRects().length) {
    const width = Math.min(324, bounds.width);
    setStyle(composer, 'width', width + 'px');
    setStyle(composer, 'max-height', Math.max(40, bounds.height - 180) + 'px');
    setStyle(composer, 'height', 'auto');
    setStyle(composer, 'top', 'auto');
    setStyle(composer, 'bottom', (shell.bottom - bottom) + 'px');
    const height = composer.getBoundingClientRect().height;
    const pet = anchor.getBoundingClientRect();
    const x = Math.max(left, Math.min(pet.left + pet.width / 2 - width / 2, right - width));
    setStyle(composer, 'left', (x - shell.left) + 'px');
    setStyle(composer, 'right', 'auto');
    composerTop = bottom - height;
    reserved = height + 8;
    composer.dataset.placement = 'below';
  }
  setStyle(host, '--pet-composer-space', reserved + 'px');
  // Padding changes the stage position, so measure the pet only after reserving input space.
  const pet = anchor.getBoundingClientRect();
  const speechBounds = { ...bounds, height: Math.max(1, composerTop - shell.top - bounds.y - (reserved ? 8 : 0)) };
  const target: Rect = { x: pet.left - shell.left, y: pet.top - shell.top, width: pet.width, height: pet.height };

  for (const id of ['pet-bubble', 'pet-interaction', 'pet-dialogue']) {
    const bubble = root.querySelector<HTMLElement>('#' + id);
    if (!bubble || bubble.hidden || !bubble.getClientRects().length) continue;
    const interaction = id === 'pet-interaction';
    const dialogue = id === 'pet-dialogue';
    const summary = interaction ? bubble.querySelector<HTMLElement>('.pet-interactions-summary:not([hidden])') : null;
    const width = Math.min(interaction ? 348 : 324, bounds.width);
    // Reset only dimensions to measure wrapped content; positioning never affects pet layout.
    setStyle(bubble, 'right', 'auto');
    setStyle(bubble, 'bottom', 'auto');
    setStyle(bubble, 'width', width + 'px');
    // Speech stays above the head; expanded text must not cover the separate input strip.
    const available = dialogue ? speechBounds : bounds;
    const dialogueHeight = bubble.dataset.expanded === 'true' ? 256 : Math.max(36, Math.min(152, target.y - bounds.y - 8));
    setStyle(bubble, 'max-height', Math.min(interaction ? 256 : dialogue ? dialogueHeight : 110, available.height) + 'px');
    // An absolute summary has max-height:100%; give it a real containing height while measuring.
    setStyle(bubble, 'height', interaction ? Math.min(256, bounds.height) + 'px' : 'auto');
    const measured = (summary ?? bubble).getBoundingClientRect();
    const preferred = { width: summary ? measured.width : width, height: measured.height };
    const placement = placePetBubble(target, preferred, available);
    if (!placement) continue;
    setStyle(bubble, 'left', placement.x + 'px');
    setStyle(bubble, 'top', placement.y + 'px');
    setStyle(bubble, 'width', placement.width + 'px');
    setStyle(bubble, 'height', placement.height + 'px');
    setStyle(bubble, '--pet-bubble-arrow-x', placement.arrowX + 'px');
    setStyle(bubble, '--pet-bubble-arrow-y', placement.arrowY + 'px');
    bubble.dataset.placement = placement.side;
  }
}
