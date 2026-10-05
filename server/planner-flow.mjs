import { candidateOrders } from "./route-quality.mjs";
import { distanceKm, validCoordinates, isRequired } from "./regional-planning.mjs";
import { checkPlanQuality, isAuxiliaryPlace } from "./plan-quality.mjs";
import { repairTripTimes } from "./schedule.mjs";
import { mapConcurrent } from "./parallel.mjs";
import { dayRhythm } from "./day-rhythm.mjs";
import { fixedFor } from "./regional-planning.mjs";
import { openingWindows } from "./plan-quality.mjs";
import { minutes, timeString } from "../shared/schema.mjs";
import { resolveDayTransport } from "./day-transport.mjs";

// AI只选分日、景点和体验时长。真实接驳、用餐与时刻由程序统一生成。
export async function buildSelectedTrip(selection, requirements, { lookup, allowed, route, signal }) {
  if (!Array.isArray(selection.days) || !selection.days.length || selection.days.length > 14)
    throw new Error("请选择完整的旅行天数");
  for (const day of selection.days) for (const visit of day.visits || [])
    if (!allowed.has(visit.placeId) || !lookup(visit.placeId)) throw new Error("只能选择已检索的真实景点ID");
  const days = [];
  for (const chosen of selection.days) {
    if (!chosen.visits?.length || chosen.visits.length > 10) throw new Error("每天需要1至10个游览点");
    const date = requirements.startDate ? new Date(`${requirements.startDate}T12:00:00Z`) : null;
    if (date) date.setUTCDate(date.getUTCDate() + chosen.index - 1);
    const dayDate = date?.toISOString().slice(0, 10) || null;
    const selected = chosen.visits.map((v) => ({ ...v, place: lookup(v.placeId) }));
    const rhythm = dayRhythm(selected.map((v) => v.place), dayDate);
    const { legs, transport } = await resolveDayTransport(selected.map((v) => v.place),
      requirements.preferences.transport, route, signal, requirements);
    let cursor = requirements.dailyStart ? minutes(requirements.dailyStart) : minutes(rhythm.recommendedStart);
    let lunched = false, dined = false;
    const items = [];
    const meal = (lunch) => {
      cursor = Math.max(cursor, lunch ? rhythm.lunchStartMinutes : rhythm.dinnerStartMinutes);
      items.push({ kind: "break", placeId: null, title: lunch ? "午餐休息" : "晚餐休息", arrival: timeString(Math.min(1439, cursor)),
        durationMinutes: 60, notes: "在当天游览区域选择餐馆，独立留出用餐时间。" });
      cursor += 60;
      if (lunch) lunched = true; else dined = true;
    };
    for (const [position, visit] of selected.entries()) {
      const fixed = fixedFor(visit.place, requirements);
      const exact = fixed.find((v) => v.durationMinutes != null && v.durationRule !== "minimum");
      const duration = exact?.durationMinutes ?? Math.max(visit.durationMinutes || 90,
        ...fixed.filter((v) => v.durationRule === "minimum").map((v) => v.durationMinutes || 0));
      const travel = position && legs[position - 1]?.status === "verified" ? legs[position - 1].minutes + 10 : 0;
      const pinned = fixed.find((v) => v.arrival != null)?.arrival;
      const expectedArrival = pinned ? Math.max(cursor + travel, minutes(pinned)) : cursor + travel;
      // 先在上一站周边用餐，再留连续接驳；不把午餐同时记作赶路。
      if (position && !lunched && (expectedArrival >= rhythm.lunchStartMinutes + 60 ||
        expectedArrival + duration > rhythm.lunchEndMinutes)) meal(true);
      if (position && !dined && cursor + travel >= rhythm.dinnerStartMinutes + 90) meal(false);
      cursor += travel;
      const windows = openingWindows(visit.place, dayDate);
      if (windows?.length) cursor = Math.max(cursor, windows.find(([a, b]) => b > cursor)?.[0] || 0);
      const arrival = pinned || timeString(Math.min(1439, cursor));
      items.push({ kind: "place", placeId: visit.placeId, title: visit.place.name, arrival, durationMinutes: duration,
        notes: String(visit.notes || "按兴趣游览，出发前确认开放和预约。").slice(0, 60) });
      cursor = minutes(arrival) + duration;
    }
    if (!lunched && cursor >= rhythm.lunchEndMinutes - 30) meal(true);
    if (!dined && cursor >= rhythm.dinnerStartMinutes + 90) meal(false);
    const rest = items.filter((i) => i.kind === "break").reduce((s, i) => s + i.durationMinutes, 0);
    if (requirements.minRestMinutes > rest) {
      const extra = Math.max(10, requirements.minRestMinutes - rest);
      items.push({ kind: "break", placeId: null, title: "休息", arrival: timeString(Math.min(1439, cursor)), durationMinutes: extra, notes: "预留休整。" });
    }
    days.push({ index: chosen.index, date: dayDate, transport, title: selected.slice(0, 3).map((v) => v.place.name).join(" · ").slice(0, 120), items });
  }
  const destination = requirements.destinationLabel || requirements.cities.join("、");
  return { title: selection.title || `${destination}游览计划`, city: destination,
    summary: "", preferences: requirements.preferences, days };
}

