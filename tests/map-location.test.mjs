import test from "node:test";
import assert from "node:assert/strict";
import { locateMap } from "../src/map-location.mjs";

test("浏览器定位成功后转换GPS坐标，精确位置不使用网络兜底", async () => {
  const result = await locateMap({ geolocation: { getCurrentPosition(ok, fail, options) {
    assert.equal(options.enableHighAccuracy, true);
    ok({ coords: { longitude: 120, latitude: 30, accuracy: 20 } });
  } }, convert: async (point) => { assert.deepEqual(point, { lng: 120, lat: 30 }); return { lng: 120.004, lat: 29.997 }; } });
  assert.deepEqual(result, { lng: 120.004, lat: 29.997, approximate: false, city: false });
});
test("浏览器无法提供位置时使用高德，网络位置明确标为大致位置且不重复偏移", async () => {
  const result = await locateMap({ geolocation: { getCurrentPosition(ok, fail) { fail({ code: 2 }); } }, AMap: {
    plugin(name, ready) { assert.equal(name, "AMap.Geolocation"); ready(); },
    Geolocation: class {
      constructor(options) { assert.equal(options.GeoLocationFirst, false); assert.equal(options.noIpLocate, 0); }
      getCurrentPosition(callback) { callback("complete", { position: { lng: 120.1, lat: 30.2 }, location_type: "ip", isConverted: true }); }
    },
  }, convert: async () => { throw new Error("MustNotConvertTwice"); } });
  assert.deepEqual(result, { lng: 120.1, lat: 30.2, approximate: true, city: false });
});
test("用户拒绝定位权限时不继续备用定位", async () => {
  let fallback = false;
  const options = { geolocation: { getCurrentPosition(ok, fail) { fail({ code: 1 }); } }, AMap: { plugin() { fallback = true; } } };
  await assert.rejects(locateMap(options), /权限被拒绝/);
  assert.equal(fallback, false);
});
test("HTTP生产地址跳过受限的浏览器定位，使用城市网络定位且不冒充精确位置", async () => {
  const result = await locateMap({ secure: false, geolocation: { getCurrentPosition() { throw new Error("MustNotRequestGPSOverHTTP"); } }, AMap: {
    plugin(name, ready) { assert.equal(name, "AMap.Geolocation"); ready(); },
    Geolocation: class {
      getCurrentPosition() { throw new Error("MustNotRequestHTML5Fallback"); }
      getCityInfo(done) { done("complete", { position: { lng: 120.1, lat: 30.2 } }); }
    },
  }, convert: async () => { throw new Error("MustNotConvertCity"); } });
  assert.deepEqual(result, { lng: 120.1, lat: 30.2, approximate: true, city: true });
  await assert.rejects(locateMap({ secure: false }), /网络定位暂不可用/);
});
test("精确IP定位不可用时退回城市定位，城市中心不能标为当前位置", async () => {
  const result = await locateMap({ AMap: {
    plugin(name, ready) { ready(); },
    Geolocation: class {
      getCurrentPosition(done) { done("error", { info: "INVALID_USER" }); }
      getCityInfo(done) { done("complete", { position: [120.1, 30.2] }); }
    },
  }, convert: async () => { throw new Error("MustNotConvertCity"); } });
  assert.deepEqual(result, { lng: 120.1, lat: 30.2, approximate: true, city: true });
});
test("高德插件失联和服务错误会结束请求，非法定位坐标不会用于地图", async () => {
  await assert.rejects(locateMap({ AMap: { plugin() {} }, timeout: 5 }), /组件加载超时/);
  await assert.rejects(locateMap({ AMap: { plugin(name, ready) { ready(); }, Geolocation: class { getCurrentPosition(done) { done("error", {}); } } } }), /均未成功/);
  await assert.rejects(locateMap({ geolocation: { getCurrentPosition(ok) { ok({ coords: { longitude: NaN, latitude: 30 } }); } } }), /坐标无效/);
});
