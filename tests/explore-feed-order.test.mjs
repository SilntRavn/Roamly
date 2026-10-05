import test from "node:test";
import assert from "node:assert/strict";
import { rankExploreNotes, rankExplorePlaces, explorePlaceRating, explorePage } from "../src/explore-feed-order.mjs";
import { normalizePoi } from "../server/amap.mjs";

test("笔记收藏多的优先，同数量随机且会话内稳定；6篇起、每次4篇直到全量，无重复", () => {
  const notes = Array.from({ length: 19 }, (_, i) => ({ id: `note-${i}`, favoriteCount: i === 2 ? 8 : i === 1 ? 3 : 0 }));
  const ranked = rankExploreNotes(notes, 123);
  assert.deepEqual(ranked.slice(0, 2).map((n) => n.id), ["note-2", "note-1"]);
  assert.deepEqual(rankExploreNotes(notes, 123), ranked);
  assert.notDeepEqual(rankExploreNotes(notes, 456), ranked);
  let limit = 6;
  let page = explorePage(ranked, limit, 4);
  assert.equal(page.items.length, 6);
  while (page.hasMore) { limit = page.nextLimit; page = explorePage(ranked, limit, 4); }
  assert.equal(page.items.length, 19);
  assert.equal(new Set(page.items.map((n) => n.id)).size, 19);
  const visible = ranked.slice(0, 10).map((n) => n.id);
  const updated = rankExploreNotes([...notes, { id: "other-user-new", favoriteCount: 100 }], 123, visible);
  assert.deepEqual(updated.slice(0, 10).map((n) => n.id), visible);
  assert.equal(updated[10].id, "other-user-new");
});
test("四类地点按已有评分优先，缺评分不捏造；10个起、每次10个，已展开项不会因同步而移位", () => {
  const places = Array.from({ length: 23 }, (_, i) => ({ id: `place-${i}`, reviewRating: i === 3 ? 4.8 : null, poiRating: i === 5 ? 4.6 : null, aiRating: i === 8 ? 4.5 : null }));
  const ranked = rankExplorePlaces(places);
  assert.deepEqual(ranked.slice(0, 3).map((p) => p.id), ["place-3", "place-5", "place-8"]);
  assert.equal(explorePlaceRating({}), null);
  assert.equal(explorePage(ranked, 10, 10).items.length, 10);
  assert.equal(explorePage(ranked, 20, 10).items.length, 20);
  assert.equal(explorePage(ranked, 30, 10).hasMore, false);
  const displayed = ranked.slice(0, 10).map((p) => p.id);
  assert.deepEqual(rankExplorePlaces([...places, { id: "new", reviewRating: 5 }], displayed).slice(0, 10).map((p) => p.id), displayed);
});
test("高德已有评分保留，缺失和异常评分不转成虚构分数", () => {
  const poi = { id: "rating-test", name: "公园", type: "风景名胜;公园", location: "120,30" };
  assert.equal(normalizePoi({ ...poi, biz_ext: { rating: "4.8" } }).poiRating, 4.8);
  for (const value of [[], "", "unknown", "9", null]) assert.equal(normalizePoi({ ...poi, business: { rating: value } }).poiRating, null);
});
