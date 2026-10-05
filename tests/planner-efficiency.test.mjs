import test from "node:test";
import assert from "node:assert/strict";
process.env.ROAMLY_DB = ":memory:";
const { planTrip } = await import("../server/planner.mjs");
const { auditTrip } = await import("../server/amap.mjs");
const { checkPlanQuality } = await import("../server/plan-quality.mjs");
const { repairTripTimes } = await import("../server/schedule.mjs");
const { RequirementsSchema } = await import("../shared/requirements.mjs");
const { contiguousTravelMinutes } = await import("../server/route-quality.mjs");
const preferences = { pace: "relaxed", interests: ["文化"], travelers: 2, budget: null, transport: "driving" };
const places = [0, 1, 2].map((i) => ({ id: `e${i}`, name: `游览公园${i}`, city: "测试市", district: "测试区",
  country: "中国", address: "测试地址", photo: "", openingHours: "09:00-17:00", price: null,
  source: { provider: "测试", url: "", updatedAt: "now" },
  location: { lng: 120 + i * 0.02, lat: 30, coordSystem: "GCJ-02" } }));
const lookup = (id) => places.find((p) => p.id === id);
const requirements = RequirementsSchema.parse({ cities: ["测试市"], days: 1, preferences, requiredPlaceIds: places.map((p) => p.id) });
const visit = (i, arrival, durationMinutes) => ({ id: `v${i}`, kind: "place", placeId: places[i].id,
  title: places[i].name, arrival, durationMinutes, notes: "游览" });
const meal = { id: "meal", kind: "break", placeId: null, title: "午餐", arrival: "12:00", durationMinutes: 60, notes: "用餐" };
const trip = { id: "trip", title: "测试行程", city: "测试市", summary: "", preferences, requirements,
  createdAt: "now", updatedAt: "now", days: [{ index: 1, date: null, title: "当天游览",
    items: [visit(0, "09:00", 90), visit(1, "11:00", 60), meal, visit(2, "13:30", 60)] }] };
const call = (name, args) => ({ role: "assistant", content: "", tool_calls: [{ id: crypto.randomUUID(), type: "function",
  function: { name, arguments: JSON.stringify(args) } }] });

test("交通空档自动修正并复用证据，不再调用AI重写时刻或摘要；必要路段一次查询", async () => {
  let calls = 0, routeCalls = 0, saved = 0;
  const queue = [call("set_trip_requirements", { status: "ready", question: null, requirements }),
    call("search_places", { keyword: "测试公园", city: "测试市" }),
    call("get_route", { fromId: "e0", toId: "e1", mode: "driving" }), call("submit_itinerary", trip)];
  const result = await planTrip({ message: "测试市一天，三个公园都要去", history: [], preferences, existing: null,
    userId: "test", signal: new AbortController().signal, progress: () => {} }, {
    complete: async () => { calls++; assert.ok(queue.length); return queue.shift(); },
    search: async () => places, lookup, persist: () => saved++,
    route: async (a, b, mode) => { routeCalls++; return { from: a.id, to: b.id, mode, status: "verified",
      minutes: a.id === "e0" ? 90 : 40, distance: 2000, walkingDistance: 0 }; },
  });
  assert.equal(saved, 1);
  assert.equal(calls, 4);
  assert.equal(routeCalls, 2);
  assert.deepEqual(result.audit.quality.issues.filter((i) => i.severity === "error"), []);
  const day = result.trip.days[0];
  for (const leg of result.audit.days[0].legs) {
    assert.ok(contiguousTravelMinutes(day, day.items.find((i) => i.id === leg.itemFrom),
      day.items.find((i) => i.id === leg.itemTo)) >= leg.minutes);
  }
});

test("批量与同轮搜索并发执行，重复关键词合并，出错查询不丢失其他真实地点", async () => {
  let active = 0, peak = 0, searches = 0, ai = 0;
  const queue = [call("set_trip_requirements", { status: "ready", question: null, requirements }),
    call("search_places_batch", { queries: [0, 1, 2, 0, 99].map((i) => ({ keyword: `公园${i}`, city: "测试市" })) }),
    call("submit_itinerary", trip)];
  const result = await planTrip({ message: "测试市一天", history: [], preferences, existing: null,
    userId: "test", signal: new AbortController().signal, progress: () => {} }, {
    complete: async (messages) => { ai++; assert.ok(queue.length);
      if (ai === 3) { const data = JSON.parse(messages.at(-1).content);
        assert.equal(data.queries.filter((q) => q.error).length, 1);
        assert.equal(data.queries.filter((q) => q.places.length).length, 4); }
      return queue.shift(); }, lookup, persist: () => {},
    // 每个关键词只调用一次，异步任务同时进入，不依赖耗时断言。
    search: async (keyword) => {
      searches++; active++; peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve)); active--;
      if (keyword === "公园99") throw new Error("单项查询失败");
      return [places[Number(keyword.at(-1))]];
    },
    route: async (a, b, mode) => ({ from: a.id, to: b.id, mode, status: "verified", minutes: 15, distance: 1500, walkingDistance: 0 }),
  });
  assert.ok(result.trip);
  assert.equal(ai, 3);
  assert.equal(searches, 4);
  assert.ok(peak > 1 && peak <= 4);
});

