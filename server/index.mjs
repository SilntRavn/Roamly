import express from "express";
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { z } from "zod";
import { root, config } from "./config.mjs";
import {
  db,
  createGuest,
  getUser,
  defaultPreferences,
  getTrip,
  saveTrip,
  tripPlaces,
  getPlace,
  savePlace,
  getAudit,
  saveAudit,
  usernameKey,
} from "./db.mjs";
import { featured, demoTrip, demoPlaces } from "./seed.mjs";
import { searchPlaces, resolvePlace, auditTrip, ServiceError } from "./amap.mjs";
import { amap, amapStaticMap } from "./amap-client.mjs";
import { mapPlaces } from "./map-pois.mjs";
import { ensureExploreFeed, readExploreFeed, readExploreNote, readFavoriteNotes, readCachedExploreNearby } from "./explore.mjs";
import { exploreSearchArea } from "../shared/explore.mjs";
import { getCachedPlaceContent } from "./place-content.mjs";
import { placePreloader } from "./place-preload.mjs";
import { planTrip } from "./planner.mjs";
import { createTraceStore, withTrace, traceEvent } from "./ai-monitor.mjs";
import {
  reconcileManualRequirements,
  defaultRequirements,
} from "../shared/requirements.mjs";
import { checkPlanQuality } from "./plan-quality.mjs";
import {
  TripSchema,
  FileSchema,
  PreferencesSchema,
  makeExport,
} from "../shared/schema.mjs";
import { sessionToken, setSession, requireLogin, registerAccount, loginAccount, deleteAccount } from "./auth.mjs";
const app = express();
const production = process.argv.includes("--production");
let monitor = null;
if (process.env.ROAMLY_AI_MONITOR === "1" || (!production && process.env.ROAMLY_AI_MONITOR !== "0")) {
  try { monitor = createTraceStore(db); }
  catch (error) { console.warn("AI monitor could not initialize:", error.name); }
}
const monitorEnabled = Boolean(monitor);
app.disable("x-powered-by");
if (production && config.host === "127.0.0.1") app.set("trust proxy", "loopback");
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (req.path.startsWith("/api")) res.setHeader("Cache-Control", "no-store");
  next();
});
// 同源写入 + HttpOnly会话，访客数据也只属于自己的会话。
app.use("/api", (req, res, next) => {
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    req.headers.origin &&
    req.headers.origin !== `${req.protocol}://${req.get("host")}`
  )
    return res.status(403).json({ error: "仅接受同源请求" });
  const token = sessionToken(req);
  const session =
    token &&
    db
      .prepare("SELECT user_id FROM sessions WHERE token=? AND expires>?")
      .get(token, Date.now());
  req.userId = session?.user_id && getUser(session.user_id) ? session.user_id : undefined;
  if (!req.userId && !(req.method === "GET" && req.path.startsWith("/shares/"))) {
    req.userId = createGuest();
    setSession(req, res, req.userId);
  }
  next();
});
const rates = new Map();
function limit(name, max, windowMs = 60000) {
  return (req, res, next) => {
    const key = `${name}:${name === "auth" ? "" : req.userId}:${req.ip}`;
    const now = Date.now();
    let x = rates.get(key);
    if (!x || x.until < now) x = { count: 0, until: now + windowMs };
    x.count++;
    rates.set(key, x);
    if (rates.size > 10000)
      for (const [k, v] of rates) if (v.until < now) rates.delete(k);
    if (x.count > max)
      return res.status(429).json({ error: "操作过于频繁，请稍后再试" });
    next();
  };
}
const activePlans = new Map();
app.use("/api/ai-monitor", (req, res, next) => {
  if (!monitor) return res.status(404).json({ error: "AI 监视插件未启用" });
  const user = getUser(req.userId);
  if (!user?.username) return res.status(401).json({ error: "请验证身份后访问 AI 监视", code: "MONITOR_LOGIN_REQUIRED" });
  if (usernameKey(user.username) !== "silntravn")
    return res.status(403).json({ error: "当前账号无权访问 AI 监视", code: "MONITOR_FORBIDDEN" });
  next();
});
app.get("/api/ai-monitor", (req, res) => res.json({ enabled: monitorEnabled }));
app.get("/api/ai-monitor/traces", (req, res) => res.json({ traces: monitor.list(req.userId) }));
app.get("/api/ai-monitor/traces/:id", (req, res) => {
  const trace = monitor.get(req.userId, req.params.id);
  if (!trace) return res.status(404).json({ error: "记录不存在" });
  res.json(trace);
});
app.delete("/api/ai-monitor/traces/:id", (req, res) => {
  if (!monitor.remove(req.userId, req.params.id)) return res.status(409).json({ error: "记录不存在或仍在运行" });
  res.json({ ok: true });
});
function requireTrip(req) {
  const trip = getTrip(req.params.id, req.userId);
  if (!trip) throw new ServiceError("行程不存在", 404);
  return trip;
}
const sendTrip = (trip) => {
  const places = tripPlaces(trip);
  placePreloader.preload(places);
  return { trip, places, placeContents: placePreloader.snapshots(places), audit: getAudit(trip.id) };
};
app.get("/api/bootstrap", (req, res) => {
  const user = getUser(req.userId);
  const favorites = db
    .prepare("SELECT place_id FROM favorites WHERE user_id=?")
    .all(req.userId)
    .map((r) => r.place_id);
  res.json({
    user,
    featured,
    favorites,
    favoriteNotes: readFavoriteNotes(req.userId),
    services: {
      aiConfigured: Boolean(config.aiKey),
      mapConfigured: Boolean(config.amapKeys.length),
      mapMode: config.amapJsKey && config.amapSecurity ? "js" : "static",
    },
    demo: { trip: demoTrip, places: demoPlaces },
  });
});
app.get("/api/profile", (req, res) => {
  const user = getUser(req.userId);
  const trips = db
    .prepare("SELECT payload,status,saved_visible,footprint_visible FROM trips WHERE user_id=?")
    .all(req.userId);
  res.json({
    user,
    stats: {
      trips: trips.filter((t) => t.saved_visible).length,
      favorites: db
        .prepare("SELECT COUNT(*) AS n FROM favorites WHERE user_id=?")
        .get(req.userId).n,
      visited: new Set(
        trips
          .filter((t) => t.footprint_visible)
          .flatMap((t) =>
            JSON.parse(t.payload).days.flatMap((d) =>
              d.items.map((i) => i.placeId),
            ),
          )
          .filter(Boolean),
      ).size,
    },
  });
});
app.patch("/api/profile", (req, res) => {
  const data = z
    .object({
      preferences: PreferencesSchema,
    })
    .parse(req.body);
  db.prepare("UPDATE users SET preferences=? WHERE id=?").run(
    JSON.stringify({ ...data.preferences, transportChoice: true }),
    req.userId,
  );
  res.json(getUser(req.userId));
});
app.post("/api/auth/register", limit("auth", 8, 15 * 60000), registerAccount);
app.post("/api/auth/login", limit("auth", 8, 15 * 60000), loginAccount);
app.post("/api/auth/logout", (req, res) => {
  const token = sessionToken(req);
  if (token) db.prepare("DELETE FROM sessions WHERE token=?").run(token);
  res.clearCookie("roamly_session", { path: "/" });
  res.json({ ok: true });
});
app.delete("/api/auth/account", requireLogin, limit("delete-account", 5, 15 * 60000), (req, res) => {
  if (activePlans.has(req.userId))
    throw new ServiceError("请先取消或等待 AI 规划完成，再注销账号", 409);
  deleteAccount(req, res);
});
app.get("/api/places/search", limit("search", 30), async (req, res) => {
  const query = z
    .object({
      q: z.string().trim().min(1).max(100),
      city: z.string().max(100).optional(),
    })
    .parse(req.query);
  res.json(await searchPlaces(query.q, query.city));
});
app.get("/api/map/places", limit("map-places", 60), async (req, res) => {
  const bounds = z.object({
    west: z.coerce.number(), south: z.coerce.number(), east: z.coerce.number(), north: z.coerce.number(),
    category: z.enum(["scenery", "food", "stay", "fun"]).optional(),
  }).parse(req.query);
  res.json(await mapPlaces(bounds, bounds.category));
});
const exploreQuery = z.object({
  west: z.coerce.number(), south: z.coerce.number(), east: z.coerce.number(), north: z.coerce.number(),
  category: z.enum(["scenery", "food", "stay", "fun"]),
  lng: z.coerce.number().min(-179).max(179).optional(), lat: z.coerce.number().min(-80).max(80).optional(),
  radius: z.coerce.number().refine((n) => n === 5000 || n === 10000).optional(),
}).refine((value) => [value.lng, value.lat, value.radius].every((n) => n === undefined) ||
  [value.lng, value.lat, value.radius].every((n) => n !== undefined));
