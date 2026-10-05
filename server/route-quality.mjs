import { minutes } from "../shared/schema.mjs";
import { matchesPlace } from "../shared/requirements.mjs";
import { openingWindows } from "./plan-quality.mjs";
import { groupByRegion, validCoordinates } from "./regional-planning.mjs";

// 没有餐厅坐标时不假设可以把用餐与赶路重叠，要求能容纳整段路线的连续空档。
export function contiguousTravelMinutes(day, from, to) {
  let cursor = minutes(from.arrival) + from.durationMinutes;
  const end = minutes(to.arrival);
  let available = 0;
  const a = day.items.indexOf(from),
    b = day.items.indexOf(to);
  for (const stop of day.items.slice(a + 1, b)) {
    const start = minutes(stop.arrival);
    available = Math.max(available, Math.min(start, end) - cursor);
    cursor = Math.max(cursor, start + stop.durationMinutes);
  }
  return Math.max(0, available, end - cursor);
}
function geographicDistance(a, b) {
  const meanLat = (((a.location.lat + b.location.lat) / 2) * Math.PI) / 180;
  return Math.hypot(
    (a.location.lng - b.location.lng) * Math.cos(meanLat),
    a.location.lat - b.location.lat,
  );
}
function approximateCost(order, places) {
  return order
    .slice(1)
    .reduce(
      (sum, index, i) =>
        sum + geographicDistance(places[order[i]], places[index]),
      0,
    );
}
export function candidateOrders(places) {
  const orders = [];
  for (let start = 0; start < places.length; start++) {
    const order = [start],
      unused = new Set(places.map((_, i) => i).filter((i) => i !== start));
    while (unused.size) {
      const next = [...unused].sort(
        (a, b) =>
          geographicDistance(places[order.at(-1)], places[a]) -
          geographicDistance(places[order.at(-1)], places[b]),
      )[0];
      order.push(next);
      unused.delete(next);
    }
    orders.push(order, [...order].reverse());
  }
  const unique = new Map(orders.map((o) => [o.join(","), o]));
  return [...unique.values()]
    .sort((a, b) => approximateCost(a, places) - approximateCost(b, places))
    .slice(0, 3);
}
function respectsFixedSlots(order, places, day, trip) {
  const slots = day.items.filter((i) => i.kind === "place");
  return order.every((index, position) => {
    const place = places[index],
      item = slots[index],
      slot = slots[position];
    for (const fixed of trip.requirements?.fixedVisits || []) {
      if (
        !(fixed.placeId
          ? fixed.placeId === place.id
          : matchesPlace(place, fixed))
      )
        continue;
      if (
        (fixed.day !== null && fixed.day !== day.index) ||
        (fixed.arrival !== null && fixed.arrival !== slot.arrival)
      )
        return false;
    }
    const windows = openingWindows(place, day.date);
    return (
      !windows ||
      windows.some(
        ([a, b]) =>
          minutes(slot.arrival) >= a &&
          minutes(slot.arrival) + item.durationMinutes <= b,
      )
    );
  });
}
export async function compareOrders({
  day,
  trip,
  places,
  legs,
  route,
  signal,
  budget,
}) {
  if (places.some((p) => !validCoordinates(p)))
    return { queries: 0, suggestion: null };
  const mode = trip.preferences.transport === "auto" ? day.transport || legs[0]?.requestedMode || legs[0]?.mode || "auto" : trip.preferences.transport;
  const cache = new Map(legs.map((l) => [`${l.from}:${l.to}:${l.requestedMode || l.mode}`, l]));
  const currentMinutes = legs.reduce((sum, l) => sum + l.minutes, 0);
  const currentDistance = legs.reduce((sum, l) => sum + l.distance, 0);
  let best = null,
    queries = 0;
  for (const order of candidateOrders(places)) {
    if (
      order.every((index, i) => index === i) ||
      !respectsFixedSlots(order, places, day, trip)
    )
      continue;
    const candidateLegs = [];
    for (let i = 1; i < order.length; i++) {
      const from = places[order[i - 1]],
        to = places[order[i]],
        key = `${from.id}:${to.id}:${mode}`;
      let leg = cache.get(key);
      if (!leg) {
        if (queries >= budget) break;
        queries++;
        try {
          leg = await route(from, to, mode, signal);
        } catch (error) {
          if (signal?.aborted) throw error;
          leg = { status: "unavailable" };
        }
        cache.set(key, leg);
      }
      if (leg.status !== "verified") break;
      candidateLegs.push(leg);
    }
    if (candidateLegs.length !== order.length - 1) continue;
    let position = 0;
    const originalSlots = day.items.filter((i) => i.kind === "place");
    const candidateDay = { ...day, items: day.items.map((item) => item.kind === "place" ?
      { ...originalSlots[order[position++]], arrival: item.arrival } : item) };
    const candidateSlots = candidateDay.items.filter((i) => i.kind === "place");
    if (candidateDay.items.some((item, i) => i > 0 && minutes(item.arrival) <
      minutes(candidateDay.items[i - 1].arrival) + candidateDay.items[i - 1].durationMinutes) ||
      candidateLegs.some((leg, i) => leg.minutes > contiguousTravelMinutes(candidateDay, candidateSlots[i], candidateSlots[i + 1]))) continue;
    const travelMinutes = candidateLegs.reduce((sum, l) => sum + l.minutes, 0);
    const distance = candidateLegs.reduce((sum, l) => sum + l.distance, 0);
    const significantTime =
      currentMinutes - travelMinutes >= 15 &&
      travelMinutes <= currentMinutes * 0.8;
    const significantWalk =
      trip.preferences.transport === "walking" &&
      currentDistance - distance >= 800 &&
      distance <= currentDistance * 0.75 &&
      travelMinutes <= currentMinutes;
    if (
      (significantTime || significantWalk) &&
      (!best || travelMinutes < best.travelMinutes)
    )
      best = {
        placeIds: order.map((i) => places[i].id),
        names: order.map((i) => places[i].name),
        currentMinutes,
        travelMinutes,
        savedMinutes: currentMinutes - travelMinutes,
        currentDistance,
        distance,
        legs: candidateLegs,
        scope:
          "仅比较当天相同景点之间的交通，未计住宿接驳；候选比较不保证全局最优",
      };
  }
  return { queries, suggestion: best };
}

