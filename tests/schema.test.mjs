import test from "node:test";
import assert from "node:assert/strict";
import { FileSchema, makeExport, PlaceSchema } from "../shared/schema.mjs";
import { demoTrip, demoPlaces } from "../server/seed.mjs";
test("行程往返：逐日顺序、景点快照与坐标系保留", () => {
  const file = makeExport(demoTrip, demoPlaces);
  const restored = FileSchema.parse(JSON.parse(JSON.stringify(file)));
  assert.deepEqual(restored.itinerary, demoTrip);
  assert.equal(restored.places.length, 3);
  assert.equal(restored.places[0].location.coordSystem, "WGS84");
});
test("导入拒绝未知版本、无效坐标、缺失景点和危险图片链接", () => {
  const original = makeExport(demoTrip, demoPlaces);
  for (const alter of [
    (f) => (f.version = "2.0"),
    (f) => (f.places[0].location.lng = 200),
    (f) => (f.places = []),
    (f) => (f.places[0].photo = "javascript:alert(1)"),
  ]) {
    const f = structuredClone(original);
    alter(f);
    assert.equal(FileSchema.safeParse(f).success, false);
  }
});
test("导入拒绝时间倒序与重复 ID", () => {
  const original = makeExport(demoTrip, demoPlaces);
  const reversed = structuredClone(original);
  reversed.itinerary.days[0].items.reverse();
  assert.equal(FileSchema.safeParse(reversed).success, false);
  const repeated = structuredClone(original);
  repeated.itinerary.days[0].items[1].id =
    repeated.itinerary.days[0].items[0].id;
  assert.equal(FileSchema.safeParse(repeated).success, false);
});
test("文件仅包含行程需要的地点，不泄露收藏或用户数据", () => {
  const file = makeExport({ ...demoTrip, userId: "secret", favorite: true }, [
    ...demoPlaces,
    { ...demoPlaces[0], id: "unused" },
  ]);
  assert.equal("userId" in file.itinerary, false);
  assert.equal("favorite" in file.itinerary, false);
  assert.equal(
    file.places.some((p) => p.id === "unused"),
    false,
  );
});

test("三图、介绍来源和微信预约渠道随行程往返，兼容旧单图文件", () => {
  const enriched = {
    ...demoPlaces[0],
    photos: ["/images/fuji.png", "https://images.example.com/2.jpg", "https://images.example.com/3.jpg"],
    overviewSource: { title: "官方介绍", url: "https://travel.example.com/intro", updatedAt: "2026-10-04" },
    bookingChannels: [{ kind: "miniprogram", name: "景区预约", url: null, instructions: "微信搜索后预约", source: { title: "官方公告", url: "https://travel.example.com/book", updatedAt: "2026-10-04" } }],
  };
  const file = makeExport(demoTrip, [enriched, ...demoPlaces.slice(1)]);
  const restored = FileSchema.parse(JSON.parse(JSON.stringify(file))).places.find((p) => p.id === enriched.id);
  assert.deepEqual(restored.photos, enriched.photos);
  assert.deepEqual(restored.bookingChannels, enriched.bookingChannels);
  assert.deepEqual(restored.overviewSource, enriched.overviewSource);
  assert.deepEqual(PlaceSchema.parse(demoPlaces[0]).photos, []);
  for (const alter of [
    (p) => p.photos.push("https://images.example.com/4.jpg"),
    (p) => p.photos[0] = "javascript:alert(1)",
    (p) => p.bookingChannels[0].url = "javascript:alert(1)",
    (p) => p.overviewSource.url = "https://",
  ]) {
    const invalid = structuredClone(enriched);
    alter(invalid);
    assert.equal(PlaceSchema.safeParse(invalid).success, false);
  }
});
