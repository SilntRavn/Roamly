import { amap, ServiceError } from "./amap-client.mjs";
import { db } from "./db.mjs";
import { normalizePoi, savePoi } from "./amap.mjs";
import { poiBounds, poiGroups } from "../shared/map-pois.mjs";

const pending = new Map();
async function groupPlaces(bounds, types, section = 0, divisions = 1) {
  const key = JSON.stringify(["roamly-poi-v3", bounds, types, section, divisions]);
  const cached = db.prepare("SELECT payload FROM search_cache WHERE cache_key=? AND expires>?").get(key, Date.now());
  if (cached) return JSON.parse(cached.payload);
  if (pending.has(key)) return pending.get(key);
  const request = (async () => {
    const [left, south, right, north] = bounds;
    const west = left + (right - left) * section / divisions;
    const east = left + (right - left) * (section + 1) / divisions;
    const lng = (west + east) / 2, lat = (south + north) / 2;
    const radius = Math.min(50000, Math.ceil(Math.hypot((east - west) * 111320 * Math.cos(lat * Math.PI / 180), (north - south) * 111320) / 2));
    const places = new Map();
    // A bounded sample per category keeps dense city views from exhausting quota.
    // A closer viewport gets its own sample and exposes more individual POIs.
    for (let page = 1; page <= 1; page++) {
      // Weight sorting represents the whole viewport instead of filling every
      // sample with minor facilities around its center. Offscreen POIs are culled.
      const data = await amap("/v3/place/around", { location: `${lng.toFixed(6)},${lat.toFixed(6)}`, radius: String(radius), sortrule: "weight", types, offset: "25", page: String(page), extensions: "all" });
      const pois = data.pois || [];
      for (const poi of pois) {
        if (!poi.location || /停车场|出入口|售票处|公共厕所/.test(poi.type || "")) continue;
        const result = (() => { try { return normalizePoi(poi); } catch { return null; } })();
        if (result) places.set(result.id, savePoi(result));
      }
      if (pois.length < 25 || page * 25 >= Number(data.count)) break;
    }
    const result = [...places.values()];
    db.prepare("INSERT OR REPLACE INTO search_cache VALUES(?,?,?)").run(key, JSON.stringify(result), Date.now() + 6 * 3600 * 1000);
    return result;
  })();
  pending.set(key, request);
  try { return await request; } finally { pending.delete(key); }
}

export async function mapPlaces(bounds) {
  let snapped;
  try { snapped = poiBounds(bounds); }
  catch { throw new ServiceError("地图查询范围不正确，请放大地图后重试", 400); }
  // Spread scenic samples across the viewport; one central result page otherwise
  // concentrates markers in dense neighborhoods and misses its outer thirds.
  const groups = await Promise.all([
    ...[0, 1, 2].map((section) => groupPlaces(snapped, poiGroups[0], section, 3)),
    ...poiGroups.slice(1).map((types) => groupPlaces(snapped, types)),
  ]);
  return [...new Map(groups.flat().filter((place) => !/花鸟鱼虫|商务住宅/.test(place.category)).map((place) => [place.id, place])).values()];
}
