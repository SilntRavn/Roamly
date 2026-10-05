import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRouteSegments, parsePolyline } from "../shared/route-segments.mjs";
import { mapRoutes, routeStyle, metroColor, pointAlong } from "../src/route-symbols.mjs";

const walk = { steps: [{ polyline: "120.1,30.2;120.11,30.21" }], distance: "350", duration: "240" };
const rail = { name: "地铁1号线(湘湖--萧山国际机场)", type: "地铁线路", id: "metro-1", polyline: "120.11,30.21;120.12,30.22", distance: "1900", duration: "300",
  departure_stop: { name: "龙翔桥", location: "120.11,30.21" }, arrival_stop: { name: "城站", location: "120.12,30.22" }, via_stops: [] };

test("换乘路段保留步行、地铁、公交顺序与站点，不把同一路段的备选公交画进路线", () => {
  const segments = normalizeRouteSegments({ segments: [
    { walking: walk, bus: { buslines: [rail, { ...rail, name: "备选线路", polyline: "121,31;122,32" }] } },
    { bus: { buslines: [{ ...rail, name: "7路(城站--灵隐)", type: "普通公交" }] } },
    { walking: walk },
  ] }, "transit", "杭州市");
  assert.deepEqual(segments.map((s) => s.mode), ["walking", "subway", "bus", "walking"]);
  assert.equal(segments[1].name, "1号线");
  assert.equal(segments[1].departureStop, "龙翔桥");
  assert.equal(segments[1].arrivalStop, "城站");
  assert.equal(segments[1].minutes, 5);
  assert.equal(segments[1].stops.length, 2);
  assert.ok(segments.every((s) => s.polyline.every(([lng]) => lng < 121)));
});

test("地铁配色按城市匹配，线路数字相同也不会混用；缺失配色使用稳定默认色", () => {
  assert.equal(metroColor("杭州市", rail.name), "#FC0601");
  assert.notEqual(metroColor("上海", "1号线"), metroColor("杭州", "1号线"));
  assert.equal(metroColor("未知城市", "1号线"), undefined);
  const base = { name: "未知线", polyline: [] };
  assert.equal(routeStyle({ ...base, mode: "subway", city: "未知城市" }).color, "#75638D");
  assert.equal(routeStyle({ ...base, mode: "bus", color: "#123456" }).color, "#123456");
  assert.equal(routeStyle({ ...base, mode: "bus", color: "invalid" }).color, "#B47724");
});

test("各出行方式除颜色外还有线型区别，旧公共交通数据不会被冒充成某条地铁", () => {
  const segment = { name: "路线", polyline: [] };
  assert.deepEqual(routeStyle({ ...segment, mode: "walking" }).dash, [2, 8]);
  assert.deepEqual(routeStyle({ ...segment, mode: "bus" }).dash, [12, 5]);
  assert.equal(routeStyle({ ...segment, mode: "driving" }).directions, true);
  const routes = mapRoutes({ days: [{ index: 1, legs: [{ status: "verified", mode: "transit", from: "a", to: "b", polyline: [[120, 30], [120.1, 30.1]] }] }] }, []);
  assert.equal(routes[0].mode, "transit");
  assert.equal(routes[0].name, "公共交通");
});

test("两种地图共用核验状态筛选与分段几何，不画失败路线或无效坐标", () => {
  const valid = { mode: "walking", name: "步行", polyline: [[120, 30], [120.1, 30.1]] };
  const routes = mapRoutes({ days: [{ index: 1, legs: [
    { status: "unavailable", polyline: valid.polyline },
    { status: "verified", from: "a", to: "b", segments: [valid, { ...valid, polyline: [[NaN, 30], [120, 30]] }] },
  ] }] }, []);
  assert.equal(routes.length, 1);
  assert.deepEqual(routes[0].polyline, valid.polyline);
  assert.deepEqual(parsePolyline("120,30;NaN,31;181,30;120;120,,30;,30;121,31"), [[120, 30], [121, 31]]);
});

test("未核验连接明确标为景点顺序，路线标签沿实际折线长度定位", () => {
  const points = ["a", "b"].map((id, i) => ({ id, location: { lng: 120 + i, lat: 30 } }));
  assert.equal(mapRoutes(null, points)[0].mode, "planned");
  const middle = pointAlong([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 300 }]);
  assert.equal(middle.x, 100);
  assert.equal(middle.y, 100);
  assert.equal(middle.angle, 90);
});
