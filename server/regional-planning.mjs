import { matchesPlace, normalizedName } from "../shared/requirements.mjs";

// 坐标只用于提出候选区域；是否省时必须另用实际交通路线核验。
export function distanceKm(a, b) {
  const radians = (n) => n * Math.PI / 180;
  const x = radians(b.location.lat - a.location.lat);
  const y = radians(b.location.lng - a.location.lng);
  const h = Math.sin(x / 2) ** 2 + Math.cos(radians(a.location.lat)) *
    Math.cos(radians(b.location.lat)) * Math.sin(y / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
export function validCoordinates(place) {
  return place?.location?.coordSystem === "GCJ-02" &&
    Number.isFinite(place.location.lng) && Number.isFinite(place.location.lat) &&
    Math.abs(place.location.lng) <= 180 && Math.abs(place.location.lat) <= 90;
}
export function fixedFor(place, requirements) {
  return (requirements.fixedVisits || []).filter((v) =>
    v.placeId ? v.placeId === place.id : matchesPlace(place, v));
}
export function isRequired(place, requirements) {
  return Boolean(place && ((requirements.requiredPlaceIds || []).includes(place.id) ||
    (requirements.requiredPlaces || []).some((v) => matchesPlace(place, v)) ||
    fixedFor(place, requirements).length));
}

// Complete-link 避免通过一串中间点把两端很远的地点误归成一个小区域。
// 固定日期、重复访问保守留在原日；不依赖特定城市或行政区大小。
export function groupByRegion(entries, dayIndices, requirements = {}) {
  if (!entries.length || !dayIndices.length || entries.some((e) => !validCoordinates(e.place))) return null;
  const repeated = new Set(entries.filter((e) =>
    entries.filter((v) => v.place.id === e.place.id).length > 1).map((e) => e.place.id));
  let clusters = entries.map((entry) => {
    const fixed = fixedFor(entry.place, requirements);
    const assigned = requirements.dayDestinations?.find((v) => v.day === entry.day);
    const uniqueDay = assigned && requirements.dayDestinations.filter((v) =>
      normalizedName(v.destination) === normalizedName(assigned.destination)).length === 1;
    const pinned = fixed.find((v) => v.day != null)?.day ??
      (entry.day && (uniqueDay || repeated.has(entry.place.id) || fixed.some((v) => v.arrival != null)) ? entry.day : null);
    return { entries: [entry], pinned };
  });
  if (clusters.some((c) => c.pinned != null && !dayIndices.includes(c.pinned))) return null;
  // 同一天的固定预约必须一起保留，即便相隔很远也不悄悄改预约。
  for (const index of dayIndices) {
    const pinned = clusters.filter((c) => c.pinned === index);
    if (pinned.length > 1) {
      clusters = clusters.filter((c) => c.pinned !== index);
      clusters.push({ pinned: index, entries: pinned.flatMap((c) => c.entries) });
    }
  }
  const span = (entries) => Math.max(0, ...entries.flatMap((a, i) =>
    entries.slice(i + 1).map((b) => distanceKm(a.place, b.place))));
  const limit = requirements.maxDailyStops ?? 8;
  while (clusters.length > dayIndices.length) {
    let best = null;
    for (let a = 0; a < clusters.length; a++) for (let b = a + 1; b < clusters.length; b++) {
      const left = clusters[a], right = clusters[b];
      if (left.pinned != null && right.pinned != null && left.pinned !== right.pinned) continue;
      const combined = [...left.entries, ...right.entries];
      if (combined.length > limit) continue;
      const cost = span(combined);
      if (!best || cost < best.cost) best = { a, b, cost, combined, pinned: left.pinned ?? right.pinned };
    }
    if (!best) return null;
    clusters[best.a] = { entries: best.combined, pinned: best.pinned };
    clusters.splice(best.b, 1);
  }
  const assigned = new Map(clusters.filter((c) => c.pinned != null).map((c) => [c.pinned, c]));
  const free = clusters.filter((c) => c.pinned == null);
  // 尽量保留原日；尚未排程时紧凑区域优先，不凭坐标臆测市中心。
  for (const index of dayIndices.filter((d) => !assigned.has(d))) {
    free.sort((a, b) => b.entries.filter((e) => e.day === index).length -
      a.entries.filter((e) => e.day === index).length || span(a.entries) - span(b.entries));
    if (free.length) assigned.set(index, free.shift());
  }
  return [...assigned].sort(([a], [b]) => a - b).map(([index, c]) => ({
    index, entries: c.entries, spanKm: Math.round(span(c.entries) * 10) / 10,
  }));
}

export function regionalAdvice(places, requirements, entries = null) {
  const groups = groupByRegion(entries || places.map((place) => ({ place })),
    Array.from({ length: requirements.days || 1 }, (_, i) => i + 1), requirements);
  return {
    groups: groups?.map((g) => ({ day: g.index, spanKm: g.spanKm,
      places: g.entries.map(({ place }) => ({ id: place.id, name: place.name, city: place.city, district: place.district })) })) ?? null,
    scope: "按坐标与固定日期提出区域候选，直线跨度不是交通时间。需核验实际交通、开放与停留时长；不含住宿接驳，不保证最优。若区域过散，替换非必去推荐或增加同区域候选。",
  };
}

// POI 明确用“整体景区名-内部点”命名时，普通推荐用实际游览点代表该区域，
// 不再额外往返整体范围坐标。用户必去 ID、预约和明确保留的整体景区不合并。
export function consolidateAreaStops(trip, lookup, requirements) {
  const removed = [];
  const days = trip.days.map((day) => {
    const visits = day.items.filter((i) => i.kind === "place");
    const redundant = new Set(visits.filter((item) => {
      const parent = lookup(item.placeId);
      return parent && /(?:风景名胜区|风景区|旅游景区|景区)$/.test(parent.name) &&
        !isRequired(parent, requirements) && visits.some((other) => {
          const child = lookup(other.placeId);
          return child && other.id !== item.id && child.city === parent.city &&
            child.name.startsWith(`${parent.name}-`) &&
            !/停车|出入口|游客中心|售票|餐饮|住宿|购物/.test(`${child.category || ""} ${child.name}`);
        });
    }).map((i) => i.id));
    if (!redundant.size) return day;
    const items = day.items.filter((i) => !redundant.has(i.id)).map((i) => ({ ...i }));
    removed.push(...visits.filter((i) => redundant.has(i.id)).map((i) => i.title));
    const first = items.find((i) => i.kind === "place");
    if (redundant.has(visits[0]?.id) && first &&
      !fixedFor(lookup(first.placeId), requirements).some((v) => v.arrival != null))
      first.arrival = visits[0].arrival;
    items.sort((a, b) => a.arrival.localeCompare(b.arrival));
    return { ...day, items };
  });
  return { trip: removed.length ? { ...trip, days } : trip, removed };
}
