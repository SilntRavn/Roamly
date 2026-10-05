import test from "node:test";
import assert from "node:assert/strict";
import { serviceJson } from "../server/service-json.mjs";
async function mockFetch(mock, action) {
  const old = globalThis.fetch; globalThis.fetch = mock;
  try { return await action(); } finally { globalThis.fetch = old; }
}
test("AI临时网络中断只重试同一请求一次，不改变消息内容", async () => {
  const requests = [];
  await mockFetch(async (url, options) => { requests.push({ url, body: options.body });
    if (requests.length === 1) throw new TypeError("fetch failed");
    return Response.json({ choices: [] });
  }, async () => {
    const result = await serviceJson("https://example.invalid", { method: "POST", body: '{"messages":[]}' });
    assert.equal(result.response.status, 200);
  });
  assert.equal(requests.length, 2); assert.deepEqual(requests[0], requests[1]);
});
test("临时服务错误有一次重试，认证失败不重试", async () => {
  let calls = 0;
  await mockFetch(async () => { calls++; return calls === 1 ? new Response("temporary", { status: 503 }) : Response.json({ ok: true }); },
    async () => assert.equal((await serviceJson("https://example.invalid", {})).data.ok, true));
  assert.equal(calls, 2); calls = 0;
  await mockFetch(async () => { calls++; return Response.json({ error: "authentication" }, { status: 401 }); },
    async () => assert.equal((await serviceJson("https://example.invalid", {})).response.status, 401));
  assert.equal(calls, 1);
});
test("持续网络故障最多两次请求，用户取消不发请求或重试", async () => {
  let calls = 0;
  await mockFetch(async () => { calls++; throw new TypeError("fetch failed"); },
    async () => assert.rejects(serviceJson("https://example.invalid", {}), /fetch failed/));
  assert.equal(calls, 2); calls = 0;
  const canceled = new AbortController(); canceled.abort();
  await mockFetch(async () => { calls++; }, async () => assert.rejects(serviceJson("https://example.invalid", {}, canceled.signal)));
  assert.equal(calls, 0);
});
