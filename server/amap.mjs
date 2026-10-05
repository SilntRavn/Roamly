import { amap, ServiceError } from "./amap-client.mjs";
export { amap, ServiceError } from "./amap-client.mjs";
import { db, savePlace, getPlace } from "./db.mjs";
import { PlaceSchema, minutes } from "../shared/schema.mjs";
import { compareOrders, compareDayGroups, contiguousTravelMinutes } from "./route-quality.mjs";
import { regionalAdvice } from "./regional-planning.mjs";
import { normalizeRouteSegments } from "../shared/route-segments.mjs";
import { mapConcurrent } from "./parallel.mjs";
import { resolveDayTransport } from "./day-transport.mjs";
import { chooseTransitPath } from "./transit-choice.mjs";
const value = (x) => (typeof x === "string" && x ? x : null);
export function normalizePoi(p) {
  const [lng, lat] = p.location.split(",").map(Number);
  const photos = [...new Set((Array.isArray(p.photos) ? p.photos : [])
    .map((photo) => typeof photo.url === "string" ? photo.url.replace(/^http:/, "https:") : "")
    .filter((url) => /^https:\/\//.test(url) && PlaceSchema.shape.photo.safeParse(url).success))].slice(0, 3);
  return PlaceSchema.parse({
    id: `amap-${p.id}`,
    name: p.name,
    city: value(p.cityname) || value(p.pname) || "",
    province: value(p.pname) || "",
    district: value(p.adname) || "",
    country: "中国",
    address: value(p.address) || "",
    location: { lng, lat, coordSystem: "GCJ-02" },
    overview: "",
    category: value(p.type)?.split(";").at(-1) || "景点",
    photo: photos[0] || "",
    photos,
    suggestedMinutes: 90,
    openingHours:
      value(p.business?.opentime_today) ||
      value(p.business?.opentime_week) ||
      value(p.biz_ext?.open_time),
    price: null,
    currency: "CNY",
    source: {
      provider: "高德 POI",
      url: `https://www.amap.com/place/${p.id}`,
      updatedAt: new Date().toISOString(),
      note: "营业时间与票价请在出发前向景点确认。",
    },
  });
}
export function savePoi(place) {
  const previous = getPlace(place.id);
  return savePlace({
    ...place,
    // POI 基础资料刷新不能抹掉独立检索、保存的介绍与预约渠道。
    overview: previous?.overview || place.overview,
    overviewSource: previous?.overviewSource || place.overviewSource,
    bookingChannels: previous?.bookingChannels || place.bookingChannels,
    aiRating: previous?.aiRating ?? place.aiRating,
  }, 24 * 3600 * 1000);
}
const pendingPlaces = new Map();
export async function resolvePlace(id) {
  const cached = getPlace(id);
  if (cached) return cached;
  if (!/^amap-[A-Za-z0-9_-]{1,64}$/.test(id))
    throw new ServiceError("景点不存在", 404);
  if (pendingPlaces.has(id)) return pendingPlaces.get(id);
  const request = (async () => {
    const data = await amap("/v3/place/detail", { id: id.slice(5), extensions: "all" });
    const poi = data.pois?.find((p) => `amap-${p.id}` === id && p.location);
    if (!poi) throw new ServiceError("未找到该景点的资料", 404);
    return savePoi(normalizePoi(poi));
  })();
  pendingPlaces.set(id, request);
  try { return await request; }
  finally { pendingPlaces.delete(id); }
}
export async function refreshPlacePhotos(place, signal) {
  if (!/^amap-[A-Za-z0-9_-]+$/.test(place.id) || Array.isArray(place.photos)) return place;
  const data = await amap("/v3/place/detail", { id: place.id.slice(5), extensions: "all" }, signal);
  const poi = data.pois?.find((p) => `amap-${p.id}` === place.id && p.location);
  if (!poi) throw new ServiceError("暂时无法更新景点照片");
  return savePoi(normalizePoi(poi));
}
export async function searchPlaces(keyword, city = "", signal) {
  // 旧缓存没有区县字段，不能用于区县目的地的核验。
  const key = JSON.stringify(["administrative-v3-photos", keyword, city]);
  const cached = db
    .prepare("SELECT payload FROM search_cache WHERE cache_key=? AND expires>?")
    .get(key, Date.now());
  if (cached) return JSON.parse(cached.payload).map((p) => getPlace(p.id) || p);
  const d = await amap(
    "/v3/place/text",
    {
      keywords: keyword,
      city,
      citylimit: city ? "true" : "false",
      offset: "10",
      extensions: "all",
    },
    signal,
  );
  const places = (d.pois || [])
    .filter((p) => p.location)
    .map((p) => savePoi(normalizePoi(p)));
  db.prepare("INSERT OR REPLACE INTO search_cache VALUES(?,?,?)").run(
    key,
    JSON.stringify(places),
    Date.now() + 3600 * 1000,
  );
  return places;
}
export async function routeBetween(from, to, mode = "walking", signal) {
  if (mode === "auto") {
    const day = await resolveDayTransport([from, to], "auto", routeBetween, signal);
    return { ...day.legs[0], requestedMode: "auto" };
  }
  if (!["walking", "driving", "transit"].includes(mode))
    throw new ServiceError("交通方式不正确", 400);
  if (
    from.location.coordSystem !== "GCJ-02" ||
    to.location.coordSystem !== "GCJ-02"
  )
    return {
      from: from.id,
      to: to.id,
      mode,
      status: "unsupported",
      message: "当前高德配置不支持此海外路线",
    };
  const key = JSON.stringify([from.location, to.location, mode]);
  const cached = db
    .prepare("SELECT payload FROM route_cache WHERE cache_key=? AND expires>?")
    .get(key, Date.now());
  if (cached) {
    const route = JSON.parse(cached.payload);
    // Transit caches created before segment support lose service names and
    // combine alternatives. Refresh those; other old modes still render safely.
    if (mode !== "transit" || (Array.isArray(route.segments) && route.choiceVersion === 1))
      return { ...route, from: from.id, to: to.id };
  }
  const params = {
    origin: `${from.location.lng.toFixed(6)},${from.location.lat.toFixed(6)}`,
    destination: `${to.location.lng.toFixed(6)},${to.location.lat.toFixed(6)}`,
    extensions: "all",
  };
  let d;
  if (mode === "transit") {
    d = await amap(
      "/v3/direction/transit/integrated",
      { ...params, city: from.city, cityd: to.city, strategy: "0" },
      signal,
    );
  } else {
    d = await amap(`/v3/direction/${mode}`, params, signal);
  }
  const p = mode === "transit" ? chooseTransitPath(d.route?.transits) : d.route?.paths?.[0];
  if (!p)
    return {
      from: from.id,
      to: to.id,
      mode,
      status: "unavailable",
      message: "未查询到合适的交通方案，请调整交通方式",
    };
  const segments = normalizeRouteSegments(p, mode, from.city);
  const duration = Number(p.duration),
    distance = Number(p.distance);
  if (
    ![p.duration, p.distance].every(
      (value) =>
        ["number", "string"].includes(typeof value) &&
        String(value).trim() !== "",
    ) ||
    !Number.isFinite(duration) ||
    duration < 0 ||
    !Number.isFinite(distance) ||
    distance < 0
  )
    return {
      from: from.id,
      to: to.id,
      mode,
      status: "unavailable",
      message: "路线缺少有效的交通时间或距离",
    };
  const route = {
    from: from.id,
    to: to.id,
    mode,
    status: "verified",
    minutes: Math.ceil(duration / 60),
    distance,
    walkingDistance:
      mode === "walking"
        ? distance
        : mode === "transit" &&
            typeof p.walking_distance === "string" &&
            p.walking_distance !== "" &&
            Number.isFinite(Number(p.walking_distance))
          ? Number(p.walking_distance)
          : null,
    segments,
    polyline: segments.flatMap((segment) => segment.polyline),
    checkedAt: new Date().toISOString(),
    source: "高德路线规划",
    choiceVersion: 1,
  };
  db.prepare("INSERT OR REPLACE INTO route_cache VALUES(?,?,?)").run(
    key,
    JSON.stringify(route),
    Date.now() + 4 * 3600 * 1000,
  );
  return route;
}
export async function auditTrip(trip, signal, options = {}) {
  const days = [];
  const lookup = options.lookup || getPlace;
  const route = options.route || routeBetween;
  let comparisonBudget = options.comparisonBudget ?? 18;
  const evidenceRoute = (from, to, mode, routeSignal) => {
    const reused = options.evidence?.days.flatMap((d) => d.legs).find((l) =>
      l.from === from.id && l.to === to.id && (l.requestedMode || l.mode) === mode);
    return reused || route(from, to, mode, routeSignal);
  };
  const resolvedDays = await mapConcurrent(trip.days, 1, async (day) => {
    const items = day.items.filter((i) => i.kind === "place");
    const points = items.map((i) => lookup(i.placeId));
    if (points.some((p) => !p)) return { index: day.index, legs: [] };
    const preference = trip.preferences.transport === "auto" ? day.transport || "auto" : trip.preferences.transport;
    const resolved = await resolveDayTransport(points, preference, evidenceRoute, signal, trip.requirements);
    return { index: day.index, transport: resolved.transport, legs: resolved.legs.map((leg, i) =>
      ({ day: day.index, ...leg, itemFrom: items[i].id, itemTo: items[i + 1].id })) };
  });
  const resolved = resolvedDays.flatMap((d) => d.legs);
  if (signal?.aborted) throw signal.reason || new Error("已取消");
  for (const day of trip.days) {
    const points = day.items.filter((i) => i.kind === "place");
    const legs = [];
    const warnings = [];
    const conflicts = [];
    let needsRevision = false;
    for (let i = 1; i < day.items.length; i++) {
      const previous = day.items[i - 1],
        current = day.items[i];
      if (
        minutes(current.arrival) <
        minutes(previous.arrival) + previous.durationMinutes
      ) {
        warnings.push(`${previous.title}与${current.title}的停留时间重叠`);
        conflicts.push({ code: "time_overlap", message: warnings.at(-1) });
        needsRevision = true;
      }
    }
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i],
        from = lookup(a.placeId),
        to = lookup(b.placeId);
      if (!from || !to) {
        warnings.push("有地点资料缺失");
        continue;
      }
      const leg = resolved.find((l) => l?.day === day.index && l.itemFrom === a.id && l.itemTo === b.id);
      const available = contiguousTravelMinutes(day, a, b);
      if (leg.status === "verified" && leg.minutes > available) {
        warnings.push(
          `${from.name}到${to.name}需要约 ${leg.minutes} 分钟，当前仅预留 ${Math.max(0, available)} 分钟连续交通时间`,
        );
        conflicts.push({ code: "travel_time", message: warnings.at(-1) });
        needsRevision = true;
      }
      if (leg.status === "verified" && leg.minutes > 90) {
        warnings.push(
          `${from.name}到${to.name}交通超过 90 分钟，建议调整顺序或拆分日期`,
        );
      }
      if (leg.status !== "verified") warnings.push(leg.message);
      legs.push({ ...leg, itemFrom: a.id, itemTo: b.id });
    }
    days.push({
      index: day.index,
      transport: resolvedDays.find((d) => d.index === day.index)?.transport,
      legs,
      warnings,
      conflicts,
      needsRevision,
      orderSuggestion: null,
    });
  }
  let regionalSuggestion = null;
  // 必要路段不受比较预算影响；额外查询优先处理跨日区域混排。
  if (options.compare !== false && comparisonBudget > 0) {
    const comparison = await compareDayGroups({ trip, days, lookup, route, signal, budget: comparisonBudget });
    comparisonBudget -= comparison.queries;
    regionalSuggestion = comparison.suggestion;
    if (regionalSuggestion) for (const routeDay of days) {
      routeDay.needsRevision = true;
      routeDay.warnings.push(`按区域跨日重排相同景点，已核验日内交通合计可减少约 ${regionalSuggestion.savedMinutes} 分钟；不含住宿与跨日接驳`);
    }
    for (const day of trip.days) {
      const routeDay = days.find((d) => d.index === day.index);
      const points = day.items.filter((i) => i.kind === "place");
      if (comparisonBudget <= 0 || points.length < 3 || points.length > 6 ||
        routeDay.legs.length !== points.length - 1 || routeDay.legs.some((l) => l.status !== "verified")) continue;
      const order = await compareOrders({ day, trip, places: points.map((i) => lookup(i.placeId)),
        legs: routeDay.legs, route, signal, budget: comparisonBudget });
      comparisonBudget -= order.queries;
      routeDay.orderSuggestion = order.suggestion;
      if (order.suggestion) {
        routeDay.warnings.push(`同一组景点有经高德核验的更顺路顺序，可减少约 ${order.suggestion.savedMinutes} 分钟交通`);
        routeDay.needsRevision = true;
      }
    }
  }
  const entries = trip.days.flatMap((day) => day.items.filter((i) => i.kind === "place")
    .map((item) => ({ item, day: day.index, place: lookup(item.placeId) })));
  const regionalGroups = options.compare !== false && trip.days.length > 1 &&
    trip.requirements?.routingStyle !== "roadtrip" ?
    regionalAdvice(entries.map((e) => e.place), { ...trip.requirements, days: trip.days.length }, entries) : null;
  return { days, regionalSuggestion, regionalGroups, checkedAt: new Date().toISOString() };
}
