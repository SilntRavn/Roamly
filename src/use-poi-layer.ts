import { useEffect, useRef } from "react";
import { api } from "./api";
import { poiBounds, poiIcon, poiPriority, poiSprite } from "../shared/map-pois.mjs";
import type { Place } from "./types";

const cachedViews = new Map<string, { expires: number; places: Place[] }>();
type Area = { left: number; right: number; top: number; bottom: number; controls: { left: number; top: number; bottom: number } };

export function usePoiLayer(mapRef: { current: any }, options: {
  active: boolean; revision: number; excluded: Place[]; focusId?: string | null; safeArea: Area;
  select: (place: Place) => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const redraw = useRef<() => void>(() => {});
  const contents = useRef<{ id: string; element: HTMLButtonElement }[]>([]);
  const excludedKey = options.excluded.map((p) => p.id).join(",");
  useEffect(() => {
    const map = mapRef.current;
    if (!options.active || !map || !window.AMap) return;
    let disposed = false, version = 0;
    let timer = 0;
    let controller: AbortController | null = null;
    let places: Place[] = [];
    let overlays: any[] = [];
    const draw = () => {
      if (disposed) return;
      map.remove(overlays);
      overlays = [];
      contents.current = [];
      const current = latest.current;
      const excluded = new Set(current.excluded.map((p) => p.id));
      const boxes: { x: number; y: number; width: number }[] = [];
      const area = current.safeArea;
      const sorted = [...places].sort((a, b) => poiPriority(b) - poiPriority(a));
      for (const place of sorted) {
        if (excluded.has(place.id)) continue;
        const pixel = map.lngLatToContainer([place.location.lng, place.location.lat]);
        const x = pixel.getX() - 13, y = pixel.getY() - 13;
        const labelWidth = Math.min(96, place.name.length * 11);
        const width = 30 + labelWidth;
        if (x < area.left || x + width > area.right || y < area.top || y + 26 > area.bottom ||
          (x + width > area.controls.left - 8 && y < area.controls.bottom + 8 && y + 26 > area.controls.top - 8) ||
          boxes.some((box) => y < box.y + 34 && y + 34 > box.y && x < box.x + box.width + 10 && x + width + 10 > box.x)) continue;
        boxes.push({ x, y, width });
        const content = document.createElement("button");
        content.className = `roamly-poi ${place.id === current.focusId ? "selected" : ""}`;
        content.setAttribute("aria-label", `查看${place.name}`);
        content.title = place.name;
        const badge = document.createElement("span");
        badge.className = "roamly-poi-icon";
        badge.setAttribute("aria-hidden", "true");
        Object.assign(badge.style, poiSprite(Number(poiIcon(place.category, place.name))));
        const label = document.createElement("span");
        label.className = "roamly-poi-name";
        label.textContent = place.name;
        content.append(badge, label);
        content.onclick = (event) => { event.stopPropagation(); latest.current.select(place); };
        const marker = new window.AMap.Marker({
          position: [place.location.lng, place.location.lat], content,
          offset: new window.AMap.Pixel(-13, -13), zIndex: 80, bubble: false,
        });
        overlays.push(marker);
        contents.current.push({ id: place.id, element: content });
      }
      if (overlays.length) map.add(overlays);
    };
    redraw.current = draw;
    const update = async () => {
      if (disposed) return;
      const currentVersion = ++version;
      controller?.abort();
      controller = null;
      if (map.getZoom() < 12) { places = []; draw(); return; }
      const area = latest.current.safeArea;
      const bounds = map.getBounds();
      const visible = area.bottom - area.top >= 80 && area.right - area.left >= 80;
      // Query the uncovered map band rather than points hidden by the planner.
      const sw = visible ? map.containerToLngLat(new window.AMap.Pixel(area.left, area.bottom)) : bounds.getSouthWest();
      const ne = visible ? map.containerToLngLat(new window.AMap.Pixel(area.right, area.top)) : bounds.getNorthEast();
      let snapped: number[];
      try { snapped = poiBounds({ west: sw.getLng(), south: sw.getLat(), east: ne.getLng(), north: ne.getLat() }); }
      catch { places = []; draw(); return; }
      const key = snapped.join(",");
      const warm = cachedViews.get(key);
      if (warm && warm.expires > Date.now()) {
        places = warm.places;
        map.setFeatures(["bg", "road", "building"]);
        draw();
        return;
      }
      controller = new AbortController();
      try {
        const [west, south, east, north] = snapped;
        const result = await api<Place[]>(`/map/places?${new URLSearchParams({ west: String(west), south: String(south), east: String(east), north: String(north) })}`, { signal: controller.signal });
        if (disposed || currentVersion !== version) return;
        cachedViews.set(key, { expires: Date.now() + 6 * 3600 * 1000, places: result });
        if (cachedViews.size > 40) cachedViews.delete(cachedViews.keys().next().value!);
        places = result;
        map.setFeatures(["bg", "road", "building"]);
        draw();
      } catch {
        if (disposed || currentVersion !== version || controller?.signal.aborted) return;
        // Preserve usable POIs if the custom data service is temporarily unavailable.
        places = [];
        draw();
        map.setFeatures(["bg", "point", "road", "building"]);
      }
    };
    const schedule = () => {
      clearTimeout(timer);
      // Existing markers move with the SDK; re-evaluate collisions at the settled view.
      draw();
      timer = window.setTimeout(() => { void update(); }, 650);
    };
    ["moveend", "zoomend", "resize", "complete"].forEach((event) => map.on(event, schedule));
    void update();
    return () => {
      disposed = true;
      version++;
      controller?.abort();
      clearTimeout(timer);
      ["moveend", "zoomend", "resize", "complete"].forEach((event) => map.off(event, schedule));
      map.remove(overlays);
      contents.current = [];
      redraw.current = () => {};
    };
  }, [options.active, options.revision]);
  useEffect(() => {
    contents.current.forEach(({ id, element }) => element.classList.toggle("selected", id === options.focusId));
  }, [options.focusId]);
  useEffect(() => { redraw.current(); }, [excludedKey, options.safeArea.left, options.safeArea.right, options.safeArea.top, options.safeArea.bottom]);
}
