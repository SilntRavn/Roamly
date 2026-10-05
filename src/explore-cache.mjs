// Public views survive reopening the app without storing account-owned favorites.
const viewsKey = "roamly-explore-views-v2";
const stateKey = "roamly-explore-state-v1";
export function createExploreViewCache(storage, limit = 12) {
  let entries = [];
  try { entries = JSON.parse(storage?.getItem(viewsKey) || "[]"); } catch {}
  const cache = new Map(Array.isArray(entries) ? entries.filter((entry) => Array.isArray(entry) && typeof entry[0] === "string" &&
    Array.isArray(entry[1]?.places) && Array.isArray(entry[1]?.feed?.notes) && Array.isArray(entry[1]?.feed?.places)).slice(-limit) : []);
  return {
    get: (key) => {
      if (cache.has(key)) return cache.get(key);
      const [category, lng, lat, radius] = key.split(":");
      if (![lng, lat, radius].every((value) => value !== undefined && Number.isFinite(Number(value)))) return undefined;
      let closest;
      let distance = 1000;
      for (const [storedKey, result] of cache) {
        const [storedCategory, storedLng, storedLat, storedRadius] = storedKey.split(":");
        if (category !== storedCategory || radius !== storedRadius) continue;
        const delta = Math.hypot((Number(storedLng) - Number(lng)) * Math.cos(Number(lat) * Math.PI / 180), Number(storedLat) - Number(lat)) * 111320;
        if (delta <= distance) { closest = result; distance = delta; }
      }
      return closest;
    },
    set: (key, result) => {
      cache.delete(key);
      cache.set(key, result);
      if (cache.size > limit) cache.delete(cache.keys().next().value);
      try { storage?.setItem(viewsKey, JSON.stringify([...cache])); } catch {}
    },
  };
}
export function readExploreState(storage, fallback) {
  try {
    const value = JSON.parse(storage?.getItem(stateKey) || "null");
    if (!value || !["scenery", "food", "stay", "fun"].includes(value.category) ||
        ![0, 1, 2].includes(value.sheet) || !Number.isFinite(value.scroll) || value.scroll < 0) return fallback;
    const area = value.area;
    const search = value.search;
    if (area && (![area.lng, area.lat, area.zoom].every(Number.isFinite) || Math.abs(area.lng) > 179 || Math.abs(area.lat) > 80)) return fallback;
    if (search && (![search.lng, search.lat, search.west, search.south, search.east, search.north].every(Number.isFinite) ||
        ![5000, 10000].includes(search.radius) || search.west >= search.east || search.south >= search.north)) return fallback;
    return value;
  } catch { return fallback; }
}
export function writeExploreState(storage, value) {
  try { storage?.setItem(stateKey, JSON.stringify(value)); } catch {}
}
