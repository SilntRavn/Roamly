import test from "node:test";
import assert from "node:assert/strict";
process.env.ROAMLY_DB = ":memory:";
const { normalizePoi, searchPlaces } = await import("../server/amap.mjs");
const { db } = await import("../server/db.mjs");
const { config } = await import("../server/config.mjs");
const { matchesDestination, matchesPlace, RequirementsSchema } = await import("../shared/requirements.mjs");
const { PlaceSchema, makeExport, FileSchema } = await import("../shared/schema.mjs");
const { checkPlanQuality } = await import("../server/plan-quality.mjs");
const { demoTrip } = await import("../server/seed.mjs");

const rawPoi = {
  id: "linan-poi", name: "大明山风景区", location: "119.002,30.03",
  pname: "浙江省", cityname: "杭州市", adname: "临安区", address: "测试地址",
};
const place = normalizePoi(rawPoi);

test("高德区县归属用于临安目的地校验，不将临安扩大成全杭州", () => {
  assert.equal(place.province, "浙江省");
  assert.equal(place.district, "临安区");
  for (const destination of ["临安", "临安区", "临安市", "杭州", "杭州市", "杭州临安", "杭州市临安区", "浙江省杭州市临安区", "浙江", "浙江省"])
    assert.equal(matchesDestination(place, destination), true, destination);
  for (const destination of ["西湖区", "湖州", "江苏", "苏州市临安区"])
    assert.equal(matchesDestination(place, destination), false, destination);
  assert.equal(matchesDestination({ ...place, district: "西湖区" }, "临安"), false);
  assert.equal(matchesPlace(place, { name: "大明山", city: "临安" }), true);
  assert.equal(matchesPlace({ ...place, district: "西湖区" }, { name: "大明山", city: "临安" }), false);
});

test("自治州、地区和自治区使用来源行政字段匹配简称，不能靠任意前缀或景点名称猜测", () => {
  const fixtures = [
    [{ province: "甘肃省", city: "甘南藏族自治州", district: "夏河县" }, ["甘南", "甘南藏族自治州", "甘肃甘南", "甘肃省甘南藏族自治州", "夏河"], ["甘", "临夏", "青海", "兰州"]],
    [{ province: "四川省", city: "甘孜藏族自治州", district: "稻城县" }, ["甘孜", "稻城", "四川"], ["甘南", "阿坝", "成都"]],
    [{ province: "西藏自治区", city: "阿里地区", district: "普兰县" }, ["西藏", "西藏自治区", "阿里", "阿里地区"], ["西", "青海", "拉萨"]],
    [{ province: "新疆维吾尔自治区", city: "伊犁哈萨克自治州", district: "特克斯县" }, ["新疆", "伊犁", "特克斯"], ["伊", "乌鲁木齐", "青海"]],
    [{ province: "内蒙古自治区", city: "阿拉善盟", district: "阿拉善左旗" }, ["内蒙古", "阿拉善"], ["内", "蒙古", "青海"]],
    [{ province: "广西壮族自治区", city: "桂林市", district: "阳朔县" }, ["广西", "桂林", "阳朔"], ["广", "广东", "南宁"]],
  ];
  for (const [poi, included, excluded] of fixtures) {
    for (const destination of included) assert.equal(matchesDestination(poi, destination), true, destination);
    for (const destination of excluded) assert.equal(matchesDestination(poi, destination), false, destination);
  }
  assert.equal(matchesDestination({ city: "兰州市", name: "甘南旅游服务中心", address: "甘南" }, "甘南"), false);
  assert.equal(matchesDestination({ city: "西宁市", province: "青海省" }, "青藏大环线"), false);
});

