export const poiGroups = [
  "110000|080301|080600",
  "140000",
  "050000",
];

/** @param {{west:number, south:number, east:number, north:number}} bounds */
export function poiBounds(bounds) {
  const { west, south, east, north } = bounds;
  if (![west, south, east, north].every(Number.isFinite) || west < -180 || east > 180 || south < -85 || north > 85 ||
    west >= east || south >= north || east - west > 2 || north - south > 2) throw new Error("InvalidPoiBounds");
  const step = Math.max(east - west, north - south) > .08 ? .02 : .005;
  const floor = (n) => Number((Math.floor(n / step + 1e-8) * step).toFixed(3));
  const ceil = (n) => Number((Math.ceil(n / step - 1e-8) * step).toFixed(3));
  return [floor(west), floor(south), ceil(east), ceil(north)];
}

/** @param {string} type @param {string} [name] */
export function poiIcon(type, name = "") {
  const category = `${type} ${name}`;
  const rules = [
    [/动物园|野生动物/, 12], [/水族|海洋馆/, 13], [/植物园|植物研究/, 5],
    [/博物|纪念馆|展览|陈列|文化馆/, 8], [/美术|艺术馆|画廊/, 9],
    [/科技|科学|天文/, 10], [/图书|书店|学校|大学|学院|院校|小学|中学|幼儿园|教育|研究|科研|文化宫/, 11],
    [/寺|庙|道观|教堂|宗教/, 6], [/古迹|故居|遗址|古城|古建筑|城墙/, 7],
    [/游乐|主题乐园|欢乐|迪士尼/, 14], [/影剧|剧院|影院|戏院/, 15],
    [/观景|观光台|瞭望/, 16], [/步行街|商业街|历史文化街/, 17],
    [/咖啡/, 19], [/茶艺|茶馆|茶室|茶社/, 20], [/甜品|冰淇淋|蛋糕|烘焙/, 22],
    [/小吃|面馆|粉店|饺|粥|快餐/, 21], [/餐饮|餐厅|饭店|菜馆|饮食/, 18],
    [/森林|林场/, 4], [/湖|江|河|瀑|海滩|水景/, 3], [/山|峡谷|地貌/, 2],
    [/公园|绿地|花园/, 1], [/非遗|民俗|文化遗产/, 23],
  ];
  return rules.find(([pattern]) => /** @type {RegExp} */ (pattern).test(category))?.[1] ?? 0;
}

/** @param {{category:string, name:string}} place */
export function poiPriority(place) {
  const index = Number(poiIcon(place.category, place.name));
  return index >= 18 && index <= 22 ? 1 : /学校|大学|学院|院校|小学|中学|幼儿园|教育|培训|科研|传媒|报社|文化宫/.test(place.category) ? 2 : 3;
}

/** Generated atlas crop coordinates, consumed as a CSS sprite with circular clipping.
 * @param {number} index @param {number} [size]
 */
export function poiSprite(index, size = 26) {
  const centersX = [145, 395, 646, 894, 1144, 1391];
  const centersY = [151, 390, 631, 870];
  const scale = size / 198;
  const safeIndex = Math.max(0, Math.min(23, Math.trunc(index)));
  return {
    backgroundSize: `${1536 * scale}px ${1024 * scale}px`,
    backgroundPosition: `${-(centersX[safeIndex % 6] - 99) * scale}px ${-(centersY[Math.floor(safeIndex / 6)] - 99) * scale}px`,
  };
}
