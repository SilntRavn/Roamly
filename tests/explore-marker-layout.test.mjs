import test from "node:test";
import assert from "node:assert/strict";
import { layoutExploreMarkers } from "../src/explore-marker-layout.mjs";
const area = { left: 0, right: 400, top: 0, bottom: 300, controls: { left: 350, bottom: 60 } };
const point = (id, x, y) => ({ id, x, y, name: "很长的景点名称" });

test("相邻景点的名称拥挤时保留图标，只避让文字", () => {
  const layout = layoutExploreMarkers([point("a", 80, 120), point("b", 125, 120), point("c", 170, 120)], area);
  assert.deepEqual(layout.map((p) => p.id), ["a", "b", "c"]);
  assert.ok(layout.some((p) => !p.label));
});
test("重叠图标优先保留选中地点，其名称仍可见", () => {
  const layout = layoutExploreMarkers([point("a", 100, 120), point("b", 110, 120), point("c", 180, 120)], area, "b");
  assert.deepEqual(layout.map((p) => p.id), ["b", "c"]);
  assert.equal(layout[0].label, true);
});
test("面板与地图控件区域内的图标隐藏，边缘能放下图标时不因名称而隐藏", () => {
  const layout = layoutExploreMarkers([point("outside", 10, 100), point("controls", 370, 50), point("edge", 100, 278), point("below", 180, 310)], area);
  assert.deepEqual(layout.map((p) => p.id), ["edge"]);
  assert.equal(layout[0].label, false);
});
