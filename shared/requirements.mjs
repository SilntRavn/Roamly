import { z } from "zod";

const name = z.string().trim().min(1).max(120);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const PreferencesSchema = z.object({
  pace: z.enum(["relaxed", "balanced", "packed"]).default("balanced"),
  interests: z.array(z.string().max(40)).max(10).default(["自然风景"]),
  travelers: z.number().int().min(1).max(50).default(2),
  budget: z.number().min(0).max(10000000).nullable().default(null),
  transport: z.enum(["auto", "walking", "driving", "transit"]).default("auto"),
});
// null 表示用户没有提出这个硬限制，不能把产品建议伪装成用户要求。
export const RequirementsSchema = z.object({
  version: z.literal(1).default(1),
  // cities 沿用旧字段名，实际存放用于 POI 核验的行政目的地范围。
  cities: z.array(name).max(10).default([]),
  destinationLabel: name.nullable().default(null),
  days: z.number().int().min(1).max(14).nullable().default(null),
  dayDestinations: z.array(z.object({ day: z.number().int().min(1).max(14), destination: name })).max(14).default([]),
  startDate: z.iso.date().nullable().default(null),
  preferences: PreferencesSchema,
  requiredPlaces: z
    .array(z.object({ name, city: z.string().max(100) }))
    .max(40)
    .default([]),
  requiredPlaceIds: z.array(name).max(100).default([]),
  excludedPlaces: z.array(name).max(40).default([]),
  repeatPlaces: z.array(name).max(40).default([]),
  fixedVisits: z
    .array(
      z.object({
        placeId: name.nullable(),
        name,
        day: z.number().int().min(1).max(14).nullable(),
        arrival: time.nullable(),
        durationMinutes: z.number().int().min(10).max(1440).nullable(),
        durationRule: z.enum(["exact", "minimum"]).default("exact"),
      }),
    )
    .max(40)
    .default([]),
  dailyStart: time.nullable().default(null),
  dailyEnd: time.nullable().default(null),
  nightTour: z.enum(["auto", "prefer", "avoid"]).default("auto"),
  routingStyle: z.enum(["local", "roadtrip"]).default("local"),
  maxDailyStops: z.number().int().min(1).max(12).nullable().default(null),
  maxWalkingMeters: z
    .number()
    .int()
    .min(0)
    .max(100000)
    .nullable()
    .default(null),
  maxDailyTravelMinutes: z
    .number()
    .int()
    .min(0)
    .max(1440)
    .nullable()
    .default(null),
  minRestMinutes: z.number().int().min(0).max(720).nullable().default(null),
  childrenAges: z.array(z.number().int().min(0).max(17)).max(12).default([]),
  hasElderly: z.boolean().default(false),
  stepFree: z.boolean().default(false),
});

export const RequirementExtractionSchema = z.object({
  status: z.enum(["ready", "clarify"]),
  question: z.string().max(1000).nullable(),
  requirements: RequirementsSchema,
  removals: z
    .array(z.object({ placeId: name, evidence: z.string().min(2).max(500) }))
    .max(100)
    .default([]),
  replaceExisting: z.boolean().default(false),
  replaceEvidence: z.string().max(500).nullable().default(null),
});

export function defaultRequirements(trip) {
  const visits = trip.days.flatMap((d) =>
    d.items.filter((i) => i.kind === "place"),
  );
  return RequirementsSchema.parse({
    cities: trip.city ? [trip.city] : [],
    days: trip.days.length,
    preferences: trip.preferences,
    repeatPlaces: [
      ...new Set(
        visits
          .filter(
            (i) => visits.filter((v) => v.placeId === i.placeId).length > 1,
          )
          .map((i) => i.title),
      ),
    ],
    // 老版本/手工行程缺少来源标记时保守保留所有已有地点。
    requiredPlaceIds: [
      ...new Set(
        trip.days.flatMap((d) => d.items.map((i) => i.placeId)).filter(Boolean),
      ),
    ],
  });
}

