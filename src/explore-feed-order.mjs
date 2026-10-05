const validRating = (value) => typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 5 ? value : null;
export const explorePlaceRating = (place) => validRating(place.reviewRating) ?? validRating(place.poiRating) ?? validRating(place.aiRating);
function weight(id, seed) {
  let hash = 2166136261;
  for (const char of `${seed}:${id}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}
function keepDisplayed(items, displayed, compare) {
  const ids = new Set(displayed);
  const byId = new Map(items.map((item) => [item.id, item]));
  return [...displayed.map((id) => byId.get(id)).filter(Boolean), ...items.filter((item) => !ids.has(item.id)).sort(compare)];
}
export function rankExploreNotes(notes, seed, displayed = []) {
  return keepDisplayed(notes, displayed, (a, b) => (b.favoriteCount || 0) - (a.favoriteCount || 0) || weight(a.id, seed) - weight(b.id, seed) || a.id.localeCompare(b.id));
}
export function rankExplorePlaces(places, displayed = [], distance = (_place) => 0) {
  return keepDisplayed(places, displayed, (a, b) => (explorePlaceRating(b) || 0) - (explorePlaceRating(a) || 0) || distance(a) - distance(b) || a.id.localeCompare(b.id));
}
export function explorePage(items, limit, increment) {
  return { items: items.slice(0, limit), hasMore: items.length > limit, nextLimit: limit + increment };
}
