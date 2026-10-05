import { timeString } from "../shared/schema.mjs";

const radians = (degrees) => (degrees * Math.PI) / 180;
const roundHalfHour = (value) => Math.round(value / 30) * 30;

// NOAA 的近似太阳位置公式；统一输出北京时间。仅作为排程参考，
// 不含山体遮挡、海拔和当天天气，不能当作景点开放或灯光亮灯的证据。
// https://gml.noaa.gov/grad/solcalc/solareqns.PDF
export function estimateDaylight(location, date) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const instant = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== date)
    return null;
  const { lng, lat } = location || {};
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) >= 90)
    return null;
  const year = instant.getUTCFullYear();
  const daysInYear = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000;
  const dayOfYear = Math.floor((instant.getTime() - Date.UTC(year, 0, 1)) / 86400000) + 1;
  const gamma = (2 * Math.PI * (dayOfYear - 1)) / daysInYear;
  const equation = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) -
    0.032077 * Math.sin(gamma) - 0.014615 * Math.cos(2 * gamma) -
    0.040849 * Math.sin(2 * gamma));
  const declination = 0.006918 - 0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) - 0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) - 0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);
  const latitude = radians(lat);
  const cosine = Math.cos(radians(90.833)) / (Math.cos(latitude) * Math.cos(declination)) -
    Math.tan(latitude) * Math.tan(declination);
  if (Math.abs(cosine) > 1) return null;
  const hourAngle = Math.acos(cosine) * 180 / Math.PI;
  const noon = 720 - 4 * lng - equation + 8 * 60;
  const sunrise = Math.round(noon - 4 * hourAngle);
  const sunset = Math.round(noon + 4 * hourAngle);
  if (sunrise < 0 || sunset >= 1440) return null;
  return { sunrise: timeString(sunrise), sunset: timeString(sunset), sunsetMinutes: sunset };
}

function isXinjiang(place) {
  return /^新疆/.test(place.province || "") ||
    /^(?:乌鲁木齐|克拉玛依|吐鲁番|哈密|昌吉|博尔塔拉|巴音郭楞|阿克苏|克孜勒苏|喀什|和田|伊犁|塔城|阿勒泰|石河子|阿拉尔|图木舒克|五家渠|北屯|铁门关|双河|可克达拉|昆玉|胡杨河|新星|白杨)(?:市|地区|州|自治州)?$/.test(place.city || "");
}

export function dayRhythm(places, date = null) {
  // 从当天实际地点判定，避免多城市行程全部套用同一作息。
  const xinjiang = places.length > 0 && places.every(isXinjiang);
  const western = !xinjiang && places.length > 0 && places.every((p) =>
    p.country === "中国" && Number.isFinite(p.location?.lng) && p.location.lng < 100);
  const shift = xinjiang ? 90 : western ? 60 : 0;
  const daylight = places.map((p) => estimateDaylight(p.location, date)).filter(Boolean);
  const sunset = daylight.length ? Math.min(...daylight.map((d) => d.sunsetMinutes)) : null;
  const dayEnd = xinjiang
    ? sunset === null ? 20 * 60 : Math.max(18 * 60, Math.min(22 * 60, roundHalfHour(sunset - 30)))
    : 17 * 60 + (western ? 60 : 0);
  return {
    region: xinjiang ? "新疆" : western ? "西部目的地" : "常规目的地",
    timeZone: "Asia/Shanghai",
    recommendedStart: xinjiang ? "10:00" : western ? "09:30" : "08:30",
    recommendedDayEnd: timeString(dayEnd),
    dayEndMinutes: dayEnd,
    // 无日期时是作息建议，不能声称这个时间已天黑。
    eveningStartMinutes: xinjiang ? sunset ?? 21 * 60 : 18 * 60 + (western ? 60 : 0),
    lunchStartMinutes: 11 * 60 + shift,
    lunchEndMinutes: 14 * 60 + 30 + shift,
    dinnerStartMinutes: 17 * 60 + shift,
    dinnerEndMinutes: 20 * 60 + 30 + shift,
    daylight: daylight.length ? {
      approximateSunset: timeString(sunset),
      date,
      note: "根据日期和坐标估算；不含天气、地形遮挡，不代表开放或亮灯时间",
    } : null,
  };
}

export function rhythmForModel(places, date = null) {
  const rhythm = dayRhythm(places, date);
  return {
    region: rhythm.region,
    timeZone: rhythm.timeZone,
    recommendedStart: rhythm.recommendedStart,
    recommendedDayEnd: rhythm.recommendedDayEnd,
    lunchWindow: `${timeString(rhythm.lunchStartMinutes)}—${timeString(rhythm.lunchEndMinutes)}`,
    dinnerWindow: `${timeString(rhythm.dinnerStartMinutes)}—${timeString(rhythm.dinnerEndMinutes)}`,
    daylight: rhythm.daylight,
  };
}
