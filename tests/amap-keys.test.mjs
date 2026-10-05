import test from "node:test";
import assert from "node:assert/strict";
import { parseAmapWebKeys, createAmapKeyRotation } from "../server/amap-keys.mjs";
import { config } from "../server/config.mjs";
import { amap, amapStaticMap, ServiceError } from "../server/amap-client.mjs";

const keys = ["key-one", "key-two", "key-three"];
const ok = () => Response.json({ status: "1", info: "OK", infocode: "10000", pois: [] });
const failure = (infocode, info = "QUOTA_EXCEEDED") => Response.json({ status: "0", infocode, info });

async function withFetch(mock, run, configuredKeys = keys) {
  const previousKeys = config.amapKeys;
  const previousFetch = globalThis.fetch;
  config.amapKeys = [...configuredKeys];
  globalThis.fetch = mock;
  try { await run(); }
  finally { config.amapKeys = previousKeys; globalThis.fetch = previousFetch; }
}

test("读取全部编号 Web Key，按编号排序并去重，不混入 JS Key 与文档链接", () => {
  assert.deepEqual(parseAmapWebKeys({
    "高德api3": " key-three ", "高德 API 1": "key-one", "高德api10": "key-ten",
    "高德api2": "key-two", "高德api4": "key-three", "高德api5": "",
    "高德JS": "js-key", "高德底图js api": "style", "高德webapi文档": "documentation",
  }), [...keys, "key-ten"]);
  assert.deepEqual(parseAmapWebKeys({ "高德api3": "local" }, " env-one,env-two, env-one, "), ["env-one", "env-two"]);
});

test("正常请求按 1→2→3 轮询，重试列表独立，Key 数量变化及空配置均可处理", () => {
  const next = createAmapKeyRotation();
  const first = next(keys);
  assert.deepEqual(first, keys);
  assert.deepEqual(next(keys), [keys[1], keys[2], keys[0]]);
  assert.deepEqual(next(keys), [keys[2], keys[0], keys[1]]);
  assert.deepEqual(next(keys), keys);
  assert.deepEqual(first, keys);
  assert.deepEqual(next([]), []);
  assert.deepEqual(next([keys[0]]), [keys[0]]);
});

test("地点搜索、详情和路线在成功请求之间轮换，共享同一池", async () => {
  const seen = [];
  await withFetch(async (url) => {
    seen.push({ key: url.searchParams.get("key"), path: url.pathname });
    return ok();
  }, async () => {
    for (const endpoint of ["/v3/place/text", "/v3/place/detail", "/v3/direction/walking"]) {
      assert.equal((await amap(endpoint, { keywords: "景点" })).status, "1");
    }
  });
  assert.deepEqual(seen.map((entry) => entry.key), keys);
  assert.deepEqual(seen.map((entry) => entry.path), ["/v3/place/text", "/v3/place/detail", "/v3/direction/walking"]);
});

test("静态地图也轮询且额度不足时切换 Key，保留图片内容和类型", async () => {
  const seen = [];
  const bytes = new Uint8Array([137, 80, 78, 71]);
  await withFetch(async (url) => {
    seen.push({ key: url.searchParams.get("key"), path: url.pathname });
    if (seen.length < 3) return failure("10003");
    if (url.pathname === "/v3/staticmap") return new Response(bytes, { headers: { "content-type": "image/png" } });
    return ok();
  }, async () => {
    const image = await amapStaticMap({ location: "120.1,30.2", size: "100*100", zoom: "13" });
    assert.equal(image.contentType, "image/png");
    assert.deepEqual(image.body, Buffer.from(bytes));
    await amap("/v3/place/text", { keywords: "景点" });
  });
  assert.equal(seen.length, 4);
  assert.equal(new Set(seen.slice(0, 3).map((entry) => entry.key)).size, 3);
  assert.equal(seen[3].key, seen[1].key);
  assert.ok(seen.slice(0, 3).every((entry) => entry.path === "/v3/staticmap"));
});

test("并发请求固定各自候选，不因另一请求完成而跳过或重复重试 Key", async () => {
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  const seen = { slow: [], fast: [] };
  await withFetch(async (url) => {
    const name = url.searchParams.get("keywords");
    seen[name].push(url.searchParams.get("key"));
    if (name === "slow" && seen.slow.length === 1) { await delayed; return failure("10003"); }
    if (name === "slow" && seen.slow.length === 2) return failure("10004");
    return ok();
  }, async () => {
    const slow = amap("/v3/place/text", { keywords: "slow" });
    try { await amap("/v3/place/text", { keywords: "fast" }); }
    finally { release(); }
    await slow;
  });
  assert.equal(seen.slow.length, 3);
  assert.equal(new Set(seen.slow).size, 3);
  assert.equal(seen.fast[0], seen.slow[1]);
});

for (const code of ["10001", "10003", "10004", "10009", "10020", "10021", "10044", "10045"]) {
  test(`高德错误 ${code} 尝试其余 Key，每个最多一次`, async () => {
    const seen = [];
    await withFetch(async (url) => { seen.push(url.searchParams.get("key")); return failure(code); }, async () => {
      await assert.rejects(amap("/v3/place/text", { keywords: "景点" }), ServiceError);
    });
    assert.equal(seen.length, 3);
    assert.equal(new Set(seen).size, 3);
  });
}

test("参数错误不使用备用 Key，避免浪费配额", async () => {
  let requests = 0;
  await withFetch(async () => { requests++; return failure("20001", "INVALID_PARAMS"); }, async () => {
    await assert.rejects(amap("/v3/place/text", { keywords: "景点" }), /INVALID_PARAMS/);
  });
  assert.equal(requests, 1);
});

test("HTTP 限流或平台异常也尝试剩余 Key，包括非 JSON 错误响应", async () => {
  let requests = 0;
  await withFetch(async () => {
    requests++;
    if (requests === 1) return new Response("rate limited", { status: 429 });
    if (requests === 2) return new Response("unavailable", { status: 503 });
    return ok();
  }, async () => { assert.equal((await amap("/v3/place/text", { keywords: "景点" })).status, "1"); });
  assert.equal(requests, 3);
});

test("取消中的请求不继续轮询；取消前未开始的请求不调用高德", async () => {
  const controller = new AbortController();
  let requests = 0;
  await withFetch(async () => {
    requests++;
    controller.abort();
    return failure("10003");
  }, async () => {
    await assert.rejects(amap("/v3/place/text", { keywords: "景点" }, controller.signal), { name: "AbortError" });
    await assert.rejects(amap("/v3/place/text", { keywords: "景点" }, controller.signal), { name: "AbortError" });
  });
  assert.equal(requests, 1);
});

test("没有配置 Key 时返回 503，不发送请求", async () => {
  await withFetch(async () => { assert.fail("不应发送请求"); }, async () => {
    await assert.rejects(amap("/v3/place/text", {}), (error) => error instanceof ServiceError && error.status === 503);
  }, []);
});
