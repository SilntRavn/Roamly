import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { root } from "../server/config.mjs";
import { demoTrip, demoPlaces } from "../server/seed.mjs";

test("笔记收藏持久化、幂等、隔离账号并随访客登录合并；详情来源与行程对话可恢复", async (t) => {
  const temp = mkdtempSync(path.join(tmpdir(), "roamly-explore-test-"));
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const server = spawn(process.execPath, ["server/index.mjs", "--production"], { cwd: root,
    env: { ...process.env, PORT: String(port), ROAMLY_DB: path.join(temp, "test.sqlite") }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    server.kill(); if (server.exitCode === null) await once(server, "exit");
    if (path.resolve(temp).startsWith(path.join(path.resolve(tmpdir()), "roamly-explore-test-"))) rmSync(temp, { recursive: true, force: true });
  });
  await once(server.stdout, "data");
  let cookie = "";
  const call = async (url, method = "GET", body, stranger = false) => {
    const response = await fetch(`http://127.0.0.1:${port}/api${url}`, { method,
      headers: { "Content-Type": "application/json", cookie: stranger ? "" : cookie }, body: body ? JSON.stringify(body) : undefined });
    if (!stranger) cookie = response.headers.getSetCookie().at(-1)?.split(";")[0] || cookie;
    return { status: response.status, data: await response.json() };
  };
  await call("/bootstrap");
  const place = demoPlaces.find((p) => p.id === demoTrip.days[0].items[0].placeId);
  const created = await call("/trips", "POST", demoTrip);
  const trip = created.data.trip;
  const chat = await call(`/trips/${trip.id}/conversation`, "POST", { placeId: place.id });
  assert.equal(chat.status, 200);
  assert.equal(chat.data.trip_id, trip.id);
  assert.ok(chat.data.messages[0].content.includes(place.name));
  const restored = (await call("/conversations")).data.find((c) => c.id === chat.data.id);
  assert.equal(restored.trip_id, trip.id);
  assert.deepEqual(restored.messages, chat.data.messages);
  assert.equal((await call(`/trips/${trip.id}/conversation`, "POST", {})).data.id, chat.data.id);
  assert.equal((await call(`/trips/${trip.id}/conversation`, "POST", { placeId: "amap-missing" })).status, 400);
  assert.equal((await call(`/trips/${trip.id}/conversation`, "POST", {}, true)).status, 404);
  assert.equal((await call(`/trips/${trip.id}`)).data.trip.requirements.requiredPlaceIds.includes(place.id), true);
  assert.equal((await call("/explore/notes/missing")).status, 404);
  assert.equal((await call("/explore/nearby?west=120&south=30&east=120.1&north=30.1&category=unknown")).status, 400);
  assert.equal((await call("/explore/nearby?west=120&south=30&east=119&north=30.1&category=scenery")).status, 400);
  assert.equal((await call("/explore/nearby?west=120&south=30&east=120.1&north=30.1&category=scenery&radius=5000")).status, 400);
  assert.equal((await call("/explore/nearby?west=120&south=30&east=120.1&north=30.1&category=scenery&lng=120&lat=30&radius=9000")).status, 400);
  const localDb = new DatabaseSync(path.join(temp, "test.sqlite"));
  const note = { id: "note-api-test", title: "公开笔记", category: "scenery", placeIds: [place.id], sources: [{ title: "原文", url: "https://example.com/post", updatedAt: "2026-10-05" }] };
  localDb.prepare("INSERT INTO explore_notes VALUES(?,?,?,?)").run(note.id, note.category, JSON.stringify(note), "2026-10-05");
  const mapPlace = { ...place, id: "api-cached-map-place", location: { lng: 120, lat: 30, coordSystem: "GCJ-02" } };
  localDb.prepare("UPDATE places SET payload=? WHERE id=?").run(JSON.stringify({ ...place, location: mapPlace.location }), place.id);
  localDb.prepare("INSERT INTO places(id,payload) VALUES(?,?)").run(mapPlace.id, JSON.stringify(mapPlace));
  localDb.prepare("INSERT INTO explore_feeds VALUES(?,?,?)").run("explore-v2-api-stored-feed", JSON.stringify({ category: "scenery", status: "ready", bounds: { lng: 120, lat: 30, radius: 10000 }, noteIds: [note.id], nearbyPlaceIds: [mapPlace.id], message: "" }), "2026-10-05");
  localDb.close();
  // A cached endpoint responds without waiting for any external map or AI service.
  for (const lng of [120, 120.004]) {
    const cached = await call(`/explore/nearby?west=119&south=29&east=121&north=31&category=scenery&lng=${lng}&lat=30&radius=10000`);
    assert.equal(cached.status, 200);
    assert.match(cached.data.feed.key, /^explore-v2-scenery-/);
    assert.equal(cached.data.feed.status, "ready");
    assert.equal(cached.data.feed.notes[0].id, note.id);
    assert.equal(cached.data.places[0].id, mapPlace.id);
  }
  const detail = (await call(`/explore/notes/${note.id}`)).data;
  assert.deepEqual(detail.note.sources, note.sources);
  assert.equal(detail.places[0].id, place.id);
  assert.equal((await call("/explore/favorites/missing", "PUT")).status, 404);
  assert.deepEqual((await call("/explore/favorites")).data.notes, []);
  assert.equal((await call(`/explore/favorites/${note.id}`, "PUT")).data.favorite, true);
  assert.equal((await call(`/explore/favorites/${note.id}`, "PUT")).data.favorite, true);
  const saved = (await call("/explore/favorites")).data;
  assert.deepEqual(saved.notes, [note]);
  assert.equal(saved.places[0].id, place.id);
  assert.deepEqual((await call("/bootstrap")).data.favoriteNotes, saved);
  assert.deepEqual((await call("/explore/favorites", "GET", undefined, true)).data.notes, []);
  await call(`/explore/favorites/${note.id}`, "DELETE", undefined, true);
  assert.equal((await call("/explore/favorites")).data.notes.length, 1);

  // A refreshed public note keeps the existing favorite relationship.
  const refreshed = { ...note, title: "更新后的公开笔记" };
  const refreshDb = new DatabaseSync(path.join(temp, "test.sqlite"));
  refreshDb.prepare("UPDATE explore_notes SET payload=? WHERE id=?").run(JSON.stringify(refreshed), note.id);
  const other = { ...note, id: "note-api-other", title: "另一篇笔记" };
  refreshDb.prepare("INSERT INTO explore_notes VALUES(?,?,?,?)").run(other.id, other.category, JSON.stringify(other), "2026-10-05");
  refreshDb.close();
  const libraryUrl = "/explore/stored?west=119&south=29&east=121&north=31&category=scenery&lng=120&lat=30&radius=10000";
  const publicNotes = (await call(libraryUrl, "GET", undefined, true)).data.feed.notes;
  assert.ok(publicNotes.some((n) => n.id === other.id));
  assert.equal(publicNotes.find((n) => n.id === note.id).favoriteCount, 1);
  assert.deepEqual(new Set((await call(libraryUrl)).data.feed.notes.map((n) => n.id)), new Set(publicNotes.map((n) => n.id)));
  assert.equal((await call("/explore/favorites")).data.notes[0].title, refreshed.title);
  await call(`/explore/favorites/${note.id}`, "DELETE");
  await call(`/explore/favorites/${note.id}`, "DELETE");
  assert.deepEqual((await call("/explore/favorites")).data.notes, []);
  await call(`/explore/favorites/${note.id}`, "PUT");
  const credentials = { username: "笔记收藏测试", password: "testnote123" };
  const registered = await call("/auth/register", "POST", credentials);
  assert.equal(registered.status, 200);
  await call("/auth/logout", "POST");
  cookie = "";
  await call("/bootstrap");
  await call(`/explore/favorites/${note.id}`, "PUT");
  await call(`/explore/favorites/${other.id}`, "PUT");
  assert.equal((await call("/auth/login", "POST", credentials)).status, 200);
  assert.deepEqual((await call("/explore/favorites")).data.notes.map((n) => n.id), [other.id, note.id]);
  assert.equal((await call("/auth/account", "DELETE", { password: credentials.password })).status, 200);
  const deletedDb = new DatabaseSync(path.join(temp, "test.sqlite"));
  assert.equal(deletedDb.prepare("SELECT COUNT(*) AS n FROM note_favorites WHERE user_id=?").get(registered.data.id).n, 0);
  deletedDb.close();
  assert.equal((await call(`/explore/notes/${note.id}`)).status, 200);
});
