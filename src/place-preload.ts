import { post } from "./api";
import { createPlaceContentCache } from "./place-content-cache.mjs";
import type { Place, PlaceContentResult, TripBundle } from "./types";

const photos = new Map<string, HTMLImageElement>();
function warmPhotos(place: Place) {
  for (const url of [...new Set([place.photo, ...(place.photos || [])].filter(Boolean))].slice(0, 3)) {
    if (photos.has(url)) continue;
    const image = new Image();
    image.fetchPriority = "low";
    image.src = url;
    photos.set(url, image);
    if (photos.size > 100) photos.delete(photos.keys().next().value!);
  }
}
const cache = createPlaceContentCache({
  request: (id: string, { force }: { force?: boolean }) => post<PlaceContentResult>(`/places/${encodeURIComponent(id)}/content`, { force: Boolean(force) }),
  onPlace: warmPhotos,
});
export const cachedPlaceContent = (id: string): PlaceContentResult | null => cache.get(id);
export const loadPlaceContent = (id: string, options?: { force?: boolean; priority?: number }): Promise<PlaceContentResult> => cache.load(id, options);
export const rememberPlaceContent = (result: PlaceContentResult): PlaceContentResult => cache.remember(result);
export const warmPlace = (place: Place, priority = 1) => cache.preload([place], priority);
export const subscribePlaceContent = (listener: (result: PlaceContentResult) => void) => cache.subscribe(listener);
export function warmBundle(bundle: TripBundle) {
  for (const place of bundle.places) {
    const metadata = bundle.placeContents?.[place.id];
    if (metadata) cache.remember({ ...metadata, place });
  }
  cache.preload(bundle.places);
}
