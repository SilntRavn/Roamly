import test from "node:test";
import assert from "node:assert/strict";
process.env.ROAMLY_DB = ":memory:";
const { resolveDayTransport } = await import("../server/day-transport.mjs");
const { planTrip, extractRequirements } = await import("../server/planner.mjs");
const { PreferencesSchema, RequirementsSchema } = await import("../shared/requirements.mjs");
const { profilePreferences } = await import("../shared/profile-preferences.mjs");
const { chooseTransitPath } = await import("../server/transit-choice.mjs");
const { checkPlanQuality } = await import("../server/plan-quality.mjs");
const points = [0, 1, 2].map((i) => ({ id: `mode-${i}`, name: `游览公园${i}`, city: "测试市", district: "测试区",
  location: { lng: 120 + i * 0.02, lat: 30, coordSystem: "GCJ-02" }, openingHours: "09:00-17:00",
  source: { provider: "测试", url: "", updatedAt: "now" } }));
const leg = (a, b, mode, minutes = 15) => ({ from: a.id, to: b.id, mode, status: "verified", minutes,
  distance: 2000, walkingDistance: 0 });

test("默认智能出行，升级旧完整默认公交配置，保留明确保存的公交与自定义偏好", () => {
  const defaults = PreferencesSchema.parse({});
  assert.equal(defaults.transport, "auto");
  const old = { ...defaults, transport: "transit" };
  assert.equal(profilePreferences(old).transport, "auto");
  assert.equal(profilePreferences({ ...old, transportChoice: true }).transport, "transit");
  assert.equal(profilePreferences({ ...old, interests: ["文化"] }).transport, "transit");
  assert.equal(profilePreferences({ ...old, transport: "walking" }).transport, "walking");
});

test("助手过去的公交失败反馈不转化为用户公交限制，用户真实说不自驾才保留公交", async () => {
  const preferences = PreferencesSchema.parse({});
  const requirements = RequirementsSchema.parse({ cities: ["测试市"], days: 1, preferences: { ...preferences, transport: "transit" } });
  const complete = async () => ({ role: "assistant", tool_calls: [{ function: { name: "set_trip_requirements",
    arguments: JSON.stringify({ status: "ready", question: null, requirements }) } }] });
  const automatic = await extractRequirements({ message: "重新规划测试市一天", preferences, existing: null,
    history: [{ role: "assistant", content: "公共交通无法核验，不得擅自改交通方式" }], complete });
  assert.equal(automatic.requirements.preferences.transport, "auto");
  const strict = await extractRequirements({ message: "重新规划测试市一天", preferences, existing: null,
    history: [{ role: "user", content: "我这次不自驾，只坐公交地铁" }], complete });
  assert.equal(strict.requirements.preferences.transport, "transit");
});

test("智能出行的公交失败后核验整天自驾，统一方式且不编造分钟数", async () => {
  const calls = [];
  const result = await resolveDayTransport(points, "auto", async (a, b, mode) => {
    calls.push(mode);
    return mode === "transit" && a.id === points[0].id ? { from: a.id, to: b.id, mode, status: "unavailable" } : leg(a, b, mode, mode === "driving" ? 23 : 16);
  });
  assert.equal(result.transport, "driving");
  assert.deepEqual(result.legs.map((l) => [l.mode, l.minutes]), [["driving", 23], ["driving", 23]]);
  assert.deepEqual(calls, ["transit", "transit", "driving", "driving"]);
});

test("明确公共交通或不自驾时，不因公交无方案而查询驾车", async () => {
  const calls = [];
  const result = await resolveDayTransport(points, "transit", async (a, b, mode) => {
    calls.push(mode); return { from: a.id, to: b.id, mode, status: "unavailable" };
  });
  assert.equal(result.transport, "transit");
  assert.deepEqual(calls, ["transit", "transit"]);
  assert.ok(result.legs.every((l) => !Object.hasOwn(l, "minutes")));
});

test("远郊先核验驾车，公交与驾车都失败时仍保留未核验状态", async () => {
  const far = { ...points[1], location: { ...points[1].location, lng: 120.3 } };
  const calls = [];
  const good = await resolveDayTransport([points[0], far], "auto", async (a, b, mode) => {
    calls.push(mode); return leg(a, b, mode, 48);
  });
  assert.deepEqual(calls, ["driving"]);
  assert.equal(good.legs[0].minutes, 48);
  const failed = await resolveDayTransport([points[0], far], "auto", async (a, b, mode) =>
    ({ from: a.id, to: b.id, mode, status: "unavailable" }));
  assert.equal(failed.legs[0].status, "unavailable");
  assert.equal(failed.legs[0].minutes, undefined);
});

test("近邻步行必须真实核验且遵守步行额度，不能因坐标接近假定可走", async () => {
  const nearby = { ...points[1], location: { ...points[1].location, lng: 120.004 } };
  const result = await resolveDayTransport([points[0], nearby], "auto", async (a, b, mode) =>
    ({ ...leg(a, b, mode), distance: mode === "walking" ? 2500 : 1000 }), undefined, { maxWalkingMeters: 500 });
  assert.equal(result.transport, "transit");
});

