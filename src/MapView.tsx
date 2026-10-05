import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  LocateFixed,
  LoaderCircle,
  MapPin,
  RefreshCw,
  RotateCcw,
  ChevronRight,
  TrainFront, BusFront, CarFront, Footprints, Bike, Route, X,
} from "lucide-react";
import { api } from "./api";
import { isAndroidApp, nativeGeolocation } from "./native";
import { locateMap } from "./map-location.mjs";
import { IconButton, Photo } from "./components";
import { previewLayout } from "./map-preview.mjs";
import { createHotspotSelection } from "./map-hotspots.mjs";
import { MotionPresence, motion } from "./motion";
import { mapRoutes, routeStyle, pointAlong, modeNames } from "./route-symbols.mjs";
import type { Place, Audit } from "./types";
declare global {
  interface Window {
    AMap: any;
    _AMapSecurityConfig: unknown;
  }
}
let mapLoader: Promise<any> | null = null;
const routeIcons: Record<string, typeof Route> = { subway: TrainFront, bus: BusFront, driving: CarFront, walking: Footprints, cycling: Bike };
const routeMode = (mode: string) => modeNames[mode as keyof typeof modeNames] || "公共交通";
const routeLabel = (route: { mode: string; name: string }) => `查看${route.name.startsWith(routeMode(route.mode)) ? "" : routeMode(route.mode)}${route.name}`;
const distanceText = (distance?: number) => distance == null ? "" : distance < 1000 ? `${Math.round(distance)} 米` : `${(distance / 1000).toFixed(1)} 公里`;
async function loadMap() {
  const cfg = await api<{
    key: string;
    serviceHost: string;
    style: string;
    mode: string;
  }>("/map/config");
  if (cfg.mode !== "js") return { AMap: null, cfg };
  if (!mapLoader)
    mapLoader = new Promise((resolve, reject) => {
      window._AMapSecurityConfig = { serviceHost: cfg.serviceHost };
      const script = document.createElement("script");
      script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(cfg.key)}`;
      script.onload = () => resolve(window.AMap);
      script.onerror = () => {
        mapLoader = null;
        reject(new Error("地图加载失败"));
      };
      document.head.append(script);
    });
  return { AMap: await mapLoader, cfg };
}
function project(lng: number, lat: number, zoom: number) {
  const scale = 256 * 2 ** zoom;
  return {
    x: ((lng + 180) / 360) * scale,
    y:
      (0.5 -
        Math.log(
          (1 + Math.sin((lat * Math.PI) / 180)) /
            (1 - Math.sin((lat * Math.PI) / 180)),
        ) /
          (4 * Math.PI)) *
      scale,
  };
}
function unproject(x: number, y: number, zoom: number) {
  const scale = 256 * 2 ** zoom;
  return {
    lng: (x / scale) * 360 - 180,
    lat:
      (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / scale))) * 180) / Math.PI,
  };
}
export default function MapView({
  places = [],
  audit,
  onSelect,
  focusId,
  onOpenPlace,
  onDeselect,
  overseas = false,
  className = "",
}: {
  places?: Place[];
  audit?: Audit | null;
  onSelect?: (p: Place) => void;
  focusId?: string | null;
  onOpenPlace?: (p: Place) => void;
  onDeselect?: () => void;
  overseas?: boolean;
  className?: string;
}) {
  const div = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const map = useRef<any>(null);
  const overlays = useRef<any[]>([]);
  const routeOverlays = useRef<{ id: string; line: any; weight: number }[]>([]);
  const markers = useRef<{ id: string; content: HTMLButtonElement }[]>([]);
  const preview = useRef<HTMLButtonElement>(null);
  const canvasPress = useRef<{ x: number; y: number } | null>(null);
  const callback = useRef(onSelect);
  callback.current = onSelect;
  const dismiss = useRef(onDeselect);
  dismiss.current = onDeselect;
  const hotspotSelection = useRef<ReturnType<typeof createHotspotSelection<Place>> | null>(null);
  const [hotspotPlace, setHotspotPlace] = useState<Place | null>(null);
  const [hotspotLoading, setHotspotLoading] = useState(false);
  const [hotspotError, setHotspotError] = useState("");
  const [mode, setMode] = useState<"loading" | "js" | "static">("loading");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [locating, setLocating] = useState(false);
  const [locationNotice, setLocationNotice] = useState("");
  const locationRequest = useRef(0);
  const locationMarker = useRef<any>(null);
  useEffect(() => () => { locationRequest.current++; }, []);
  const [size, setSize] = useState({ width: 800, height: 800 });
  const [zoom, setZoom] = useState(13);
  const [center, setCenter] = useState({ lng: 120.145, lat: 30.25 });
  const [staticView, setStaticView] = useState({ center, zoom: 13, width: 800, height: 800 });
  const [loaded, setLoaded] = useState(false);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [restoreRevision, setRestoreRevision] = useState(0);
  const fittedView = useRef("");
  const [, refreshProjection] = useState(0);
  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });
  const [safeArea, setSafeArea] = useState({ left: 0, right: 0, top: 0, bottom: 0, gap: 0, controls: { left: 0, top: 0, bottom: 0 } });
  const drag = useRef<{ x: number; y: number; center: typeof center } | null>(
    null,
  );
  const points = places.filter((p) => p.location.coordSystem === "GCJ-02");
  const knownPoints = useRef(points);
  knownPoints.current = points;
  const pointKey = JSON.stringify(points.map((p) => [p.id, p.location.lng, p.location.lat]));
  // The parent recreates its daily audit during unrelated status refreshes.
  // Compare route contents so those renders never reset the user's camera.
  const auditKey = JSON.stringify(audit?.days || []);
  const routes = useMemo(() => mapRoutes(audit, points), [auditKey, pointKey]);
  const selectedRoute = routes.find((route) => route.id === selectedRouteId);
  const clearRoute = useRef(() => setSelectedRouteId(null));
  const chooseRoute = (id: string) => {
    if (hotspotSelection.current) hotspotSelection.current.dismiss();
    else dismiss.current?.();
    setSelectedRouteId(id);
  };
  useEffect(() => { setSelectedRouteId(null); }, [auditKey, pointKey]);
  useEffect(() => { if (focusId) setSelectedRouteId(null); }, [focusId]);
  useEffect(() => {
    if (!selectedRoute) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setSelectedRouteId(null); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [selectedRoute]);
  const focusedPlace = points.find((p) => p.id === focusId) || (hotspotPlace?.id === focusId ? hotspotPlace : undefined);
  const jsAnchor = () => {
    if (!focusedPlace || !map.current || !div.current) return null;
    const marker = markers.current.find((entry) => entry.id === focusId)?.content;
    // The SDK can offset its rendered marker layer during camera updates.
    // Measure the visible pin so the reveal stays attached to that exact point.
    if (marker?.isConnected) {
      const pin = marker.getBoundingClientRect();
      const viewport = div.current.getBoundingClientRect();
      if (pin.width && pin.height) return {
        x: pin.left + pin.width / 2 - viewport.left,
        y: pin.top + pin.height / 2 - viewport.top,
      };
    }
    const pixel = map.current.lngLatToContainer([focusedPlace.location.lng, focusedPlace.location.lat]);
    return { x: pixel.getX(), y: pixel.getY() };
  };
  useEffect(() => {
    if (mode !== "static") return;
    const timeout = window.setTimeout(() => setStaticView({
      center, zoom,
      width: Math.min(1024, Math.max(100, size.width)),
      height: Math.min(1024, Math.max(100, size.height)),
    }), 180);
    return () => window.clearTimeout(timeout);
  }, [mode, center.lng, center.lat, zoom, size.width, size.height]);
  useEffect(() => {
    const measure = () => {
      if (!div.current) return;
      const r = div.current.getBoundingClientRect();
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      const margin = rem * 0.75;
      setSize({
        width: Math.round(r.width),
        height: Math.round(r.height),
      });
      let top = margin, bottom = r.height - margin;
      div.current.parentElement?.querySelectorAll<HTMLElement>("[data-map-obstacle]").forEach((el) => {
        const obstacle = el.getBoundingClientRect();
        if (el.dataset.mapObstacle === "top") top = Math.max(top, obstacle.bottom - r.top + margin);
        else bottom = Math.min(bottom, obstacle.top - r.top - Math.max(margin, rem * 1.25));
      });
      const controlRect = div.current.querySelector(".map-controls")?.getBoundingClientRect();
      const controls = controlRect
        ? { left: controlRect.left - r.left, top: controlRect.top - r.top, bottom: controlRect.bottom - r.top }
        : { left: r.width, top: 0, bottom: 0 };
      setSafeArea({ left: margin, right: r.width - margin, top, bottom, gap: rem * 2, controls });
      map.current?.resize();
    };
    const observer = new ResizeObserver(measure);
    if (div.current) observer.observe(div.current);
    div.current?.parentElement?.querySelectorAll("[data-map-obstacle]").forEach((el) => observer.observe(el));
    const controls = div.current?.querySelector(".map-controls");
    if (controls) observer.observe(controls);
    measure();
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setError("");
    if (overseas && !points.length) {
      setLoaded(true);
      return;
    }
    setMode("loading");
    loadMap()
      .then(({ AMap, cfg }) => {
        if (cancelled) return;
        if (!AMap) {
          setMode("static");
          return;
        }
        map.current = new AMap.Map(canvas.current, {
          zoom: 13,
          center: [120.145, 30.25],
          viewMode: "2D",
          mapStyle: cfg.style || "amap://styles/whitesmoke",
          showLabel: true,
          features: ["bg", "point", "road", "building"],
          isHotspot: true,
        });
        const selection = createHotspotSelection<Place>({
          resolve: async (id, signal) => knownPoints.current.find((p) => p.id === id) ||
            (await api<{ place: Place }>(`/places/${encodeURIComponent(id)}`, { signal })).place,
          select: (place) => {
            setHotspotPlace(place);
            clearRoute.current();
            callback.current?.(place);
          },
          dismiss: () => { dismiss.current?.(); clearRoute.current(); },
          loading: setHotspotLoading,
          error: setHotspotError,
        });
        hotspotSelection.current = selection;
        map.current.on("complete", () => setLoaded(true));
        map.current.on("click", () => selection.blankClick());
        map.current.on("hotspotclick", (event: { id?: string }) => { void selection.hotspotClick(event); });
        setMode("js");
      })
      .catch(() => {
        if (!cancelled) {
          setMode("static");
          setError("已切换到高德静态底图");
        }
      });
    return () => {
      cancelled = true;
      hotspotSelection.current?.dispose();
      hotspotSelection.current = null;
      map.current?.destroy();
      map.current = null;
    };
  }, [retry, overseas]);
  useEffect(() => {
    if (!points.length) return;
    const lng = points.reduce((a, p) => a + p.location.lng, 0) / points.length;
    const lat = points.reduce((a, p) => a + p.location.lat, 0) / points.length;
    setCenter({ lng, lat });
    const spread = Math.max(
      ...points.map(
        (p) => Math.abs(p.location.lng - lng) + Math.abs(p.location.lat - lat),
      ),
    );
    setZoom(spread > 1 ? 8 : spread > 0.2 ? 11 : 13);
  }, [pointKey]);
  useEffect(() => {
    if (mode !== "js" || !map.current || !window.AMap) return;
    const AMap = window.AMap;
    map.current.remove(overlays.current);
    const current = [];
    routeOverlays.current = [];
    markers.current = [];
    for (const [p, index] of points.map((p, i) => [p, i] as const)) {
      const content = document.createElement("button");
      content.className = `map-marker ${focusId === p.id ? "selected" : ""}`;
      content.textContent = String(index + 1);
      content.setAttribute("aria-label", p.name);
      content.onclick = (event) => {
        event.stopPropagation();
        clearRoute.current();
        if (hotspotSelection.current) hotspotSelection.current.select(p);
        else callback.current?.(p);
      };
      markers.current.push({ id: p.id, content });
      const marker = new AMap.Marker({
        position: [p.location.lng, p.location.lat],
        content,
        offset: new AMap.Pixel(0, 0),
        title: p.name,
      });
      current.push(marker);
    }
    for (const route of routes) {
      const style = routeStyle(route);
      const options = { path: route.polyline, bubble: false, cursor: "pointer", lineJoin: "round", lineCap: "round" };
      const hit = new AMap.Polyline({ ...options, strokeColor: style.color, strokeOpacity: .01, strokeWeight: 22, zIndex: 40 });
      const line = new AMap.Polyline({ ...options, strokeColor: style.color, strokeWeight: style.weight,
        strokeOpacity: 1, isOutline: true, outlineColor: "#FFFFFF", borderWeight: 2,
        strokeStyle: style.dash.length ? "dashed" : "solid", strokeDasharray: style.dash,
        showDir: style.directions, zIndex: 45 });
      [hit, line].forEach((overlay) => overlay.on("click", () => chooseRoute(route.id)));
      routeOverlays.current.push({ id: route.id, line, weight: style.weight });
      current.push(hit, line);
      if (route.mode === "subway" || route.mode === "bus") {
        const stops = route.stops?.length ? route.stops : [
          { name: route.departureStop || "上车站", location: route.polyline[0] },
          { name: route.arrivalStop || "下车站", location: route.polyline[route.polyline.length - 1] },
        ];
        for (const stop of stops) {
          const content = document.createElement("span");
          content.className = `route-station route-station-${route.mode}`;
          content.style.setProperty("--route-color", style.color);
          content.title = stop.name;
          const marker = new AMap.Marker({ position: stop.location, content, anchor: "center", offset: new AMap.Pixel(0, 0), zIndex: 100, bubble: false });
          marker.on("click", () => chooseRoute(route.id));
          current.push(marker);
        }
      }
    }
    map.current.add(current);
    overlays.current = current;
  }, [mode, pointKey, routes, retry]);
  useEffect(() => {
    routeOverlays.current.forEach(({ id, line, weight }) => line.setOptions({
      strokeWeight: id === selectedRouteId ? weight + 2 : weight, zIndex: id === selectedRouteId ? 49 : 45,
    }));
  }, [selectedRouteId, mode, routes, retry]);
  useEffect(() => {
    if (mode === "loading" || !points.length) return;
    const viewKey = JSON.stringify([mode, pointKey, auditKey, retry, restoreRevision]);
    if (fittedView.current === viewKey) return;
    if (mode === "js" && (!map.current || !overlays.current.length)) return;
    fittedView.current = viewKey;
    const hasVisibleArea = safeArea.bottom - safeArea.top >= 160;
    const bounds = hasVisibleArea ? safeArea : { left: 12, right: size.width - 12, top: 100, bottom: size.height - 140 };
    if (mode === "js") {
      // AMap's padding order is top, bottom, left, right (not CSS order).
      map.current.setFitView(overlays.current, true, [bounds.top + 40, size.height - bounds.bottom + 40, 50, 50], 14);
      return;
    }
    const coordinates = routes.length ? routes.flatMap((route) => route.polyline) : points.map((p) => [p.location.lng, p.location.lat]);
    const path = coordinates.map((p) => project(p[0], p[1], 0));
    const xs = path.map((p) => p.x), ys = path.map((p) => p.y);
    const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
    const scale = Math.min((bounds.right - bounds.left - 70) / Math.max(right - left, 1e-6),
      (bounds.bottom - bounds.top - 100) / Math.max(bottom - top, 1e-6));
    const fittedZoom = Math.max(3, Math.min(14, Math.floor(Math.log2(Math.max(1, scale)))));
    const factor = 2 ** fittedZoom;
    setZoom(fittedZoom);
    setCenter(unproject((left + right) / 2 * factor + size.width / 2 - (bounds.left + bounds.right) / 2,
      (top + bottom) / 2 * factor + size.height / 2 - (bounds.top + bounds.bottom - 32) / 2, fittedZoom));
  }, [mode, routes, pointKey, auditKey, retry, restoreRevision, size.width, size.height, safeArea.left, safeArea.right, safeArea.top, safeArea.bottom]);
  useEffect(() => {
    markers.current.forEach(({ id, content }) => content.classList.toggle("selected", id === focusId));
    if (!onOpenPlace && focusId && map.current) {
      const p = points.find((p) => p.id === focusId);
      if (p) map.current.panTo([p.location.lng, p.location.lat]);
    }
  }, [focusId, mode, pointKey, onOpenPlace]);
  useEffect(() => {
    if (!preview.current) return;
    const observer = new ResizeObserver(([entry]) => {
      setPreviewSize({ width: entry.borderBoxSize[0].inlineSize, height: entry.borderBoxSize[0].blockSize });
    });
    observer.observe(preview.current);
    return () => observer.disconnect();
  }, [focusId, focusedPlace?.id, mode, onOpenPlace]);
  useEffect(() => {
    if ((!focusId && !hotspotLoading) || !onOpenPlace) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (hotspotSelection.current) hotspotSelection.current.dismiss();
        else dismiss.current?.();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [focusId, onOpenPlace, hotspotLoading]);
  useEffect(() => {
    const currentMap = map.current;
    if (mode !== "js" || !currentMap || (!routes.length && (!focusedPlace || !onOpenPlace))) {
      return;
    }
    let frame = 0;
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        refreshProjection((revision) => revision + 1);
      });
    };
    const events = ["mapmove", "zoomchange", "moveend", "zoomend", "resize", "complete"];
    events.forEach((event) => currentMap.on(event, sync));
    document.fonts?.addEventListener("loadingdone", sync);
    sync();
    return () => {
      cancelAnimationFrame(frame);
      events.forEach((event) => currentMap.off(event, sync));
      document.fonts?.removeEventListener("loadingdone", sync);
    };
  }, [mode, focusId, focusedPlace?.location.lng, focusedPlace?.location.lat, onOpenPlace, loaded, routes]);
  useEffect(() => {
    if (!onOpenPlace || !focusedPlace || !previewSize.width || mode === "loading") return;
    const currentMap = map.current;
    const deadline = performance.now() + motion.standard;
    let frame = 0;
    let cancelled = false;
    const stop = () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
    const fit = () => {
      if (cancelled) return;
      const origin = project(center.lng, center.lat, zoom);
      const position = project(focusedPlace.location.lng, focusedPlace.location.lat, zoom);
      const anchor = mode === "js" ? jsAnchor() : {
        x: position.x - origin.x + size.width / 2,
        y: position.y - origin.y + size.height / 2,
      };
      if (!anchor) return;
      const { shift } = previewLayout(anchor, previewSize, safeArea, safeArea.gap);
      if (Math.abs(shift.x) >= .5 || Math.abs(shift.y) >= .5) {
        if (mode === "js" && currentMap) {
          const newCenter = currentMap.containerToLngLat(new window.AMap.Pixel(size.width / 2 - shift.x, size.height / 2 - shift.y));
          currentMap.setCenter(newCenter);
        } else setCenter(unproject(origin.x - shift.x, origin.y - shift.y, zoom));
      }
      // Camera resize and DOM marker rendering settle on different frames.
      // Recheck only during this reveal; a user's drag cancels fitting at once.
      if (mode === "js" && performance.now() < deadline) frame = requestAnimationFrame(fit);
    };
    currentMap?.on("dragstart", stop);
    frame = requestAnimationFrame(fit);
    return () => {
      stop();
      currentMap?.off("dragstart", stop);
    };
  }, [focusId, focusedPlace?.location.lng, focusedPlace?.location.lat, mode, loaded, previewSize.width, previewSize.height, size.width, size.height, safeArea.left, safeArea.right, safeArea.top, safeArea.bottom, safeArea.gap, safeArea.controls.left, safeArea.controls.top, safeArea.controls.bottom]);
  const locate = async () => {
    if (locating) return;
    const request = ++locationRequest.current;
    setLocating(true);
    setError("");
    setLocationNotice("");
    try {
      const result = await locateMap({
        geolocation: isAndroidApp ? nativeGeolocation : navigator.geolocation,
        AMap: window.AMap, secure: isAndroidApp || window.isSecureContext, timeout: isAndroidApp ? 22000 : 10000,
        convert: (point: { lng: number; lat: number }) => api<{ lng: number; lat: number }>(`/map/convert?${new URLSearchParams({ lng: String(point.lng), lat: String(point.lat) })}`),
      });
      if (request !== locationRequest.current) return;
      dismiss.current?.();
      setSelectedRouteId(null);
      const position = [result.lng, result.lat];
      if (map.current && window.AMap) {
        map.current.setZoomAndCenter(result.city ? 11 : result.approximate ? 13 : 16, position);
        locationMarker.current?.setMap(null);
        locationMarker.current = null;
        if (!result.city) {
          locationMarker.current = new window.AMap.Marker({ position, content: '<span class="current-location-dot"></span>', offset: new window.AMap.Pixel(-8, -8), zIndex: 200 });
          map.current.add(locationMarker.current);
        }
      } else { setCenter({ lng: result.lng, lat: result.lat }); setZoom(result.city ? 11 : result.approximate ? 13 : 16); }
      setLocationNotice(result.city ? "已定位到当前城市，暂未获得精确位置" : result.approximate ? "已显示大致位置，网络定位仅供参考" : "已定位到当前位置");
    } catch (error) {
      if (request === locationRequest.current) setError((error as Error).message);
    } finally {
      if (request === locationRequest.current) setLocating(false);
    }
  };
  const base = project(center.lng, center.lat, zoom);
  const xy = (p: number[]) => {
    if (mode === "js" && map.current) {
      const pixel = map.current.lngLatToContainer(p);
      return { x: pixel.getX(), y: pixel.getY() };
    }
    const v = project(p[0], p[1], zoom);
    return {
      x: v.x - base.x + size.width / 2,
      y: v.y - base.y + size.height / 2,
    };
  };
  const anchor = focusedPlace && mode !== "loading"
    ? mode === "js" ? jsAnchor() : xy([focusedPlace.location.lng, focusedPlace.location.lat])
    : null;
  const popup = anchor ? previewLayout(anchor, previewSize, safeArea, safeArea.gap) : null;
  const staticOrigin = xy([staticView.center.lng, staticView.center.lat]);
  const staticScale = 2 ** (zoom - staticView.zoom);
  const screenRoutes = routes.map((route) => ({ route, style: routeStyle(route), pixels: route.polyline.map(xy) }));
  const labelBoxes: { x: number; y: number; width: number }[] = [];
  const labels = screenRoutes.flatMap(({ route, style, pixels }) => {
    const width = Math.min(190, 46 + route.name.length * 12);
    for (const fraction of [.5, .32, .68]) {
      const anchor = pointAlong(pixels, fraction);
      const candidates = [
        { x: anchor.x - width / 2, y: anchor.y - 36, width },
        { x: anchor.x - width - 12, y: anchor.y - 14, width },
        { x: anchor.x + 12, y: anchor.y - 14, width },
        { x: anchor.x - width / 2, y: anchor.y + 12, width },
      ];
      for (const box of candidates) {
      if (anchor.total < 65 || box.x < safeArea.left || box.x + width > safeArea.right ||
        box.y < safeArea.top || box.y + 28 > safeArea.bottom ||
        (box.x + width > safeArea.controls.left - 8 && box.y < safeArea.controls.bottom + 8 && box.y + 28 > safeArea.controls.top - 8) ||
        labelBoxes.some((other) => Math.abs(other.y - box.y) < 36 && box.x < other.x + other.width + 10 && box.x + width + 10 > other.x) ||
        points.some((p) => { const pin = xy([p.location.lng, p.location.lat]); return pin.x > box.x - 22 && pin.x < box.x + width + 22 && Math.abs(pin.y - (box.y + 14)) < 34; })) continue;
      labelBoxes.push(box);
      return [{ route, style, box }];
      }
    }
    return [];
  });
  const legend = [...new Map(routes.map((route) => [route.mode, route])).values()];
  const SelectedIcon = routeIcons[selectedRoute?.mode || ""] || Route;
  return (
    <div ref={div} className={`map-view ${className}`}>
      {overseas && !points.length && (
        <img
          className="overseas-cover"
          src={places.find((p) => p.photo)?.photo || "/images/fuji.png"}
          alt="示例目的地封面"
        />
      )}
      <div
        ref={canvas}
        className="map-canvas"
        onPointerDownCapture={(event) => {
          if (event.button !== 0) return;
          hotspotSelection.current?.beginGesture();
          if ((event.target as HTMLElement).closest(".map-marker, .route-station")) return;
          canvasPress.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerUpCapture={(event) => {
          const press = canvasPress.current;
          canvasPress.current = null;
          if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) < safeArea.gap / 8) hotspotSelection.current?.blankClick();
        }}
        onPointerCancelCapture={() => { canvasPress.current = null; }}
      />
      {mode === "static" && (
        <div
          className="static-map"
          onPointerDown={(e) => {
            if ((e.target as Element).closest("button, .route-hit")) return;
            drag.current = { x: e.clientX, y: e.clientY, center };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerUp={(e) => {
            if (!drag.current) return;
            const d = drag.current;
            drag.current = null;
            if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < safeArea.gap / 8) { dismiss.current?.(); setSelectedRouteId(null); }
          }}
          onPointerMove={(e) => {
            if (!drag.current) return;
            const d = drag.current;
            const original = project(d.center.lng, d.center.lat, zoom);
            setCenter(
              unproject(
                original.x - e.clientX + d.x,
                original.y - e.clientY + d.y,
                zoom,
              ),
            );
          }}
          onPointerCancel={() => { drag.current = null; }}
        >
          <img
            style={{ left: staticOrigin.x, top: staticOrigin.y, width: staticView.width * staticScale, height: staticView.height * staticScale }}
            src={`/api/map/static?${new URLSearchParams({ lng: String(staticView.center.lng), lat: String(staticView.center.lat), zoom: String(staticView.zoom), width: String(staticView.width), height: String(staticView.height) })}`}
            alt="高德地图"
            draggable={false}
            onLoad={() => setLoaded(true)}
            onError={() => {
              setLoaded(true);
              setError("地图加载失败，请重试");
            }}
          />
          <svg
            className="route-overlay"
            width={size.width}
            height={size.height}
          >
            {screenRoutes.map(({ route, style, pixels }) => {
              const path = pixels.map((p) => `${p.x},${p.y}`).join(" ");
              const total = pointAlong(pixels).total;
              const arrowCount = Math.min(40, Math.floor(total / 65));
              const arrows = style.directions ? Array.from({ length: arrowCount }, (_, i) => pointAlong(pixels, (i + .5) / arrowCount)) : [];
              return <g key={route.id}>
                <polyline points={path} fill="none" stroke="white" strokeWidth={style.weight + 4} strokeLinecap="round" strokeLinejoin="round" />
                <polyline points={path} fill="none" stroke={style.color} strokeWidth={style.weight + (selectedRouteId === route.id ? 2 : 0)} strokeDasharray={style.dash.join(" ") || undefined} strokeLinecap="round" strokeLinejoin="round" />
                {arrows.map((p, i) => <path key={i} d="M-3,-3 L1,0 L-3,3" fill="none" stroke="white" strokeWidth="1.6" transform={`translate(${p.x} ${p.y}) rotate(${p.angle})`} />)}
                {(route.mode === "subway" || route.mode === "bus") && (route.stops?.length ? route.stops.map((s) => xy(s.location)) : [pixels[0], pixels[pixels.length - 1]]).map((p, i) => route.mode === "subway"
                  ? <circle key={i} cx={p.x} cy={p.y} r="4" fill="white" stroke={style.color} strokeWidth="2" />
                  : <rect key={i} x={p.x - 3} y={p.y - 3} width="6" height="6" rx="1" fill="white" stroke={style.color} strokeWidth="2" />)}
                <polyline className="route-hit" points={path} fill="none" stroke="transparent" strokeWidth="22" role="button" tabIndex={0} aria-label={routeLabel(route)} onClick={(event) => { event.stopPropagation(); chooseRoute(route.id); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); chooseRoute(route.id); } }} />
              </g>;
            })}
          </svg>
          {points.map((p, i) => {
            const v = xy([p.location.lng, p.location.lat]);
            return (
              <button
                key={p.id}
                className={`map-marker static-marker ${p.id === focusId ? "selected" : ""}`}
                style={{ left: v.x, top: v.y }}
                aria-label={p.name}
                onClick={() => { setSelectedRouteId(null); onSelect?.(p); }}
              >
                {i + 1}
              </button>
            );
          })}
        </div>
      )}
      {mode !== "loading" && !overseas && <>
        <div className="route-label-layer">
          {labels.map(({ route, style, box }) => {
            const Icon = routeIcons[route.mode] || Route;
            return <button key={route.id} className={`route-label ${selectedRouteId === route.id ? "selected" : ""}`} style={{ left: box.x, top: box.y, maxWidth: box.width, "--route-color": style.color } as CSSProperties} aria-label={routeLabel(route)} onClick={() => chooseRoute(route.id)}><Icon size={13} /><span>{route.name}</span></button>;
          })}
        </div>
        {legend.length > 0 && safeArea.bottom - safeArea.top > 140 && <div className="route-legend" style={{ left: safeArea.left + 6, top: safeArea.bottom - 42 }} aria-label="路线图例">
          {legend.map((route) => { const style = routeStyle(route); return <span key={route.mode}><svg width="28" height="14" aria-hidden="true"><path d="M2 7H26" stroke={style.color} strokeWidth={route.mode === "planned" ? 2 : 3} strokeDasharray={style.dash.join(" ")} strokeLinecap="round" />{route.mode === "subway" && <circle cx="14" cy="7" r="3" fill="white" stroke={style.color} strokeWidth="1.5" />}{style.directions && <path d="m12 4 3 3-3 3" stroke="white" fill="none" strokeWidth="1.4" />}</svg>{routeMode(route.mode)}</span>; })}
        </div>}
        {selectedRoute && <section className="route-detail" aria-label="路线详情" style={{ left: safeArea.left + 6, top: safeArea.top + 8, "--route-color": routeStyle(selectedRoute).color } as CSSProperties}>
          <div className="route-detail-heading"><span className="route-detail-icon"><SelectedIcon size={18} /></span><div><small>{routeMode(selectedRoute.mode)}{selectedRoute.city ? ` · ${selectedRoute.city}` : ""}</small><strong>{selectedRoute.name}</strong></div><IconButton label="关闭路线详情" onClick={() => setSelectedRouteId(null)}><X size={16} /></IconButton></div>
          {selectedRoute.departureStop && selectedRoute.arrivalStop ? <p className="route-detail-stops"><span>{selectedRoute.departureStop}</span><ChevronRight size={14} /><span>{selectedRoute.arrivalStop}</span></p> : <p>{points.find((p) => p.id === selectedRoute.from)?.name} → {points.find((p) => p.id === selectedRoute.to)?.name}</p>}
          <div className="route-detail-meta">{selectedRoute.mode === "planned" ? "景点连接示意，核验后显示实际路线" : [selectedRoute.minutes != null ? `约 ${selectedRoute.minutes} 分钟` : "", distanceText(selectedRoute.distance)].filter(Boolean).join(" · ") || "已核验路线"}</div>
        </section>}
      </>}
      <MotionPresence show={Boolean(focusedPlace && onOpenPlace)} motionKey={focusId}>
      {focusedPlace && onOpenPlace && (
        <button
          ref={preview}
          className="map-place-preview"
          aria-label={`查看${focusedPlace.name}`}
          style={{
            left: popup?.x ?? 0,
            top: popup?.y ?? 0,
            visibility: popup?.visible && previewSize.width ? "visible" : "hidden",
            "--popup-tip": `${popup?.tip ?? 0}px`,
            "--popup-max-width": `${Math.max(0, (safeArea.bottom - safeArea.top - safeArea.gap) * 1.5)}px`,
          } as CSSProperties}
          onClick={() => onOpenPlace(focusedPlace)}
        >
          <span className="map-preview-photo"><Photo place={focusedPlace} /></span>
          <span className="map-preview-caption glass-caption">
            <span className="map-preview-title"><strong>{focusedPlace.name}</strong><ChevronRight /></span>
            <small>{focusedPlace.address || `${focusedPlace.country} · ${focusedPlace.city}`}</small>
          </span>
        </button>
      )}
      </MotionPresence>
      {!overseas && (mode === "loading" || !loaded) && (
        <div className="map-loading">
          <LoaderCircle size={22} className="spin" />
          <span>正在加载地图</span>
        </div>
      )}
      {hotspotError && <div className="map-hotspot-status map-hotspot-error" style={{ left: safeArea.left, top: safeArea.top + 8 }} role="alert">{hotspotError}<IconButton label="关闭景点加载提示" onClick={() => setHotspotError("")}><X size={16} /></IconButton></div>}
      {!overseas && (
        <div className="map-controls">
          <IconButton label={locating ? "正在定位" : "定位到当前位置"} onClick={locate} disabled={locating}>
            {locating ? <LoaderCircle size={20} className="spin" /> : <LocateFixed size={20} />}
          </IconButton>
          {points.length > 0 && (
            <IconButton label="复原地图视野" onClick={() => {
              hotspotSelection.current?.dismiss();
              dismiss.current?.();
              setSelectedRouteId(null);
              setRestoreRevision((revision) => revision + 1);
            }} disabled={mode === "loading"}>
              <RotateCcw size={20} />
            </IconButton>
          )}
        </div>
      )}
      {overseas && (
        <div className="map-notice overseas-notice">
          <MapPin size={16} />
          示例封面 · 海外路线暂未核验
        </div>
      )}
      {locationNotice && <div className="map-notice location-notice" role="status"><LocateFixed size={16} />{locationNotice}<IconButton label="关闭定位提示" onClick={() => setLocationNotice("")}><X size={16} /></IconButton></div>}
      {error && (
        <div className="map-error">
          {error}
          <IconButton
            label="重新加载地图"
            onClick={() => {
              setRetry((n) => n + 1);
              setLoaded(false);
            }}
          >
            <RefreshCw size={16} />
          </IconButton>
        </div>
      )}
    </div>
  );
}
