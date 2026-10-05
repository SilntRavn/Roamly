import { minutes, timeString } from "../shared/schema.mjs";
import { dayRhythm } from "./day-rhythm.mjs";
import { isRequired } from "./regional-planning.mjs";
import {
  matchesPlace,
  matchesDestination,
  normalizedName,
  RequirementsSchema,
} from "../shared/requirements.mjs";

export function isAuxiliaryPlace(place) {
  return /停车场|停车位|出入口|售票处|售票点|游客中心|服务中心|管理处|检票口|公交站|地铁站|洗手间|公共厕所/.test(
    `${place.name} ${place.category}`,
  );
}
function explicitlyWanted(place, requirements) {
  return (
    requirements.requiredPlaceIds.includes(place.id) ||
    requirements.requiredPlaces.some(
      (w) =>
        isAuxiliaryPlace({ name: w.name, category: "" }) &&
        matchesPlace(place, w),
    )
  );
}
function issue(code, severity, message, day, item) {
  return {
    code,
    severity,
    message,
    ...(day ? { day } : {}),
    ...(item ? { itemId: item.id } : {}),
  };
}
function transferItem(item) {
  return (
    item.kind === "break" &&
    /自驾|驾车|乘车|乘坐|打车|搭车|地铁|公交|前往|交通|返程|抵达/.test(
      item.title,
    ) &&
    !/休息|休整|午餐|午饭|用餐/.test(item.title)
  );
}
export function openingWindows(place, date) {
  const text = place.openingHours?.trim();
  if (!text) return null;
  if (/节假|法定|特殊|除外/.test(text)) return null;
  if (date) {
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    const day = ["日", "一", "二", "三", "四", "五", "六"][weekday];
    if (new RegExp(`(?:周|星期)${day}\\s*(?:闭馆|闭园|休息|不开放)`).test(text))
      return [];
  }
  if (/^(?:全天|24小时|24 小时)(?:开放|营业)?$/.test(text)) return [[0, 1440]];
  // 不把季节、工作日、节假日、跨午夜等复杂文本误当成每天适用的时段。
  if (/周|星期|节假|夏|冬|季|法定|次日|翌日/.test(text)) return null;
  const pairs = [
    ...text.matchAll(
      /([01]?\d|2[0-3])[:：]([0-5]\d)\s*[-~—至]\s*([01]?\d|2[0-3])[:：]([0-5]\d)/g,
    ),
  ].map((m) => [
    Number(m[1]) * 60 + Number(m[2]),
    Number(m[3]) * 60 + Number(m[4]),
  ]);
  return pairs.length && pairs.every(([a, b]) => b > a) ? pairs : null;
}

export function requirementConflicts(requirements) {
  const conflicts = [];
  const start = requirements.dailyStart ? minutes(requirements.dailyStart) : 0;
  const end = requirements.dailyEnd ? minutes(requirements.dailyEnd) : 1440;
  if (start >= end) conflicts.push("每天的结束时间早于或等于出发时间");
  if (requirements.days && end > start) {
    const visits = new Map();
    for (const visit of requirements.fixedVisits) {
      const key = visit.placeId || visit.name;
      visits.set(
        key,
        Math.max(visits.get(key) || 0, visit.durationMinutes || 0),
      );
      if (
        visit.arrival &&
        (minutes(visit.arrival) < start ||
          minutes(visit.arrival) + (visit.durationMinutes || 0) > end)
      )
        conflicts.push(`${visit.name}的固定时间超出每天可用时段`);
    }
    const duration =
      [...visits.values()].reduce((sum, value) => sum + value, 0) +
      (requirements.minRestMinutes || 0) * requirements.days;
    if (duration > (end - start) * requirements.days)
      conflicts.push(
        `指定停留与休息至少需要 ${duration} 分钟，但可用时段总共只有 ${(end - start) * requirements.days} 分钟，尚未计交通`,
      );
  }
  return [...new Set(conflicts)];
}

