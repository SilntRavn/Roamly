import { minutes, timeString } from "../shared/schema.mjs";
import { matchesPlace } from "../shared/requirements.mjs";
import { openingWindows, checkPlanQuality } from "./plan-quality.mjs";
import { contiguousTravelMinutes } from "./route-quality.mjs";
import { dayRhythm } from "./day-rhythm.mjs";

// 不改景点、日序或固定预约；只在来源营业时段内调整弹性时间。
function greedyRepairTripTimes(trip, requirements, places, audit = null) {
  const repaired = structuredClone(trip),
    byId = new Map(places.map((p) => [p.id, p]));
  for (const day of repaired.days) {
    let cursor = requirements.dailyStart ? minutes(requirements.dailyStart) : 0,
      lastPlace = null;
    const legs = audit?.days.find((d) => d.index === day.index)?.legs || [];
    const endLimit = requirements.dailyEnd
      ? minutes(requirements.dailyEnd)
      : 1440;
    for (const [index, item] of day.items.entries()) {
      const original = minutes(item.arrival),
        place = byId.get(item.placeId);
      const fixed =
        item.kind === "place"
          ? requirements.fixedVisits.filter((v) =>
              v.placeId
                ? v.placeId === item.placeId
                : place && matchesPlace(place, v),
            )
          : [];
      if (fixed.some((v) => v.day !== null && v.day !== day.index)) return null;
      const exact = fixed.find(
        (v) => v.durationMinutes !== null && v.durationRule !== "minimum",
      );
      const minimum = Math.max(
        0,
        ...fixed
          .filter((v) => v.durationRule === "minimum")
          .map((v) => v.durationMinutes || 0),
      );
      const pinned = fixed.find((v) => v.arrival !== null)?.arrival;
      let desired =
        exact?.durationMinutes || Math.max(item.durationMinutes, minimum);
      let floor = Math.max(cursor, index === 0 ? original : 0);
      const leg =
        lastPlace && item.kind === "place"
          ? legs.find(
              (l) =>
                l.itemFrom === lastPlace.id &&
                l.itemTo === item.id &&
                l.status === "verified",
            )
          : null;
      if (floor >= 1440) return null;
      item.arrival = timeString(floor);
      if (leg && contiguousTravelMinutes(day, lastPlace, item) < leg.minutes)
        floor = Math.max(floor, cursor + leg.minutes + 10);
      let target = pinned ? minutes(pinned) : Math.max(original, floor);
      if (target < floor || target >= 1440) return null;
      if (item.kind === "place") {
        const windows = openingWindows(place || {}, day.date) || [[0, 1440]];
        const meaningfulMinimum = exact
          ? desired
          : Math.max(
              minimum,
              Math.min(desired, Math.max(30, Math.ceil(desired * 0.6))),
            );
        let slot = null;
        for (const [open, close] of windows) {
          let start = Math.max(target, open),
            end = Math.min(close, endLimit);
          if (!pinned && end - start < desired) start = Math.max(floor, open);
          const duration = Math.min(desired, end - start);
          if (duration >= meaningfulMinimum && (!pinned || start === target)) {
            slot = { start, duration };
            break;
          }
        }
        if (!slot) return null;
        target = slot.start;
        desired = slot.duration;
      } else if (target + desired > endLimit) return null;
      if (target + desired > endLimit || target + desired > 1440) return null;
      item.arrival = timeString(target);
      item.durationMinutes = desired;
      cursor = target + desired;
      if (item.kind === "place") lastPlace = item;
    }
  }
  return JSON.stringify(repaired.days) === JSON.stringify(trip.days)
    ? null
    : repaired;
}

const timeIssues = new Set(["early_start", "late_finish", "time_overlap", "opening_hours",
  "fixed_visit", "past_midnight", "travel_time", "lunch_missing", "dinner_missing", "night_unwanted", "idle_gap"]);

