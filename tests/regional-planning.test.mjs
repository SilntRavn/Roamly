import test from "node:test";
import assert from "node:assert/strict";
process.env.ROAMLY_DB = ":memory:";
const { auditTrip } = await import("../server/amap.mjs");
const { checkPlanQuality } = await import("../server/plan-quality.mjs");
const { groupByRegion, regionalAdvice, consolidateAreaStops } = await import("../server/regional-planning.mjs");
const { RequirementsSchema } = await import("../shared/requirements.mjs");
const { planTrip } = await import("../server/planner.mjs");
const preferences = { pace: "relaxed", interests: ["文化"], travelers: 2, budget: null, transport: "transit" };
function fixture(lng = 120, lat = 30) {
  const places = [0, 0.01, 0.5, 0.51].map((offset, i) => ({
    id: `p${i}`, name: `景点${i}`, city: "测试市", district: "同一个行政区",
    country: "中国", address: "测试地址", photo: "", openingHours: null, price: null,
    source: { provider: "测试", updatedAt: "now", url: "" },
    location: { lng: lng + offset, lat, coordSystem: "GCJ-02" },
  }));
  const requirements = RequirementsSchema.parse({ cities: ["测试市"], days: 2, preferences });
  const trip = { title: "区域游览", city: "测试市", summary: "", preferences: { ...preferences }, requirements,
    days: [[0, 2], [1, 3]].map((indices, d) => ({ index: d + 1, date: null, title: "区域",
      items: [
        { id: `a${d}`, kind: "place", placeId: places[indices[0]].id, title: places[indices[0]].name, arrival: "09:00", durationMinutes: 90, notes: "游览" },
        { id: `l${d}`, kind: "break", placeId: null, title: "午餐", arrival: "12:00", durationMinutes: 60, notes: "用餐" },
        { id: `b${d}`, kind: "place", placeId: places[indices[1]].id, title: places[indices[1]].name, arrival: "16:00", durationMinutes: 90, notes: "游览" },
      ] })) };
  const lookup = (id) => places.find((p) => p.id === id);
  const route = async (a, b) => ({ from: a.id, to: b.id, mode: "transit", status: "verified",
    minutes: Math.abs(a.location.lng - b.location.lng) > 0.1 ? 180 : 15, distance: 2000 });
  return { places, trip, requirements, lookup, route };
}

test("跨日区域混排由实际交通比较发现，同一行政区与西部坐标同样适用", async () => {
  for (const [lng, lat] of [[120, 30], [87, 44], [104, 30]]) {
    const f = fixture(lng, lat);
    const audit = await auditTrip(f.trip, undefined, f);
    assert.equal(audit.regionalSuggestion.currentMinutes, 360);
    assert.equal(audit.regionalSuggestion.travelMinutes, 30);
    assert.equal(audit.regionalSuggestion.savedMinutes, 330);
    assert.ok(audit.days.every((d) => d.needsRevision));
    assert.deepEqual(audit.regionalSuggestion.days.map((d) => d.placeIds), [["p0", "p1"], ["p2", "p3"]]);
    const quality = checkPlanQuality(f.trip, f.places, f.requirements, audit);
    assert.ok(quality.errors.some((i) => i.code === "regional_regroup"));
    assert.ok(quality.errors.some((i) => i.code === "long_transfer"));
  }
});

test("坐标分组不能冒充省时证据：河流阻隔、不通行与比较预算不足均不承诺收益", async () => {
  const f = fixture();
  for (const options of [
    { route: async (a, b) => ({ ...await f.route(a, b), minutes: 200 }) },
    { route: async (a, b) => Math.abs(a.location.lng - b.location.lng) < 0.1 ?
      { from: a.id, to: b.id, status: "unavailable" } : f.route(a, b) },
    { comparisonBudget: 1 },
  ]) {
    let calls = 0;
    const candidateRoute = options.route || f.route;
    const audit = await auditTrip(f.trip, undefined, { ...f, ...options,
      route: async (...args) => { calls++; return candidateRoute(...args); } });
    assert.equal(audit.regionalSuggestion, null);
    assert.ok(calls <= 4);
    if (options.comparisonBudget === 1) assert.equal(calls, 3);
  }
});