export function normalizedName(value = "") {
  return value
    .replace(/[\s·•-]/g, "")
    .replace(/风景名胜区|风景区|旅游景区|景区|市$/g, "");
}
// 自治行政区的简称只去掉行政后缀及民族名，不做任意前缀匹配。
const ethnicNames = "维吾尔|哈萨克|柯尔克孜|布依|土家|苗|侗|藏|羌|回|彝|白|傣|哈尼|傈僳|壮|蒙古|朝鲜|满|瑶|黎|景颇|怒|独龙|拉祜|佤|纳西|普米|布朗|撒拉|东乡|保安|裕固|仫佬|毛南|水|仡佬|达斡尔|鄂温克|鄂伦春|锡伯|俄罗斯|塔吉克|乌孜别克|塔塔尔|土|门巴|珞巴|基诺|阿昌|德昂|赫哲|畲|高山|京";
const autonomousSuffix = new RegExp(`(?:(?:${ethnicNames})(?:族)?)+(?:自治州|自治区|自治县|自治旗)$`);
function administrativeName(value = "") {
  return value.replace(/[\s·•-]/g, "")
    .replace(/^内蒙古自治区$/, "内蒙古")
    .replace(/^西藏自治区$/, "西藏")
    .replace(autonomousSuffix, "")
    .replace(/(?:省|市|区|县|地区|盟|自治州|自治区|自治县|自治旗)$/, "");
}
// 目的地可以是省域、自治州、城市或区县。只匹配来源行政字段，
// 不将区县扩大成上级城市，也不从景点名或地址猜测归属。
export function matchesDestination(place, destination = "") {
  const compact = (value = "") => value.replace(/[\s·•-]/g, "");
  const short = administrativeName;
  const wanted = short(destination);
  if (!wanted) return false;
  const variants = (value) => [...new Set([compact(value), short(value)])].filter(Boolean);
  const city = variants(place.city), district = variants(place.district);
  const province = variants(place.province);
  const paths = [...province, ...city, ...district];
  for (const c of city) for (const d of district) paths.push(c + d);
  for (const p of province) {
    for (const c of city) {
      paths.push(p + c);
      for (const d of district) paths.push(p + c + d);
    }
    for (const d of district) paths.push(p + d);
  }
  return paths.some((path) => compact(path) === wanted || short(path) === wanted);
}
export function matchesPlace(place, wanted) {
  const a = normalizedName(place.name),
    b = normalizedName(wanted.name || wanted);
  const city =
    typeof wanted === "object" ? wanted.city || "" : "";
  return Boolean(
    b &&
    (a === b || (b.length >= 2 && a.includes(b))) &&
    (!city || matchesDestination(place, city)),
  );
}

export function reconcileManualRequirements(old, next, places) {
  const requirements = RequirementsSchema.parse(
    old?.requirements || next.requirements || defaultRequirements(next),
  );
  const before = new Set(
    old?.days.flatMap((d) => d.items.map((i) => i.placeId)).filter(Boolean) ||
      [],
  );
  const after = new Set(
    next.days.flatMap((d) => d.items.map((i) => i.placeId)).filter(Boolean),
  );
  const removed = places.filter((p) => before.has(p.id) && !after.has(p.id));
  requirements.requiredPlaceIds = [
    ...new Set([
      ...requirements.requiredPlaceIds.filter((id) => after.has(id)),
      ...[...after].filter((id) => !before.has(id)),
    ]),
  ];
  requirements.requiredPlaces = requirements.requiredPlaces.filter(
    (w) => !removed.some((p) => matchesPlace(p, w)),
  );
  requirements.fixedVisits = requirements.fixedVisits.filter(
    (v) => !removed.some((p) => v.placeId === p.id || matchesPlace(p, v)),
  );
  requirements.repeatPlaces = requirements.repeatPlaces.filter(
    (w) => !removed.some((p) => matchesPlace(p, w)),
  );
  const visits = next.days.flatMap((d) =>
    d.items.filter((i) => i.kind === "place"),
  );
  requirements.repeatPlaces = [
    ...new Set([
      ...requirements.repeatPlaces,
      ...visits
        .filter((i) => visits.filter((v) => v.placeId === i.placeId).length > 1)
        .map((i) => places.find((p) => p.id === i.placeId)?.name || i.title),
    ]),
  ];
  const previousItems = new Map(
    old?.days.flatMap((d) =>
      d.items.map((item) => [item.id, { item, day: d.index }]),
    ) || [],
  );
  for (const day of next.days)
    for (const item of day.items.filter((i) => i.kind === "place")) {
      const previous = previousItems.get(item.id);
      if (
        previous &&
        (previous.item.arrival !== item.arrival ||
          previous.item.durationMinutes !== item.durationMinutes ||
          previous.day !== day.index)
      ) {
        requirements.fixedVisits = requirements.fixedVisits.filter(
          (v) => v.placeId !== item.placeId,
        );
        requirements.fixedVisits.push({
          placeId: item.placeId,
          name: places.find((p) => p.id === item.placeId)?.name || item.title,
          day: day.index,
          arrival: item.arrival,
          durationMinutes: item.durationMinutes,
        });
      }
    }
  if (old && old.days[0]?.date !== next.days[0]?.date)
    requirements.startDate = next.days[0]?.date || null;
  requirements.days = next.days.length;
  requirements.preferences = next.preferences;
  return RequirementsSchema.parse(requirements);
}

