import test from "node:test";
import assert from "node:assert/strict";
import { previewLayout } from "../src/map-preview.mjs";

const bounds = { left: 12, right: 418, top: 140, bottom: 600 };
const card = { width: 190, height: 190 / 1.5 };
const gap = 32;
test("地图浮卡始终在点位上方，拖动后箭头仍指向该点", () => {
  for (const anchor of [{ x: 215, y: 400 }, { x: 275, y: 435 }]) {
    const result = previewLayout(anchor, card, bounds, gap);
    assert.equal(result.x + result.tip, anchor.x);
    assert.equal(result.y + card.height + gap, anchor.y);
    assert.equal(result.visible, true);
    assert.deepEqual(result.shift, { x: 0, y: 0 });
  }
});
test("边缘选点会计算平移量，重定位后浮卡避开欢迎卡与规划区", () => {
  for (const anchor of [{ x: 20, y: 160 }, { x: 410, y: 650 }]) {
    const result = previewLayout(anchor, card, bounds, gap);
    assert.ok(result.x >= bounds.left);
    assert.ok(result.x + card.width <= bounds.right);
    assert.equal(result.x + result.tip, anchor.x);
    const moved = previewLayout({ x: anchor.x + result.shift.x, y: anchor.y + result.shift.y }, card, bounds, gap);
    assert.equal(moved.visible, true);
    assert.ok(moved.y >= bounds.top - .5);
    assert.ok(moved.y + card.height + gap <= bounds.bottom + .5);
  }
});
test("大地图不截断屏幕坐标，浮卡和点位都使用真实容器宽度", () => {
  const anchor = { x: 1300, y: 600 };
  const result = previewLayout(anchor, card, { ...bounds, right: 1588, bottom: 900 }, gap);
  assert.equal(result.x + result.tip, 1300);
  assert.equal(result.visible, true);
});
test("小屏选点平移后毛玻璃卡片不会挡住缩放和定位控件", () => {
  const area = { left: 12, right: 363, top: 123, bottom: 261, controls: { left: 315, top: 115, bottom: 237 } };
  const smallCard = { width: 158, height: 105.333 };
  const anchor = { x: 271, y: 261 };
  const result = previewLayout(anchor, smallCard, area, gap);
  const moved = previewLayout({ x: anchor.x + result.shift.x, y: anchor.y + result.shift.y }, smallCard, area, gap);
  assert.equal(moved.visible, true);
  assert.ok(moved.x + smallCard.width <= area.controls.left - area.left);
  assert.equal(moved.x + moved.tip, anchor.x + result.shift.x);
});
test("点位拖到遮挡区或地图外时隐藏浮卡，不把卡片留在错误的位置", () => {
  for (const anchor of [{ x: -10, y: 400 }, { x: 215, y: 100 }, { x: 215, y: 700 }]) {
    assert.equal(previewLayout(anchor, card, bounds, gap).visible, false);
  }
  assert.equal(previewLayout({ x: 215, y: 200 }, card, { ...bounds, bottom: 250 }, gap).visible, false);
});
