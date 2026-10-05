import test from "node:test";
import assert from "node:assert/strict";
import { revealCircle } from "../src/motion-geometry.mjs";

test("页面展开圆心来自真实触点，半径覆盖手机与桌面内容区的所有角落", () => {
  for (const rect of [
    { left: 0, top: 0, width: 375, height: 591 },
    { left: 184, top: 80, width: 1016, height: 840 },
  ]) {
    for (const point of [
      { clientX: 146, clientY: 630 },
      { clientX: 133, clientY: 341 },
      { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 },
    ]) {
      const { x, y, radius } = revealCircle(point, rect);
      assert.equal(rect.left + x, point.clientX);
      assert.equal(rect.top + y, point.clientY);
      for (const corner of [[0, 0], [rect.width, 0], [0, rect.height], [rect.width, rect.height]]) {
        assert.ok(Math.hypot(corner[0] - x, corner[1] - y) < radius);
      }
    }
  }
});