function exploreBounds(input) {
  const query = exploreQuery.parse(input);
  return query.radius ? { ...exploreSearchArea({ lng: query.lng, lat: query.lat }, query.radius), category: query.category } : query;
}
app.get("/api/explore/nearby", limit("explore", 40), async (req, res) => {
  const bounds = exploreBounds(req.query);
  const cached = readCachedExploreNearby(bounds, bounds.category);
  if (cached) return res.json({ ...cached, feed: ensureExploreFeed(bounds, bounds.category, cached.places) });
  const places = await mapPlaces(bounds, bounds.category);
  const feed = ensureExploreFeed(bounds, bounds.category, places);
  res.json({ places, feed });
});
// Public-library synchronization reads SQLite only, never map or model services.
app.get("/api/explore/stored", limit("explore-stored", 90), (req, res) => {
  const bounds = exploreBounds(req.query);
  res.json(readCachedExploreNearby(bounds, bounds.category));
});
app.get("/api/explore/feeds/:key", limit("explore-status", 90), (req, res) => res.json(readExploreFeed(req.params.key)));
app.post("/api/explore/refresh", limit("explore-refresh", 4), async (req, res) => {
  const bounds = exploreBounds(req.body);
  const places = await mapPlaces(bounds, bounds.category);
  res.json({ places, feed: ensureExploreFeed(bounds, bounds.category, places, { force: true }) });
});
app.get("/api/explore/notes/:id", (req, res) => res.json(readExploreNote(req.params.id)));
app.get("/api/explore/favorites", (req, res) => res.json(readFavoriteNotes(req.userId)));
app.put("/api/explore/favorites/:id", (req, res) => {
  readExploreNote(req.params.id);
  db.prepare("INSERT OR IGNORE INTO note_favorites VALUES(?,?,?)").run(req.userId, req.params.id, new Date().toISOString());
  res.json({ favorite: true });
});
app.delete("/api/explore/favorites/:id", (req, res) => {
  db.prepare("DELETE FROM note_favorites WHERE user_id=? AND note_id=?").run(req.userId, req.params.id);
  res.json({ favorite: false });
});
app.get("/api/places/:id", async (req, res) => {
  const place = await resolvePlace(req.params.id);
  placePreloader.preload([place], 0);
  const cached = getCachedPlaceContent(place.id);
  const { place: ignored, ...content } = cached || {};
  const reviews = db
    .prepare(
      "SELECT r.id,r.user_id,r.rating,r.content,r.created_at,u.nickname FROM reviews r JOIN users u ON u.id=r.user_id WHERE r.place_id=? ORDER BY r.created_at DESC",
    )
    .all(place.id);
  res.json({
    place,
    content: cached ? content : null,
    reviews,
    rating: reviews.length
      ? reviews.reduce((a, r) => a + r.rating, 0) / reviews.length
      : null,
  });
});
app.post("/api/places/:id/content", limit("place-content", 60), async (req, res) => {
  const { force } = z.object({ force: z.boolean().default(false) }).parse(req.body);
  res.json(await placePreloader.request(req.params.id, { force }));
});
app.get("/api/favorites", (req, res) =>
  res.json(
    db
      .prepare(
        "SELECT p.payload FROM places p JOIN favorites f ON f.place_id=p.id WHERE f.user_id=?",
      )
      .all(req.userId)
      .map((r) => JSON.parse(r.payload)),
  ),
);
app.post("/api/favorites/:id", (req, res) => {
  if (!getPlace(req.params.id)) throw new ServiceError("景点不存在", 404);
  const exists = db
    .prepare("SELECT 1 FROM favorites WHERE user_id=? AND place_id=?")
    .get(req.userId, req.params.id);
  if (exists)
    db.prepare("DELETE FROM favorites WHERE user_id=? AND place_id=?").run(
      req.userId,
      req.params.id,
    );
  else
    db.prepare("INSERT INTO favorites VALUES(?,?)").run(
      req.userId,
      req.params.id,
    );
  res.json({ favorite: !exists });
});
app.post("/api/places/:id/reviews", limit("review", 5), (req, res) => {
  if (!getUser(req.userId).username)
    throw new ServiceError("登录后即可留下你的旅行体验", 401);
  if (!getPlace(req.params.id)) throw new ServiceError("景点不存在", 404);
  const data = z
    .object({
      rating: z.number().int().min(1).max(5),
      content: z.string().trim().min(5).max(2000),
    })
    .parse(req.body);
  db.prepare(
    "INSERT INTO reviews VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,place_id) DO UPDATE SET rating=excluded.rating,content=excluded.content,created_at=excluded.created_at",
  ).run(
    randomUUID(),
    req.userId,
    req.params.id,
    data.rating,
    data.content,
    new Date().toISOString(),
  );
  res.json({ ok: true });
});
app.delete("/api/places/:id/reviews", (req, res) => {
  db.prepare("DELETE FROM reviews WHERE user_id=? AND place_id=?").run(
    req.userId,
    req.params.id,
  );
  res.json({ ok: true });
});
app.get("/api/trips", (req, res) =>
  res.json(
    db
      .prepare(
        "SELECT payload,favorite,status,saved_visible,footprint_visible FROM trips WHERE user_id=? ORDER BY rowid DESC",
      )
      .all(req.userId)
      .map((r) => {
        const trip = JSON.parse(r.payload);
        return {
          ...trip,
          favorite: Boolean(r.favorite),
          status: r.status,
          savedVisible: Boolean(r.saved_visible),
          footprintVisible: Boolean(r.footprint_visible),
          cover: tripPlaces(trip).find((p) => p.photo) || tripPlaces(trip)[0],
        };
      }),
  ),
);
app.get("/api/trips/:id", (req, res) => res.json(sendTrip(requireTrip(req))));
app.post("/api/trips/:id/conversation", (req, res) => {
  const trip = requireTrip(req);
  if (activePlans.has(req.userId)) throw new ServiceError("请先等待当前 AI 规划完成", 409);
  const { placeId } = z.object({ placeId: z.string().max(100).optional() }).parse(req.body);
  const place = placeId ? tripPlaces(trip).find((p) => p.id === placeId) : null;
  if (placeId && !place) throw new ServiceError("这个地点尚未加入行程", 400);
  const previous = db.prepare("SELECT id,messages FROM conversations WHERE trip_id=? AND user_id=? ORDER BY rowid DESC LIMIT 1").get(trip.id, req.userId);
  const id = previous?.id || randomUUID();
  const messages = previous ? JSON.parse(previous.messages) : [];
  if (place || !messages.length) messages.push({ role: "assistant", content: place
    ? `已把「${place.name}」加入「${trip.title}」。想安排几天、什么时候去，或和哪些地方一起游玩？告诉我，我会把这一站一起安排进去。`
    : `「${trip.title}」已准备好。告诉我出行时间、想去的地方和旅行偏好，我们一起安排这段旅程。` });
  db.prepare("INSERT INTO conversations VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET messages=excluded.messages")
    .run(id, req.userId, trip.id, JSON.stringify(messages));
  res.json({ id, trip_id: trip.id, messages });
});
app.post("/api/trips", (req, res) => {
  const trip = TripSchema.parse({
    ...req.body,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  trip.requirements = reconcileManualRequirements(null, trip, tripPlaces(trip));
  makeExport(trip, tripPlaces(trip));
  saveTrip(trip, req.userId);
  res.json(sendTrip(trip));
});
app.patch("/api/trips/:id", (req, res) => {
  const old = requireTrip(req);
  const contentChanged = Object.keys(req.body).some(
    (k) => !["favorite", "status"].includes(k),
  );
  const trip = TripSchema.parse({
    ...old,
    ...req.body,
    id: old.id,
    createdAt: old.createdAt,
    updatedAt: contentChanged ? new Date().toISOString() : old.updatedAt,
  });
  if (contentChanged)
    trip.requirements = reconcileManualRequirements(old, trip, [
      ...tripPlaces(old),
      ...tripPlaces(trip),
    ]);
  makeExport(trip, tripPlaces(trip));
  if (contentChanged) saveTrip(trip, req.userId);
  if (typeof req.body.favorite === "boolean")
    db.prepare("UPDATE trips SET favorite=? WHERE id=? AND user_id=?").run(
      Number(req.body.favorite),
      trip.id,
      req.userId,
    );
  if (["saved", "started", "completed"].includes(req.body.status))
    db.prepare("UPDATE trips SET status=?,footprint_visible=? WHERE id=? AND user_id=?").run(
      req.body.status,
      Number(req.body.status === "completed"),
      trip.id,
      req.userId,
    );
  res.json(sendTrip(getTrip(trip.id, req.userId)));
});
app.delete("/api/trips/:id", (req, res) => {
  requireTrip(req);
  const scope = z.enum(["saved", "footprint"]).optional().parse(req.query.scope);
  if (activePlans.get(req.userId)?.tripId === req.params.id)
    throw new ServiceError("此行程正在规划，请先取消或等待完成后再删除", 409);
  db.exec("BEGIN");
  try {
    if (scope) {
      const column = scope === "saved" ? "saved_visible" : "footprint_visible";
      db.prepare(`UPDATE trips SET ${column}=0 WHERE id=? AND user_id=?`).run(req.params.id, req.userId);
      const memberships = db.prepare("SELECT saved_visible,footprint_visible,favorite FROM trips WHERE id=? AND user_id=?").get(req.params.id, req.userId);
      if (memberships.saved_visible || memberships.footprint_visible || memberships.favorite) {
        db.exec("COMMIT");
        return res.json({ ok: true, removed: false, trip: getTrip(req.params.id, req.userId) });
      }
    }
    db.prepare("DELETE FROM conversations WHERE trip_id=? AND user_id=?").run(req.params.id, req.userId);
    db.prepare("DELETE FROM shares WHERE trip_id=? AND user_id=?").run(req.params.id, req.userId);
    db.prepare("DELETE FROM trip_audits WHERE trip_id=?").run(req.params.id);
    db.prepare("DELETE FROM trips WHERE id=? AND user_id=?").run(req.params.id, req.userId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  res.json({ ok: true, removed: true });
});
app.get("/api/trips/:id/export", (req, res) => {
  const trip = requireTrip(req);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="roamly-${trip.id}.roamly"`,
  );
  res.json(makeExport(trip, tripPlaces(trip)));
});
app.post("/api/trips/import", (req, res) => {
  const file = FileSchema.parse(req.body);
  const remap = new Map(
    file.places.map((p) => [p.id, `import-${randomUUID()}`]),
  );
  const trip = {
    ...file.itinerary,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(file.itinerary.requirements
      ? {
          requirements: {
            ...file.itinerary.requirements,
            requiredPlaceIds: file.itinerary.requirements.requiredPlaceIds.map(
              (id) => remap.get(id),
            ),
            fixedVisits: file.itinerary.requirements.fixedVisits.map((v) => ({
              ...v,
              placeId: v.placeId ? remap.get(v.placeId) : null,
            })),
          },
        }
      : {}),
    days: file.itinerary.days.map((d) => ({
      ...d,
      items: d.items.map((i) => ({
        ...i,
        id: randomUUID(),
        placeId: i.placeId ? remap.get(i.placeId) : null,
      })),
    })),
  };
  db.exec("BEGIN");
  try {
    for (const p of file.places) savePlace({ ...p, id: remap.get(p.id) });
    saveTrip(trip, req.userId);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  res.json(sendTrip(trip));
});
app.post("/api/trips/:id/audit", limit("audit", 6), async (req, res) => {
  const trip = requireTrip(req);
  const audit = await auditTrip(trip, AbortSignal.timeout(120000));
  const quality = checkPlanQuality(
    trip,
    tripPlaces(trip),
    trip.requirements || defaultRequirements(trip),
    audit,
  );
  audit.quality = { issues: quality.issues };
  for (const day of audit.days)
    day.warnings = [
      ...new Set([
        ...day.warnings,
        ...quality.issues
          .filter((i) => i.day === day.index)
          .map((i) => i.message),
      ]),
    ];
  res.json(saveAudit(trip.id, audit));
});
app.post("/api/trips/:id/share", (req, res) => {
  const trip = requireTrip(req);
  const token = randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO shares VALUES(?,?,?,?,?)").run(
    token,
    req.userId,
    trip.id,
    JSON.stringify({
      ...makeExport(trip, tripPlaces(trip)),
      audit: getAudit(trip.id),
    }),
    new Date().toISOString(),
  );
  res.json({ path: `/share/${token}`, token });
});
app.get("/api/shares/:token", (req, res) => {
  const row = db
    .prepare("SELECT payload FROM shares WHERE token=?")
    .get(req.params.token);
  if (!row) throw new ServiceError("分享链接不存在或已撤回", 404);
  res.json(JSON.parse(row.payload));
});
app.get("/api/my-shares", (req, res) =>
  res.json(
    db
      .prepare(
        "SELECT token,trip_id,created_at FROM shares WHERE user_id=? ORDER BY created_at DESC",
      )
      .all(req.userId),
  ),
);
app.delete("/api/shares/:token", (req, res) => {
  db.prepare("DELETE FROM shares WHERE token=? AND user_id=?").run(
    req.params.token,
    req.userId,
  );
  res.json({ ok: true });
});
app.get("/api/conversations", (req, res) =>
  res.json(
    db
      .prepare(
        "SELECT id,trip_id,messages FROM conversations WHERE user_id=? ORDER BY rowid DESC",
      )
      .all(req.userId)
      .map((r) => ({ ...r, messages: JSON.parse(r.messages) })),
  ),
);
app.delete("/api/conversations/:id", (req, res) => {
  const conversation = db.prepare("SELECT trip_id FROM conversations WHERE id=? AND user_id=?").get(req.params.id, req.userId);
  if (!conversation) throw new ServiceError("草稿不存在", 404);
  if (conversation.trip_id)
    throw new ServiceError("此草稿已生成行程，请在行程列表中删除", 409);
  if (activePlans.get(req.userId)?.conversationId === req.params.id)
    throw new ServiceError("此草稿正在规划，请先取消或等待完成后再删除", 409);
  db.prepare("DELETE FROM conversations WHERE id=? AND user_id=?").run(req.params.id, req.userId);
  res.json({ ok: true });
});
app.post("/api/chat", requireLogin, limit("chat", 6), async (req, res) => {
  const data = z
    .object({
      message: z.string().trim().min(1).max(4000),
      conversationId: z.string().max(100).optional(),
      tripId: z.string().max(100).optional(),
    })
    .parse(req.body);
  if (activePlans.has(req.userId))
    throw new ServiceError("上一段规划尚未结束，请先取消或等待", 409);
  const conversation = data.conversationId
    ? db
        .prepare("SELECT * FROM conversations WHERE id=? AND user_id=?")
        .get(data.conversationId, req.userId)
    : null;
  const id = conversation?.id || randomUUID();
  const history = conversation ? JSON.parse(conversation.messages) : [];
  const existing = data.tripId
    ? getTrip(data.tripId, req.userId)
    : conversation?.trip_id
      ? getTrip(conversation.trip_id, req.userId)
      : null;
  if (data.tripId && !existing) throw new ServiceError("行程不存在", 404);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300000);
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const send = (event, payload) => {
    if (!res.destroyed)
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  activePlans.set(req.userId, { conversationId: id, tripId: existing?.id });
  send("conversation", { id });
  const initial = [...history, { role: "user", content: data.message }];
  let trace;
  try { trace = monitor?.start(req.userId, id, { ...data, history, existing,
    preferences: getUser(req.userId).preferences }); }
  catch (error) { console.warn("AI monitor could not start:", error.name); }
  if (trace) send("trace", { id: trace.id });
  const finishTrace = (status, payload) => {
    try { trace?.finish(status, payload); }
    catch (error) { console.warn("AI monitor could not finish:", error.name); }
  };
  db.prepare(
    "INSERT INTO conversations VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET messages=excluded.messages",
  ).run(id, req.userId, existing?.id || null, JSON.stringify(initial));
  try {
    const result = await withTrace(trace, () => planTrip({
      message: data.message,
      history,
      existing,
      preferences: getUser(req.userId).preferences,
      userId: req.userId,
      signal: controller.signal,
      progress: (content) => { traceEvent("planner.progress", { content }); send("progress", { content }); },
    }, { preloadPlaces: (places) => placePreloader.preload(places),
      trace: (details) => traceEvent("planner." + details.phase, details) }));
    db.prepare(
      "UPDATE conversations SET messages=?,trip_id=? WHERE id=? AND user_id=?",
    ).run(
      JSON.stringify([
        ...initial,
        { role: "assistant", content: result.reply },
      ]),
      result.trip?.id || existing?.id || null,
      id,
      req.userId,
    );
    send("result", { ...result, placeContents: placePreloader.snapshots(result.places), conversationId: id });
    finishTrace("completed", result);
  } catch (e) {
    finishTrace(controller.signal.aborted ? "canceled" : "failed", { name: e.name, error: e.message });
    send("error", {
      error: controller.signal.aborted
        ? "规划已取消或超时，你的需求已保留"
        : e.message,
    });
  } finally {
    clearTimeout(timer);
    activePlans.delete(req.userId);
    res.end();
  }
});
// JS 安全密钥保留在服务端，官方指定的固定代理路径。
app.get("/api/map/config", (req, res) =>
  res.json({
    key: config.amapJsKey,
    serviceHost: `${req.protocol}://${req.get("host")}/_AMapService`,
    style: config.amapStyle,
    mode: config.amapJsKey && config.amapSecurity ? "js" : "static",
  }),
);
app.get(
  /^\/_AMapService\/(v4\/map\/styles|v3\/vectormap|v3\/place\/text|v3\/place\/detail|v3\/direction\/walking|v3\/direction\/driving|v3\/assistant\/coordinate\/convert|maps\/ipLocation|maps\/ipCity)$/,
  async (req, res) => {
    const p = req.path.replace("/_AMapService", "");
    const u = new URL(`https://webapi.amap.com${p}`);
    u.search = new URLSearchParams({
      ...req.query,
      jscode: config.amapSecurity,
    });
    const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
    res
      .status(r.status)
      .set("Content-Type", r.headers.get("content-type") || "application/json")
      .send(Buffer.from(await r.arrayBuffer()));
  },
);
app.get("/api/map/convert", limit("map", 120), async (req, res) => {
  const point = z.object({ lng: z.coerce.number().min(-180).max(180), lat: z.coerce.number().min(-85).max(85) }).parse(req.query);
  const data = await amap("/v3/assistant/coordinate/convert", { locations: `${point.lng.toFixed(6)},${point.lat.toFixed(6)}`, coordsys: "gps" });
  const [lng, lat] = String(data.locations || "").split(",").map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 85) throw new ServiceError("定位坐标转换失败，请重试", 502);
  res.set("Cache-Control", "no-store").json({ lng, lat });
});
app.get("/api/map/static", limit("map", 120), async (req, res) => {
  const data = z
    .object({
      lng: z.coerce.number().min(-180).max(180),
      lat: z.coerce.number().min(-85).max(85),
      zoom: z.coerce.number().int().min(3).max(18),
      width: z.coerce.number().int().min(100).max(1024),
      height: z.coerce.number().int().min(100).max(1024),
    })
    .parse(req.query);
  const image = await amapStaticMap({
    location: `${data.lng.toFixed(6)},${data.lat.toFixed(6)}`,
    zoom: String(data.zoom),
    size: `${data.width}*${data.height}`,
    scale: "1",
  });
  res
    .set("Content-Type", image.contentType)
    .set("Cache-Control", "private,max-age=300")
    .send(image.body);
});
app.use("/api", (req, res) => res.status(404).json({ error: "接口不存在" }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  res.status(error.status || (error instanceof z.ZodError ? 400 : 500)).json({
    error:
      error instanceof z.ZodError
        ? "内容格式不正确，请检查后重试"
        : error.status
          ? error.message
          : "服务出现问题，请稍后重试",
  });
});
if (production) {
  app.use(express.static(path.join(root, "dist")));
  app.get("/{*path}", (req, res) =>
    res.sendFile(path.join(root, "dist/index.html")),
  );
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
app.listen(config.port, config.host, (error) => {
  if (error) {
    console.error(`漫迹启动失败 (${config.host}:${config.port}):`, error.message);
    process.exitCode = 1;
    return;
  }
  console.log(`漫迹 Roamly → http://localhost:${config.port}`);
});
