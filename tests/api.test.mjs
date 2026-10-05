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
import { makeExport } from "../shared/schema.mjs";
import { demoTrip, demoPlaces } from "../server/seed.mjs";
import { defaultRequirements } from "../shared/requirements.mjs";
test("账号隔离、导入导出、分享快照、撤回、评价与偏好持久化、删除行程和草稿", async (t) => {
  const temp = mkdtempSync(path.join(tmpdir(), "roamly-test-"));
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const server = spawn(process.execPath, ["server/index.mjs", "--production"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      ROAMLY_DB: path.join(temp, "test.sqlite"),
      ARK_BASE_URL: "http://127.0.0.1:49997/api",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    server.kill();
    if (server.exitCode === null) await once(server, "exit");
    if (
      path
        .resolve(temp)
        .startsWith(path.join(path.resolve(tmpdir()), "roamly-test-"))
    )
      rmSync(temp, { recursive: true, force: true });
  });
  let readyTimer;
  await Promise.race([
    once(server.stdout, "data"),
    new Promise((_, reject) => {
      readyTimer = setTimeout(() => reject(new Error("服务启动超时")), 10000);
    }),
  ]);
  clearTimeout(readyTimer);
  let cookie = "";
  let stranger = "";
  const call = async (url, method = "GET", body, other = false) => {
    const r = await fetch(`http://127.0.0.1:${port}/api${url}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        cookie: other ? stranger : cookie,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const c = r.headers.getSetCookie().at(-1)?.split(";")[0];
    if (c) {
      if (other) stranger = c;
      else cookie = c;
    }
    return { status: r.status, data: await r.json() };
  };
  const b = await call("/bootstrap");
  assert.equal((await call("/ai-monitor")).status, 404);
  assert.equal((await call("/ai-monitor/traces")).status, 404);
  assert.equal(b.status, 200);
  assert.equal(b.data.user.username, null);
  assert.equal("email" in b.data.user, false);
  const guestChat = await call("/chat", "POST", { message: "杭州一日游" });
  assert.equal(guestChat.status, 401);
  assert.equal(guestChat.data.code, "LOGIN_REQUIRED");
  assert.equal((await call("/conversations")).data.length, 0);
  assert.equal((await call("/bootstrap", "GET", null, true)).status, 200);
  assert.equal((await call("/places/ref-fuji/content", "POST")).data.status, "local");
  assert.equal((await call("/places/missing/content", "POST")).status, 404);
  assert.equal((await call("/places/ref-fuji/content", "POST", { force: "true" })).status, 400);
  assert.equal((await call("/places/ref-fuji")).data.content.status, "local");
  const localDb = new DatabaseSync(path.join(temp, "test.sqlite"));
  const cachedPlace = { ...demoPlaces[0], id: "amap-cached-api", aiRating: 4.2, overview: "数据库中已有的景点介绍", photos: [demoPlaces[0].photo] };
  const cachedMetadata = { status: "ready", checkedAt: "2026-10-04T00:00:00Z", automaticRetries: 0 };
  localDb.prepare("INSERT INTO places VALUES(?,?,0)").run(cachedPlace.id, JSON.stringify(cachedPlace));
  localDb.prepare("INSERT INTO place_content_cache VALUES(?,?,0)").run(`official-content-v3:${cachedPlace.id}`, JSON.stringify(cachedMetadata));
  localDb.close();
  const readyDetail = (await call(`/places/${cachedPlace.id}`)).data;
  assert.equal(readyDetail.content.status, "ready");
  assert.equal(readyDetail.content.expiresAt, null);
  assert.equal((await call(`/places/${cachedPlace.id}/content`, "POST")).data.checkedAt, cachedMetadata.checkedAt);
  const cachedTrip = await call("/trips", "POST", { ...demoTrip, days: [{ ...demoTrip.days[0], items: [{ ...demoTrip.days[0].items[0], placeId: cachedPlace.id }] }] });
  assert.equal(cachedTrip.status, 200);
  assert.equal(cachedTrip.data.placeContents[cachedPlace.id].status, "ready");
  const openedCachedTrip = (await call(`/trips/${cachedTrip.data.trip.id}`)).data;
  assert.equal(openedCachedTrip.placeContents[cachedPlace.id].checkedAt, cachedMetadata.checkedAt);
  await call(`/trips/${cachedTrip.data.trip.id}`, "DELETE");
  const portableTrip = {
    ...demoTrip,
    requirements: defaultRequirements(demoTrip),
  };
  const firstPlace = demoPlaces.find(
    (p) => p.id === demoTrip.days[0].items[0].placeId,
  );
  portableTrip.requirements.fixedVisits = [
    {
      placeId: firstPlace.id,
      name: firstPlace.name,
      day: 1,
      arrival: demoTrip.days[0].items[0].arrival,
      durationMinutes: null,
    },
  ];
  const file = makeExport(portableTrip, demoPlaces);
  const imported = await call("/trips/import", "POST", file);
  assert.equal(imported.status, 200);
  const trip = imported.data.trip;
  assert.equal((await call("/chat", "POST", { message: "少走路", tripId: trip.id })).status, 401);
  assert.equal((await call(`/trips/${trip.id}`)).status, 200);
  assert.notEqual(trip.id, demoTrip.id);
  assert.match(trip.days[0].items[0].placeId, /^import-/);
  assert.deepEqual(trip.requirements.requiredPlaceIds, [
    ...new Set(
      trip.days.flatMap((d) => d.items.map((i) => i.placeId)).filter(Boolean),
    ),
  ]);
  assert.equal(
    trip.requirements.fixedVisits[0].placeId,
    trip.days[0].items[0].placeId,
  );
  assert.equal(
    (await call(`/trips/${trip.id}`, "GET", null, true)).status,
    404,
  );
  const exported = await call(`/trips/${trip.id}/export`);
  assert.equal(exported.status, 200);
  assert.equal(exported.data.format, "roamly.itinerary");
  assert.equal(exported.data.places.length, 3);
  assert.equal(exported.data.itinerary.title, demoTrip.title);
  assert.deepEqual(exported.data.itinerary.requirements, trip.requirements);
  const shared = await call(`/trips/${trip.id}/share`, "POST");
  assert.equal(shared.status, 200);
  await call(`/trips/${trip.id}`, "PATCH", { title: "新版本标题" });
  const snapshot = await call(
    `/shares/${shared.data.token}`,
    "GET",
    null,
    true,
  );
  assert.equal(snapshot.data.itinerary.title, demoTrip.title);
  const anonymousShare = await fetch(`http://127.0.0.1:${port}/api/shares/${shared.data.token}`);
  assert.equal(anonymousShare.status, 200);
  assert.equal(anonymousShare.headers.getSetCookie().length, 0);
  assert.equal("userId" in snapshot.data, false);
  assert.equal(
    (await call(`/shares/${shared.data.token}`, "DELETE", null, true)).status,
    200,
  );
  assert.equal(
    (await call(`/shares/${shared.data.token}`, "GET", null, true)).status,
    200,
  );
  await call(`/shares/${shared.data.token}`, "DELETE");
  assert.equal(
    (await call(`/shares/${shared.data.token}`, "GET", null, true)).status,
    404,
  );
  assert.equal(
    (
      await call(`/places/${trip.days[0].items[0].placeId}/reviews`, "POST", {
        rating: 5,
        content: "仅供隔离测试的内容",
      })
    ).status,
    401,
  );
  const registered = await call("/auth/register", "POST", {
    username: "测试旅行者",
    password: "local-test-pass",
  });
  assert.equal(registered.status, 200);
  assert.equal(registered.data.username, "测试旅行者");
  assert.equal(registered.data.nickname, registered.data.username);
  assert.notEqual(cookie.split("=")[1], "");
  const duplicate = await call("/auth/register", "POST", { username: " 测试旅行者 ", password: "another-password" }, true);
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.data.error, /更换用户名/);
  assert.equal((await call("/chat", "POST", { message: "" })).status, 400);
  const placeId = trip.days[0].items[0].placeId;
  assert.equal(
    (
      await call(`/places/${placeId}/reviews`, "POST", {
        rating: 4,
        content: "仅供隔离测试的内容",
      })
    ).status,
    200,
  );
  const reviews = await call(`/places/${placeId}`);
  assert.equal(reviews.data.reviews.length, 1);
  assert.equal(reviews.data.rating, 4);
  await call("/profile", "PATCH", {
    nickname: "试图更改显示名称",
    preferences: { ...b.data.user.preferences, travelers: 3 },
  });
  const profile = await call("/profile");
  assert.equal(profile.data.user.preferences.travelers, 3);
  assert.equal(profile.data.user.nickname, "测试旅行者");
  assert.equal(profile.data.stats.trips, 1);
  const invalid = { ...file, version: "0.0" };
  assert.equal((await call("/trips/import", "POST", invalid)).status, 400);
  assert.equal(
    (await call(`/trips/${trip.id}`, "PATCH", { favorite: true })).data.trip
      .favorite,
    true,
  );
  await call("/auth/logout", "POST");
  assert.equal((await call("/chat", "POST", { message: "继续规划" })).status, 401);
  assert.equal((await call("/auth/login", "POST", { username: "测试旅行者", password: "wrong-password" })).status, 401);
  const login = await call("/auth/login", "POST", {
    username: "测试旅行者",
    password: "local-test-pass",
  });
  assert.equal(login.status, 200);
  assert.equal((await call("/trips")).data.length, 1);
  // Two independent device sessions must see additions, edits and deletions.
  const deviceLogin = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "测试旅行者", password: "local-test-pass" }),
  });
  assert.equal(deviceLogin.status, 200);
  const deviceCookie = deviceLogin.headers.getSetCookie().at(-1).split(";")[0];
  assert.notEqual(deviceCookie, cookie);
  const deviceCall = async (url, method = "GET", body) => {
    const res = await fetch(`http://127.0.0.1:${port}/api${url}`, {
      method, headers: { cookie: deviceCookie, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    return res.json();
  };
  const first = (await call("/trips", "POST", demoTrip)).data.trip;
  const second = (await call("/trips", "POST", demoTrip)).data.trip;
  assert.equal((await deviceCall("/trips")).length, 3);
  await deviceCall(`/trips/${first.id}`, "DELETE");
  await deviceCall(`/trips/${second.id}`, "DELETE");
  const added = (await deviceCall("/trips", "POST", { ...demoTrip, title: "另一台设备新建的行程" })).trip;
  assert.deepEqual(new Set((await call("/trips")).data.map((t) => t.id)), new Set([trip.id, added.id]));
  await deviceCall(`/trips/${added.id}`, "PATCH", { title: "跨设备修改" });
  assert.equal((await call(`/trips/${added.id}`)).data.trip.title, "跨设备修改");
  assert.equal((await call("/profile")).data.stats.trips, 2);
  await deviceCall(`/trips/${added.id}`, "DELETE");
  assert.equal((await call("/trips")).data.length, 1);
  const fixtureDb = new DatabaseSync(path.join(temp, "test.sqlite"));
  // Removing from one category preserves the other memberships and shared data.
  const categoryTrip = (await call("/trips", "POST", demoTrip)).data.trip;
  await call(`/trips/${categoryTrip.id}`, "PATCH", { status: "completed", favorite: true });
  const categoryShare = (await call(`/trips/${categoryTrip.id}/share`, "POST")).data;
  const withoutSaved = await call(`/trips/${categoryTrip.id}?scope=saved`, "DELETE");
  assert.equal(withoutSaved.status, 200);
  assert.equal(withoutSaved.data.removed, false);
  assert.equal(withoutSaved.data.trip.savedVisible, false);
  assert.equal(withoutSaved.data.trip.footprintVisible, true);
  assert.equal(withoutSaved.data.trip.favorite, true);
  assert.equal((await call("/profile")).data.stats.trips, 1);
  assert.ok((await call("/profile")).data.stats.visited > 0);
  assert.equal((await deviceCall(`/trips/${categoryTrip.id}`)).trip.savedVisible, false);
  assert.equal((await call(`/shares/${categoryShare.token}`)).status, 200);
  const withoutFootprint = await call(`/trips/${categoryTrip.id}?scope=footprint`, "DELETE");
  assert.equal(withoutFootprint.data.trip.footprintVisible, false);
  assert.equal(withoutFootprint.data.trip.favorite, true);
  assert.equal((await call("/profile")).data.stats.visited, 0);
  await call(`/trips/${categoryTrip.id}`, "DELETE");
  const reverseTrip = (await call("/trips", "POST", demoTrip)).data.trip;
  await call(`/trips/${reverseTrip.id}`, "PATCH", { status: "completed" });
  assert.equal((await call(`/trips/${reverseTrip.id}?scope=bad`, "DELETE")).status, 400);
  assert.equal((await call(`/trips/${reverseTrip.id}?scope=footprint`, "DELETE", null, true)).status, 404);
  const stillSaved = (await call(`/trips/${reverseTrip.id}?scope=footprint`, "DELETE")).data;
  assert.equal(stillSaved.removed, false);
  assert.equal(stillSaved.trip.savedVisible, true);
  assert.equal(stillSaved.trip.footprintVisible, false);
  assert.equal((await deviceCall(`/trips/${reverseTrip.id}`)).trip.savedVisible, true);
  const completelyRemoved = (await call(`/trips/${reverseTrip.id}?scope=saved`, "DELETE")).data;
  assert.equal(completelyRemoved.removed, true);
  assert.equal((await call(`/trips/${reverseTrip.id}`)).status, 404);
  assert.equal((await call("/trips")).data.length, 1);
  const draftId = "delete-draft";
  const linkedId = "delete-linked-conversation";
  const strangerDraftId = "stranger-draft";
  const strangerToken = stranger.split("=")[1];
  const strangerId = fixtureDb.prepare("SELECT user_id FROM sessions WHERE token=?").get(strangerToken).user_id;
  const insertConversation = fixtureDb.prepare("INSERT INTO conversations VALUES(?,?,?,?)");
  const draftMessages = JSON.stringify([{ role: "user", content: "杭州周末散步" }]);
  insertConversation.run(draftId, b.data.user.id, null, draftMessages);
  insertConversation.run(linkedId, b.data.user.id, trip.id, draftMessages);
  insertConversation.run(strangerDraftId, strangerId, null, draftMessages);
  fixtureDb.prepare("INSERT INTO trip_audits VALUES(?,?)").run(trip.id, JSON.stringify({ days: [] }));
  const deletionShare = await call(`/trips/${trip.id}/share`, "POST");
  assert.equal(deletionShare.status, 200);

  assert.equal((await call(`/conversations/${draftId}`, "DELETE", null, true)).status, 404);
  assert.equal((await call(`/conversations/${strangerDraftId}`, "DELETE")).status, 404);
  assert.equal((await call(`/conversations/${linkedId}`, "DELETE")).status, 409);
  assert.equal((await call(`/conversations/${draftId}`, "DELETE")).status, 200);
  assert.equal((await call(`/conversations/${draftId}`, "DELETE")).status, 404);
  assert.equal((await call("/conversations")).data.some((c) => c.id === draftId), false);
  assert.equal((await call("/trips")).data.length, 1);

  assert.equal((await call(`/trips/${trip.id}`, "DELETE", null, true)).status, 404);
  assert.equal((await call(`/shares/${deletionShare.data.token}`, "GET", null, true)).status, 200);
  assert.equal((await call(`/trips/${trip.id}`, "DELETE")).status, 200);
  assert.equal((await call(`/trips/${trip.id}`, "DELETE")).status, 404);
  assert.equal((await call(`/trips/${trip.id}`)).status, 404);
  assert.equal((await call("/trips")).data.length, 0);
  assert.equal((await call("/profile")).data.stats.trips, 0);
  assert.equal((await call("/conversations")).data.some((c) => c.id === linkedId), false);
  assert.equal((await call(`/shares/${deletionShare.data.token}`, "GET", null, true)).status, 404);
  assert.equal((await call("/my-shares")).data.length, 0);
  assert.equal(fixtureDb.prepare("SELECT * FROM trip_audits WHERE trip_id=?").get(trip.id), undefined);
  assert.equal((await call("/conversations", "GET", null, true)).data.some((c) => c.id === strangerDraftId), true);
  assert.equal((await call(`/places/${placeId}`)).data.reviews.length, 1);
  // Importing as a guest, then logging in, preserves the route for AI refinement.
  const guestImport = await call("/trips/import", "POST", file, true);
  const guestShare = await call(`/trips/${guestImport.data.trip.id}/share`, "POST", null, true);
  const guestCookie = stranger;
  const secondLogin = await call("/auth/login", "POST", { username: "测试旅行者", password: "local-test-pass" }, true);
  assert.equal(secondLogin.status, 200);
  assert.equal((await call(`/trips/${guestImport.data.trip.id}`, "GET", null, true)).status, 200);
  assert.equal((await call("/my-shares")).data.some((s) => s.token === guestShare.data.token), true);
  assert.equal((await call("/chat", "POST", { message: "", tripId: guestImport.data.trip.id }, true)).status, 400);
  const invalidatedGuest = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json", cookie: guestCookie }, body: JSON.stringify({ message: "重新规划" }) });
  assert.equal(invalidatedGuest.status, 401);
  const oldCookie = cookie;
  const oldSecondCookie = stranger;
  assert.equal((await call("/auth/account", "DELETE", { password: "wrong-password" })).status, 401);
  assert.equal((await call("/profile")).data.user.username, "测试旅行者");
  assert.equal((await call("/auth/account", "DELETE", { password: "local-test-pass" })).status, 200);
  const deletedReviews = await call(`/places/${placeId}`);
  assert.equal(deletedReviews.data.reviews[0].nickname, "用户已注销");
  assert.equal(deletedReviews.data.reviews[0].content, "仅供隔离测试的内容");
  assert.equal((await call(`/shares/${guestShare.data.token}`, "GET", null, true)).status, 404);
  for (const staleCookie of [oldCookie, oldSecondCookie]) {
    const r = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json", cookie: staleCookie }, body: JSON.stringify({ message: "继续规划" }) });
    assert.equal(r.status, 401);
  }
  const reused = await call("/auth/register", "POST", { username: "测试旅行者", password: "new-owner-pass" });
  assert.equal(reused.status, 200);
  assert.notEqual(reused.data.id, registered.data.id);
  assert.equal((await call("/trips")).data.length, 0);
  assert.equal((await call("/conversations")).data.length, 0);
  assert.equal((await call(`/places/${placeId}/reviews`, "DELETE")).status, 200);
  assert.equal((await call(`/places/${placeId}`)).data.reviews.length, 1);
  assert.equal((await call(`/places/${placeId}/reviews`, "POST", { rating: 5, content: "这是新用户的独立评论" })).status, 200);
  const bothReviews = (await call(`/places/${placeId}`)).data.reviews;
  assert.equal(bothReviews.length, 2);
  assert.deepEqual(new Set(bothReviews.map((r) => r.nickname)), new Set(["用户已注销", "测试旅行者"]));
  assert.equal(fixtureDb.prepare("SELECT username,username_key,password FROM users WHERE id=?").get(registered.data.id).password, null);
  assert.equal(fixtureDb.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id=?").get(registered.data.id).n, 0);
  fixtureDb.close();
});
