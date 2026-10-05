/**
 * Keep the caption above its geographic anchor. Layout dimensions come from
 * the rendered card and available map area, including any overlapping panels.
 * @param {{x: number, y: number}} anchor
 * @param {{width: number, height: number}} card
 * @param {{left: number, right: number, top: number, bottom: number, controls?: {left: number, top: number, bottom: number}}} bounds
 * @param {number} gap Distance from the card's bottom to the pin's center.
 */
export function previewLayout(anchor, card, bounds, gap) {
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const width = Math.min(card.width, bounds.right - bounds.left);
  const y = anchor.y - gap - card.height;
  const fits = bounds.bottom - bounds.top >= card.height + gap;
  const targetY = fits
      ? clamp(anchor.y, bounds.top + card.height + gap, bounds.bottom)
      : anchor.y;
  const rightAt = (top) => bounds.controls && top < bounds.controls.bottom
      && top + card.height > bounds.controls.top
    ? Math.min(bounds.right, bounds.controls.left - bounds.left)
    : bounds.right;
  const right = rightAt(y);
  const x = clamp(anchor.x - width / 2, bounds.left, right - width);
  const target = {
    x: clamp(anchor.x, bounds.left + width / 2, rightAt(targetY - gap - card.height) - width / 2),
    y: targetY,
  };
  return {
    x,
    y,
    tip: anchor.x - x,
    visible: fits && y >= bounds.top - 0.5 && anchor.y <= bounds.bottom + 0.5
      && anchor.x >= bounds.left && anchor.x <= right,
    shift: { x: target.x - anchor.x, y: target.y - anchor.y },
  };
}
