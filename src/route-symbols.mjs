import { metroColors } from "../shared/metro-colors.mjs";

export const modeNames = { subway: "地铁", bus: "公交", driving: "驾车", walking: "步行", cycling: "骑行", transit: "公共交通", planned: "景点顺序" };
const styles = {
  subway: { color: "#75638D", weight: 6, dash: [], directions: false },
  bus: { color: "#B47724", weight: 5, dash: [12, 5], directions: false },
  driving: { color: "#3977D5", weight: 6, dash: [], directions: true },
  walking: { color: "#268568", weight: 4, dash: [2, 8], directions: false },
  cycling: { color: "#15899D", weight: 4, dash: [10, 4, 2, 4], directions: true },
  transit: { color: "#75638D", weight: 5, dash: [10, 5], directions: false },
  planned: { color: "#8C949D", weight: 2, dash: [5, 7], directions: false },
};
/** @param {string} city @param {string} name */
export function metroColor(city, name) {
  const normalizedCity = city.replace(/市$/, "");
  const palette = Object.entries(metroColors).find(([key]) => key.replace(/市$/, "") === normalizedCity)?.[1];
  const normalizedName = name.replace(/[（(].*$/, "").replace(/^(地铁|轨道交通)/, "").trim();
  return palette ? Object.entries(palette).find(([key]) => key === normalizedName)?.[1] : undefined;
}
/** @param {import('./types').RouteSegment} segment */
export function routeStyle(segment) {
  const mode = Object.prototype.hasOwnProperty.call(styles, segment.mode) ? segment.mode : "transit";
  const base = styles[/** @type {keyof typeof styles} */ (mode)];
  const suppliedColor = /^#[\da-f]{6}$/i.test(segment.color || "") ? segment.color : undefined;
  return { ...base, color: suppliedColor || (mode === "subway" ? metroColor(segment.city || "", segment.name) : undefined) || base.color };
}
/** @typedef {import('./types').RouteSegment & {id: string, from: string, to: string}} DisplayRoute */
/** @param {import('./types').Audit | null | undefined} audit @param {import('./types').Place[]} points @returns {DisplayRoute[]} */
export function mapRoutes(audit, points) {
  const validPath = (/** @type {number[][] | undefined} */ path) => Array.isArray(path) && path.length > 1 &&
    path.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 85);
  const routes = (audit?.days || []).flatMap((day) => day.legs.flatMap((leg, legIndex) => {
    if (leg.status !== "verified") return [];
    const city = points.find((p) => p.id === leg.from)?.city || "";
    const segments = leg.segments?.length ? leg.segments : validPath(leg.polyline) ? [{
      mode: leg.mode, name: modeNames[/** @type {keyof typeof modeNames} */ (leg.mode)] || "公共交通",
      city, polyline: leg.polyline, minutes: leg.minutes, distance: leg.distance,
    }] : [];
    return segments.filter((s) => validPath(s.polyline)).map((segment, index) => ({
      ...segment, name: segment.mode === "walking" && segment.name === "步行接驳" ? "步行" : segment.name,
      city: segment.city || city, id: `${day.index}:${legIndex}:${index}`, from: leg.from, to: leg.to,
    }));
  }));
  // These connections show itinerary order only; they are not navigable roads.
  if (!routes.length && points.length > 1) return [{
    id: "planned", mode: "planned", name: "景点顺序 · 待核验", city: "",
    polyline: points.map((p) => [p.location.lng, p.location.lat]), from: points[0].id, to: points[points.length - 1].id,
  }];
  return routes;
}
/** @param {{x: number, y: number}[]} points @param {number} fraction */
export function pointAlong(points, fraction = .5) {
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  let remaining = total * fraction;
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i] && lengths[i] > 0) {
      const ratio = remaining / lengths[i];
      return { x: points[i].x + (points[i + 1].x - points[i].x) * ratio,
        y: points[i].y + (points[i + 1].y - points[i].y) * ratio,
        angle: Math.atan2(points[i + 1].y - points[i].y, points[i + 1].x - points[i].x) * 180 / Math.PI, total };
    }
    remaining -= lengths[i];
  }
  return { ...points[0], angle: 0, total };
}