test("跨日分组保护固定日期、到达时间与闭馆日期，不减少必去景点", async () => {
  for (const constraint of ["fixed", "arrival", "closed"]) {
    const f = fixture();
    f.requirements.requiredPlaceIds = f.places.map((p) => p.id);
    if (constraint !== "closed") f.requirements.fixedVisits = [
      { placeId: "p2", name: "景点2", day: constraint === "fixed" ? 1 : null,
        arrival: "16:00", durationMinutes: null, durationRule: "exact" },
    ];
    else {
      f.trip.days[0].date = "2026-10-05";
      f.trip.days[1].date = "2026-10-06";
      f.places[1].openingHours = "周一闭馆";
    }
    const audit = await auditTrip(f.trip, undefined, f);
    if (constraint === "closed") assert.equal(audit.regionalSuggestion, null);
    else {
      assert.equal(audit.regionalSuggestion.days[0].placeIds[1], "p2");
      f.requirements.fixedVisits.push({ placeId: "p0", name: "景点0", day: 1,
        arrival: "09:00", durationMinutes: null, durationRule: "exact" });
      assert.equal((await auditTrip(f.trip, undefined, f)).regionalSuggestion, null);
    }
    assert.equal(f.trip.days.flatMap((d) => d.items.filter((i) => i.kind === "place")).length, 4);
  }
});

test("公交不可核验的可选推荐会被退回，必去点保留缺失证据提示", async () => {
  const f = fixture();
  const audit = await auditTrip(f.trip, undefined, { ...f, route: async (a, b) =>
    ({ from: a.id, to: b.id, status: "unavailable", message: "无路线" }) });
  assert.ok(checkPlanQuality(f.trip, f.places, f.requirements, audit).errors.some((i) => i.code === "optional_route_unverified"));
  f.requirements.requiredPlaceIds = f.places.map((p) => p.id);
  const quality = checkPlanQuality(f.trip, f.places, f.requirements, audit);
  assert.ok(!quality.errors.some((i) => i.code === "optional_route_unverified"));
  assert.ok(quality.warnings.some((i) => i.code === "route_unverified"));
});

test("长距离公路旅行和已确认的交通额度允许长途，普通自驾默认仍集中区域", async () => {
  const f = fixture();
  f.trip.preferences.transport = f.requirements.preferences.transport = "driving";
  let audit = await auditTrip(f.trip, undefined, f);
  assert.ok(checkPlanQuality(f.trip, f.places, f.requirements, audit).errors.some((i) => i.code === "travel_heavy"));
  f.requirements.routingStyle = "roadtrip";
  audit = await auditTrip(f.trip, undefined, f);
  assert.equal(audit.regionalSuggestion, null);
  assert.ok(!checkPlanQuality(f.trip, f.places, f.requirements, audit).errors.some((i) => ["long_transfer", "travel_heavy"].includes(i.code)));
  f.requirements.routingStyle = "local";
  f.requirements.maxDailyTravelMinutes = 200;
  assert.ok(!checkPlanQuality(f.trip, f.places, f.requirements, audit).errors.some((i) => ["long_transfer", "travel_heavy"].includes(i.code)));
});

test("分组不会跨固定日合并，不使用无效坐标或虚构市区中心", () => {
  const f = fixture();
  const advice = regionalAdvice(f.places, f.requirements);
  assert.deepEqual(advice.groups.map((g) => g.places.map((p) => p.id)), [["p0", "p1"], ["p2", "p3"]]);
  assert.match(advice.scope, /不是交通时间/);
  f.places[0].location.lng = NaN;
  assert.equal(groupByRegion(f.places.map((place) => ({ place })), [1, 2], f.requirements), null);
});

