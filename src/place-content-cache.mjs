import { createPreloadQueue } from "../shared/preload-queue.mjs";

export function createPlaceContentCache({ request, now = Date.now, onPlace = (_place) => {} }) {
  const results = new Map();
  const listeners = new Set();
  function get(id) {
    const result = results.get(id);
    return result && (result.expiresAt === null || result.expiresAt > now()) ? result : null;
  }
  function remember(result) {
    if (result.status === "loading" || (result.status === "error" && (result.automaticRetries || 0) < 5)) return result;
    const old = results.get(result.place.id);
    if (old?.checkedAt && result.checkedAt && old.checkedAt > result.checkedAt) return old;
    results.delete(result.place.id);
    results.set(result.place.id, result);
    if (results.size > 200) results.delete(results.keys().next().value);
    onPlace(result.place);
    for (const listener of listeners) listener(result);
    return result;
  }
  const enqueue = createPreloadQueue(async (id, options) => remember(await request(id, options)), { concurrency: 2 });
  function load(id, { force = false, priority = 0 } = {}) {
    const cached = !force && get(id);
    return cached ? Promise.resolve(cached) : enqueue(id, { force, priority });
  }
  function preload(places, priority = 1) {
    for (const place of places) {
      onPlace(place);
      if (/^amap-[A-Za-z0-9_-]+$/.test(place.id)) load(place.id, { priority }).catch(() => {});
    }
  }
  return {
    get, load, remember, preload,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