export function checkPlanQuality(trip, places, requirements, audit = null) {
  requirements = RequirementsSchema.parse(requirements);
  const issues = [];
  const byId = new Map(places.map((p) => [p.id, p]));
  const visits = trip.days.flatMap((d) =>
    d.items
      .filter((i) => i.kind === "place")
      .map((item) => ({ item, day: d, place: byId.get(item.placeId) })),
  );
  const ids = new Set(visits.map((v) => v.item.placeId));
  if (audit?.regionalSuggestion)
    issues.push(issue("regional_regroup", "error",
      `相同景点按区域重新分日可将已核验的日内交通由 ${audit.regionalSuggestion.currentMinutes} 分钟降至 ${audit.regionalSuggestion.travelMinutes} 分钟，减少 ${audit.regionalSuggestion.savedMinutes} 分钟。请按区域重排完整日程并重新核验，保留必去点与预约；收益不含住宿和跨日接驳。`));
  if (requirements.days !== null && trip.days.length !== requirements.days)
    issues.push(
      issue(
        "day_count",
        "error",
        `用户要求 ${requirements.days} 天，当前安排 ${trip.days.length} 天`,
      ),
    );
  for (const key of ["travelers", "transport", "pace", "budget"])
    if (trip.preferences[key] !== requirements.preferences[key])
      issues.push(
        issue(
          `preference_${key}`,
          "error",
          `行程的${{ travelers: "人数", transport: "交通方式", pace: "旅行节奏", budget: "预算" }[key]}与已确认需求不符`,
        ),
      );
  for (const id of requirements.requiredPlaceIds)
    if (!ids.has(id))
      issues.push(
        issue(
          "required_place",
          "error",
          `遗漏用户指定景点：${byId.get(id)?.name || id}`,
        ),
      );
  for (const wanted of requirements.requiredPlaces)
    if (!visits.some((v) => v.place && matchesPlace(v.place, wanted)))
      issues.push(
        issue(
          "required_place",
          "error",
          `遗漏用户指定景点：${wanted.city} ${wanted.name}`,
        ),
      );
  for (const excluded of requirements.excludedPlaces)
    for (const v of visits.filter(
      (v) =>
        v.place &&
        (matchesPlace(v.place, excluded) ||
          (excluded === "购物" &&
            /购物|商场|商业街|百货/.test(
              `${v.place.name} ${v.place.category}`,
            ))),
    ))
      issues.push(
        issue(
          "excluded_place",
          "error",
          `用户不想去${excluded}，日程仍包含${v.place.name}`,
          v.day.index,
          v.item,
        ),
      );
  for (const fixed of requirements.fixedVisits) {
    const matches = visits.filter((v) =>
      fixed.placeId
        ? v.item.placeId === fixed.placeId
        : v.place && matchesPlace(v.place, fixed),
    );
    if (
      !matches.some(
        (v) =>
          (fixed.day === null || fixed.day === v.day.index) &&
          (fixed.arrival === null || fixed.arrival === v.item.arrival) &&
          (fixed.durationMinutes === null ||
            (fixed.durationRule === "minimum"
              ? v.item.durationMinutes >= fixed.durationMinutes
              : fixed.durationMinutes === v.item.durationMinutes)),
      )
    )
      issues.push(
        issue(
          "fixed_visit",
          "error",
          `${fixed.name}未按约定的日期、到达时间或停留时长安排`,
        ),
      );
  }
  const seen = new Set();
  for (const v of visits) {
    if (!v.place) {
      issues.push(
        issue("missing_place", "error", "景点资料缺失", v.day.index, v.item),
      );
      continue;
    }
    if (
      requirements.cities.length &&
      !requirements.cities.some((city) =>
        matchesDestination(v.place, city),
      )
    )
      issues.push(
        issue(
          "wrong_city",
          "error",
          `${v.place.name}位于${v.place.city}${v.place.district ? `·${v.place.district}` : ""}，不在本次确认的游览范围中`,
          v.day.index,
          v.item,
        ),
      );
    if (isAuxiliaryPlace(v.place) && !explicitlyWanted(v.place, requirements))
      issues.push(
        issue(
          "auxiliary_poi",
          "error",
          `${v.place.name}是设施或出入口，不能替代游览景点`,
          v.day.index,
          v.item,
        ),
      );
    if (
      seen.has(v.place.id) &&
      !requirements.repeatPlaces.some((name) => matchesPlace(v.place, name))
    )
      issues.push(
        issue(
          "repeated_place",
          "error",
          `${v.place.name}被重复安排，用户没有要求再访，请合并或替换重复站点`,
          v.day.index,
          v.item,
        ),
      );
    seen.add(v.place.id);
    const windows = openingWindows(v.place, v.day.date);
    if (
      windows &&
      !windows.some(
        ([a, b]) =>
          minutes(v.item.arrival) >= a &&
          minutes(v.item.arrival) + v.item.durationMinutes <= b,
      )
    )
      issues.push(
        issue(
          "opening_hours",
          "error",
          `${v.place.name}的安排超出来源提供的营业时间`,
          v.day.index,
          v.item,
        ),
      );
  }
  for (const city of requirements.cities)
    if (
      !visits.some(
        (v) =>
          v.place &&
          matchesDestination(v.place, city),
      )
    )
      issues.push(
        issue("missing_city", "error", `遗漏用户指定的目的地：${city}`),
      );
  for (const day of trip.days) {
    for (const item of day.items.filter(transferItem))
      issues.push(
        issue(
          "traffic_as_break",
          "error",
          `${item.title}是交通，不能计作休息或重复生成卡片；应给实际路线留出时间间隔`,
          day.index,
          item,
        ),
      );
    const stops = day.items.filter((i) => i.kind === "place");
    const assigned = requirements.dayDestinations.find((v) => v.day === day.index);
    if (assigned && stops.some((i) => byId.get(i.placeId) && !matchesDestination(byId.get(i.placeId), assigned.destination)))
      issues.push(issue("day_destination", "error", `第 ${day.index} 天应在用户指定的${assigned.destination}游览，不能为优化路线擅自换日或扩大目的地范围`, day.index));
    const rhythm = dayRhythm(stops.map((i) => byId.get(i.placeId)).filter(Boolean), day.date);
    const eveningStops = stops.filter((i) =>
      minutes(i.arrival) + i.durationMinutes >= rhythm.eveningStartMinutes + 30);
    if (!day.items.length)
      issues.push(
        issue("empty_day", "error", `第 ${day.index} 天没有安排`, day.index),
      );
    const countLimit = requirements.maxDailyStops;
    if (countLimit !== null && stops.length > countLimit)
      issues.push(
        issue(
          "stop_limit",
          "error",
          `第 ${day.index} 天超过每天最多 ${countLimit} 个景点的要求`,
          day.index,
        ),
      );
    const paceLimit = { relaxed: 3, balanced: 5, packed: 6 }[
      requirements.preferences.pace
    ] + (requirements.nightTour !== "avoid" ? Math.min(2, eveningStops.length) : 0);
    if (stops.length > paceLimit && countLimit === null)
      issues.push(
        issue(
          "pace_density",
          "warning",
          `第 ${day.index} 天有 ${stops.length} 个景点，${requirements.preferences.pace === "relaxed" ? "慢游建议分散安排" : "建议检查是否过满"}`,
          day.index,
        ),
      );
    if (requirements.startDate) {
      const date = new Date(`${requirements.startDate}T12:00:00Z`);
      date.setUTCDate(date.getUTCDate() + day.index - 1);
      if (day.date !== date.toISOString().slice(0, 10))
        issues.push(
          issue(
            "travel_date",
            "error",
            `第 ${day.index} 天日期与指定出发日期不一致`,
            day.index,
          ),
        );
    }
    const first = day.items[0],
      last = day.items.at(-1);
    if (!first || !last) continue;
    for (let i = 1; i < day.items.length; i++) {
      const previous = day.items[i - 1],
        current = day.items[i];
      if (
        minutes(current.arrival) <
        minutes(previous.arrival) + previous.durationMinutes
      )
        issues.push(
          issue(
            "time_overlap",
            "error",
            `${previous.title}与${current.title}的停留时间重叠`,
            day.index,
            current,
          ),
        );
    }
    const start = minutes(first.arrival),
      end = minutes(last.arrival) + last.durationMinutes;
    if (end > 1440)
      issues.push(
        issue(
          "past_midnight",
          "error",
          `第 ${day.index} 天的停留时间超出当天`,
          day.index,
          last,
        ),
      );
    if (requirements.dailyStart && start < minutes(requirements.dailyStart))
      issues.push(
        issue(
          "early_start",
          "error",
          `第 ${day.index} 天早于用户要求的 ${requirements.dailyStart} 出发`,
          day.index,
        ),
      );
    if (requirements.dailyEnd && end > minutes(requirements.dailyEnd))
      issues.push(
        issue(
          "late_finish",
          "error",
          `第 ${day.index} 天晚于用户要求的 ${requirements.dailyEnd} 结束`,
          day.index,
        ),
      );
    if (requirements.nightTour === "avoid" && stops.some((i) =>
      minutes(i.arrival) + i.durationMinutes > rhythm.eveningStartMinutes))
      issues.push(issue(
        "night_unwanted", "error",
        `第 ${day.index} 天用户不要夜游，仍安排了晚间游览；按当天作息与白昼参考，游览应在 ${timeString(rhythm.eveningStartMinutes)} 前结束，另留用餐和真实交通时间，明确时间要求优先`,
        day.index,
      ));
    const targetEnd = Math.min(rhythm.dayEndMinutes,
      requirements.dailyEnd ? minutes(requirements.dailyEnd) : rhythm.dayEndMinutes);
    const availableStart = requirements.dailyStart ? minutes(requirements.dailyStart) : minutes(rhythm.recommendedStart);
    const daytimeStops = stops.filter((i) => minutes(i.arrival) < rhythm.eveningStartMinutes);
    const daytimeEnd = Math.max(0, ...daytimeStops.map((i) => minutes(i.arrival) + i.durationMinutes));
    if (requirements.preferences.pace !== "relaxed" && requirements.maxDailyStops === null &&
      targetEnd - availableStart >= 360 && daytimeEnd < targetEnd - 30)
    {
      issues.push(issue(
        "day_underfilled", "warning",
        `第 ${day.index} 天白天游览${daytimeEnd ? `在 ${timeString(daytimeEnd)} 结束` : "缺少安排"}，默认充实节奏建议游览到 ${timeString(targetEnd)} 左右；请补充顺路的下午项目，不能用休息或仅加夜游凑时长，明确限制与实际开放优先`,
        day.index,
      ));
      if (daytimeEnd < targetEnd - 90)
        issues.push(issue("afternoon_missing", "error", `第 ${day.index} 天白天仅游览到 ${timeString(daytimeEnd)}，缺少完整下午。请从当天附近已检索的真实地点补足有价值的游览，不能靠远距离赶路、长休息或虚增时长填满`, day.index));
    }
    if (requirements.nightTour === "prefer" && !eveningStops.length &&
      (!requirements.dailyEnd || minutes(requirements.dailyEnd) >= rhythm.eveningStartMinutes + 60))
      issues.push(issue(
        "night_missing", "warning",
        `第 ${day.index} 天用户希望夜游，尚无覆盖 ${timeString(rhythm.eveningStartMinutes)} 之后至少 30 分钟的晚间项目；请查找顺路且适合夜晚的地点，条件不允许时说明原因`,
        day.index,
      ));
    const rest = day.items
      .filter((i) => i.kind === "break" && !transferItem(i))
      .reduce((sum, i) => sum + i.durationMinutes, 0);
    if (
      requirements.minRestMinutes !== null &&
      rest < requirements.minRestMinutes
    )
      issues.push(
        issue(
          "rest_limit",
          "error",
          `第 ${day.index} 天休息不足 ${requirements.minRestMinutes} 分钟`,
          day.index,
        ),
      );
    if (
      start <= rhythm.lunchStartMinutes + 30 &&
      end >= rhythm.lunchEndMinutes - 30 &&
      end - start >= 240 &&
      !day.items.some(
        (i) =>
          i.kind === "break" &&
          /午餐|午饭|用餐|吃饭/.test(i.title) &&
          i.durationMinutes >= 45 &&
          minutes(i.arrival) >= rhythm.lunchStartMinutes &&
          minutes(i.arrival) <= rhythm.lunchEndMinutes,
      )
    )
      issues.push(
        issue(
          "lunch_missing",
          "error",
          `第 ${day.index} 天跨越午间，缺少午餐休息；午餐应在 ${timeString(rhythm.lunchStartMinutes)} 至 ${timeString(rhythm.lunchEndMinutes)} 到达并留出至少 45 分钟，建议 60 分钟`,
          day.index,
        ),
      );
    if (start <= rhythm.dinnerStartMinutes && end >= rhythm.dinnerStartMinutes + 120 &&
      !day.items.some((i) => i.kind === "break" && /晚餐|晚饭|用餐|吃饭/.test(i.title) &&
        i.durationMinutes >= 60 && minutes(i.arrival) >= rhythm.dinnerStartMinutes &&
        minutes(i.arrival) <= rhythm.dinnerEndMinutes))
      issues.push(issue(
        "dinner_missing", "error",
        `第 ${day.index} 天游览跨越晚餐时段，缺少晚餐休息；晚餐应在 ${timeString(rhythm.dinnerStartMinutes)} 至 ${timeString(rhythm.dinnerEndMinutes)} 到达并留出至少 60 分钟，不能把下午的休息当作晚餐`,
        day.index,
      ));
    const activeLimit = { relaxed: 480, balanced: 600, packed: 720 }[
      requirements.preferences.pace
    ];
    const routeDay = audit?.days.find((d) => d.index === day.index);
    // 空档不等于活动；以游览加已核验交通评估强度，避免因空档长而继续删景点。
    const activeMinutes = stops.reduce((sum, item) => sum + item.durationMinutes, 0) +
      (routeDay?.legs || []).filter((l) => l.status === "verified").reduce((sum, l) => sum + l.minutes, 0);
    if (activeMinutes > activeLimit)
      issues.push(
        issue(
          "active_hours",
          "warning",
          `第 ${day.index} 天游览与已核验交通共 ${activeMinutes} 分钟，强度偏高；先减少绕路，再按体力调整非指定停留和休息`,
          day.index,
        ),
      );
    if (
      (requirements.childrenAges.length || requirements.hasElderly) &&
      end - start >= 360 &&
      rest < 90
    )
      issues.push(
        issue(
          "family_rest",
          "warning",
          `第 ${day.index} 天带孩子或长者出行，建议预留至少 90 分钟用餐与休息`,
          day.index,
        ),
      );
    if (routeDay) {
      if (routeDay.orderSuggestion)
        issues.push(issue("inefficient_order", "error",
          `第 ${day.index} 天存在已核验的更顺路顺序，可减少 ${routeDay.orderSuggestion.savedMinutes} 分钟交通；请重排并重新核验。`, day.index));
      for (const conflict of routeDay.conflicts || [])
        if (conflict.code !== "time_overlap")
          issues.push(
            issue(conflict.code, "error", conflict.message, day.index),
          );
      const expected = Math.max(0, stops.length - 1);
      if (
        routeDay.legs.filter((l) => l.status === "verified").length < expected
      )
        issues.push(
          issue(
            "route_unverified",
            "warning",
            `第 ${day.index} 天还有交通路段未核验，不能保证通行时间`,
            day.index,
          ),
        );
      const travel = routeDay.legs
        .filter((l) => l.status === "verified")
        .reduce((sum, l) => sum + l.minutes, 0);
      const local = requirements.routingStyle !== "roadtrip";
      const acceptsTravel = requirements.maxDailyTravelMinutes !== null &&
        travel <= requirements.maxDailyTravelMinutes;
      for (const leg of routeDay.legs) {
        const from = byId.get(leg.from), to = byId.get(leg.to);
        const a = day.items.find((i) => i.id === leg.itemFrom), b = day.items.find((i) => i.id === leg.itemTo);
        if (a && b && leg.status === "verified" && requirements.preferences.pace !== "relaxed" &&
          targetEnd - availableStart >= 360 && requirements.maxDailyStops === null &&
          !(requirements.fixedVisits.some((v) => v.arrival && (v.placeId ? v.placeId === b.placeId : matchesPlace(to, v))))) {
          const startGap = minutes(a.arrival) + a.durationMinutes, endGap = minutes(b.arrival);
          const restBetween = day.items.filter((i) => i.kind === "break" && minutes(i.arrival) >= startGap &&
            minutes(i.arrival) + i.durationMinutes <= endGap).reduce((s, i) => s + i.durationMinutes, 0);
          const idle = endGap - startGap - restBetween - leg.minutes;
          if (idle > 90 && endGap > rhythm.lunchStartMinutes + 120 && startGap < targetEnd)
            issues.push(issue("idle_gap", "error", `第 ${day.index} 天${a.title}与${b.title}之间，扣除真实交通和用餐仍空置 ${idle} 分钟，不能把下午空档留到晚间再游览。应前移弹性时间或补充同区域项目，固定预约和开放条件优先`, day.index));
        }
        const optional = (from && !isRequired(from, requirements)) || (to && !isRequired(to, requirements));
        if (leg.status === "verified" && (leg.minutes > 90 || (leg.distance > 50000 && leg.minutes > 45)) && local && !acceptsTravel)
          issues.push(issue("long_transfer", optional ? "error" : "warning",
            `${from?.name || "上一站"}到${to?.name || "下一站"}需 ${leg.minutes} 分钟，普通区域游览不应因可选推荐反复远距离赶路。先集中同区域游览，远处按方向分日或替换可选点；必去点、固定预约与真实交通必须保留。`, day.index));
        if (leg.status !== "verified" && optional && local)
          issues.push(issue("optional_route_unverified", "error",
            `第 ${day.index} 天可选推荐之间的${trip.preferences.transport === "transit" ? "公共交通" : "交通"}无法核验。请选择能核验且顺路的替代推荐，不得假定通行时间${trip.preferences.transport === "auto" ? "；智能出行可按整天重新选择自驾或公交并核验" : "或擅自改交通方式"}。`, day.index));
      }
      const sightseeing = stops.reduce((sum, item) => sum + item.durationMinutes, 0);
      if (local && !acceptsTravel && travel > 120 &&
        (travel >= 180 || travel / (travel + sightseeing) > 0.35))
        issues.push(issue("travel_heavy", stops.some((i) => !isRequired(byId.get(i.placeId), requirements)) ? "error" : "warning",
          `第 ${day.index} 天已核验日内交通 ${travel} 分钟、游览 ${sightseeing} 分钟，赶路占比偏高。应按区域分日、减少折返或替换远处可选点，不能仅压缩游览、推迟结束或删掉必去点。`, day.index));
      if (
        requirements.maxDailyTravelMinutes !== null &&
        travel > requirements.maxDailyTravelMinutes
      )
        issues.push(
          issue(
            "travel_limit",
            "error",
            `第 ${day.index} 天交通需 ${travel} 分钟，超过 ${requirements.maxDailyTravelMinutes} 分钟的要求`,
            day.index,
          ),
        );
      const walkKnown =
        routeDay.legs.length === expected &&
        routeDay.legs.every(
          (l) =>
            l.status === "verified" &&
            (l.mode === "walking" || Number.isFinite(l.walkingDistance)),
        );
      const walking = routeDay.legs
        .filter((l) => l.status === "verified")
        .reduce(
          (sum, l) =>
            sum + (l.mode === "walking" ? l.distance : l.walkingDistance || 0),
          0,
        );
      if (requirements.maxWalkingMeters !== null) {
        if (walking > requirements.maxWalkingMeters)
          issues.push(
            issue(
              "walking_limit",
              "error",
              `第 ${day.index} 天交通步行距离约 ${Math.round(walking)} 米，超过 ${requirements.maxWalkingMeters} 米的要求`,
              day.index,
            ),
          );
        else if (!walkKnown)
          issues.push(
            issue(
              "walking_unverified",
              "warning",
              `第 ${day.index} 天缺少部分步行距离数据，尚不能确认步行上限`,
              day.index,
            ),
          );
      }
    }
  }
  if (requirements.stepFree)
    issues.push(
      issue(
        "accessibility_unverified",
        "warning",
        "普通路线结果不能证明全程无台阶，需向景点与交通运营方确认无障碍通行",
      ),
    );
  for (let i = 1; i < trip.days.length; i++) {
    const before = trip.days[i - 1].items
      .filter((item) => item.kind === "place")
      .at(-1);
    const after = trip.days[i].items.find((item) => item.kind === "place");
    const a = byId.get(before?.placeId),
      b = byId.get(after?.placeId);
    if (a && b && normalizedName(a.city) !== normalizedName(b.city))
      issues.push(
        issue(
          "intercity_unverified",
          "warning",
          `第 ${trip.days[i].index} 天由${a.city}转往${b.city}，跨日城际交通未包含在景点间核验中，请另行确认`,
          trip.days[i].index,
        ),
      );
  }
  if (visits.some((v) => !v.place?.openingHours))
    issues.push(
      issue(
        "opening_unverified",
        "warning",
        "部分景点营业时间与预约规则未核实，请在出发前确认",
      ),
    );
  if (
    requirements.preferences.budget !== null &&
    visits.some((v) => v.place?.price === null)
  )
    issues.push(
      issue(
        "budget_unverified",
        "warning",
        "部分门票或交通费用缺少来源价格，预算仅作为规划目标，尚不能核实总费用",
      ),
    );
  return {
    issues,
    errors: issues.filter((i) => i.severity === "error"),
    warnings: issues.filter((i) => i.severity === "warning"),
  };
}

export function briefForModel(requirements) {
  return JSON.stringify(requirements, null, 2);
}
