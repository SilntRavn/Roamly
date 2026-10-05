import { matchesExploreCategory } from "./explore.mjs";

// Use known POI types, saved assessments and actual ratings; absence is not a low score.
export function exploreAreaQuality(places, category, notes = []) {
  const relevant = [...new Map(places.filter((p) => matchesExploreCategory(category, p.poiType || p.category, p.name)).map((p) => [p.id, p])).values()];
  const ids = new Set(relevant.map((p) => p.id));
  const assessed = new Set(notes.flatMap((n) => (n.recommendations || []).filter((r) => r.worthVisiting && ids.has(r.placeId)).map((r) => r.placeId)));
  const highlyRated = relevant.filter((p) => [p.reviewRating, p.poiRating, p.aiRating].some((r) => typeof r === "number" && r >= 4)).length;
  const landmarks = category === "scenery" ? relevant.filter((p) => /^1101/.test(p.poiTypecode || "") || /风景名胜;风景名胜|国家公园|博物馆|文物古迹|文化遗产/.test(p.poiType || p.category)).length : 0;
  const tier = !relevant.length ? "none" : assessed.size >= 6 || highlyRated >= 3 || landmarks >= 4 || category !== "scenery" && relevant.length >= 20 ? "rich" :
    assessed.size >= 2 || highlyRated >= 1 || landmarks >= 1 || relevant.length >= 5 ? "normal" : "sparse";
  return { tier, minimumNotes: { none: 0, sparse: 1, normal: 4, rich: 8 }[tier], placeCount: relevant.length };
}

export function shouldGenerateExploreNotes(quality, noteCount, attemptedAt, now = Date.now()) {
  if (!quality.minimumNotes || noteCount >= quality.minimumNotes) return false;
  const attempted = Date.parse(attemptedAt || "");
  // Only manual refresh bypasses the shared daily attempt limit, including empty/error results.
  return !Number.isFinite(attempted) || now - attempted >= 24 * 3600 * 1000;
}
