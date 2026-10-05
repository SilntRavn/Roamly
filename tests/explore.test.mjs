import test from "node:test";
import assert from "node:assert/strict";
process.env.ROAMLY_DB = ":memory:";
const { savePlace, db } = await import("../server/db.mjs");
const { normalizePoi } = await import("../server/amap.mjs");
const { config } = await import("../server/config.mjs");
const { mapPlaces } = await import("../server/map-pois.mjs");
const { matchesExploreCategory, snapExploreSheet, exploreSearchArea, shouldReloadExplore, insideExploreBounds } = await import("../shared/explore.mjs");
const { parseExploreResponse, ensureExploreFeed, readExploreFeed, waitExploreFeed, exploreFeedKey, lookupExploreNotes, readExploreNote, readCachedExploreNearby } = await import("../server/explore.mjs");
const place = savePlace(normalizePoi({ id: "explore-test", name: "附近公园", type: "风景名胜;公园广场;公园", location: "120.121,30.221", cityname: "杭州市" }));
const url = "https://travel.example.com/nearby-park";
const bounds = { west: 120.1, south: 30.2, east: 120.14, north: 30.24 };
const note = { title: "公园里的慢时光", summary: "公开游记总结的公园体验。", tags: ["散步"], sections: [{ heading: "沿湖走走", body: "游记提到沿湖步道适合慢走。", placeIds: [place.id], sourceUrls: [url] }] };
const verdict = { placeId: place.id, worthVisiting: true, reason: "公开游记记录了沿湖步道，适合散步观景。", sourceUrls: [url] };
const response = (notes = [note], recommendations = [verdict]) => ({ output: [
  { type: "web_search_call", status: "completed" },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: `\`\`\`json\n${JSON.stringify({ notes, recommendations })}\n\`\`\``, annotations: [{ type: "url_citation", url, title: "公园体验游记" }] }] },
] });

test("景点与娱乐分开，住宿与餐饮按完整高德类型分类，三档滑动可进退", () => {
  for (const name of ["KTV", "桌游", "剧本杀", "密室逃脱", "台球馆"]) {
    assert.equal(matchesExploreCategory("scenery", "风景名胜", name), false);
    assert.equal(matchesExploreCategory("fun", "娱乐场所", name), true);
  }
  assert.equal(matchesExploreCategory("scenery", "科教文化服务;博物馆"), true);
  assert.equal(matchesExploreCategory("scenery", "科教文化服务;高等院校"), false);
  assert.equal(matchesExploreCategory("food", "餐饮服务;中餐厅;江苏菜"), true);
  assert.equal(matchesExploreCategory("stay", "住宿服务;宾馆酒店;四星级宾馆"), true);
  assert.equal(matchesExploreCategory("fun", "风景名胜;公园"), false);
  assert.equal(matchesExploreCategory("scenery", "体育休闲服务;娱乐场所;游乐场", "主题乐园"), true);
  assert.equal(matchesExploreCategory("scenery", "风景名胜", "景区管理委员会"), false);
  for (const name of ["上保社区文化小广场", "文化广场", "幸福小区", "社区公园", "老和山四角凉亭", "抗战纪念坊"]) assert.equal(matchesExploreCategory("scenery", "风景名胜;公园", name), false);
  assert.equal(matchesExploreCategory("fun", "体育休闲服务;体育休闲服务场所", "咖啡馆"), false);
  assert.equal(matchesExploreCategory("fun", "体育休闲服务;运动场馆;健身中心"), false);
  assert.equal(snapExploreSheet(0, -100), 1);
  assert.equal(snapExploreSheet(1, -100), 2);
  assert.equal(snapExploreSheet(2, 100), 1);
  assert.equal(snapExploreSheet(1, 100), 0);
  assert.equal(snapExploreSheet(1, 10), 1);
});

test("笔记只接受有真实工具引用、可绑定已知POI的段落，拒绝伪URL与未知地点", () => {
  const notes = parseExploreResponse(response(), [place], "scenery");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].sources[0].url, url);
  assert.deepEqual(notes[0].placeIds, [place.id]);
  for (const invalid of ["https://madeup.example.com/post", "javascript:alert(1)"]) {
    const forged = structuredClone(note);
    forged.sections[0].sourceUrls = [invalid];
    assert.throws(() => parseExploreResponse(response([forged]), [place], "scenery"), /Ungrounded/);
  }
  const missing = structuredClone(note);
  missing.sections[0].placeIds = ["amap-invented"];
  assert.throws(() => parseExploreResponse(response([missing]), [place], "scenery"), /Ungrounded/);
  assert.throws(() => parseExploreResponse({ output: response().output.slice(1) }, [place], "scenery"), /MissingWebSearch/);
  assert.deepEqual(parseExploreResponse(response([]), [place], "scenery"), []);
  assert.equal(notes[0].recommendations[0].reason, verdict.reason);
  assert.deepEqual(parseExploreResponse(response([note], [{ ...verdict, worthVisiting: false }]), [place], "scenery"), []);
  assert.throws(() => parseExploreResponse(response([note], []), [place], "scenery"), /Ungrounded/);
  assert.throws(() => parseExploreResponse(response([note], [{ ...verdict, sourceUrls: ["https://fake.example.com"] }]), [place], "scenery"), /Ungrounded/);
});

