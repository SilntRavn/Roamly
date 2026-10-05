import test from "node:test";
import assert from "node:assert/strict";
process.env.ROAMLY_DB = ":memory:";
const { config } = await import("../server/config.mjs");
const { mapPlaces } = await import("../server/map-pois.mjs");
const { poiBounds, poiIcon, poiSprite, poiGroups } = await import("../shared/map-pois.mjs");

test("图标分类覆盖景点细类、餐饮和科教文化，按类别取不同图案", () => {
  for (const [category, index] of [["植物园", 5], ["博物馆", 8], ["美术馆", 9], ["科技馆", 10], ["高等院校", 11], ["动物园", 12], ["水族馆", 13], ["游乐场", 14], ["影剧院", 15], ["步行街", 17], ["餐饮服务", 18], ["咖啡厅", 19], ["茶艺馆", 20], ["快餐厅", 21], ["甜品店", 22]]) {
    assert.equal(poiIcon(category), index, category);
  }
  assert.equal(poiIcon("风景名胜", "灵隐寺"), 6);
  assert.equal(poiIcon("景点"), 0);
  assert.notDeepEqual(poiSprite(0), poiSprite(23));
  assert.deepEqual(poiSprite(24), poiSprite(23));
});
test("小范围拖动使用同一缓存范围，重复归整稳定，无效和过大范围拒绝", () => {
  const a = poiBounds({ west: 120.101, south: 30.201, east: 120.121, north: 30.221 });
  assert.deepEqual(a, poiBounds({ west: 120.102, south: 30.202, east: 120.122, north: 30.222 }));
  assert.deepEqual(a, poiBounds({ west: a[0], south: a[1], east: a[2], north: a[3] }));
  for (const bounds of [{ west: 121, east: 120, south: 30, north: 31 }, { west: 0, east: 3, south: 30, north: 31 }, { west: NaN, east: 120, south: 30, north: 31 }]) assert.throws(() => poiBounds(bounds));
});
test("三类分别采样，景点分区取样有上限、去重、保留学校；同视野和并发查询复用缓存", async (t) => {
  const oldKeys = config.amapKeys;
  config.amapKeys = ["test-key"];
  t.after(() => { config.amapKeys = oldKeys; });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(url);
    assert.equal(url.pathname, "/v3/place/around");
    assert.equal(url.searchParams.get("sortrule"), "weight");
    assert.ok(Number(url.searchParams.get("radius")) <= 50000);
    assert.equal(url.searchParams.get("offset"), "25");
    const group = poiGroups.indexOf(url.searchParams.get("types"));
    const page = url.searchParams.get("page");
    const poi = (i, type = "风景名胜;公园") => ({ id: `g${group}-${url.searchParams.get("location")}-${page}-${i}`, name: `测试地点${i}`, type, location: "120.12,30.22", cityname: "杭州市", pname: "浙江省", adname: "西湖区" });
    const sample = poi(0, group === 1 ? "科教文化服务;学校" : "餐饮服务;咖啡厅");
    return { json: async () => ({ status: "1", count: group === 0 ? "100" : "2", pois: group === 0 ? Array.from({ length: 25 }, (_, i) => poi(i, i === 0 ? "停车场" : "风景名胜;公园")) : [sample, sample] }) };
  });
  const bounds = { west: 120.1, south: 30.2, east: 120.14, north: 30.24 };
  const [a, b] = await Promise.all([mapPlaces(bounds), mapPlaces(bounds)]);
  assert.deepEqual(a, b);
  assert.equal(calls.length, 5);
  assert.equal(a.length, 74);
  assert.ok(a.some((p) => p.category === "学校"));
  assert.ok(!a.some((p) => p.category === "停车场"));
  assert.deepEqual(await mapPlaces(bounds), a);
  assert.equal(calls.length, 5);
  await assert.rejects(mapPlaces({ ...bounds, east: 119 }), { status: 400 });
  assert.equal(calls.length, 5);
});
