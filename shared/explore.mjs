export const exploreCategories = {
  scenery: { label: "景点", description: "公园、风景与人文去处", types: "110000|080301|140000" },
  food: { label: "美食", description: "餐厅、小吃与咖啡甜品", types: "050000" },
  stay: { label: "住宿", description: "酒店、民宿与青年旅舍", types: "100000" },
  fun: { label: "玩乐", description: "KTV、桌游、剧本杀与休闲娱乐", types: "080300|080500|080600" },
};

export function matchesExploreCategory(category, type, name = "") {
  const text = `${type} ${name}`;
  if (/停车场|出入口|售票处|公共厕所|管理委员会|管理处|游客中心|景区服务中心/.test(text)) return false;
  const entertainment = /KTV|卡拉OK|卡拉ＯＫ|桌游|剧本杀|密室|棋牌|游戏厅|网吧|电竞|保龄球|台球|电影院|影剧院/i.test(text) || (!/游乐场|主题乐园/.test(type) && /娱乐场所|休闲场所/.test(type));
  if (category === "fun") return !/游乐场|主题乐园|学校|大学|学院|咖啡|餐厅|奶茶/.test(text) && entertainment;
  if (category === "scenery") return !entertainment && !/学校|大学|学院|教育|培训|科研|传媒|报社/.test(type) && !/小区|社区|住宅|居民|文化广场|文化小广场|健身广场|市民广场|凉亭|四角亭|纪念坊/.test(text) && /风景|景点|公园|名胜|游乐场|主题乐园|博物|美术|纪念馆|艺术馆|展览馆|文化遗产|文物|寺庙|寺院|教堂/.test(type);
  if (category === "food") return /餐饮|餐厅|饭店|菜馆|咖啡|茶|小吃|甜品|糕饼|快餐|面馆/.test(type);
  if (category === "stay") return /住宿|宾馆|酒店|旅馆|旅舍|民宿|客栈|招待所/.test(type);
  return false;
}

export function insideExploreBounds(place, bounds) {
  return place.location.coordSystem === "GCJ-02" && place.location.lng >= bounds.west && place.location.lng <= bounds.east &&
    place.location.lat >= bounds.south && place.location.lat <= bounds.north &&
    (!bounds.radius || exploreDistance(place, bounds) <= bounds.radius);
}

/** @param {{lng:number,lat:number}} center @param {number} radius */
export function exploreSearchArea(center, radius = 10000) {
  const latDelta = radius / 111320;
  const lngDelta = latDelta / Math.cos(center.lat * Math.PI / 180);
  return { lng: center.lng, lat: center.lat, radius, west: center.lng - lngDelta, east: center.lng + lngDelta,
    south: center.lat - latDelta, north: center.lat + latDelta };
}

/** @param {{lng:number,lat:number}} center @param {{lng:number,lat:number,radius:number}|null} anchor */
export function shouldReloadExplore(center, anchor) {
  return !anchor || exploreDistance({ location: center }, anchor) > anchor.radius;
}

export function exploreDistance(place, center) {
  return Math.hypot((place.location.lng - center.lng) * Math.cos(center.lat * Math.PI / 180), place.location.lat - center.lat) * 111320;
}

export function snapExploreSheet(current, delta, velocity = 0) {
  if (Math.abs(delta) < 35 && Math.abs(velocity) < .35) return current;
  return Math.max(0, Math.min(2, current + (delta < 0 ? 1 : -1)));
}