test("5/10公里固定推荐区域在范围内拖动和缩放不重新加载，移出圆形范围才更新", () => {
  const center = { lng: 120.12, lat: 30.22 };
  const area = exploreSearchArea(center, 5000);
  assert.equal(shouldReloadExplore(center, null), true);
  assert.equal(shouldReloadExplore({ ...center, lat: center.lat + .04, zoom: 16 }, area), false);
  assert.equal(shouldReloadExplore({ ...center, lat: center.lat + .05, zoom: 13 }, area), true);
  const wider = exploreSearchArea(center, 10000);
  assert.deepEqual(exploreSearchArea(center), wider);
  assert.equal(shouldReloadExplore({ ...center, lat: center.lat + .05 }, wider), false);
  assert.equal(insideExploreBounds(place, area), true);
  const corner = { location: { lng: area.east, lat: area.north, coordSystem: "GCJ-02" } };
  assert.equal(insideExploreBounds(corner, area), false);
  assert.notEqual(exploreFeedKey(area, "scenery"), exploreFeedKey(wider, "scenery"));
});

test("附近笔记并发合并并永久固化，刷新失败保留已保存摘要，错误不自动反复请求", async () => {
  let calls = 0;
  const lookup = async () => { calls++; return parseExploreResponse(response(), [place], "scenery"); };
  const first = ensureExploreFeed(bounds, "scenery", [place], { lookup });
  const second = ensureExploreFeed(bounds, "scenery", [place], { lookup });
  assert.equal(first.key, second.key);
  assert.equal(first.status, "loading");
  const ready = await waitExploreFeed(first.key);
  assert.equal(ready.status, "ready");
  assert.equal(calls, 1);
  assert.equal(ensureExploreFeed(bounds, "scenery", [place], { lookup }).notes.length, 1);
  assert.equal(calls, 1);
  assert.deepEqual(readExploreNote(ready.notes[0].id).places.map((p) => p.id), [place.id]);
  const failed = ensureExploreFeed(bounds, "scenery", [place], { force: true, lookup: async () => { calls++; throw new Error("ToolNotOpen-secret"); } });
  const retained = await waitExploreFeed(failed.key);
  assert.equal(retained.status, "error");
  assert.equal(retained.notes.length, 1);
  assert.ok(!JSON.stringify(retained).includes("ToolNotOpen-secret"));
  ensureExploreFeed(bounds, "scenery", [place], { lookup });
  assert.equal(calls, 2);
  assert.notEqual(exploreFeedKey(bounds, "food"), first.key);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM explore_notes").get().n, 1);
  assert.equal(readExploreFeed(first.key).notes[0].sources[0].url, url);
  assert.throws(() => readExploreNote("missing"), { status: 404 });
});

test("10公里区域直接读取固化笔记与地图点位，重新打开和小幅中心偏移复用缓存", async () => {
  const area = exploreSearchArea({ lng: 120.12, lat: 30.22 });
  const cached = ensureExploreFeed(area, "scenery", [place], { lookup: async () => parseExploreResponse(response(), [place], "scenery") });
  await waitExploreFeed(cached.key);
  const exact = readCachedExploreNearby(area, "scenery");
  assert.equal(exact.feed.status, "ready");
  assert.equal(exact.places[0].id, place.id);
  assert.equal(exact.feed.notes.length, 1);
  const nearby = readCachedExploreNearby(exploreSearchArea({ lng: 120.121, lat: 30.221 }), "scenery");
  assert.equal(nearby.feed.key, exact.feed.key);
  assert.equal(readCachedExploreNearby(area, "food"), null);
  assert.equal(readCachedExploreNearby(exploreSearchArea({ lng: 121, lat: 30.22 }), "scenery"), null);
  assert.throws(() => readCachedExploreNearby({ ...area, east: area.west - 1 }, "scenery"), { status: 400 });
});

