import { z } from "zod";
import { PreferencesSchema, RequirementsSchema } from "./requirements.mjs";
export { PreferencesSchema, RequirementsSchema } from "./requirements.mjs";
const text = (max = 1000) => z.string().max(max);
const httpsUrl = z.string().max(2000).refine((x) => {
  try {
    const url = new URL(x);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}, "链接必须是有效的 HTTPS 地址");
const photoUrl = z.string().max(2000).refine(
  (x) => !x || httpsUrl.safeParse(x).success || /^\/images\/[a-z0-9_-]+\.(png|jpg|webp)$/.test(x),
  "图片地址不安全",
);
export const ContentSourceSchema = z.object({
  title: text(300).min(1),
  url: z.string().max(2000).refine((value) => {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
    } catch { return false; }
  }, "来源链接必须是有效的 HTTP 或 HTTPS 地址"),
  updatedAt: text(100),
});
export const BookingChannelSchema = z.object({
  kind: z.enum(["website", "miniprogram", "official_account"]),
  name: text(120).min(1),
  url: httpsUrl.nullable().default(null),
  instructions: text(1000).default(""),
  source: ContentSourceSchema,
});
export const LocationSchema = z.object({
  lng: z.number().min(-180).max(180),
  lat: z.number().min(-85).max(85),
  coordSystem: z.enum(["GCJ-02", "WGS84"]),
});
export const PlaceSchema = z.object({
  id: text(100).min(1),
  name: text(100).min(1),
  city: text(100),
  province: text(100).default(""),
  district: text(100).default(""),
  country: text(100).default("中国"),
  address: text(300).default(""),
  location: LocationSchema,
  overview: text(5000).default(""),
  overviewSource: ContentSourceSchema.nullable().default(null),
  bookingChannels: z.array(BookingChannelSchema).max(5).default([]),
  aiRating: z.number().min(1).max(5).multipleOf(0.1).nullable().default(null),
  category: text(100).default("景点"),
  photo: photoUrl.default(""),
  photos: z.array(photoUrl.refine((x) => Boolean(x))).max(3).default([]),
  suggestedMinutes: z.number().int().min(10).max(1440).default(90),
  openingHours: text(500).nullable().default(null),
  price: z.number().min(0).max(1000000).nullable().default(null),
  currency: z.enum(["CNY", "JPY", "USD", "EUR"]).default("CNY"),
  source: z.object({
    provider: text(80),
    url: z
      .string()
      .max(2000)
      .refine((x) => !x || /^https:\/\//.test(x)),
    updatedAt: z.string().max(100),
    note: text(1000).default(""),
  }),
});
export const ItemSchema = z
  .object({
    id: text(100).min(1),
    kind: z.enum(["place", "break"]),
    placeId: text(100).nullable(),
    title: text(120),
    arrival: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    durationMinutes: z.number().int().min(10).max(1440),
    notes: text(1500).default(""),
  })
  .refine((x) => x.kind !== "place" || Boolean(x.placeId), "景点缺少地点 ID");
export const TripSchema = z.object({
  id: text(100).min(1),
  title: text(150).min(1),
  city: text(120),
  summary: text(2000),
  preferences: PreferencesSchema,
  requirements: RequirementsSchema.optional(),
  createdAt: text(100),
  updatedAt: text(100),
  days: z
    .array(
      z.object({
        index: z.number().int().min(1).max(14),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable(),
        title: text(120),
        transport: z.enum(["walking", "driving", "transit"]).optional(),
        items: z.array(ItemSchema).max(12),
      }),
    )
    .min(1)
    .max(14),
});
export const FileSchema = z
  .object({
    format: z.literal("roamly.itinerary"),
    version: z.literal("1.0"),
    exportedAt: text(100),
    itinerary: TripSchema,
    places: z.array(PlaceSchema).max(100),
  })
  .superRefine((file, ctx) => {
    const ids = new Set(file.places.map((p) => p.id));
    if (ids.size !== file.places.length)
      ctx.addIssue({ code: "custom", message: "地点 ID 重复" });
    const itemIds = new Set();
    for (const id of file.itinerary.requirements?.requiredPlaceIds || []) {
      if (!ids.has(id))
        ctx.addIssue({ code: "custom", message: `指定地点 ${id} 缺少快照` });
    }
    for (const visit of file.itinerary.requirements?.fixedVisits || []) {
      if (visit.placeId && !ids.has(visit.placeId))
        ctx.addIssue({
          code: "custom",
          message: `固定地点 ${visit.placeId} 缺少快照`,
        });
    }
    const dayIds = new Set();
    for (const [index, day] of file.itinerary.days.entries()) {
      if (day.index !== index + 1)
        ctx.addIssue({ code: "custom", message: "日程序号必须从1起连续递增" });
      if (dayIds.has(day.index))
        ctx.addIssue({ code: "custom", message: "日程序号重复" });
      dayIds.add(day.index);
      let previous = "";
      for (const item of day.items) {
        if (itemIds.has(item.id))
          ctx.addIssue({ code: "custom", message: "日程项目 ID 重复" });
        itemIds.add(item.id);
        if (item.arrival < previous)
          ctx.addIssue({ code: "custom", message: "日程时间顺序有误" });
        previous = item.arrival;
        if (item.kind === "place" && !ids.has(item.placeId))
          ctx.addIssue({
            code: "custom",
            message: `地点 ${item.placeId} 缺少快照`,
          });
      }
    }
  });
export function makeExport(trip, places) {
  const used = new Set(
    trip.days.flatMap((d) => d.items.map((i) => i.placeId)).filter(Boolean),
  );
  return FileSchema.parse({
    format: "roamly.itinerary",
    version: "1.0",
    exportedAt: new Date().toISOString(),
    itinerary: trip,
    places: places.filter((p) => used.has(p.id)),
  });
}
export function minutes(time) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}
export function timeString(m) {
  return `${Math.floor(m / 60)
    .toString()
    .padStart(2, "0")}:${(m % 60).toString().padStart(2, "0")}`;
}
