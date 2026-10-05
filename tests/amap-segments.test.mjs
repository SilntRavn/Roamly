import test from "node:test";
import assert from "node:assert/strict";
process.env.ROAMLY_DB = ":memory:";
const { config } = await import("../server/config.mjs");
const { db } = await import("../server/db.mjs");
const { routeBetween } = await import("../server/amap.mjs");
const from = { id: "from", city: "杭州市", location: { lng: 120.1, lat: 30.2, coordSystem: "GCJ-02" } };
const to = { id: "to", city: "杭州市", location: { lng: 120.2, lat: 30.3, coordSystem: "GCJ-02" } };
const transit = { duration: "600", distance: "2000", walking_distance: "100", segments: [{
  walking: { steps: [{ polyline: "120.1,30.2;120.11,30.21" }], duration: "60", distance: "100" },
  bus: { buslines: [
    { name: "地铁1号线(湘湖--机场)", type: "地铁线路", polyline: "120.11,30.21;120.2,30.3", duration: "540", distance: "1900" },
    { name: "备选路线", type: "地铁线路", polyline: "121,31;122,32", duration: "540", distance: "1900" },
  ] },
}] };

test("旧公交缓存重新核验后保存分段元数据，随后从缓存返回相同线路与当前地点ID", async () => {
  const key = JSON.stringify([from.location, to.location, "transit"]);
  db.prepare("INSERT INTO route_cache VALUES(?,?,?)").run(key, JSON.stringify({ status: "verified", mode: "transit", polyline: [[121, 31], [122, 32]] }), Date.now() + 60000);
  const originalFetch = globalThis.fetch, keys = config.amapKeys;
  let calls = 0;
  config.amapKeys = ["fixture-key"];
  globalThis.fetch = async () => { calls++; return Response.json({ status: "1", route: { transits: [transit] } }); };
  try {
    const route = await routeBetween(from, to, "transit");
    assert.equal(calls, 1);
    assert.equal(route.status, "verified");
    assert.deepEqual(route.segments.map((s) => s.mode), ["walking", "subway"]);
    assert.equal(route.segments[1].name, "1号线");
    assert.ok(route.polyline.every(([lng]) => lng < 121));
    const cached = await routeBetween({ ...from, id: "copy-from" }, { ...to, id: "copy-to" }, "transit");
    assert.equal(calls, 1);
    assert.equal(cached.from, "copy-from");
    assert.equal(cached.to, "copy-to");
    assert.deepEqual(cached.segments, JSON.parse(JSON.stringify(route.segments)));
  } finally { globalThis.fetch = originalFetch; config.amapKeys = keys; }
});