test("所有必要交通并发核验且顺序稳定，重排时刻不重查；反向或换交通方式不复用", async () => {
  let active = 0, peak = 0, count = 0;
  const route = async (a, b, mode) => {
    count++; active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve)); active--;
    return { from: a.id, to: b.id, mode, status: "verified", minutes: 40, distance: 2000 };
  };
  const original = await auditTrip(trip, undefined, { lookup, route, compare: false });
  assert.equal(count, 2); assert.equal(peak, 2);
  assert.deepEqual(original.days[0].legs.map((l) => [l.from, l.to]), [["e0", "e1"], ["e1", "e2"]]);
  const repaired = repairTripTimes(trip, requirements, places, original);
  const checked = await auditTrip(repaired, undefined, { lookup, route, compare: false, evidence: original });
  assert.equal(count, 2); assert.equal(checked.days[0].conflicts.length, 0);
  await auditTrip({ ...trip, preferences: { ...preferences, transport: "walking" } }, undefined,
    { lookup, route, compare: false, evidence: original });
  assert.equal(count, 4);
  const reverse = { ...trip, days: [{ ...trip.days[0], items: [visit(2, "09:00", 60), visit(1, "11:00", 60), meal, visit(0, "14:00", 60)] }] };
  await auditTrip(reverse, undefined, { lookup, route, compare: false, evidence: original });
  assert.equal(count, 6);
});

test("优化不能把明确指定的分日目的地换日；缺失完整下午不能作为质量合格保存", () => {
  const p = [{ ...places[0], city: "杭州", district: "西湖区" }, { ...places[1], city: "杭州", district: "临安区" }];
  const req = RequirementsSchema.parse({ cities: ["杭州", "临安"], days: 2, preferences,
    dayDestinations: [{ day: 1, destination: "杭州" }, { day: 2, destination: "临安" }] });
  const wrong = { ...trip, days: [{ index: 1, date: null, title: "第一天", items: [visit(1, "09:00", 90)] },
    { index: 2, date: null, title: "第二天", items: [visit(0, "09:00", 90)] }] };
  assert.ok(checkPlanQuality(wrong, p, req).errors.some((i) => i.code === "day_destination"));
  const regular = { ...preferences, pace: "balanced" };
  const short = { ...trip, preferences: regular, days: [{ ...trip.days[0], items: [visit(0, "09:00", 120), meal] }] };
  assert.ok(checkPlanQuality(short, places, RequirementsSchema.parse({ cities: ["测试市"], days: 1, preferences: regular })).errors
    .some((i) => i.code === "afternoon_missing"));
});

test("简洁选点即可生成按真实交通排好的日程，固定时长与预约不会被默认值覆盖", async () => {
  const req = RequirementsSchema.parse({ ...requirements, fixedVisits: [{ placeId: "e1", name: places[1].name,
    day: 1, arrival: "13:00", durationMinutes: 120, durationRule: "minimum" }] });
  const queue = [call("set_trip_requirements", { status: "ready", question: null, requirements: req }),
    call("search_places", { keyword: "公园", city: "测试市" }),
    call("submit_route", { days: [{ index: 1, visits: places.map((p) => ({ placeId: p.id, durationMinutes: 60 })) }] })];
  let calls = 0, queries = 0;
  const result = await planTrip({ message: "测试市一天，中间公园13点预约，至少两小时", history: [], preferences,
    existing: null, userId: "test", signal: new AbortController().signal, progress: () => {} }, {
    complete: async (messages) => { calls++; assert.ok(queue.length, messages.at(-1).content); return queue.shift(); }, lookup, search: async () => places,
    route: async (a, b, mode) => { queries++; return { from: a.id, to: b.id, mode, status: "verified", minutes: 20, distance: 1000, walkingDistance: 0 }; },
    persist: () => {},
  });
  assert.ok(result.trip); assert.equal(calls, 3); assert.equal(queries, 2);
  const pinned = result.trip.days[0].items.find((i) => i.placeId === "e1");
  assert.equal(pinned.arrival, "13:00"); assert.ok(pinned.durationMinutes >= 120);
  assert.deepEqual(result.audit.quality.issues.filter((i) => i.severity === "error"), []);
});

test("替换远郊点后按较短真实交通前移下午，不能因原到达时刻而留下整个下午空档", async () => {
  const regular = { ...preferences, pace: "balanced" };
  const req = RequirementsSchema.parse({ cities: ["测试市"], days: 1, preferences: regular, requiredPlaceIds: ["e0", "e1"] });
  const snapshots = places.map((p) => ({ ...p, openingHours: "09:00-20:00" }));
  const candidate = { ...trip, preferences: regular, requirements: req, days: [{ ...trip.days[0],
    items: [visit(0, "09:00", 180), meal, visit(1, "17:00", 180)] }] };
  let queries = 0;
  const original = await auditTrip(candidate, undefined, { lookup: (id) => snapshots.find((p) => p.id === id), compare: false,
    route: async (a, b, mode) => { queries++; return { from: a.id, to: b.id, mode, status: "verified", minutes: 30, distance: 1500 }; } });
  assert.ok(checkPlanQuality(candidate, snapshots, req, original).errors.some((i) => i.code === "idle_gap"));
  const repaired = repairTripTimes(candidate, req, snapshots, original);
  assert.ok(repaired); assert.ok(repaired.days[0].items.find((i) => i.placeId === "e1").arrival < "15:00");
  const evidence = await auditTrip(repaired, undefined, { lookup, compare: false, evidence: original,
    route: async () => { throw new Error("不能重复查询已核验路线"); } });
  assert.equal(queries, 1);
  assert.deepEqual(checkPlanQuality(repaired, snapshots, req, evidence).errors, []);
});
