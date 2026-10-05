function bounded(register, timeout, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeout);
    const done = (error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
    try { register(done); } catch (error) { done(error); }
  });
}
function coordinates(lng, lat) {
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 85)
    throw new Error("定位服务返回的坐标无效，请重试");
  return { lng, lat };
}
export async function locateMap({ geolocation, AMap, convert, secure = true, timeout = 10000 }) {
  if (!secure) throw new Error("定位需要 HTTPS 或 localhost，请通过安全地址打开");
  let browserError;
  let position;
  if (geolocation) {
    try {
      position = await bounded((done) => geolocation.getCurrentPosition(
        (value) => done(null, value), (error) => done(error),
        { enableHighAccuracy: true, maximumAge: 60000, timeout },
      ), timeout + 1000, "浏览器定位超时");
    } catch (error) {
      browserError = error;
      if (error.code === 1) throw new Error("定位权限被拒绝，请检查浏览器和系统的位置权限");
    }
  }
  if (position) {
    const gps = coordinates(position.coords.longitude, position.coords.latitude);
    const location = await convert(gps);
    return { ...coordinates(location.lng, location.lat), approximate: position.coords.accuracy > 1000, city: false };
  }
  if (!AMap?.plugin) throw new Error(browserError?.code === 3 ? "定位超时，请检查系统定位服务后重试" : "浏览器未能获取位置，请检查系统定位服务或网络连接");
  await bounded((done) => AMap.plugin("AMap.Geolocation", () => done(null, true)), timeout, "定位组件加载超时，请检查网络后重试");
  const locator = new AMap.Geolocation({
    enableHighAccuracy: true, timeout, maximumAge: 60000, convert: true,
    GeoLocationFirst: false, noIpLocate: 0, needAddress: false,
    showButton: false, showMarker: false, showCircle: false, panToLocation: false, zoomToAccuracy: false,
  });
  let result;
  try { result = await bounded((done) => locator.getCurrentPosition((status, value) => {
    if (status !== "complete") done(new Error("浏览器与网络定位均未成功，请检查系统定位服务和网络后重试"));
    else done(null, value);
  }), timeout + 1000, "网络定位超时，请稍后重试"); }
  catch (error) {
    if (!locator.getCityInfo) throw error;
    result = await bounded((done) => locator.getCityInfo((status, value) => {
      if (status !== "complete") done(error);
      else done(null, { ...value, location_type: "ipcity", isConverted: true });
    }), timeout, "城市定位也未成功，请检查网络后重试");
  }
  const lng = result.position?.getLng?.() ?? result.position?.lng ?? result.position?.[0];
  const lat = result.position?.getLat?.() ?? result.position?.lat ?? result.position?.[1];
  const point = coordinates(lng, lat);
  const location = result.isConverted === false ? await convert(point) : point;
  return { ...coordinates(location.lng, location.lat), approximate: !["html5", "sdk"].includes(result.location_type) || result.accuracy > 1000, city: result.location_type === "ipcity" };
}