test("分类地图仅返回当前区域与所选类别，餐饮细类保留，缓存跨分类隔离", async (t) => {
  const oldKeys = config.amapKeys;
  config.amapKeys = ["test-key"];
  t.after(() => { config.amapKeys = oldKeys; });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(url);
    const category = url.searchParams.get("types");
    const item = (id, type, location = "120.121,30.221", name = id) => ({ id, name, type, location, cityname: "杭州市" });
    return { json: async () => ({ status: "1", count: "3", pois: category === "050000"
      ? [item("noodles", "餐饮服务;中餐厅;江苏菜"), item("outside", "餐饮服务;小吃", "121,31"), item("ktv", "娱乐场所;KTV")]
      : [item("hotel", "住宿服务;宾馆酒店"), item("school", "科教文化服务;学校"), item("outside-stay", "住宿服务;旅馆", "121,31")] }) };
  });
  assert.deepEqual((await mapPlaces(bounds, "food")).map((p) => p.id), ["amap-noodles"]);
  assert.deepEqual((await mapPlaces(bounds, "stay")).map((p) => p.id), ["amap-hotel"]);
  await mapPlaces(bounds, "food");
  assert.equal(calls.length, 6);
  await assert.rejects(() => mapPlaces(bounds, "unknown"), { status: 400 });
});

test("笔记联网使用Responses工具，凭据与供应商错误不泄漏到公开结果", async (t) => {
  const original = { key: config.contentKey, base: config.contentBase, model: config.contentModel };
  config.contentKey = "test-content-key"; config.contentBase = "https://content.example.com/api/v3"; config.contentModel = "test-content-model";
  t.after(() => { config.contentKey = original.key; config.contentBase = original.base; config.contentModel = original.model; });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://content.example.com/api/v3/responses");
    const body = JSON.parse(options.body);
    assert.equal(body.tools[0].type, "web_search");
    assert.equal(body.store, false);
    assert.match(body.input[0].content, /小红书公开网页/);
    if (++calls === 1) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(response()), { status: 200 });
  });
  assert.equal((await lookupExploreNotes([place], "scenery", AbortSignal.timeout(1000))).length, 1);
  assert.equal(calls, 2);
});

test("附近地点网络中断只短重试一次，持续失败返回明确的服务错误", async (t) => {
  const oldKeys = config.amapKeys;
  config.amapKeys = ["test-key"];
  t.after(() => { config.amapKeys = oldKeys; });
  const calls = new Map();
  let failing = false;
  t.mock.method(globalThis, "fetch", async (url) => {
    const key = url.searchParams.get("location");
    const count = (calls.get(key) || 0) + 1;
    calls.set(key, count);
    if (failing || count === 1) throw new TypeError("fetch failed");
    return { json: async () => ({ status: "1", count: "0", pois: [] }) };
  });
  assert.deepEqual(await mapPlaces({ west: 119.8, south: 30.2, east: 119.84, north: 30.24 }, "scenery"), []);
  assert.deepEqual([...calls.values()], [2, 2, 2]);
  calls.clear(); failing = true;
  await assert.rejects(() => mapPlaces({ west: 119.7, south: 30.2, east: 119.74, north: 30.24 }, "scenery"), { status: 502, message: "附近地点查询暂时无法连接，请稍后重试" });
  assert.ok([...calls.values()].every((count) => count <= 2));
});

test("刷新补充笔记不会覆盖原列表，失败与空结果都保留旧笔记，小幅偏移不重开整理", async () => {
  const area = exploreSearchArea({ lng: 120.19, lat: 30.22 });
  const makeNotes = (title) => parseExploreResponse(response([{ ...note, title }]), [place], "scenery");
  const initial = ensureExploreFeed(area, "scenery", [place], { lookup: async () => makeNotes("第一篇需要保留") });
  const before = await waitExploreFeed(initial.key);
  const refresh = ensureExploreFeed(area, "scenery", [place], { force: true, lookup: async () => makeNotes("第二篇新增内容") });
  const after = await waitExploreFeed(refresh.key);
  for (const oldNote of before.notes) assert.ok(after.notes.some((note) => note.id === oldNote.id));
  assert.ok(after.notes.some((note) => note.title === "第二篇新增内容"));
  const empty = ensureExploreFeed(area, "scenery", [place], { force: true, lookup: async () => [] });
  assert.deepEqual((await waitExploreFeed(empty.key)).notes.map((n) => n.id), after.notes.map((n) => n.id));
  const failed = ensureExploreFeed(area, "scenery", [place], { force: true, lookup: async () => { throw new Error("failure"); } });
  await waitExploreFeed(failed.key);
  const cached = readCachedExploreNearby(exploreSearchArea({ lng: 120.191, lat: 30.221 }), "scenery");
  assert.equal(cached.feed.key, initial.key);
  assert.equal(cached.feed.status, "error");
  assert.deepEqual(cached.feed.notes.map((n) => n.id), after.notes.map((n) => n.id));
  const legacy = exploreSearchArea({ lng: 121, lat: 31 });
  db.prepare("INSERT INTO explore_feeds VALUES(?,?,?)").run("explore-v1-old", JSON.stringify({ category: "scenery", bounds: legacy, status: "ready", noteIds: before.notes.map((n) => n.id) }), new Date().toISOString());
  assert.equal(readCachedExploreNearby(legacy, "scenery"), null);
});

