import { mapConcurrent } from "./parallel.mjs";
import { distanceKm, validCoordinates } from "./regional-planning.mjs";

// 智能出行按整天选择主要方式，避免把车留在上一站后又在下一站继续驾车。
// 坐标只决定先查询哪种方式；所有接驳时长必须由路线服务核验。
export async function resolveDayTransport(points, preference, route, signal, requirements = {}) {
  const query = async (mode) => ({ transport: mode, legs: await mapConcurrent(points.slice(1), 4, async (to, i) => {
    const from = points[i];
    try {
      const leg = await route(from, to, mode, signal);
      // 公交出行本来包含步行接驳。近邻查不到公交时，核验短步行段而非假定需要开车。
      const mobility = requirements.hasElderly || requirements.stepFree || requirements.childrenAges?.length;
      const limit = Math.min(requirements.maxWalkingMeters ?? 1500, mobility ? 600 : 1500);
      if (mode === "transit" && (leg.status !== "verified" || leg.minutes > 25) && limit > 0 &&
        validCoordinates(from) && validCoordinates(to) && distanceKm(from, to) <= limit / 1500) {
        try {
          const walking = await route(from, to, "walking", signal);
          if (walking.status === "verified" && walking.distance <= limit && walking.minutes <= (mobility ? 12 : 20))
            return { ...walking, requestedMode: "transit" };
        } catch (error) { if (signal?.aborted) throw error; }
      }
      return leg;
    }
    catch (error) {
      if (signal?.aborted) throw error;
      return { from: from.id, to: to.id, mode, status: "unavailable", message: error.message };
    }
  }) });
  if (preference !== "auto") return query(preference);
  if (points.length < 2) return { transport: "transit", legs: [] };
  const distances = points.every(validCoordinates) ? points.slice(1).map((to, i) => distanceKm(points[i], to)) : [];
  const verified = (day) => day.legs.every((leg) => leg.status === "verified");
  const total = (day) => day.legs.reduce((sum, leg) => sum + leg.minutes, 0);
  // 很近且体力条件允许时先核验步行，步行不通再查公交。
  if (distances.length && distances.every((km) => km <= 0.8) &&
    distances.reduce((a, b) => a + b, 0) <= 2 && !requirements.hasElderly &&
    !requirements.stepFree && !requirements.childrenAges?.length) {
    const walking = await query("walking");
    if (verified(walking) && walking.legs.every((l) => l.minutes <= 25) &&
      walking.legs.reduce((sum, l) => sum + l.distance, 0) <= (requirements.maxWalkingMeters ?? 3000)) return walking;
  }
  const first = await query(distances.some((km) => km > 12) ? "driving" : "transit");
  if (first.transport === "driving" && verified(first)) return first;
  if (first.transport === "transit" && verified(first) && first.legs.every((l) =>
    l.minutes <= (l.segments?.some((s) => s.mode === "subway") ? 75 : 45))) return first;
  const alternative = await query(first.transport === "transit" ? "driving" : "transit");
  if (!verified(alternative)) return first;
  if (!verified(first) || (first.transport === "transit" && total(first) - total(alternative) >= 20 &&
    total(alternative) <= total(first) * 0.75)) return alternative;
  return first;
}
