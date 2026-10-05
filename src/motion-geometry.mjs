/**
 * A reveal starts at the actual input position, including a navigation button
 * outside the content pane. Its final circle must cover every pane corner.
 * @param {{clientX: number, clientY: number}} point
 * @param {{left: number, top: number, width: number, height: number}} rect
 */
export function revealCircle(point, rect) {
  const x = point.clientX - rect.left;
  const y = point.clientY - rect.top;
  const dx = Math.max(Math.abs(x), Math.abs(rect.width - x));
  const dy = Math.max(Math.abs(y), Math.abs(rect.height - y));
  return { x, y, radius: Math.hypot(dx, dy) + 1 };
}
