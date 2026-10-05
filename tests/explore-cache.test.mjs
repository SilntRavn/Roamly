import test from "node:test";
import assert from "node:assert/strict";
import { createExploreViewCache, readExploreState, writeExploreState } from "../src/explore-cache.mjs";
import { exploreSearchArea } from "../shared/explore.mjs";
const storage = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
};
const result = (title) => ({ places: [{ id: "place" }], feed: { status: "ready", notes: [{ id: "note", title }], places: [{ id: "place" }] } });
test("返回探索、切换分类和页面重载可直接复用已保存视图，容量有界", () => {
  const session = storage();
  const cache = createExploreViewCache(session, 2);
  cache.set("scenery", result("已保存景点"));
  cache.set("food", result("已保存美食"));
  const reopened = createExploreViewCache(session, 2);
  assert.equal(reopened.get("scenery").feed.notes[0].title, "已保存景点");
  assert.equal(reopened.get("food").feed.notes[0].title, "已保存美食");
  reopened.set("stay", result("住宿"));
  assert.equal(createExploreViewCache(session, 2).get("scenery"), undefined);
});
test("地图锚点和面板状态在重载后保留；损坏或不可用的存储不会阻断探索", () => {
  const session = storage();
  const fallback = { category: "scenery", area: null, search: null, sheet: 1, scroll: 0 };
  const state = { ...fallback, area: { lng: 120, lat: 30, zoom: 13 }, search: exploreSearchArea({ lng: 120, lat: 30 }), sheet: 2, scroll: 120 };
  writeExploreState(session, state);
  assert.deepEqual(readExploreState(session, fallback), state);
  writeExploreState(session, { ...state, area: { lng: "bad", lat: 30, zoom: 13 } });
  assert.deepEqual(readExploreState(session, fallback), fallback);
  const blocked = { getItem: () => { throw new Error("storage blocked"); }, setItem: () => { throw new Error("storage full"); } };
  assert.equal(readExploreState(blocked, fallback), fallback);
  const cache = createExploreViewCache(blocked);
  assert.doesNotThrow(() => cache.set("scenery", result("内存缓存仍可用")));
  assert.equal(cache.get("scenery").feed.notes.length, 1);
  const broken = { getItem: () => "[null,{},[\"bad\",null]]" };
  assert.doesNotThrow(() => createExploreViewCache(broken));
});

test("小幅中心偏移复用同分类和半径的结果，失败状态也不会因切换而自动重试", () => {
  const disk = storage();
  const cache = createExploreViewCache(disk);
  const failed = { ...result("上次已找到的笔记"), feed: { ...result("上次已找到的笔记").feed, status: "error" } };
  cache.set("scenery:120.12000:30.22000:10000", failed);
  const reopened = createExploreViewCache(disk);
  assert.equal(reopened.get("scenery:120.12100:30.22100:10000").feed.notes[0].title, "上次已找到的笔记");
  assert.equal(reopened.get("scenery:120.12100:30.22100:10000").feed.status, "error");
  assert.equal(reopened.get("food:120.12000:30.22000:10000"), undefined);
  assert.equal(reopened.get("scenery:120.12000:30.22000:5000"), undefined);
  assert.equal(reopened.get("scenery:120.20000:30.22000:10000"), undefined);
});
