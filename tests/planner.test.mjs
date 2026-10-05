import test from "node:test";
import assert from "node:assert/strict";
process.env.ROAMLY_DB = ":memory:";
const { planTrip, extractRequirements } = await import("../server/planner.mjs");
const { RequirementsSchema, defaultRequirements } =
  await import("../shared/requirements.mjs");
const { createGuest, saveTrip, savePlace, getTrip, getUser } =
  await import("../server/db.mjs");
const preferences = {
  pace: "relaxed",
  interests: ["文化"],
  travelers: 2,
  budget: null,
  transport: "transit",
};
const place = {
  id: "real-poi",
  name: "景山公园",
  city: "北京",
  country: "中国",
  address: "景山前街",
  location: { lng: 116.396, lat: 39.925, coordSystem: "GCJ-02" },
  photo: "",
  openingHours: null,
  price: null,
  source: { provider: "测试源", url: "", updatedAt: "now" },
};
const tool = (name, args) => ({
  role: "assistant",
  content: "",
  tool_calls: [
    {
      id: crypto.randomUUID(),
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});
const request = () => ({
  message: "北京1天，必去景山公园，10点出发",
  history: [],
  preferences,
  existing: null,
  userId: "test",
  signal: new AbortController().signal,
  progress: () => {},
});
const brief = (changes) =>
  tool("set_trip_requirements", {
    status: "ready",
    question: null,
    requirements: RequirementsSchema.parse({
      cities: ["北京"],
      days: 1,
      preferences,
      dailyStart: "10:00",
      requiredPlaces: [{ name: "景山公园", city: "北京" }],
      ...changes,
    }),
  });
const candidate = (arrival) => ({
  title: "北京慢游",
  city: "北京",
  summary: "预留半日游园",
  preferences,
  days: [
    {
      index: 1,
      date: null,
      title: "景山",
      items: [
        {
          kind: "place",
          placeId: place.id,
          title: place.name,
          arrival,
          durationMinutes: 90,
          notes: "慢慢看城市景观",
        },
      ],
    },
  ],
});
const cleanAudit = (trip) => ({
  checkedAt: "now",
  days: trip.days.map((d) => ({
    index: d.index,
    legs: [],
    warnings: [],
    conflicts: [],
    needsRevision: false,
  })),
});

test("景点核验完成即启动预加载，与最终摘要并行，不等待预加载或因其失败阻止保存", async () => {
  for (const fails of [false, true]) {
    let warmed = false, saved = false;
    const queue = [brief({}), tool("search_places", { keyword: place.name, city: "北京" }), tool("submit_itinerary", candidate("10:00"))];
    const result = await planTrip(request(), {
      complete: async () => {
        if (queue.length) return queue.shift();
        assert.equal(warmed, true);
        return tool("summarize_verified_plan", { summary: "已核验的安排。" });
      },
      search: async () => [place], lookup: () => place, audit: async (trip) => cleanAudit(trip),
      preloadPlaces: (places) => {
        assert.deepEqual(places.map((p) => p.id), [place.id]);
        warmed = true;
        if (fails) throw new Error("后台暂不可用");
        return new Promise(() => {});
      },
      persist: () => { saved = true; },
    });
    assert.equal(saved, true);
    assert.ok(result.trip);
  }
});

test("新用户使用充实节奏；午后过早结束的候选会交回AI补足再保存", async () => {
  assert.equal(getUser(createGuest()).preferences.pace, "balanced");
  const balanced = { ...preferences, pace: "balanced" };
  const otherPlace = { ...place, id: "afternoon-poi", name: "城市绿地", openingHours: "全天开放" };
  const short = { ...candidate("08:30"), preferences: balanced };
  short.days[0].items[0].durationMinutes = 180;
  short.days[0].items.push({ kind: "break", placeId: null, title: "午餐", arrival: "12:00", durationMinutes: 60, notes: "" });
  const full = structuredClone(short);
  full.days[0].items.push({ kind: "place", placeId: otherPlace.id, title: otherPlace.name,
    arrival: "15:00", durationMinutes: 120, notes: "下午继续游览" });
  const queue = [
    brief({ preferences: balanced, dailyStart: null }),
    tool("search_places", { keyword: "北京公园", city: "北京" }),
    tool("submit_itinerary", short),
    tool("submit_itinerary", full),
    tool("summarize_verified_plan", { summary: "从上午游览到17点，中间安排午餐与交通空档。" }),
  ];
  const feedback = [], saved = [];
  const result = await planTrip({ ...request(), preferences: balanced }, {
    complete: async (messages) => { feedback.push(structuredClone(messages)); return queue.shift(); },
    search: async () => [place, otherPlace],
    lookup: (id) => id === place.id ? place : otherPlace,
    audit: async (trip) => cleanAudit(trip),
    persist: (trip) => saved.push(trip),
  });
  assert.equal(saved.length, 1);
  assert.equal(result.trip.days[0].items.at(-1).arrival, "15:00");
  assert.ok(feedback.some((messages) => messages.some((m) => m.role === "tool" && m.content.includes("day_underfilled"))));
  assert.ok(!result.audit.quality.issues.some((i) => i.code === "day_underfilled"));
  const searchResult = feedback.flat().find((m) => m.role === "tool" && m.content.includes("planningRhythm"));
  assert.ok(searchResult);
});

test("需求解析后检索真实地点；违反出发时间会反馈并修正后才持久化", async () => {
  const bad = candidate("09:00");
  bad.preferences = { ...preferences, transport: "walking" };
  const queue = [
    brief({}),
    tool("search_places", { keyword: place.name, city: "北京" }),
    tool("submit_itinerary", bad),
    tool("submit_itinerary", candidate("10:00")),
    tool("summarize_verified_plan", {
      summary: "10点开始在景山慢慢游园，预留充足停留。",
    }),
  ];
  const feedback = [],
    saved = [];
  const result = await planTrip(request(), {
    complete: async (messages) => {
      feedback.push(structuredClone(messages));
      return queue.shift();
    },
    search: async () => [place],
    lookup: () => place,
    audit: async (trip) => cleanAudit(trip),
    persist: (trip) => saved.push(trip),
  });
  assert.equal(saved.length, 1);
  assert.equal(result.trip.days[0].items[0].arrival, "10:00");
  assert.equal(result.trip.requirements.dailyStart, "10:00");
  assert.ok(feedback.some((m) => JSON.stringify(m).includes("early_start")));
  assert.match(result.reply, /营业时间与预约规则未核实/);
});
test("多次修正仍违反硬要求时不保存，不覆盖原行程", async () => {
  const existing = {
    ...candidate("10:00"),
    id: "old-trip",
    createdAt: "now",
    updatedAt: "now",
  };
  existing.days[0].items[0].id = "old-item";
  existing.requirements = defaultRequirements(existing);
  let calls = 0,
    saves = 0;
  const bad = candidate("09:00");
  bad.preferences = { ...preferences, transport: "walking" };
  const result = await planTrip(
    { ...request(), existing },
    {
      complete: async () =>
        ++calls === 1
          ? brief({})
          : calls <= 5
            ? tool("submit_itinerary", bad)
            : { role: "assistant", content: "已经生成好了" },
      lookup: () => place,
      audit: async (trip) => cleanAudit(trip),
      persist: () => saves++,
    },
  );
  assert.equal(result.trip, null);
  assert.equal(saves, 0);
  assert.match(result.reply, /早于用户要求/);
  assert.equal(existing.days[0].items[0].arrival, "10:00");
});
test("缺少目的地时只询问范围，不重问已知天数，不检索或保存", async () => {
  let searches = 0;
  const result = await planTrip(request(), {
    complete: async () => brief({ cities: [] }),
    search: async () => {
      searches++;
      return [];
    },
    persist: () => assert.fail("不应保存"),
  });
  assert.equal(result.trip, null);
  assert.match(result.reply, /哪个目的地/);
  assert.doesNotMatch(result.reply, /玩几天/);
  assert.equal(searches, 0);
});

test("环线范围澄清保留具体问题，缺少天数时不重问已知地区", async () => {
  const question = "青藏大环线准备从哪里出发、在哪里结束？";
  const result = await planTrip({ ...request(), message: "青藏大环线14天" }, {
    complete: async () => tool("set_trip_requirements", { status: "clarify", question,
      requirements: RequirementsSchema.parse({ cities: [], destinationLabel: "青藏大环线", days: 14, preferences }) }),
    search: () => assert.fail("未确定线路不检索"), persist: () => assert.fail("不保存"),
  });
  assert.equal(result.reply, question);
  const missingDays = await extractRequirements({ message: "甘南自驾", preferences,
    complete: async () => brief({ cities: ["甘南藏族自治州"], destinationLabel: "甘南", days: null }) });
  assert.equal(missingDays.status, "clarify");
  assert.equal(missingDays.question, "你计划玩几天？");
});

test("解析误把景点放进行政目的地时要求修正，连续错误不进入规划", async () => {
  const invalid = { cities: ["青海湖"], destinationLabel: "青藏大环线", days: 6,
    requiredPlaces: [{ name: "青海湖", city: "海南藏族自治州" }] };
  let calls = 0;
  const parsed = await extractRequirements({ message: "青藏大环线6天，去青海湖", preferences,
    complete: async () => ++calls === 1 ? brief(invalid) : brief({ ...invalid, cities: ["海南藏族自治州"] }) });
  assert.equal(calls, 2);
  assert.deepEqual(parsed.requirements.cities, ["海南藏族自治州"]);
  await assert.rejects(extractRequirements({ message: "青藏大环线6天", preferences,
    complete: async () => brief(invalid) }), /未能理解完整需求/);
});

test("甘南6天区域自驾能经过解析、检索、选点、核验并保存，不再要求城市", async () => {
  const driving = { ...preferences, transport: "driving" };
  const pois = Array.from({ length: 6 }, (_, i) => ({ ...place, id: `gannan-${i}`, name: `测试甘南游览点${i}`,
    province: "甘肃省", city: "甘南藏族自治州", district: "夏河县",
    location: { lng: 102.5 + i * 0.01, lat: 35.2, coordSystem: "GCJ-02" } }));
  const requirements = RequirementsSchema.parse({ cities: ["甘南"], destinationLabel: "甘南", days: 6,
    preferences: driving, routingStyle: "roadtrip" });
  const queue = [tool("set_trip_requirements", { status: "ready", question: null, requirements }),
    tool("search_places_batch", { queries: pois.map((p) => ({ keyword: p.name, city: "甘南藏族自治州" })) }),
    tool("submit_route", { days: pois.map((p, i) => ({ index: i + 1, visits: [{ placeId: p.id, durationMinutes: 120 }] })) })];
  let saved = 0;
  const result = await planTrip({ ...request(), message: "甘南6天5晚自驾，夏天去", preferences: driving }, {
    complete: async () => { assert.ok(queue.length); return queue.shift(); },
    search: async (keyword, city) => { assert.equal(city, "甘南藏族自治州"); return pois.filter((p) => p.name === keyword); },
    lookup: (id) => pois.find((p) => p.id === id), audit: async (trip) => cleanAudit(trip),
    persist: () => { saved++; },
  });
  assert.equal(saved, 1);
  assert.equal(result.trip.days.length, 6);
  assert.equal(result.trip.city, "甘南");
  assert.equal(result.trip.requirements.routingStyle, "roadtrip");
  assert.deepEqual(result.audit.quality.issues.filter((i) => i.severity === "error"), []);
});

test("错误地区的候选不会保存，也不要求用户调整时间限制", async () => {
  const elsewhere = { ...place, city: "沈阳市" };
  const queue = [
    brief({}),
    tool("search_places", { keyword: place.name, city: "北京" }),
    tool("submit_itinerary", candidate("10:00")),
    { role: "assistant", content: "已经规划好了" },
  ];
  const result = await planTrip(request(), {
    complete: async () => queue.shift(),
    search: async () => [elsewhere],
    lookup: () => elsewhere,
    persist: () => assert.fail("不能保存错误地区的候选"),
  });
  assert.equal(result.trip, null);
  assert.match(result.reply, /沈阳市/);
  assert.match(result.reply, /符合目的地与景点要求/);
  assert.doesNotMatch(result.reply, /哪些时间或限制可以调整/);
});
test("取消信号到达核验后仍阻止保存", async () => {
  const controller = new AbortController();
  const queue = [
    brief({}),
    tool("search_places", { keyword: place.name, city: "北京" }),
    tool("submit_itinerary", candidate("10:00")),
  ];
  await assert.rejects(
    planTrip(
      { ...request(), signal: controller.signal },
      {
        complete: async () => queue.shift(),
        search: async () => [place],
        lookup: () => place,
        audit: async (trip) => {
          controller.abort();
          return cleanAudit(trip);
        },
        persist: () => assert.fail("取消后不应保存"),
      },
    ),
    /已取消/,
  );
});
test("规划期间手工稿已更新时拒绝用旧草稿覆盖", async () => {
  savePlace(place);
  const userId = createGuest();
  const existing = {
    ...candidate("10:00"),
    id: "race-trip",
    createdAt: "old",
    updatedAt: "old",
  };
  existing.days[0].items[0].id = "race-item";
  existing.requirements = defaultRequirements(existing);
  saveTrip(existing, userId);
  const queue = [
    brief({}),
    tool("submit_itinerary", candidate("10:00")),
    tool("summarize_verified_plan", {
      summary: "保留指定景点，10点开始慢游。",
    }),
  ];
  await assert.rejects(
    planTrip(
      { ...request(), existing, userId },
      {
        complete: async () => queue.shift(),
        lookup: () => place,
        audit: async (trip) => {
          saveTrip(
            { ...existing, title: "新的手工稿", updatedAt: "new" },
            userId,
          );
          return cleanAudit(trip);
        },
      },
    ),
    /原行程已被修改/,
  );
  assert.equal(getTrip(existing.id, userId).title, "新的手工稿");
});
