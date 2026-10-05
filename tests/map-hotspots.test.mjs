import test from "node:test";
import assert from "node:assert/strict";
import { createHotspotSelection } from "../src/map-hotspots.mjs";

function setup() {
  const requests = [], selected = [], errors = [], loading = [];
  let dismissals = 0;
  const selection = createHotspotSelection({
    resolve: (id, signal) => new Promise((resolve, reject) => requests.push({ id, signal, resolve, reject })),
    select: (p) => selected.push(p), dismiss: () => dismissals++,
    loading: (v) => loading.push(v), error: (e) => { if (e) errors.push(e); },
  });
  return { selection, requests, selected, errors, loading, dismissals: () => dismissals };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("底图点击使用高德 ID，先清除旧卡片，再选择查询结果", async () => {
  const s = setup();
  const request = s.selection.hotspotClick({ id: "B01234" });
  assert.equal(s.requests[0].id, "amap-B01234");
  assert.equal(s.dismissals(), 1);
  assert.equal(s.loading.at(-1), true);
  s.requests[0].resolve({ id: "amap-B01234" });
  await request;
  assert.deepEqual(s.selected, [{ id: "amap-B01234" }]);
  assert.equal(s.loading.at(-1), false);
});
test("同次点击先后触发空白和热点事件，不会关闭新卡片", async () => {
  const s = setup();
  s.selection.beginGesture();
  s.selection.blankClick();
  const request = s.selection.hotspotClick({ id: "first" });
  s.selection.blankClick();
  s.requests[0].resolve({ id: "first" });
  await request;
  await tick();
  assert.equal(s.dismissals(), 1);
  assert.equal(s.selected.length, 1);
  s.selection.beginGesture();
  s.selection.blankClick();
  await tick();
  assert.equal(s.dismissals(), 2);
});
test("连续点击只显示最新点位；旧请求即使忽略取消也不能覆盖", async () => {
  const s = setup();
  const first = s.selection.hotspotClick({ id: "first" });
  const second = s.selection.hotspotClick({ id: "second" });
  assert.equal(s.requests[0].signal.aborted, true);
  s.requests[1].resolve({ id: "second" });
  await second;
  s.requests[0].resolve({ id: "first" });
  await first;
  assert.deepEqual(s.selected, [{ id: "second" }]);
});
test("选择已有行程标记会取消底图查询，并保留行程标记卡片", async () => {
  const s = setup();
  const request = s.selection.hotspotClick({ id: "pending" });
  s.selection.select({ id: "existing" });
  s.selection.blankClick();
  s.requests[0].resolve({ id: "pending" });
  await request;
  await tick();
  assert.equal(s.requests[0].signal.aborted, true);
  assert.deepEqual(s.selected, [{ id: "existing" }]);
  assert.equal(s.dismissals(), 1);
});
test("关闭或卸载地图后，请求结果和错误不会重新打开卡片", async () => {
  for (const action of ["dismiss", "dispose"]) {
    const s = setup();
    const request = s.selection.hotspotClick({ id: "pending" });
    s.selection[action]();
    const count = s.loading.length;
    s.requests[0].reject(new Error("旧请求失败"));
    await request;
    assert.equal(s.requests[0].signal.aborted, true);
    assert.equal(s.selected.length, 0);
    assert.equal(s.errors.length, 0);
    assert.equal(s.loading.length, count);
  }
});
test("加载失败显示提示，随后可以重新点击查询", async () => {
  const s = setup();
  const request = s.selection.hotspotClick({ id: "first" });
  s.requests[0].reject(new Error("暂时无法获取资料"));
  await request;
  assert.deepEqual(s.errors, ["暂时无法获取资料"]);
  assert.equal(s.loading.at(-1), false);
  const retry = s.selection.hotspotClick({ id: "first" });
  s.requests[1].resolve({ id: "first" });
  await retry;
  assert.equal(s.selected.length, 1);
});
test("缺失或非法热点 ID 不发请求", async () => {
  const s = setup();
  for (const id of [undefined, "", "../key.txt", "a".repeat(65)]) await s.selection.hotspotClick({ id });
  assert.equal(s.requests.length, 0);
});