// 贪心后推失败时，有限搜索整天的弹性时间与停留分配；不改景点、日期或顺序。
// 午餐、晚餐、固定预约、明确停留和连续交通一起检验，不能用餐与赶路重叠。
function coordinateDay(day, trip, requirements, byId, audit) {
  const rhythm = dayRhythm(day.items.map((i) => byId.get(i.placeId)).filter(Boolean), day.date);
  const first = day.items[0];
  if (!first) return null;
  const start = requirements.dailyStart ? minutes(requirements.dailyStart) :
    Math.min(minutes(first.arrival), minutes(rhythm.recommendedStart));
  const end = requirements.dailyEnd ? minutes(requirements.dailyEnd) : 1440;
  const legs = audit?.days.find((d) => d.index === day.index)?.legs || [];
  let states = [{ items: [], score: 0 }];
  for (const original of day.items) {
    const place = byId.get(original.placeId);
    const fixed = original.kind === "place" ? requirements.fixedVisits.filter((v) =>
      v.placeId ? v.placeId === original.placeId : place && matchesPlace(place, v)) : [];
    if (fixed.some((v) => v.day != null && v.day !== day.index)) return null;
    const pinned = fixed.find((v) => v.arrival != null)?.arrival;
    const exact = fixed.find((v) => v.durationMinutes != null && v.durationRule !== "minimum");
    const minimum = Math.max(0, ...fixed.filter((v) => v.durationRule === "minimum").map((v) => v.durationMinutes || 0));
    const desired = exact?.durationMinutes ?? Math.max(original.durationMinutes, minimum);
    const meaningful = Math.min(desired, Math.max(30, Math.ceil(desired * 0.6), minimum));
    const durations = original.kind === "break" || exact ? [desired] :
      [...new Set([desired, Math.max(meaningful, Math.ceil(desired * 0.8 / 5) * 5), meaningful])];
    const windows = original.kind === "place" ? openingWindows(place || {}, day.date) || [[0, 1440]] : [[0, 1440]];
    const lunch = original.kind === "break" && /午餐|午饭/.test(original.title);
    const dinner = original.kind === "break" && /晚餐|晚饭/.test(original.title);
    const mealStart = lunch ? rhythm.lunchStartMinutes : dinner ? rhythm.dinnerStartMinutes : 0;
    const mealEnd = lunch ? rhythm.lunchEndMinutes : dinner ? rhythm.dinnerEndMinutes : 1440;
    const nextStates = [];
    const nextPlace = day.items.slice(day.items.indexOf(original) + 1).find((i) => i.kind === "place");
    for (const state of states) {
      const previous = state.items.at(-1);
      const cursor = previous ? minutes(previous.arrival) + previous.durationMinutes : start;
      const lastPlace = state.items.findLast((i) => i.kind === "place");
      const leg = lastPlace && original.kind === "place" ? legs.find((l) =>
        l.itemFrom === lastPlace.id && l.itemTo === original.id && l.status === "verified") : null;
      for (const [open, close] of windows) for (const duration of durations) {
        let earliest = Math.max(cursor, open, mealStart);
        const tentative = { ...original, arrival: timeString(Math.min(1439, earliest)), durationMinutes: duration };
        if (leg && contiguousTravelMinutes({ ...day, items: [...state.items, tentative] }, lastPlace, tentative) < leg.minutes)
          earliest = Math.max(earliest, cursor + leg.minutes + 15);
        const latest = Math.min(close, end,
          original.kind === "place" && requirements.nightTour === "avoid" ? rhythm.eveningStartMinutes : 1440) - duration;
        const beforeMeal = original.kind === "break" && lastPlace && nextPlace ? legs.find((l) =>
          l.itemFrom === lastPlace.id && l.itemTo === nextPlace.id && l.status === "verified") : null;
        const candidates = pinned ? [minutes(pinned)] : [...new Set([earliest,
          Math.max(earliest, Math.min(minutes(original.arrival), latest, mealEnd)),
          ...(beforeMeal ? [earliest + beforeMeal.minutes + 15] : [])])];
        for (const arrival of candidates) {
          if (arrival < earliest || arrival > latest || arrival > mealEnd || arrival >= 1440) continue;
          const item = { ...original, arrival: timeString(arrival), durationMinutes: duration };
          const items = [...state.items, item];
          if (leg && contiguousTravelMinutes({ ...day, items }, lastPlace, item) < leg.minutes) continue;
          nextStates.push({ items, score: state.score + (desired - duration) * 3 +
            Math.abs(arrival - minutes(original.arrival)) * 0.2 + (pinned ? 0 : Math.max(0, arrival - earliest - 30)) });
        }
      }
    }
    // 同终点保留代价最低的状态，限制搜索规模；不承诺找到所有可行排程。
    const unique = new Map();
    for (const state of nextStates.sort((a, b) => a.score - b.score)) {
      const last = state.items.at(-1), lastPlace = state.items.findLast((i) => i.kind === "place");
      const key = `${last.arrival}:${last.durationMinutes}:${lastPlace?.arrival}:${lastPlace?.durationMinutes}`;
      if (!unique.has(key)) unique.set(key, state);
    }
    states = [...unique.values()].slice(0, 64);
    if (!states.length) return null;
  }
  return { ...day, items: states[0].items };
}