// 几何只决定是否值得比较，省时结论仍必须来自实际路线证据。
export function needsRouteComparison(trip, lookup, audit) {
  if (audit.days.some((d) => d.legs.some((l) => l.status === "verified" && l.minutes > 90))) return true;
  const span = (places) => Math.max(0, ...places.flatMap((a, i) =>
    places.slice(i + 1).map((b) => distanceKm(a, b))));
  const groups = audit.regionalGroups?.groups;
  const original = trip.days.map((d) => d.items.filter((i) => i.kind === "place").map((i) => lookup(i.placeId)));
  if (original.some((ps) => ps.some((p) => !validCoordinates(p)))) return false;
  if (groups && groups.reduce((s, g) => s + g.spanKm, 0) <
    original.reduce((s, ps) => s + span(ps), 0) * 0.75) return true;
  return original.some((places) => {
    if (places.length < 3 || places.length > 6) return false;
    const length = (order) => order.slice(1).reduce((s, v, i) => s + distanceKm(places[order[i]], places[v]), 0);
    const current = length(places.map((_, i) => i));
    return candidateOrders(places).some((order) => length(order) < current * 0.75);
  });
}

// 比较器已经核验原时间槽、源开放时段和预约；应用后仍由统一质量检查复核。
export function applyVerifiedSuggestions(trip, audit, lookup) {
  if (!audit.regionalSuggestion && !audit.days.some((d) => d.orderSuggestion)) return null;
  const items = new Map(trip.days.flatMap((d) => d.items.filter((i) => i.kind === "place"))
    .map((item) => [item.placeId, item]));
  const days = trip.days.map((day) => {
    const suggestion = audit.regionalSuggestion?.days.find((d) => d.index === day.index) ||
      audit.days.find((d) => d.index === day.index)?.orderSuggestion;
    if (!suggestion) return day;
    let cursor = 0;
    const sources = suggestion.placeIds.map((id) =>
      day.items.find((i) => i.kind === "place" && i.placeId === id) || items.get(id));
    const reordered = day.items.map((item) => item.kind === "place" ?
      { ...sources[cursor++], arrival: item.arrival } : item);
    return { ...day, items: reordered,
      title: suggestion.placeIds.map((id) => lookup(id)?.name).filter(Boolean).slice(0, 3).join(" · ") };
  });
  const evidence = { days: trip.days.map((day) => {
    const suggestion = audit.regionalSuggestion?.days.find((d) => d.index === day.index) ||
      audit.days.find((d) => d.index === day.index)?.orderSuggestion;
    return { index: day.index, legs: suggestion?.legs || audit.days.find((d) => d.index === day.index)?.legs || [] };
  }) };
  return { trip: { ...trip, days }, evidence };
}

// 只修复过满/赶路的可选推荐，不删必去点或预约，也不放宽用户限制。
// 最多两次精简，每次至多比较四个候选；新相邻路段仍须真实查询。
export async function repairRecommendedStops({ trip, audit, quality, requirements, places, lookup, auditPlan, signal }) {
  let current = { trip, audit, quality };
  const score = (value) => value.quality.errors.length * 100000 +
    value.quality.warnings.filter((i) => ["day_underfilled", "night_missing"].includes(i.code)).length * 10000 +
    value.audit.days.flatMap((d) => d.legs).filter((l) => l.status === "verified").reduce((s, l) => s + l.minutes, 0);
  const repairCodes = new Set(["travel_time", "long_transfer", "travel_heavy", "optional_route_unverified"]);
  for (let attempt = 0; attempt < 2 && current.quality.errors.length; attempt++) {
    const problemDays = new Set(current.quality.errors.filter((i) => repairCodes.has(i.code)).map((i) => i.day));
    const selected = new Set(current.trip.days.flatMap((d) => d.items.map((i) => i.placeId)).filter(Boolean));
    const options = current.trip.days.filter((d) => problemDays.has(d.index)).flatMap((day) => {
      const stops = day.items.filter((i) => i.kind === "place");
      if (stops.length < 2) return [];
      return stops.filter((item) => !isRequired(lookup(item.placeId), requirements)).flatMap((remove) => {
        const anchors = stops.filter((i) => i.id !== remove.id).map((i) => lookup(i.placeId));
        const nearby = places.filter((p) => !selected.has(p.id) && !isAuxiliaryPlace(p) &&
          /风景|名胜|景点|公园|文化|博物|展览|古迹|古镇|纪念|旅游/.test(`${p.category || ""} ${p.name}`) &&
          validCoordinates(p) && anchors.every(validCoordinates) &&
          anchors.some((a) => a.city === p.city && distanceKm(a, p) <= 5))
          .sort((a, b) => Math.min(...anchors.map((p) => distanceKm(p, a))) - Math.min(...anchors.map((p) => distanceKm(p, b))))
          .slice(0, 2);
        return [...nearby.map((replacement) => ({ day, remove, replacement })),
          ...(stops.length > 2 && remove.id !== stops[0].id ? [{ day, remove }] : [])];
      });
    }).slice(0, 4);
    if (!options.length) break;
    const candidates = await mapConcurrent(options, 2, async ({ day, remove, replacement }) => {
      let candidate = { ...current.trip, days: current.trip.days.map((d) => d.index !== day.index ? d :
        { ...d, items: replacement ? d.items.map((i) => i.id !== remove.id ? i :
          { ...i, placeId: replacement.id, title: replacement.name, notes: "在当天区域继续游览，出发前确认开放与预约。" }) :
          d.items.filter((i) => i.id !== remove.id) }) };
      let evidence = await auditPlan(candidate, signal, { compare: false, evidence: current.audit });
      const repaired = repairTripTimes(candidate, requirements, places, evidence, { partial: true });
      if (repaired) {
        candidate = repaired;
        evidence = await auditPlan(candidate, signal, { compare: false, evidence });
      }
      return { trip: candidate, audit: evidence, quality: checkPlanQuality(candidate, places, requirements, evidence) };
    });
    const best = candidates.sort((a, b) => score(a) - score(b))[0];
    if (score(best) >= score(current)) break;
    current = best;
  }
  return current;
}
