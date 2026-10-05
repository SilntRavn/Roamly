import test from "node:test";
import assert from "node:assert/strict";
process.env.ROAMLY_DB = ":memory:";
const { db, savePlace } = await import("../server/db.mjs");
const { auditTrip, routeBetween } = await import("../server/amap.mjs");
const { demoTrip, demoPlaces } = await import("../server/seed.mjs");
const from = savePlace({
  ...demoPlaces[0],
  id: "test-a",
  name: "景点甲",
  city: "杭州",
  location: { lng: 120.14, lat: 30.25, coordSystem: "GCJ-02" },
});
const to = savePlace({
  ...demoPlaces[1],
  id: "test-b",
  name: "景点乙",
  city: "杭州",
  location: { lng: 120.15, lat: 30.23, coordSystem: "GCJ-02" },
});
const key = JSON.stringify([from.location, to.location, "walking"]);
db.prepare("INSERT INTO route_cache VALUES(?,?,?)").run(
  key,
  JSON.stringify({
    from: from.id,
    to: to.id,
    mode: "walking",
    status: "verified",
    minutes: 30,
    distance: 2200,
    polyline: [],
  }),
  Date.now() + 60000,
);
test("路线核验扣除午餐时间，避免把休息时间当成交通时间", async () => {
  const trip = {
    ...demoTrip,
    preferences: { ...demoTrip.preferences, transport: "walking" },
    days: [
      {
        index: 1,
        date: null,
        title: "测试",
        items: [
          {
            id: "a",
            kind: "place",
            placeId: from.id,
            title: from.name,
            arrival: "09:00",
            durationMinutes: 90,
          },
          {
            id: "lunch",
            kind: "break",
            placeId: null,
            title: "午餐",
            arrival: "10:30",
            durationMinutes: 60,
          },
          {
            id: "b",
            kind: "place",
            placeId: to.id,
            title: to.name,
            arrival: "11:30",
            durationMinutes: 90,
          },
        ],
      },
    ],
  };
  const audit = await auditTrip(trip);
  assert.equal(audit.days[0].needsRevision, true);
  assert.match(audit.days[0].warnings.join(""), /仅预留 0 分钟/);
  trip.days[0].items[2].arrival = "12:00";
  const corrected = await auditTrip(trip);
  assert.equal(corrected.days[0].needsRevision, false);
  assert.equal(corrected.days[0].warnings.length, 0);
});
test("单景点日程也会检测停留时间重叠", async () => {
  const audit = await auditTrip({
    ...demoTrip,
    days: [
      {
        index: 1,
        date: null,
        title: "测试",
        items: [
          {
            id: "a",
            kind: "place",
            placeId: from.id,
            title: from.name,
            arrival: "09:00",
            durationMinutes: 120,
          },
          {
            id: "rest",
            kind: "break",
            placeId: null,
            title: "休息",
            arrival: "10:00",
            durationMinutes: 30,
          },
        ],
      },
    ],
  });
  assert.equal(audit.days[0].needsRevision, true);
  assert.match(audit.days[0].warnings[0], /重叠/);
});

test("坐标相同的导入副本使用缓存时仍返回本次地点ID", async () => {
  const route = await routeBetween(
    { ...from, id: "import-a" },
    { ...to, id: "import-b" },
    "walking",
  );
  assert.equal(route.from, "import-a");
  assert.equal(route.to, "import-b");
});

test("零散空档总时长足够但无法连续赶路时仍检测冲突", async () => {
  const items = [
    {
      id: "a",
      kind: "place",
      placeId: from.id,
      title: from.name,
      arrival: "09:00",
      durationMinutes: 60,
    },
    {
      id: "rest",
      kind: "break",
      title: "午餐",
      arrival: "10:15",
      durationMinutes: 90,
    },
    {
      id: "b",
      kind: "place",
      placeId: to.id,
      title: to.name,
      arrival: "12:00",
      durationMinutes: 60,
    },
  ];
  const audit = await auditTrip({
    ...demoTrip,
    preferences: { ...demoTrip.preferences, transport: "walking" },
    days: [{ index: 1, date: null, items }],
  });
  assert.ok(audit.days[0].conflicts.some((c) => c.code === "travel_time"));
  assert.match(audit.days[0].warnings.join(""), /仅预留 15 分钟/);
});