test("甘南必去点与省域环线可通过范围校验，域外地点仍拒绝，线路名不替代行政范围", () => {
  const preferences = { ...demoTrip.preferences, transport: "driving" };
  const poi = { ...place, id: "gannan", name: "测试游览点", province: "甘肃省", city: "甘南藏族自治州", district: "夏河县" };
  const trip = { ...demoTrip, city: "甘南", preferences, days: [{ index: 1, date: null, title: "甘南", items: [{
    id: "visit", kind: "place", placeId: poi.id, title: poi.name, arrival: "09:00", durationMinutes: 120, notes: "",
  }] }] };
  const requirements = RequirementsSchema.parse({ cities: ["甘南"], destinationLabel: "甘南", days: 1, preferences,
    requiredPlaces: [{ name: poi.name, city: "甘南" }], dayDestinations: [{ day: 1, destination: "甘南" }] });
  assert.deepEqual(checkPlanQuality(trip, [poi], requirements).errors, []);
  const outside = checkPlanQuality(trip, [{ ...poi, city: "临夏回族自治州" }], requirements);
  for (const code of ["wrong_city", "missing_city", "required_place", "day_destination"])
    assert.ok(outside.errors.some((i) => i.code === code), code);
  const routeRequirements = RequirementsSchema.parse({ cities: ["青海省", "西藏自治区"], destinationLabel: "青藏大环线", days: 2, preferences });
  const routePlaces = [{ ...poi, id: "qinghai", province: "青海省", city: "西宁市" }, { ...poi, id: "tibet", province: "西藏自治区", city: "拉萨市" }];
  const routeTrip = { ...trip, city: "青藏大环线", requirements: routeRequirements, days: routePlaces.map((p, i) => ({
    ...trip.days[0], index: i + 1, items: [{ ...trip.days[0].items[0], id: `visit-${i}`, placeId: p.id }],
  })) };
  assert.deepEqual(checkPlanQuality(routeTrip, routePlaces, routeRequirements).errors, []);
  assert.equal(makeExport(routeTrip, routePlaces).itinerary.requirements.destinationLabel, "青藏大环线");
  const offRoute = checkPlanQuality(routeTrip, routePlaces.map((p) => ({ ...p, province: "甘肃省", city: "兰州市" })), routeRequirements);
  assert.ok(offRoute.errors.some((i) => i.code === "wrong_city"));
  assert.equal(offRoute.errors.filter((i) => i.code === "missing_city").length, 2);
});

test("县、县级市与所属城市按来源字段识别，缺失区县资料不猜测", () => {
  for (const [city, district, destination] of [["桂林市", "阳朔县", "阳朔"], ["金华市", "义乌市", "义乌"], ["成都市", "都江堰市", "都江堰"]])
    assert.equal(matchesDestination({ city, district }, destination), true);
  assert.equal(matchesDestination({ city: "杭州市", name: "临安景区", address: "临安区" }, "临安"), false);
  assert.equal(matchesDestination({ city: "石家庄市", district: "长安区" }, "西安市长安区"), false);
});

test("临安行程的必去景点与目的地通过，杭州其他区仍被拒绝", () => {
  const preferences = { ...demoTrip.preferences, transport: "driving" };
  const trip = { ...demoTrip, preferences, days: [{ index: 1, date: null, title: "临安", items: [{
    id: "visit", kind: "place", placeId: place.id, title: place.name,
    arrival: "09:00", durationMinutes: 120, notes: "",
  }] }] };
  const requirements = RequirementsSchema.parse({ cities: ["临安"], days: 1, preferences, requiredPlaces: [{ name: "大明山", city: "临安" }] });
  const quality = checkPlanQuality(trip, [place], requirements);
  assert.deepEqual(quality.errors, []);
  const outside = checkPlanQuality(trip, [{ ...place, district: "西湖区" }], requirements);
  for (const code of ["wrong_city", "missing_city", "required_place"])
    assert.ok(outside.errors.some((error) => error.code === code), code);
  const exported = makeExport(trip, [place]);
  assert.equal(FileSchema.parse(exported).places[0].district, "临安区");
  const { province, district, ...legacy } = place;
  assert.equal(PlaceSchema.parse(legacy).district, "");
});

test("旧 POI 缓存缺少区县时重新查询，后续使用含区县的缓存", async () => {
  const keyword = "临安缓存回归";
  const { province, district, ...legacy } = place;
  db.prepare("INSERT INTO search_cache VALUES(?,?,?)").run(JSON.stringify([keyword, "临安"]), JSON.stringify([legacy]), Date.now() + 60000);
  const originalFetch = globalThis.fetch;
  const originalKeys = config.amapKeys;
  config.amapKeys = ["test-key"];
  let queries = 0;
  globalThis.fetch = async () => {
    queries++;
    return { json: async () => ({ status: "1", pois: [rawPoi] }) };
  };
  try {
    assert.equal((await searchPlaces(keyword, "临安"))[0].district, "临安区");
    assert.equal((await searchPlaces(keyword, "临安"))[0].district, "临安区");
    assert.equal(queries, 1);
  } finally {
    globalThis.fetch = originalFetch;
    config.amapKeys = originalKeys;
  }
});
