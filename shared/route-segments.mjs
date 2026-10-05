export function parsePolyline(value) {
  if (typeof value !== "string") return [];
  return value.split(";").filter((point) => point.split(",").every((coordinate) => coordinate.trim() !== ""))
    .map((point) => point.split(",").map(Number))
    .filter((point) => point.length === 2 && point.every(Number.isFinite) &&
      Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 85);
}

const metric = (value) => value !== "" && value != null && !Array.isArray(value) &&
  Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : undefined;
const text = (value) => typeof value === "string" ? value : "";

export function normalizeRouteSegments(path, mode, city) {
  if (mode !== "transit") return [{
    mode, city, name: mode === "driving" ? "驾车" : "步行",
    polyline: (path.steps || []).flatMap((step) => parsePolyline(step.polyline)),
    distance: metric(path.distance), minutes: metric(path.duration) === undefined ? undefined : Math.ceil(Number(path.duration) / 60),
  }].filter((segment) => segment.polyline.length > 1);

  return (path.segments || []).flatMap((segment) => {
    const result = [];
    const walk = segment.walking;
    const walkingPath = (walk?.steps || []).flatMap((step) => parsePolyline(step.polyline));
    if (walkingPath.length > 1) result.push({
      mode: "walking", city, name: "步行", polyline: walkingPath,
      distance: metric(walk.distance), minutes: metric(walk.duration) === undefined ? undefined : Math.ceil(Number(walk.duration) / 60),
    });
    // buslines contains alternatives for this segment, not consecutive services.
    const line = segment.bus?.buslines?.[0];
    if (line) {
      const polyline = parsePolyline(line.polyline);
      const subway = /地铁|轻轨|磁悬浮|有轨电车/.test(text(line.type));
      const fullName = text(line.name);
      if (polyline.length > 1) result.push({
        mode: subway ? "subway" : "bus", city,
        name: fullName.replace(/[（(].*$/, "").replace(/^地铁/, "") || (subway ? "地铁" : "公交"),
        fullName, lineId: text(line.id), polyline,
        color: /^#?[\da-f]{6}$/i.test(text(line.color)) ? `#${line.color.replace(/^#/, "")}` : undefined,
        departureStop: text(line.departure_stop?.name), arrivalStop: text(line.arrival_stop?.name),
        stops: [line.departure_stop, ...(line.via_stops || []), line.arrival_stop]
          .filter(Boolean).map((stop) => ({ name: text(stop.name), location: parsePolyline(stop.location)[0] }))
          .filter((stop) => stop.location),
        distance: metric(line.distance), minutes: metric(line.duration) === undefined ? undefined : Math.ceil(Number(line.duration) / 60),
      });
    }
    return result;
  });
}
