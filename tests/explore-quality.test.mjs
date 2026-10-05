import test from "node:test";
import assert from "node:assert/strict";
import { exploreAreaQuality, shouldGenerateExploreNotes } from "../shared/explore-quality.mjs";
const park = (id) => ({ id, name: "湖边公园", poiType: "风景名胜;公园" });

test("区域下限依据真实类别、已有评价和核验记录分档，不因工厂与住宅数量多就生成笔记", () => {
  const factories = Array.from({ length: 50 }, (_, i) => ({ id: String(i), name: "工业园工厂", poiType: "公司企业;工厂" }));
  assert.equal(exploreAreaQuality(factories, "scenery").minimumNotes, 0);
  assert.equal(exploreAreaQuality([park("one")], "scenery").minimumNotes, 1);
  const ordinary = Array.from({ length: 5 }, (_, i) => park(String(i)));
  assert.equal(exploreAreaQuality(ordinary, "scenery").minimumNotes, 4);
  const landmarks = Array.from({ length: 4 }, (_, i) => ({ ...park(String(i)), poiTypecode: "110101" }));
  assert.equal(exploreAreaQuality(landmarks, "scenery").minimumNotes, 8);
  const verified = Array.from({ length: 6 }, (_, i) => park(String(i)));
  assert.equal(exploreAreaQuality(verified, "scenery", [{ recommendations: verified.map((p) => ({ placeId: p.id, worthVisiting: true })) }]).tier, "rich");
  for (const [category, type] of [["food", "餐饮服务;餐厅"], ["stay", "住宿服务;宾馆酒店"], ["fun", "娱乐场所;KTV"]]) {
    assert.equal(exploreAreaQuality(Array.from({ length: 20 }, (_, i) => ({ id: String(i), name: "地点", poiType: type })), category).minimumNotes, 8);
  }
});
test("数据库足够时不生成，缺乏资源不生成，失败与空结果的自动尝试一天内不重复", () => {
  const now = Date.parse("2026-10-06T00:00:00+08:00");
  assert.equal(shouldGenerateExploreNotes({ minimumNotes: 8 }, 25, null, now), false);
  assert.equal(shouldGenerateExploreNotes({ minimumNotes: 0 }, 0, null, now), false);
  assert.equal(shouldGenerateExploreNotes({ minimumNotes: 8 }, 2, null, now), true);
  assert.equal(shouldGenerateExploreNotes({ minimumNotes: 8 }, 2, new Date(now - 60000).toISOString(), now), false);
  assert.equal(shouldGenerateExploreNotes({ minimumNotes: 8 }, 2, new Date(now - 25 * 3600000).toISOString(), now), true);
});
