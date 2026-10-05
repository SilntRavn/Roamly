import test from "node:test";
import assert from "node:assert/strict";
import { dayRhythm, estimateDaylight } from "../server/day-rhythm.mjs";
import { PreferencesSchema, RequirementsSchema } from "../shared/requirements.mjs";
import { checkPlanQuality } from "../server/plan-quality.mjs";

const preferences = PreferencesSchema.parse({});
const places = ["城市公园", "历史街区", "河畔步道", "本地夜市"].map((name, i) => ({
  id: `rhythm-${i}`, name, city: "杭州市", province: "浙江省", country: "中国",
  category: "景点", openingHours: "全天开放",
  location: { lng: 120.15 + i * 0.001, lat: 30.25, coordSystem: "GCJ-02" },
}));
const xinjiangPlaces = places.map((p) => ({ ...p, city: "乌鲁木齐市", province: "新疆维吾尔自治区",
  location: { lng: 87.62, lat: 43.82, coordSystem: "GCJ-02" } }));
const visit = (index, arrival, durationMinutes = 90) => ({
  id: `visit-${index}`, kind: "place", placeId: places[index].id,
  title: places[index].name, arrival, durationMinutes, notes: "",
});
const meal = (arrival, title = "午餐", durationMinutes = 60) => ({
  id: title, kind: "break", placeId: null, title, arrival, durationMinutes, notes: "",
});
const quality = (items, changes = {}, snapshots = places, date = null) => {
  const requirements = RequirementsSchema.parse({
    cities: [snapshots[0].city], days: 1, preferences, ...changes,
  });
  return checkPlanQuality({
    preferences: requirements.preferences,
    days: [{ index: 1, date, items }],
  }, snapshots, requirements);
};
const codes = (result) => result.issues.map((i) => i.code);

test("产品默认充实节奏，明确慢游与旧夜游字段仍兼容", () => {
  assert.equal(preferences.pace, "balanced");
  assert.equal(PreferencesSchema.parse({ pace: "relaxed" }).pace, "relaxed");
  assert.equal(RequirementsSchema.parse({ preferences }).nightTour, "auto");
});

test("默认日程13点结束会反馈补排，晚休息或仅加夜游不能补足下午", () => {
  const short = [visit(0, "08:30"), meal("11:30"), visit(1, "12:30", 30)];
  assert.ok(codes(quality(short)).includes("day_underfilled"));
  assert.ok(codes(quality([...short, meal("17:00", "休息")])).includes("day_underfilled"));
  assert.ok(codes(quality([...short, meal("18:00", "晚餐"), visit(3, "19:30")])).includes("day_underfilled"));
  const full = [...short, visit(2, "15:00", 120)];
  assert.ok(!codes(quality(full)).includes("day_underfilled"));
});

test("慢游、明确少量景点、半天和晚出发的限制不会被全天建议覆盖", () => {
  const short = [visit(0, "09:00")];
  for (const changes of [
    { preferences: { ...preferences, pace: "relaxed" } },
    { maxDailyStops: 1 },
    { dailyEnd: "12:00" },
    { dailyStart: "13:00" },
  ]) assert.ok(!codes(quality(short, changes)).includes("day_underfilled"));
  const bounded = quality([visit(0, "09:00"), visit(1, "10:45")], { dailyEnd: "15:00" });
  const warning = bounded.warnings.find((i) => i.code === "day_underfilled");
  assert.match(warning.message, /15:00/);
  assert.doesNotMatch(warning.message, /17:00/);
});