test("合理公交不额外查自驾；明显耗时的公交只在完整核验自驾更省时后替代", async () => {
  const calls = [];
  await resolveDayTransport(points, "auto", async (a, b, mode) => { calls.push(mode); return leg(a, b, mode, 20); });
  assert.deepEqual(calls, ["transit", "transit"]);
  const faster = await resolveDayTransport(points, "auto", async (a, b, mode) => leg(a, b, mode, mode === "transit" ? 95 : 30));
  assert.equal(faster.transport, "driving");
});

test("地铁作为软偏好：耗时接近时优先，明显更慢或步行更远时选公交；无地铁仍可规划", () => {
  const path = (type, minutes, walking = 200) => ({ duration: String(minutes * 60), distance: "8000", walking_distance: String(walking),
    segments: [{ bus: { buslines: [{ type }] } }] });
  const bus = path("普通公交", 30), subway = path("地铁", 34);
  assert.equal(chooseTransitPath([bus, subway]), subway);
  assert.equal(chooseTransitPath([bus, path("地铁", 50)]), bus);
  assert.equal(chooseTransitPath([bus, path("地铁", 32, 1500)]), bus);
  assert.equal(chooseTransitPath([bus]), bus);
  assert.equal(chooseTransitPath([{ duration: [] }, subway]), subway);
});

test("公共交通的近邻接驳核验步行并准确展示；零步行额度禁止替代，步行服务失败仍保留已核验公交", async () => {
  const nearby = { ...points[1], location: { ...points[1].location, lng: 120.005 } };
  const route = async (a, b, mode) => mode === "transit" ? { from: a.id, to: b.id, mode, status: "unavailable" } :
    { ...leg(a, b, mode, 10), distance: 600 };
  const resolved = await resolveDayTransport([points[0], nearby], "transit", route);
  assert.equal(resolved.transport, "transit");
  assert.equal(resolved.legs[0].mode, "walking");
  assert.equal(resolved.legs[0].requestedMode, "transit");
  const limited = await resolveDayTransport([points[0], nearby], "transit", route, undefined, { maxWalkingMeters: 0 });
  assert.equal(limited.legs[0].status, "unavailable");
  const kept = await resolveDayTransport([points[0], nearby], "transit", async (a, b, mode) => {
    if (mode === "walking") throw new TypeError("fetch failed");
    return leg(a, b, mode, 35);
  });
  assert.equal(kept.legs[0].status, "verified");
  assert.equal(kept.legs[0].minutes, 35);
});

test("自驾不能掩盖普通区域游可选景点之间超过50公里的赶路，必去点则保留并提示", () => {
  const preferences = { ...PreferencesSchema.parse({}), pace: "relaxed", transport: "driving" };
  const requirements = RequirementsSchema.parse({ cities: ["测试市"], days: 1, preferences });
  const trip = { preferences, days: [{ index: 1, date: null, items: points.slice(0, 2).map((p, i) =>
    ({ id: p.id, kind: "place", placeId: p.id, title: p.name, arrival: i ? "14:00" : "09:00", durationMinutes: 120 })) }] };
  const audit = { days: [{ index: 1, legs: [{ ...leg(points[0], points[1], "driving", 60), distance: 70000,
    itemFrom: points[0].id, itemTo: points[1].id }] }] };
  assert.ok(checkPlanQuality(trip, points, requirements, audit).errors.some((i) => i.code === "long_transfer"));
  requirements.requiredPlaceIds = points.slice(0, 2).map((p) => p.id);
  assert.ok(checkPlanQuality(trip, points, requirements, audit).warnings.some((i) => i.code === "long_transfer"));
});

test("公交无法核验的可选推荐自动按自驾生成行程，只选点一次、不增加AI修正轮次", async () => {
  const preferences = { ...PreferencesSchema.parse({}), pace: "relaxed" };
  const requirements = RequirementsSchema.parse({ cities: ["测试市"], days: 1, preferences });
  const call = (name, args) => ({ role: "assistant", content: "", tool_calls: [{ id: crypto.randomUUID(), type: "function",
    function: { name, arguments: JSON.stringify(args) } }] });
  const queue = [call("set_trip_requirements", { status: "ready", question: null, requirements }),
    call("search_places", { keyword: "公园", city: "测试市" }),
    call("submit_route", { title: "公园一日游", days: [{ index: 1, visits: points.map((p) =>
      ({ placeId: p.id, durationMinutes: 120 })) }] })];
  let aiCalls = 0, routeCalls = 0, saved = 0;
  const result = await planTrip({ message: "测试市公园一日游，慢一点", history: [], preferences,
    existing: null, userId: "test", signal: new AbortController().signal, progress: () => {} }, {
    complete: async () => { aiCalls++; assert.ok(queue.length); return queue.shift(); },
    lookup: (id) => points.find((p) => p.id === id), search: async () => points, persist: () => saved++,
    route: async (a, b, mode) => { routeCalls++; return mode === "transit" ?
      { from: a.id, to: b.id, mode, status: "unavailable" } : leg(a, b, mode, 23); },
  });
  assert.equal(saved, 1);
  assert.equal(aiCalls, 3);
  assert.equal(routeCalls, 4);
  assert.equal(result.trip.preferences.transport, "auto");
  assert.equal(result.trip.days[0].transport, "driving");
  assert.match(result.reply, /自驾.*车辆/);
  assert.ok(result.audit.days[0].legs.every((l) => l.mode === "driving" && l.status === "verified"));
  assert.equal(result.audit.quality.issues.filter((i) => i.severity === "error").length, 0);
});
