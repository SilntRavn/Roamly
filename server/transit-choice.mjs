const numeric = (value) => ["string", "number"].includes(typeof value) && String(value).trim() !== "" &&
  Number.isFinite(Number(value)) && Number(value) >= 0;

// 地铁是便利性偏好：仅在时间、步行成本接近时优先，不能排除更合适的公交。
export function chooseTransitPath(paths = []) {
  const usable = paths.filter((p) => numeric(p.duration) && numeric(p.distance)).sort((a, b) => Number(a.duration) - Number(b.duration));
  if (!usable.length) return paths[0];
  const fastest = usable[0];
  const subway = (path) => (path.segments || []).some((segment) =>
    /地铁|轻轨|磁悬浮|有轨电车/.test(segment.bus?.buslines?.[0]?.type || ""));
  return usable.find((path) => subway(path) && Number(path.duration) <= Number(fastest.duration) * 1.25 &&
    Number(path.duration) - Number(fastest.duration) <= 900 &&
    (!numeric(path.walking_distance) || !numeric(fastest.walking_distance) ||
      Number(path.walking_distance) <= Number(fastest.walking_distance) + 500)) || fastest;
}
