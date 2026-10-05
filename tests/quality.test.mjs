import test from "node:test";
import assert from "node:assert/strict";
import {
  RequirementsSchema,
  defaultRequirements,
  reconcileExtractedRequirements,
  reconcileManualRequirements,
} from "../shared/requirements.mjs";
import {
  checkPlanQuality,
  openingWindows,
  requirementConflicts,
} from "../server/plan-quality.mjs";
import { makeExport } from "../shared/schema.mjs";

const preferences = {
  pace: "relaxed",
  interests: ["文化"],
  travelers: 3,
  budget: null,
  transport: "transit",
};
const places = ["故宫博物院", "景山公园", "天坛公园", "颐和园"].map(
  (name, i) => ({
    id: `p${i}`,
    name,
    city: "北京市",
    country: "中国",
    address: "测试地址",
    location: { lng: 116.4 + i * 0.01, lat: 39.9, coordSystem: "GCJ-02" },
    photo: "",
    openingHours: null,
    price: null,
    source: { provider: "测试", url: "", updatedAt: "2026-10-04" },
  }),
);
const visit = (index, arrival, durationMinutes = 90) => ({
  id: `i${index}`,
  kind: "place",
  placeId: `p${index}`,
  title: places[index].name,
  arrival,
  durationMinutes,
  notes: "",
});
const base = () => ({
  id: "trip",
  title: "北京慢游",
  city: "北京",
  summary: "",
  preferences,
  createdAt: "now",
  updatedAt: "now",
  days: [
    {
      index: 1,
      date: null,
      title: "文化一日",
      items: [
        visit(0, "09:30"),
        {
          id: "meal",
          kind: "break",
          placeId: null,
          title: "午餐",
          arrival: "11:15",
          durationMinutes: 60,
          notes: "",
        },
        visit(1, "13:00"),
        visit(2, "15:00"),
      ],
    },
  ],
});
const requirements = (changes) =>
  RequirementsSchema.parse({
    cities: ["北京"],
    days: 1,
    preferences,
    requiredPlaces: [{ name: "故宫", city: "北京" }],
    ...changes,
  });

test("连续修改保留夜游意愿，明确更改晚上安排才替换", () => {
  const existing = base();
  existing.requirements = requirements({ nightTour: "prefer" });
  const extraction = { requirements: requirements({}), removals: [], replaceExisting: false };
  assert.equal(reconcileExtractedRequirements(extraction, existing, "午餐多休息一会", places).nightTour, "prefer");
  assert.equal(reconcileExtractedRequirements({ ...extraction, requirements: requirements({ nightTour: "avoid" }) },
    existing, "晚上不玩了", places).nightTour, "avoid");
});

test("完整慢游日程满足必去点、时间限制和人数", () => {
  const quality = checkPlanQuality(
    base(),
    places,
    requirements({ dailyStart: "09:30", dailyEnd: "17:00", maxDailyStops: 3 }),
  );
  assert.deepEqual(quality.errors, []);
});
for (const [name, mutate, constraints, code] of [
  [
    "遗漏指定点",
    (trip) => {
      trip.days[0].items = [visit(1, "10:00")];
    },
    {},
    "required_place",
  ],
  [
    "固定预约时间被改动",
    () => {},
    {
      fixedVisits: [
        {
          placeId: "p0",
          name: "故宫",
          day: 1,
          arrival: "10:00",
          durationMinutes: null,
        },
      ],
    },
    "fixed_visit",
  ],
  ["提前出发", () => {}, { dailyStart: "10:00" }, "early_start"],
  ["超时结束", () => {}, { dailyEnd: "16:00" }, "late_finish"],
  ["超过明确景点数量", () => {}, { maxDailyStops: 2 }, "stop_limit"],
  [
    "安排明确不想去的点",
    () => {},
    { excludedPlaces: ["天坛"] },
    "excluded_place",
  ],
  ["指定天数错误", () => {}, { days: 2 }, "day_count"],
  ["忘记出发日期", () => {}, { startDate: "2026-10-06" }, "travel_date"],
  ["忽略休息要求", () => {}, { minRestMinutes: 120 }, "rest_limit"],
  [
    "两次停留重叠",
    (trip) => {
      trip.days[0].items[1].arrival = "10:00";
    },
    {},
    "time_overlap",
  ],
  [
    "午间长行程没有午餐",
    (trip) => {
      trip.days[0].items.splice(1, 1);
    },
    {},
    "lunch_missing",
  ],
])
  test(`拒绝${name}`, () => {
    const trip = base();
    mutate(trip);
    assert.ok(
      checkPlanQuality(trip, places, requirements(constraints)).errors.some(
        (i) => i.code === code,
      ),
    );
  });