// 只有用户这次明确删除/换行程时才允许解锁已有地点，避免调时间时悄悄少一站。
export function reconcileExtractedRequirements(
  extraction,
  existing,
  message,
  places,
) {
  if (!existing) return extraction.requirements;
  const previous = existing.requirements || defaultRequirements(existing);
  const evidenceValid = (evidence) =>
    Boolean(
      evidence &&
      message.includes(evidence) &&
      /删|取消|不去|不要|不想|去掉|移除|换成|改为|改成|重新|重做|换个/.test(
        evidence,
      ),
    );
  if (extraction.replaceExisting && evidenceValid(extraction.replaceEvidence))
    return extraction.requirements;
  const mentions = (place, evidence) => {
    const commonName = place.name
      .replace(/[（(].*$/, "")
      .replace(/博物院$|博物馆$|公园$/, "");
    return (
      evidence.includes(place.name) ||
      normalizedName(evidence).includes(normalizedName(place.name)) ||
      (commonName.length >= 2 && evidence.includes(commonName)) ||
      previous.requiredPlaces.some(
        (w) => matchesPlace(place, w) && evidence.includes(w.name),
      )
    );
  };
  const removed = new Set(
    extraction.removals
      .filter(
        (r) =>
          evidenceValid(r.evidence) &&
          places.some((p) => p.id === r.placeId && mentions(p, r.evidence)),
      )
      .map((r) => r.placeId),
  );
  const requirements = structuredClone(extraction.requirements);
  if (!requirements.destinationLabel && previous.destinationLabel &&
    requirements.cities.length === previous.cities.length &&
    requirements.cities.every((c) => previous.cities.some((p) => administrativeName(c) === administrativeName(p))))
    requirements.destinationLabel = previous.destinationLabel;
  // 缺省 auto 不能在一次无关修改中抹掉已确认的夜游意愿。
  if (requirements.nightTour === "auto" && previous.nightTour &&
    !/夜|晚上|晚间|傍晚|灯光/.test(message))
    requirements.nightTour = previous.nightTour;
  if (previous.routingStyle === "roadtrip" && requirements.routingStyle === "local" &&
    !/路线|线路|长途|公路|赶路|区域|市区|郊区|沿途|跨城|重新/.test(message))
    requirements.routingStyle = previous.routingStyle;
  requirements.requiredPlaceIds = [
    ...new Set([
      ...previous.requiredPlaceIds,
      ...requirements.requiredPlaceIds,
    ]),
  ].filter((id) => !removed.has(id));
  requirements.requiredPlaces = [
    ...previous.requiredPlaces,
    ...requirements.requiredPlaces,
  ].filter(
    (w, index, list) =>
      !places.some((p) => removed.has(p.id) && matchesPlace(p, w)) &&
      list.findIndex((a) => a.name === w.name && a.city === w.city) === index,
  );
  requirements.fixedVisits = requirements.fixedVisits.filter(
    (v) =>
      !places.some(
        (p) => removed.has(p.id) && (v.placeId === p.id || matchesPlace(p, v)),
      ),
  );
  return RequirementsSchema.parse(requirements);
}