test("按地点坐标汇总共享笔记：旧5公里分组、无分组笔记与空缓存均不阻挡10公里内全部结果", async () => {
  const { createGuest } = await import("../server/db.mjs");
  const area = exploreSearchArea({ lng: 122.148, lat: 32.242 });
  const nearby = savePlace(normalizePoi({ id: "shared-spatial", name: "湖畔公园", type: "风景名胜;公园", location: "122.15,32.24", cityname: "测试市" }));
  const corner = savePlace({ ...nearby, id: "spatial-corner", location: { lng: area.east - .001, lat: area.north - .001, coordSystem: "GCJ-02" } });
  const wgs = savePlace({ ...nearby, id: "spatial-wgs", location: { ...nearby.location, coordSystem: "WGS84" } });
  const saved = Array.from({ length: 13 }, (_, index) => ({ ...parseExploreResponse(response(), [place], "scenery")[0], id: `spatial-note-${index}`, title: `附近已存笔记 ${index}`, placeIds: [nearby.id] }));
  const insert = (note) => db.prepare("INSERT INTO explore_notes VALUES(?,?,?,?)").run(note.id, note.category, JSON.stringify(note), note.updatedAt);
  saved.forEach(insert);
  insert({ ...saved[0], id: "spatial-outside", placeIds: [corner.id] });
  insert({ ...saved[0], id: "spatial-other-coordinates", placeIds: [wgs.id] });
  insert({ ...saved[0], id: "spatial-other-category", category: "food" });
  db.prepare("INSERT INTO explore_feeds VALUES(?,?,?)").run("explore-v1-spatial-old", JSON.stringify({ category: "scenery", bounds: exploreSearchArea(area, 5000), status: "ready", noteIds: saved.slice(0, 8).map((n) => n.id) }), new Date().toISOString());
  db.prepare("INSERT INTO explore_feeds VALUES(?,?,?)").run(exploreFeedKey(area, "scenery"), JSON.stringify({ category: "scenery", bounds: area, status: "empty", noteIds: [], nearbyPlaceIds: [], message: "空的旧查询" }), new Date().toISOString());
  const users = [createGuest(), createGuest()];
  users.forEach((user) => db.prepare("INSERT INTO note_favorites VALUES(?,?,?)").run(user, saved[2].id, new Date().toISOString()));
  const found = readCachedExploreNearby(area, "scenery");
  assert.equal(found.feed.status, "ready");
  assert.equal(found.feed.message, "");
  assert.equal(found.feed.notes.length, 13);
  assert.equal(found.feed.notes.find((n) => n.id === saved[2].id).favoriteCount, 2);
  assert.equal(found.places.some((p) => p.id === nearby.id), true);
  const shifted = readCachedExploreNearby(exploreSearchArea({ lng: 122.17, lat: 32.242 }), "scenery");
  assert.equal(shifted.feed.notes.length, 13);
  insert({ ...saved[0], id: "spatial-new-other-user" });
  assert.equal(readCachedExploreNearby(area, "scenery").feed.notes.length, 14);
});

test("自动补充只弥补区域下限，空结果后不同用户与邻近中心共用冷却，工业区不生成", async () => {
  const area = exploreSearchArea({ lng: 123.148, lat: 33.242 });
  const parks = Array.from({ length: 5 }, (_, index) => savePlace(normalizePoi({ id: `quality-park-${index}`, name: `湖畔公园${index}`, type: "风景名胜;公园", location: `${123.15 + index * .002},33.24` })));
  let calls = 0;
  const lookup = async (_places, _category, _signal, options) => { calls++; assert.equal(options.targetCount, 4); return []; };
  const first = ensureExploreFeed(area, "scenery", parks, { lookup });
  assert.equal(first.quality.minimumNotes, 4);
  await waitExploreFeed(first.key);
  assert.equal(ensureExploreFeed(area, "scenery", parks, { lookup }).status, "empty");
  assert.equal(ensureExploreFeed(exploreSearchArea({ lng: 123.17, lat: 33.242 }), "scenery", parks, { lookup }).status, "empty");
  assert.equal(calls, 1);
  const industrial = exploreSearchArea({ lng: 124.148, lat: 34.242 });
  const factory = savePlace(normalizePoi({ id: "quality-factory", name: "工业园工厂", type: "公司企业;工厂", location: "124.15,34.24" }));
  const empty = ensureExploreFeed(industrial, "scenery", [factory], { lookup });
  assert.equal(empty.status, "empty");
  assert.equal(empty.quality.minimumNotes, 0);
  assert.equal(calls, 1);
});
