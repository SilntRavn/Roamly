import test from "node:test";
import assert from "node:assert/strict";
process.env.ROAMLY_DB = ":memory:";
const { resolvePlace, normalizePoi } = await import("../server/amap.mjs");
const { savePlace, getPlace } = await import("../server/db.mjs");
const { config } = await import("../server/config.mjs");
const raw = (id) => ({ id, name: "底图测试景点", location: "120.14,30.25", pname: "浙江省", cityname: "杭州市", adname: "西湖区", address: "测试地址", photos: [{ url: "https://images.example.com/place.jpg" }] });
function mock(t, fetch) {
  const previous = config.amapKeys;
  config.amapKeys = ["test-key"];
  t.after(() => { config.amapKeys = previous; });
  t.mock.method(globalThis, "fetch", fetch);
}
test("未知底图景点按精确 ID 查询并保存；再次点击直接使用缓存", async (t) => {
  let calls = 0;
  mock(t, async (url) => {
    calls++;
    assert.equal(url.pathname, "/v3/place/detail");
    assert.equal(url.searchParams.get("id"), "new-poi");
    assert.equal(url.searchParams.get("extensions"), "all");
    return { json: async () => ({ status: "1", pois: [raw("new-poi")] }) };
  });
  const place = await resolvePlace("amap-new-poi");
  assert.equal(place.name, "底图测试景点");
  assert.equal(place.location.coordSystem, "GCJ-02");
  assert.equal(place.photo, "https://images.example.com/place.jpg");
  assert.deepEqual(getPlace(place.id), place);
  assert.deepEqual(await resolvePlace(place.id), place);
  assert.equal(calls, 1);
});
test("已有景点的介绍与本地景点均直接复用，不重新查询", async (t) => {
  mock(t, async () => { throw new Error("不应请求高德"); });
  const place = { ...normalizePoi(raw("existing")), overview: "已经保存的景点介绍" };
  savePlace(place);
  savePlace({ ...place, id: "local-existing" });
  assert.equal((await resolvePlace(place.id)).overview, place.overview);
  assert.equal((await resolvePlace("local-existing")).overview, place.overview);
});
test("并发点击同一新景点合并为一次高德查询", async (t) => {
  let calls = 0, release;
  mock(t, () => { calls++; return new Promise((resolve) => { release = () => resolve({ json: async () => ({ status: "1", pois: [raw("shared")] }) }); }); });
  const first = resolvePlace("amap-shared"), second = resolvePlace("amap-shared");
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
});
test("无效 ID、本地不存在的 ID 不调用高德", async (t) => {
  mock(t, async () => { throw new Error("不应请求高德"); });
  for (const id of ["missing", "amap-", "amap-../secret", `amap-${"a".repeat(65)}`])
    await assert.rejects(resolvePlace(id), { status: 404 });
});
test("高德返回其他点位时拒绝使用，失败请求不阻止后续重试", async (t) => {
  let calls = 0;
  mock(t, async () => ({ json: async () => ({ status: "1", pois: [raw(++calls === 1 ? "wrong" : "retry")] }) }));
  await assert.rejects(resolvePlace("amap-retry"), { status: 404 });
  assert.equal(getPlace("amap-retry"), null);
  assert.equal((await resolvePlace("amap-retry")).id, "amap-retry");
  assert.equal(calls, 2);
});
