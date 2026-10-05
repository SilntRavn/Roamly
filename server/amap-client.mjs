import { config } from "./config.mjs";
import { createAmapKeyRotation } from "./amap-keys.mjs";

const nextKeys = createAmapKeyRotation();
const retryCodes = new Set([
  "10001", "10003", "10004", "10009", "10020", "10021", "10044", "10045",
]);

export class ServiceError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

async function requestAmap(endpoint, params, signal, image = false) {
  const keys = nextKeys(config.amapKeys);
  if (!keys.length) throw new ServiceError("高德 Web 服务尚未配置", 503);
  let last;
  for (const key of keys) {
    signal?.throwIfAborted();
    const url = new URL(`https://restapi.amap.com${endpoint}`);
    url.search = new URLSearchParams({ ...params, key, output: "JSON" });
    const response = await fetch(url, {
      signal: signal || AbortSignal.timeout(image ? 12000 : 15000),
    });
    if (image && response.ok && response.headers.get("content-type")?.startsWith("image/")) {
      return {
        body: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get("content-type"),
      };
    }
    const httpRetry = response.status === 429 || response.status >= 500;
    let data;
    try {
      data = await response.json();
    } catch (error) {
      if (signal?.aborted || error.name === "AbortError" || error.name === "TimeoutError") throw error;
      last = `HTTP ${response.status}`;
      if (httpRetry) continue;
      break;
    }
    if (!image && data.status === "1") return data;
    last = data.info || `HTTP ${response.status}`;
    if (!httpRetry && !retryCodes.has(String(data.infocode))) break;
  }
  throw new ServiceError(`高德服务暂不可用（${last || "请求失败"}）`);
}

// 地点检索、详情、路径规划和静态底图共用一次请求一个首选 Key 的轮询池。
export function amap(endpoint, params, signal) {
  return requestAmap(endpoint, params, signal);
}

export function amapStaticMap(params, signal) {
  return requestAmap("/v3/staticmap", params, signal, true);
}
