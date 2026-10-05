import test from "node:test";
import assert from "node:assert/strict";
import { createPreloadQueue } from "../shared/preload-queue.mjs";
import { createPlaceContentCache } from "../src/place-content-cache.mjs";
process.env.ROAMLY_DB = ":memory:";
const { createPlacePreloader } = await import("../server/place-preload.mjs");
const { getPlaceContent, getCachedPlaceContent } = await import("../server/place-content.mjs");
const { normalizePoi } = await import("../server/amap.mjs");
const { getPlace, savePlace, db } = await import("../server/db.mjs");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const source = { title: "景区官网", url: "https://official.example.com/intro", updatedAt: "2026-10-04T00:00:00Z" };
const content = { overview: "景区溪谷徒步介绍。", overviewSource: source, bookingChannels: [] };
const makePlace = (id) => savePlace(normalizePoi({ id, name: "测试公园", location: "116.4,39.9", pname: "北京市", cityname: "北京市", adname: "东城区", address: "测试地址", photos: [] }));

test("预加载合并同一任务、最多两项并发，已点击的景点优先，失败释放位置", async () => {
  const gates = new Map(), started = [];
  let concurrent = 0, maxConcurrent = 0;
  const queue = createPreloadQueue(async (id) => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    started.push(id);
    const gate = deferred();
    gates.set(id, gate);
    try { return await gate.promise; } finally { concurrent--; }
  });
  const first = queue("first");
  const second = queue("second");
  const waiting = queue("waiting", { priority: 2 });
  const clicked = queue("clicked", { priority: 2 });
  await tick();
  assert.deepEqual(started, ["first", "second"]);
  assert.equal(queue("clicked", { priority: 0 }), clicked);
  assert.equal(queue("first"), first);
  const rejected = assert.rejects(second, /provider failed/);
  gates.get("second").reject(new Error("provider failed"));
  await rejected;
  await tick();
  assert.deepEqual(started, ["first", "second", "clicked"]);
  gates.get("first").resolve("one");
  gates.get("clicked").resolve("click");
  await tick();
  gates.get("waiting").resolve("last");
  assert.deepEqual(await Promise.all([first, clicked, waiting]), ["one", "click", "last"]);
  assert.equal(maxConcurrent, 2);
});

test("行程后台预加载写入数据库，打开详情、重复行程与新加载器都不再次查询", async () => {
  const place = makePlace("preload-persisted");
  const gate = deferred();
  let queries = 0;
  const load = (id, options) => getPlaceContent(id, { ...options, photos: async (p) => p, lookup: async () => { queries++; return gate.promise; } });
  const preloader = createPlacePreloader({ load });
  preloader.preload([place, place, { id: "ref-fuji" }]);
  preloader.preload([place]);
  const detail = preloader.request(place.id);
  assert.equal(preloader.request(place.id), detail);
  await tick();
  assert.equal(queries, 1);
  gate.resolve(content);
  assert.equal((await detail).status, "ready");
  assert.equal(getPlace(place.id).overview, content.overview);
  assert.equal(getCachedPlaceContent(place.id).expiresAt, null);
  preloader.preload([place]);
  const restarted = createPlacePreloader({ load });
  assert.equal((await restarted.request(place.id)).place.overview, content.overview);
  assert.equal(restarted.snapshots([place])[place.id].status, "ready");
  assert.equal(queries, 1);
});

test("首次失败后最多自动重试5次，次数持久化；重复访问不重置，只能手动开启新一轮", async () => {
  const place = makePlace("preload-retry-limit");
  let queries = 0;
  const delays = [];
  const load = (id, options) => getPlaceContent(id, { ...options, photos: async (p) => p, lookup: async () => {
    queries++;
    assert.equal(getCachedPlaceContent(id).automaticRetries, (queries - 1) % 6);
    throw new Error("ProviderUnavailable");
  } });
  const options = { load, wait: async (ms) => { delays.push(ms); await tick(); } };
  const preloader = createPlacePreloader(options);
  preloader.preload([place]);
  const first = await preloader.request(place.id);
  assert.equal(queries, 6);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000]);
  assert.equal(first.automaticRetries, 5);
  assert.equal(first.manualRetryRequired, true);
  assert.equal(getCachedPlaceContent(place.id).automaticRetries, 5);
  const restarted = createPlacePreloader(options);
  restarted.preload([place]);
  await restarted.request(place.id);
  assert.equal(queries, 6);
  await restarted.request(place.id, { force: true });
  assert.equal(queries, 12);
});

test("自动重试成功即停止，退避等待不阻挡其他景点；中断恢复不重新获得5次", async () => {
  const failing = makePlace("preload-temporary-failure"), other = makePlace("preload-unblocked");
  const retryWait = deferred();
  let attempts = 0, otherQueries = 0;
  const preloader = createPlacePreloader({
    wait: () => retryWait.promise,
    load: (id, options) => getPlaceContent(id, { ...options, photos: async (p) => p, lookup: async () => {
      if (id === failing.id && ++attempts === 1) throw new Error("TemporaryFailure");
      if (id === other.id) otherQueries++;
      return content;
    } }),
  });
  const pending = preloader.request(failing.id);
  await tick();
  assert.equal((await preloader.request(other.id)).status, "ready");
  assert.equal(otherQueries, 1);
  retryWait.resolve();
  assert.equal((await pending).status, "ready");
  assert.equal(attempts, 2);
  await preloader.request(failing.id);
  assert.equal(attempts, 2);
  const interrupted = makePlace("preload-interrupted");
  db.prepare("INSERT INTO place_content_cache VALUES(?,?,0)").run(`official-content-v3:${interrupted.id}`, JSON.stringify({ status: "loading", automaticRetries: 4 }));
  let resumed = 0;
  const recovering = createPlacePreloader({ wait: async () => {}, load: (id, options) => getPlaceContent(id, { ...options, photos: async (p) => p, lookup: async () => { resumed++; throw new Error("StillUnavailable"); } }) });
  assert.equal((await recovering.request(interrupted.id)).manualRetryRequired, true);
  assert.equal(resumed, 1);
});

test("前端预加载完成即同步缓存与订阅者，打开立即复用，刷新合并，旧快照不覆盖新资料", async () => {
  const place = { id: "amap-client", photo: "", photos: [] };
  const gate = deferred();
  let queries = 0;
  const updates = [];
  const cache = createPlaceContentCache({ request: async () => { queries++; return gate.promise; } });
  const unsubscribe = cache.subscribe((result) => updates.push(result));
  cache.preload([place, place]);
  const clicked = cache.load(place.id);
  assert.equal(cache.load(place.id), clicked);
  await tick();
  assert.equal(queries, 1);
  const result = { place: { ...place, ...content }, status: "ready", checkedAt: "2026-10-04T01:00:00Z", expiresAt: null };
  gate.resolve(result);
  await clicked;
  assert.equal(cache.get(place.id), result);
  assert.equal(await cache.load(place.id), result);
  cache.preload([place]);
  assert.equal(queries, 1);
  cache.remember({ ...result, checkedAt: "2026-10-03T00:00:00Z", place });
  assert.equal(cache.get(place.id), result);
  cache.remember({ ...result, status: "loading" });
  cache.remember({ ...result, status: "error", automaticRetries: 1 });
  assert.equal(cache.get(place.id), result);
  const forced = cache.load(place.id, { force: true });
  assert.equal(cache.load(place.id, { force: true }), forced);
  await forced;
  assert.equal(queries, 2);
  unsubscribe();
  assert.equal(updates.length, 2);
});
