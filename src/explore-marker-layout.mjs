// Keep the icons visible independently of crowded place-name labels.
export function layoutExploreMarkers(points, area, focusedId) {
  const visible = [];
  for (const point of [...points].sort((a, b) => Number(b.id === focusedId) - Number(a.id === focusedId))) {
    const focused = point.id === focusedId;
    if (!focused && (point.x <= area.left + 16 || point.x >= area.right - 16 || point.y <= area.top + 16 || point.y >= area.bottom - 16 ||
      point.x > area.controls.left - 20 && point.y < area.controls.bottom + 30 ||
      visible.some((other) => Math.hypot(other.x - point.x, other.y - point.y) < 36))) continue;
    visible.push(point);
  }
  const labels = [];
  const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  return visible.map((point) => {
    const width = Math.min(128, Math.max(36, point.name.length * 10 + 12));
    const box = { left: point.x - width / 2, right: point.x + width / 2, top: point.y + 20, bottom: point.y + 42 };
    const label = point.id === focusedId || (box.left >= area.left && box.right <= area.right && box.bottom <= area.bottom &&
      !labels.some((other) => overlaps(box, other)) && !visible.some((other) => other.id !== point.id &&
        overlaps(box, { left: other.x - 17, right: other.x + 17, top: other.y - 17, bottom: other.y + 17 })));
    if (label) labels.push(box);
    return { ...point, label };
  });
}