test("整体景区与明确的内部点不重复占站，合并保留上午且保护必去和预约", () => {
  const f = fixture();
  f.places[0].name = "某湖风景名胜区";
  f.places[2].name = "某湖风景名胜区-滨湖步道";
  const normalized = consolidateAreaStops(f.trip, f.lookup, f.requirements);
  assert.equal(normalized.removed.length, 1);
  assert.deepEqual(normalized.trip.days[0].items.map((i) => i.placeId), ["p2", null]);
  assert.equal(normalized.trip.days[0].items[0].arrival, "09:00");
  assert.equal(f.trip.days[0].items[2].arrival, "16:00");
  f.requirements.requiredPlaceIds = ["p0"];
  assert.equal(consolidateAreaStops(f.trip, f.lookup, f.requirements).removed.length, 0);
  f.requirements.requiredPlaceIds = [];
  f.requirements.fixedVisits = [{ placeId: "p0", name: "某湖风景名胜区", day: 1,
    arrival: "09:00", durationMinutes: 90, durationRule: "exact" }];
  assert.equal(consolidateAreaStops(f.trip, f.lookup, f.requirements).removed.length, 0);
  f.requirements.fixedVisits = [];
  f.places[2].category = "住宿服务";
  assert.equal(consolidateAreaStops(f.trip, f.lookup, f.requirements).removed.length, 0);
});

test("跨日景点数量改变时仍给出区域候选，未完整验证排程前不宣称省时", async () => {
  const f = fixture();
  const moved = f.trip.days[1].items.pop();
  f.trip.days[0].items.push({ ...moved, arrival: "19:00" });
  const audit = await auditTrip(f.trip, undefined, f);
  assert.equal(audit.regionalSuggestion, null);
  assert.deepEqual(audit.regionalGroups.groups.map((g) => g.places.map((p) => p.id).sort().join(",")).sort(), ["p0,p1", "p2,p3"]);
  assert.match(audit.regionalGroups.scope, /不是交通时间/);
});

test("空档较长不会误判活动过量，实际游览和交通过量仍会提醒", () => {
  const f = fixture();
  const audit = { days: f.trip.days.map((d) => ({ index: d.index, legs: [
    { from: d.items[0].placeId, to: d.items[2].placeId, status: "verified", minutes: 15 },
  ] })) };
  f.trip.days[0].items[2].arrival = "20:00";
  let quality = checkPlanQuality(f.trip, f.places, f.requirements, audit);
  assert.ok(!quality.warnings.some((i) => i.code === "active_hours"));
  f.trip.days[0].items[0].durationMinutes = 500;
  quality = checkPlanQuality(f.trip, f.places, f.requirements, audit);
  assert.ok(quality.warnings.some((i) => i.code === "active_hours"));
});

test("多次提交仍不合理的路线不会在第三次自动放行，也不会覆盖原行程", async () => {
  const f = fixture();
  const baseRoute = f.route;
  f.route = async (...args) => ({ ...await baseRoute(...args), minutes: 180 });
  let saved = 0, submissions = 0;
  const call = (name, args) => ({ role: "assistant", content: "", tool_calls: [{
    id: crypto.randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) },
  }] });
  const replies = [call("set_trip_requirements", { status: "ready", question: null, requirements: f.requirements }),
    call("search_places", { keyword: "测试景点", city: "测试市" }),
    ...Array.from({ length: 4 }, () => call("submit_itinerary", f.trip))];
  const result = await planTrip({ message: "测试市2天", history: [], preferences, existing: null, userId: "test",
    signal: new AbortController().signal, progress: () => {} }, {
    lookup: f.lookup, search: async () => f.places, route: f.route,
    audit: (trip, signal) => auditTrip(trip, signal, f), persist: () => saved++,
    complete: async (messages) => {
      if (messages.at(-1).role === "tool" && JSON.parse(messages.at(-1).content).accepted === false) submissions++;
      return replies.shift() || { role: "assistant", content: "暂未找到合理方案" };
    },
  });
  assert.equal(saved, 0);
  assert.equal(result.trip, null);
  assert.equal(submissions, 4);
  assert.match(result.reply, /同区域/);
  assert.doesNotMatch(result.reply, /哪些时间或限制可以调整/);
});