test("夜游意愿、结束上限和晚餐均参与核验", () => {
  const full = [visit(0, "08:30", 180), meal("12:00"), visit(1, "14:00", 180)];
  assert.ok(codes(quality(full, { nightTour: "prefer" })).includes("night_missing"));
  assert.ok(!codes(quality(full, { nightTour: "prefer", dailyEnd: "17:00" })).includes("night_missing"));
  const night = [...full, visit(3, "19:00", 60)];
  assert.ok(codes(quality(night, { nightTour: "avoid" })).includes("night_unwanted"));
  assert.ok(codes(quality(night)).includes("dinner_missing"));
  assert.ok(!codes(quality([...full, meal("18:00", "晚餐"), visit(3, "19:15")])).includes("dinner_missing"));
  assert.ok(codes(quality([...full, meal("18:00", "晚餐", 30), visit(3, "19:15")])).includes("dinner_missing"));
  const spanning = [...full, meal("17:15", "晚餐"), visit(3, "18:20", 100)];
  assert.ok(!codes(quality(spanning, { nightTour: "prefer" })).includes("night_missing"));
  const earlyEveningVisit = [visit(0, "08:30", 180), meal("12:00"), visit(1, "14:00", 90),
    meal("16:00", "晚餐"), visit(3, "17:30", 150)];
  assert.ok(!codes(quality(earlyEveningVisit, { nightTour: "prefer" })).includes("night_missing"));
  const earlyDinnerIssue = quality(earlyEveningVisit).errors.find((i) => i.code === "dinner_missing");
  assert.match(earlyDinnerIssue.message, /17:00 至 20:30/);
});

test("新疆以北京时间晚出晚归，白昼参考按日期区分夏冬，无日期不猜夏季", () => {
  const summer = dayRhythm(xinjiangPlaces, "2026-06-21");
  const winter = dayRhythm(xinjiangPlaces, "2026-12-21");
  assert.equal(summer.recommendedStart, "10:00");
  assert.equal(summer.timeZone, "Asia/Shanghai");
  assert.equal(summer.recommendedDayEnd, "21:30");
  assert.equal(winter.recommendedDayEnd, "18:00");
  assert.equal(dayRhythm(xinjiangPlaces).daylight, null);
  assert.equal(dayRhythm(xinjiangPlaces).recommendedDayEnd, "20:00");
  assert.equal(dayRhythm(places).recommendedDayEnd, "17:00");
  assert.equal(dayRhythm([...places, ...xinjiangPlaces]).region, "常规目的地");
  assert.equal(dayRhythm([{ ...xinjiangPlaces[0], province: "" }]).region, "新疆");
  assert.equal(dayRhythm([{ ...places[0], name: "新疆美食街" }]).region, "常规目的地");
});

test("太阳估算处理闰年、坐标与日期缺失，不将参考数值当作来源事实", () => {
  const summer = estimateDaylight(xinjiangPlaces[0].location, "2026-06-21");
  assert.ok(summer.sunsetMinutes > 21 * 60 + 30 && summer.sunsetMinutes < 22 * 60 + 15);
  assert.ok(estimateDaylight(xinjiangPlaces[0].location, "2028-02-29"));
  for (const date of [null, "2026-02-29", "2026-13-01", "tomorrow"])
    assert.equal(estimateDaylight(xinjiangPlaces[0].location, date), null);
  assert.equal(estimateDaylight({}, "2026-06-21"), null);
  assert.equal(estimateDaylight({ lng: 181, lat: 30 }, "2026-06-21"), null);
});

test("新疆夏季晚间仍有白昼，13点午餐与21点游览不误判夜游，冬季按天黑收早", () => {
  const items = [visit(0, "10:00", 150), meal("13:00"), visit(1, "14:30", 180),
    meal("19:00", "晚餐"), visit(2, "20:00", 90)];
  const summer = quality(items, { nightTour: "avoid" }, xinjiangPlaces, "2026-06-21");
  assert.ok(!codes(summer).includes("night_unwanted"));
  assert.ok(!codes(summer).includes("day_underfilled"));
  assert.ok(!codes(summer).includes("lunch_missing"));
  assert.ok(!codes(summer).includes("dinner_missing"));
  const winter = quality(items, { nightTour: "avoid" }, xinjiangPlaces, "2026-12-21");
  assert.ok(codes(winter).includes("night_unwanted"));
});
