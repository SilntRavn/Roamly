import { createPreloadQueue } from "../shared/preload-queue.mjs";
import { getCachedPlaceContent, getPlaceContent } from "./place-content.mjs";
import { getPlace } from "./db.mjs";
import { ServiceError } from "./amap.mjs";

const retryDelays = [1000, 2000, 4000, 8000, 16000];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const finished = (result) => result && (result.status === "ready" || result.status === "empty" || result.status === "local" || (result.status === "error" && (result.automaticRetries || 0) >= 5));

export function createPlacePreloader({ load = getPlaceContent, cached = getCachedPlaceContent, lookup = getPlace, wait = sleep } = {}) {
  const enqueue = createPreloadQueue(load, { concurrency: 2 });
  const active = new Map();
  function request(id, { force = false, priority = 0 } = {}) {
    if (!lookup(id)) return Promise.reject(new ServiceError("景点不存在", 404));
    const ongoing = active.get(id);
    if (ongoing) {
      ongoing.priority = Math.min(ongoing.priority, priority);
      enqueue.promote(id, priority);
      return ongoing.promise;
    }
    const ready = !force && cached(id);
    if (finished(ready)) return Promise.resolve(ready);
    const job = { priority, promise: null };
    job.promise = (async () => {
      let result = ready || await enqueue(id, { force, priority: job.priority });
      if (result.status === "loading") result = { ...result, status: "error" };
      while (result.status === "error" && (result.automaticRetries || 0) < 5) {
        await wait(retryDelays[result.automaticRetries || 0]);
        // 等待退避时释放全局并发位置，让其他景点继续预加载。
        result = await enqueue(id, { force: true, automaticRetry: true, priority: job.priority });
      }
      return result;
    })();
    active.set(id, job);
    job.promise.then(() => active.delete(id), () => active.delete(id));
    return job.promise;
  }
  function preload(places, priority = 1) {
    for (const id of new Set(places.map((place) => typeof place === "string" ? place : place.id))) {
      if (!/^amap-[A-Za-z0-9_-]+$/.test(id) || !lookup(id) || finished(cached(id))) continue;
      // 后台失败由内容缓存记录，不能影响规划、读行程或其他景点的加载。
      request(id, { priority }).catch(() => {});
    }
  }
  function snapshots(places) {
    return Object.fromEntries(places.flatMap((place) => {
      const result = cached(place.id);
      if (!result) return [];
      const { place: ignored, ...metadata } = result;
      return [[place.id, metadata]];
    }));
  }
  return { request, preload, snapshots };
}

export const placePreloader = createPlacePreloader();