// 先比较跨日区域分组，再比较日内顺序。只报告完整核验过的交通收益。
export async function compareDayGroups({ trip, days, lookup, route, signal, budget }) {
  const none = { queries: 0, suggestion: null };
  if (trip.days.length < 2 || trip.requirements?.routingStyle === "roadtrip") return none;
  const entries = trip.days.flatMap((day) => day.items.filter((i) => i.kind === "place")
    .map((item) => ({ item, place: lookup(item.placeId), day: day.index })));
  if (entries.length < 3 || entries.some((e) => !validCoordinates(e.place))) return none;
  const currentLegs = days.flatMap((d) => d.legs);
  const expected = trip.days.reduce((n, d) => n + Math.max(0, d.items.filter((i) => i.kind === "place").length - 1), 0);
  if (currentLegs.length !== expected || currentLegs.some((l) => l.status !== "verified")) return none;
  const groups = groupByRegion(entries, trip.days.map((d) => d.index), trip.requirements);
  if (!groups || groups.length !== trip.days.length || !groups.some((g) => g.entries.some((e) => e.day !== g.index))) return none;
  const proposed = [];
  for (const group of groups) {
    const day = trip.days.find((d) => d.index === group.index);
    // 用原日时间槽检验可行候选，固定预约、营业时间不因省路被挪掉。
    // 数量改变时交由 AI 重排，不将未经排程验证的分组声称为更优方案。
    const slots = day.items.filter((i) => i.kind === "place");
    if (slots.length !== group.entries.length) return none;
    const places = group.entries.map((e) => e.place);
    const orders = candidateOrders(places).filter((order) => order.every((i, position) => {
      const { item, place } = group.entries[i], slot = slots[position];
      if ((trip.requirements?.fixedVisits || []).some((v) =>
        (v.placeId ? v.placeId === place.id : matchesPlace(place, v)) &&
        ((v.day != null && v.day !== day.index) || (v.arrival != null && v.arrival !== slot.arrival)))) return false;
      const windows = openingWindows(place, day.date);
      return !windows || windows.some(([a, b]) => minutes(slot.arrival) >= a &&
        minutes(slot.arrival) + item.durationMinutes <= b);
    }));
    if (!orders.length) return none;
    proposed.push({ day, entries: group.entries, slots, order: orders[0] });
  }
  const cache = new Map(currentLegs.map((l) => [`${l.from}:${l.to}:${l.requestedMode || l.mode}`, l]));
  let queries = 0;
  const result = [];
  for (const group of proposed) {
    const mode = trip.preferences.transport === "auto" ? group.day.transport ||
      days.find((d) => d.index === group.day.index)?.transport || "auto" : trip.preferences.transport;
    const ordered = group.order.map((i) => group.entries[i]);
    let position = 0;
    const candidateDay = { ...group.day, items: group.day.items.map((item) =>
      item.kind === "place" ? { ...ordered[position++].item, arrival: item.arrival } : item) };
    const candidateSlots = candidateDay.items.filter((i) => i.kind === "place");
    if (candidateDay.items.some((item, i) => i > 0 && minutes(item.arrival) <
      minutes(candidateDay.items[i - 1].arrival) + candidateDay.items[i - 1].durationMinutes))
      return { queries, suggestion: null };
    const last = candidateDay.items.at(-1);
    if (minutes(last.arrival) + last.durationMinutes >
      (trip.requirements?.dailyEnd ? minutes(trip.requirements.dailyEnd) : 1440)) return { queries, suggestion: null };
    const legs = [];
    for (let i = 1; i < ordered.length; i++) {
      const from = ordered[i - 1].place, to = ordered[i].place, key = `${from.id}:${to.id}:${mode}`;
      let leg = cache.get(key);
      if (!leg) {
        if (queries >= budget) return { queries, suggestion: null };
        queries++;
        try { leg = await route(from, to, mode, signal); }
        catch (error) { if (signal?.aborted) throw error; leg = { status: "unavailable" }; }
        cache.set(key, leg);
      }
      if (leg.status !== "verified") return { queries, suggestion: null };
      // 跨日比较也扣除午餐，不能把省路候选的交通塞进休息。
      if (leg.minutes > contiguousTravelMinutes(candidateDay, candidateSlots[i - 1], candidateSlots[i]))
        return { queries, suggestion: null };
      legs.push(leg);
    }
    result.push({ index: group.day.index, placeIds: ordered.map((e) => e.place.id),
      names: ordered.map((e) => e.place.name), travelMinutes: legs.reduce((s, l) => s + l.minutes, 0), legs });
  }
  const currentMinutes = currentLegs.reduce((s, l) => s + l.minutes, 0);
  const travelMinutes = result.reduce((s, g) => s + g.travelMinutes, 0);
  return { queries, suggestion: currentMinutes - travelMinutes >= 30 && travelMinutes <= currentMinutes * 0.75 ? {
    days: result, currentMinutes, travelMinutes, savedMinutes: currentMinutes - travelMinutes,
    scope: "相同景点跨日分组、原日时间槽内的实际交通比较；不含住宿及跨日接驳，不保证全程最优。需按分组重排完整日程。",
  } : null };
}