test("停车场不能因名称包含故宫而冒充必去景点", () => {
  const trip = base();
  trip.days[0].items = [visit(0, "10:00")];
  const quality = checkPlanQuality(
    trip,
    [{ ...places[0], name: "故宫停车场", category: "停车场" }],
    requirements({}),
  );
  assert.ok(quality.errors.some((i) => i.code === "auxiliary_poi"));
});
test("营业时间只解析来源明确的简单时段，复杂季节时段不猜测", () => {
  assert.deepEqual(
    openingWindows({ openingHours: "09:00-12:00;13:00-17:00" }),
    [
      [540, 720],
      [780, 1020],
    ],
  );
  assert.equal(
    openingWindows({ openingHours: "夏季09:00-18:00 冬季09:00-16:00" }),
    null,
  );
  assert.equal(openingWindows({ openingHours: "20:00-02:00" }), null);
  assert.deepEqual(
    openingWindows({ openingHours: "周一闭馆" }, "2026-10-05"),
    [],
  );
  assert.equal(
    openingWindows({ openingHours: "周一至周五开放，周六休息" }, "2026-10-09"),
    null,
  );
  assert.equal(
    openingWindows({ openingHours: "周一闭馆，节假日除外" }, "2026-10-05"),
    null,
  );
  const quality = checkPlanQuality(
    base(),
    [{ ...places[0], openingHours: "10:00-16:00" }, ...places.slice(1)],
    requirements({}),
  );
  assert.ok(quality.errors.some((i) => i.code === "opening_hours"));
});
test("名称相同也不能选错城市，指定的游览城市不能遗漏", () => {
  const trip = base();
  trip.days[0].items = [visit(0, "10:00")];
  const quality = checkPlanQuality(
    trip,
    [{ ...places[0], city: "沈阳市" }],
    requirements({}),
  );
  assert.ok(quality.errors.some((i) => i.code === "wrong_city"));
  assert.ok(quality.errors.some((i) => i.code === "missing_city"));
});
test("少走路限制依据真实接驳距离；数据缺失和无障碍不能被判定为已保证", () => {
  const audit = {
    days: [
      {
        index: 1,
        legs: [
          {
            status: "verified",
            mode: "transit",
            minutes: 30,
            walkingDistance: 900,
          },
          {
            status: "verified",
            mode: "transit",
            minutes: 25,
            walkingDistance: 800,
          },
        ],
      },
    ],
  };
  let quality = checkPlanQuality(
    base(),
    places,
    requirements({ maxWalkingMeters: 1500, maxDailyTravelMinutes: 45 }),
    audit,
  );
  assert.ok(quality.errors.some((i) => i.code === "walking_limit"));
  assert.ok(quality.errors.some((i) => i.code === "travel_limit"));
  audit.days[0].legs[0].walkingDistance = null;
  quality = checkPlanQuality(
    base(),
    places,
    requirements({ maxWalkingMeters: 1500, stepFree: true }),
    audit,
  );
  assert.ok(quality.warnings.some((i) => i.code === "walking_unverified"));
  assert.ok(
    quality.warnings.some((i) => i.code === "accessibility_unverified"),
  );
});
test("未核验路线保留显式提醒，带娃休息不足不会悄悄忽略", () => {
  const quality = checkPlanQuality(
    base(),
    places,
    requirements({ childrenAges: [5] }),
    { days: [{ index: 1, legs: [{ status: "unavailable" }] }] },
  );
  assert.ok(quality.warnings.some((i) => i.code === "route_unverified"));
  assert.ok(quality.warnings.some((i) => i.code === "family_rest"));
});
test("只改出发时间不能删除已有或手工地点，明确删除须有本轮原文证据", () => {
  const trip = base();
  trip.requirements = defaultRequirements(trip);
  const extraction = {
    requirements: requirements({}),
    removals: [{ placeId: "p0", evidence: "故宫不去了" }],
    replaceExisting: false,
  };
  let req = reconcileExtractedRequirements(
    extraction,
    trip,
    "每天10点再出发",
    places,
  );
  assert.deepEqual(req.requiredPlaceIds, ["p0", "p1", "p2"]);
  req = reconcileExtractedRequirements(extraction, trip, "故宫不去了", places);
  assert.deepEqual(req.requiredPlaceIds, ["p1", "p2"]);
  assert.equal(req.requiredPlaces.length, 0);
});
test("手工删除解除对应约束，新增地点被保留，导出包含这些约束", () => {
  const old = base();
  old.requirements = defaultRequirements(old);
  const next = base();
  next.days[0].items = [visit(1, "10:00"), visit(3, "13:00")];
  next.requirements = reconcileManualRequirements(old, next, places);
  assert.deepEqual(next.requirements.requiredPlaceIds, ["p1", "p3"]);
  assert.deepEqual(
    makeExport(next, places).itinerary.requirements.requiredPlaceIds,
    ["p1", "p3"],
  );
});
test("停留至少120分钟允许更久，但明确固定120分钟不能改为更久", () => {
  const trip = base();
  trip.days[0].items = [visit(0, "10:00", 150)];
  const fixed = {
    placeId: "p0",
    name: "故宫",
    day: 1,
    arrival: "10:00",
    durationMinutes: 120,
    durationRule: "minimum",
  };
  assert.equal(
    checkPlanQuality(trip, places, requirements({ fixedVisits: [fixed] }))
      .errors.length,
    0,
  );
  fixed.durationRule = "exact";
  assert.ok(
    checkPlanQuality(
      trip,
      places,
      requirements({ fixedVisits: [fixed] }),
    ).errors.some((i) => i.code === "fixed_visit"),
  );
});
test("无法容纳指定停留的要求可在查询景点前发现", () => {
  const conflicts = requirementConflicts(
    requirements({
      dailyStart: "09:00",
      dailyEnd: "10:00",
      fixedVisits: [
        {
          placeId: null,
          name: "故宫",
          day: null,
          arrival: null,
          durationMinutes: 120,
        },
        {
          placeId: null,
          name: "颐和园",
          day: null,
          arrival: null,
          durationMinutes: 120,
        },
      ],
    }),
  );
  assert.match(conflicts.join(""), /240 分钟.*60 分钟/);
});
test("手工编辑时间与停留会更新固定约束", () => {
  const old = base();
  old.requirements = defaultRequirements(old);
  const next = structuredClone(old);
  next.days[0].items[0].arrival = "10:00";
  next.days[0].items[0].durationMinutes = 60;
  const req = reconcileManualRequirements(old, next, places);
  assert.equal(req.fixedVisits[0].arrival, "10:00");
  assert.equal(req.fixedVisits[0].durationMinutes, 60);
});
test("不能为填满日程重复排同一地点，用户明确再访时允许", () => {
  const trip = base();
  trip.days.push({
    index: 2,
    date: null,
    title: "第二天",
    items: [visit(0, "10:00")],
  });
  const quality = checkPlanQuality(trip, places, requirements({ days: 2 }));
  assert.ok(quality.errors.some((i) => i.code === "repeated_place"));
  const allowed = checkPlanQuality(
    trip,
    places,
    requirements({ days: 2, repeatPlaces: ["故宫"] }),
  );
  assert.equal(
    allowed.errors.some((i) => i.code === "repeated_place"),
    false,
  );
});
test("交通不能重复生成休息卡或冒充休息时长", () => {
  const trip = base();
  trip.days[0].items[1].title = "自驾前往景山公园";
  const quality = checkPlanQuality(
    trip,
    places,
    requirements({ minRestMinutes: 60 }),
  );
  assert.ok(quality.errors.some((i) => i.code === "traffic_as_break"));
  assert.ok(quality.errors.some((i) => i.code === "rest_limit"));
});