test("已核验的区域重排直接应用并保留全部必去点，不再调用AI抄写分组或摘要", async () => {
  const f = fixture();
  f.requirements.requiredPlaceIds = f.places.map((p) => p.id);
  let saved = 0, calls = 0;
  const call = (name, args) => ({ role: "assistant", content: "", tool_calls: [{
    id: crypto.randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) },
  }] });
  const replies = [call("set_trip_requirements", { status: "ready", question: null, requirements: f.requirements }),
    call("search_places", { keyword: "测试景点", city: "测试市" }), call("submit_itinerary", f.trip)];
  const result = await planTrip({ message: "测试市2天，保留所有必去点", history: [], preferences,
    existing: null, userId: "test", signal: new AbortController().signal, progress: () => {} }, {
    lookup: f.lookup, search: async () => f.places, route: f.route,
    audit: (trip, signal, options) => auditTrip(trip, signal, { ...f, ...options }), persist: () => saved++,
    complete: async () => { calls++; assert.ok(replies.length, "不应再让AI重新写已经证明可行的行程"); return replies.shift(); },
  });
  assert.equal(saved, 1);
  assert.equal(calls, 3);
  assert.deepEqual(result.trip.requirements.requiredPlaceIds, ["p0", "p1", "p2", "p3"]);
  assert.deepEqual(result.trip.days.map((d) => d.items.filter((i) => i.kind === "place").map((i) => i.placeId)), [["p0", "p1"], ["p2", "p3"]]);
  assert.equal(result.audit.days.flatMap((d) => d.legs).reduce((s, l) => s + l.minutes, 0), 30);
  assert.deepEqual(result.audit.quality.issues.filter((i) => i.severity === "error"), []);
});

test("持续查路线时预留提交轮次，强制提交仍须经过完整核验", async () => {
  const f = fixture();
  const requirements = RequirementsSchema.parse({ ...f.requirements, days: 1 });
  const candidate = { ...f.trip, days: [{ ...f.trip.days[0], items: f.trip.days[0].items.map((item) =>
    item.kind === "place" && item.placeId === "p2" ? { ...item, placeId: "p1", title: "景点1" } : item) }] };
  let phase = 0, forced = 0, queries = 0, saved = 0;
  const call = (name, args) => ({ role: "assistant", content: "", tool_calls: [{
    id: crypto.randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) },
  }] });
  const result = await planTrip({ message: "测试市1天", history: [], preferences, existing: null,
    userId: "test", signal: new AbortController().signal, progress: () => {} }, {
    lookup: f.lookup, search: async () => f.places, route: async (...args) => { queries++; return f.route(...args); },
    audit: (trip, signal) => auditTrip(trip, signal, f), persist: () => saved++,
    complete: async (messages, signal, options) => {
      if (phase++ === 0) return call("set_trip_requirements", { status: "ready", question: null, requirements });
      if (phase === 2) return call("search_places", { city: "测试市", keyword: "景点" });
      if (options?.toolChoice?.function.name === "summarize_verified_plan")
        return call("summarize_verified_plan", { summary: "同区域游览。" });
      if (options?.toolChoice?.function.name === "submit_route") {
        forced++;
        assert.equal(saved, 0);
        return call("submit_route", { days: candidate.days.map((d) => ({ index: d.index,
          visits: d.items.filter((i) => i.kind === "place").map((i) => ({ placeId: i.placeId, durationMinutes: i.durationMinutes })) })) });
      }
      return call("get_route", { fromId: "p0", toId: "p1", mode: "transit" });
    },
  });
  assert.ok(result.trip);
  assert.equal(forced, 1);
  assert.equal(queries, 1);
  assert.equal(saved, 1);
  assert.equal(result.audit.days[0].legs[0].minutes, 15);
});
