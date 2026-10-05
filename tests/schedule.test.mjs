import test from "node:test";
import assert from "node:assert/strict";
import { RequirementsSchema } from "../shared/requirements.mjs";
import { repairTripTimes } from "../server/schedule.mjs";
import { checkPlanQuality } from "../server/plan-quality.mjs";
import { contiguousTravelMinutes } from "../server/route-quality.mjs";
const preferences = {
  pace: "relaxed",
  travelers: 2,
  budget: null,
  transport: "driving",
  interests: ["文化"],
};
const places = ["总统府", "南京博物院"].map((name, i) => ({
  id: `p${i}`,
  name,
  city: "南京",
  openingHours: "09:00-17:00",
}));
const trip = () => ({
  preferences,
  city: "南京",
  days: [
    {
      index: 1,
      date: null,
      items: [
        {
          id: "a",
          kind: "place",
          placeId: "p0",
          title: "总统府",
          arrival: "10:00",
          durationMinutes: 120,
        },
        {
          id: "lunch",
          kind: "break",
          placeId: null,
          title: "午餐",
          arrival: "12:00",
          durationMinutes: 60,
        },
        {
          id: "b",
          kind: "place",
          placeId: "p1",
          title: "南京博物院",
          arrival: "13:00",
          durationMinutes: 210,
        },
      ],
    },
  ],
});
const req = (changes) =>
  RequirementsSchema.parse({
    cities: ["南京"],
    days: 1,
    preferences,
    fixedVisits: [
      {
        placeId: "p0",
        name: "总统府",
        day: 1,
        arrival: "10:00",
        durationMinutes: 120,
      },
    ],
    ...changes,
  });
const audit = {
  days: [
    {
      index: 1,
      legs: [
        {
          status: "verified",
          from: "p0",
          to: "p1",
          itemFrom: "a",
          itemTo: "b",
          mode: "driving",
          minutes: 35,
          distance: 8000,
        },
      ],
    },
  ],
};
test("保留固定预约和午餐，为真实交通另留时间并适应闭馆", () => {
  const original = trip();
  const repaired = repairTripTimes(original, req({}), places, audit);
  assert.equal(repaired.days[0].items[0].arrival, "10:00");
  assert.equal(repaired.days[0].items[0].durationMinutes, 120);
  assert.equal(repaired.days[0].items[1].durationMinutes, 60);
  assert.equal(repaired.days[0].items[2].arrival, "13:45");
  assert.equal(repaired.days[0].items[2].durationMinutes, 195);
  assert.deepEqual(checkPlanQuality(repaired, places, req({})).errors, []);
  assert.equal(original.days[0].items[2].arrival, "13:00");
});
test("不能为了容纳交通而移动固定预约或缩短明确停留", () => {
  const requirements = req({
    fixedVisits: [
      ...req({}).fixedVisits,
      {
        placeId: "p1",
        name: "南京博物院",
        day: 1,
        arrival: "13:00",
        durationMinutes: 210,
      },
    ],
  });
  assert.equal(repairTripTimes(trip(), requirements, places, audit), null);
});
test("弹性空档可以前移，但每日结束限制和至少停留要求仍须满足", () => {
  const original = trip();
  original.days[0].items[2].arrival = "16:00";
  const repaired = repairTripTimes(original, req({}), places, audit);
  assert.equal(repaired.days[0].items[2].arrival, "13:45");
  const requirements = req({
    dailyEnd: "15:00",
    fixedVisits: [
      ...req({}).fixedVisits,
      {
        placeId: "p1",
        name: "南京博物院",
        day: 1,
        arrival: null,
        durationMinutes: 120,
        durationRule: "minimum",
      },
    ],
  });
  assert.equal(repairTripTimes(original, requirements, places, audit), null);
});

test("整天协调能解决贪心后推撞闭馆的情况，旧核验冲突不会否定已修正空档", () => {
  const original = trip();
  original.days[0].items[0].durationMinutes = 180;
  original.days[0].items[1].arrival = "13:00";
  original.days[0].items[2].arrival = "14:00";
  original.days[0].items[2].durationMinutes = 180;
  const source = places.map((p) => ({ ...p, openingHours: "09:00-16:00" }));
  const actual = structuredClone(audit);
  actual.days[0].legs[0].minutes = 80;
  actual.days[0].conflicts = [{ code: "travel_time", message: "旧草稿未留交通空档" }];
  const requirements = req({ fixedVisits: [], dailyEnd: "16:00" });
  const repaired = repairTripTimes(original, requirements, source, actual);
  assert.ok(repaired);
  assert.deepEqual(repaired.days[0].items.map((i) => i.placeId), ["p0", null, "p1"]);
  assert.deepEqual(checkPlanQuality(repaired, source, requirements).errors, []);
  const [from, meal, to] = repaired.days[0].items;
  assert.equal(meal.durationMinutes, 60);
  assert.ok(from.durationMinutes >= 108 && to.durationMinutes >= 108);
  assert.ok(contiguousTravelMinutes(repaired.days[0], from, to) >= 80);
  assert.equal(original.days[0].items[0].arrival, "10:00");
  requirements.fixedVisits = source.map((p) => ({ placeId: p.id, name: p.name,
    day: 1, arrival: null, durationMinutes: 180, durationRule: "minimum" }));
  assert.equal(repairTripTimes(original, requirements, source, actual), null);
});