test("超过24段的长行程不会静默停止核验", async () => {
  let calls = 0;
  const trip = {
    ...demoTrip,
    preferences: { ...demoTrip.preferences, transport: "driving" },
    days: Array.from({ length: 14 }, (_, d) => ({
      index: d + 1,
      date: null,
      items: [0, 1, 2].map((i) => ({
        id: `${d}-${i}`,
        kind: "place",
        placeId: `p${i}`,
        title: `点${i}`,
        arrival: `${9 + i * 3}:00`.padStart(5, "0"),
        durationMinutes: 60,
      })),
    })),
  };
  const audit = await auditTrip(trip, undefined, {
    compare: false,
    lookup: (id) => ({ ...from, id }),
    route: async (a, b) => {
      calls++;
      return {
        from: a.id,
        to: b.id,
        status: "verified",
        mode: "driving",
        minutes: 30,
        distance: 1000,
      };
    },
  });
  assert.equal(calls, 28);
  assert.equal(audit.days.flatMap((d) => d.legs).length, 28);
});

test("绕路顺序的改进必须由真实算路比较证明，固定时间点不得移位", async () => {
  const places = [0, 2, 1].map((position, i) => ({
    ...from,
    id: `order-${i}`,
    name: `测试点${i}`,
    location: { lng: 120 + position * 0.01, lat: 30, coordSystem: "GCJ-02" },
  }));
  const items = places.map((p, i) => ({
    id: p.id,
    placeId: p.id,
    kind: "place",
    title: p.name,
    arrival: `${9 + i * 3}:00`.padStart(5, "0"),
    durationMinutes: 60,
  }));
  const trip = { ...demoTrip, days: [{ index: 1, date: null, items }] };
  const lookup = (id) => places.find((p) => p.id === id);
  const route = async (a, b) => ({
    from: a.id,
    to: b.id,
    status: "verified",
    mode: "transit",
    minutes: Math.round(Math.abs(a.location.lng - b.location.lng) * 3000),
    distance: Math.abs(a.location.lng - b.location.lng) * 100000,
  });
  const audit = await auditTrip(trip, undefined, { lookup, route });
  assert.equal(audit.days[0].orderSuggestion.savedMinutes, 30);
  assert.equal(audit.days[0].orderSuggestion.travelMinutes, 60);
  trip.requirements = {
    fixedVisits: places.map((p, i) => ({
      placeId: p.id,
      name: p.name,
      day: 1,
      arrival: items[i].arrival,
      durationMinutes: null,
    })),
  };
  const fixed = await auditTrip(trip, undefined, { lookup, route });
  assert.equal(fixed.days[0].orderSuggestion, null);
});

test("交通总量较少但赶不上固定预约的顺序不能作为强制调整建议", async () => {
  const places = [0, 1, 2].map((position) => ({ ...from, id: `pin-${position}`, name: `点${position}`,
    openingHours: "09:00-17:00", location: { lng: 120 + position * 0.01, lat: 30, coordSystem: "GCJ-02" } }));
  const arrivals = ["09:00", "10:30", "13:00"];
  const trip = { ...demoTrip, requirements: { dailyStart: "09:00", fixedVisits: [{
    placeId: "pin-1", name: "点1", day: 1, arrival: "10:30", durationMinutes: 60,
  }] }, days: [{ index: 1, date: null, items: places.map((p, i) => ({ id: p.id, placeId: p.id,
    kind: "place", title: p.name, arrival: arrivals[i], durationMinutes: 60 })) }] };
  const times = { "pin-0:pin-1": 15, "pin-1:pin-2": 80, "pin-2:pin-1": 50, "pin-1:pin-0": 5 };
  const audit = await auditTrip(trip, undefined, { lookup: (id) => places.find((p) => p.id === id),
    route: async (a, b) => ({ from: a.id, to: b.id, mode: "transit", status: "verified",
      minutes: times[`${a.id}:${b.id}`] ?? 300, distance: 1000 }) });
  assert.equal(audit.days[0].orderSuggestion, null);
  assert.deepEqual(audit.days[0].conflicts, []);
});