export function repairTripTimes(trip, requirements, places, audit = null, options = {}) {
  const originalDays = JSON.stringify(trip.days);
  const mealIssues = checkPlanQuality(trip, places, requirements).errors.filter((i) =>
    ["lunch_missing", "dinner_missing"].includes(i.code));
  if (mealIssues.length) {
    trip = structuredClone(trip);
    for (const problem of mealIssues) {
      const day = trip.days.find((d) => d.index === problem.day);
      if (day.items.length >= 12) continue;
      const rhythm = dayRhythm(day.items.map((i) => places.find((p) => p.id === i.placeId)).filter(Boolean), day.date);
      const lunch = problem.code === "lunch_missing";
      // 已有但排错时刻的用餐交给协调器；缺少用餐时补入独立休息，不能占用交通。
      if (day.items.some((i) => i.kind === "break" && (lunch ? /午餐|午饭/ : /晚餐|晚饭/).test(i.title))) continue;
      const target = lunch ? rhythm.lunchStartMinutes + 60 : rhythm.dinnerStartMinutes + 30;
      const position = day.items.findIndex((i) => minutes(i.arrival) >= target);
      day.items.splice(position < 0 ? day.items.length : position, 0, {
        id: crypto.randomUUID(), kind: "break", placeId: null, title: lunch ? "午餐休息" : "晚餐休息",
        arrival: timeString(target), durationMinutes: 60, notes: "在当天游览区域用餐休息。",
      });
    }
  }
  // 原核验中的时间冲突针对旧时刻，不能直接拿来否定修正稿；用同一真实路段重新计算连续空档。
  const valid = (candidate) => candidate &&
    !checkPlanQuality(candidate, places, requirements, audit ? { ...audit,
      days: audit.days.map((d) => ({ ...d, conflicts: [] })) } : null).errors.some((i) => timeIssues.has(i.code)) &&
    candidate.days.every((day) => (audit?.days.find((d) => d.index === day.index)?.legs || []).every((leg) => {
      if (leg.status !== "verified") return true;
      const from = day.items.find((i) => i.id === leg.itemFrom), to = day.items.find((i) => i.id === leg.itemTo);
      return from && to && contiguousTravelMinutes(day, from, to) >= leg.minutes;
    }));
  const greedy = greedyRepairTripTimes(trip, requirements, places, audit);
  if (valid(greedy)) return greedy;
  const byId = new Map(places.map((p) => [p.id, p]));
  const days = trip.days.map((day) => coordinateDay(day, trip, requirements, byId, audit));
  if (days.some((d) => !d) && !options.partial) return null;
  const candidate = { ...structuredClone(trip), days: days.map((d, i) => d || trip.days[i]) };
  if (options.partial) {
    // 某一天还需换推荐时，不丢弃其他日期已经完成的真实交通排程。
    // 这里只返回修正稿；最终能否保存仍由完整行程质量检查决定。
    return JSON.stringify(candidate.days) !== originalDays ? candidate : null;
  }
  return valid(candidate) && JSON.stringify(candidate.days) !== originalDays ? candidate : null;
}
