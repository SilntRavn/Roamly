import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

process.env.ROAMLY_DB = ":memory:";
const { db, createGuest, getUser } = await import("../server/db.mjs");
const { UsernameSchema, registerAccount, loginAccount, requireLogin } = await import("../server/auth.mjs");
const response = () => ({ cookie() {}, json(data) { this.data = data; }, status(code) { this.code = code; return this; } });

test("用户名统一全半角和大小写判重，只接受用户名密码，显示名称与登录凭据一致", () => {
  const userId = createGuest();
  const res = response();
  registerAccount({ userId, headers: {}, body: { username: " Ｒｏａｍｌｙ ", password: "test-password" } }, res);
  assert.equal(res.data.username, "Roamly");
  assert.equal(res.data.nickname, "Roamly");
  assert.equal("email" in res.data, false);
  const guestId = createGuest();
  assert.throws(() => registerAccount({ userId: guestId, headers: {}, body: { username: "roamly", password: "test-password" } }, response()), (e) => e.status === 409 && /更换用户名/.test(e.message));
  assert.equal(getUser(guestId).username, null);
  assert.equal(UsernameSchema.safeParse("用户已注销").success, false);
  assert.equal(UsernameSchema.safeParse("abc def").success, false);
  assert.equal(UsernameSchema.safeParse("中文用户名_Abc").success, true);
  assert.equal(UsernameSchema.safeParse("一二三四五六七八九十甲乙").success, true);
  assert.equal(UsernameSchema.safeParse("一二三四五六七八九十甲乙丙").success, false);
  assert.equal(UsernameSchema.safeParse("Abc_中文Def_汉字").success, true);
  for (const name of ["name1", "name.name", "name-name", "é", "🙂"])
    assert.equal(UsernameSchema.safeParse(name).success, false, name);
  // Supplementary Chinese characters count as one, rather than two UTF-16 units.
  assert.equal(UsernameSchema.safeParse("𠀀".repeat(12)).success, true);
  assert.equal(UsernameSchema.safeParse("𠀀".repeat(13)).success, false);
  assert.throws(() => registerAccount({ userId: guestId, headers: {}, body: { username: "长密码", password: "a".repeat(17) } }, response()));
  assert.throws(() => loginAccount({ userId: guestId, headers: {}, body: { username: "Roamly", password: "a".repeat(17) } }, response()));
  const maxPasswordUser = createGuest();
  registerAccount({ userId: maxPasswordUser, headers: {}, body: { username: "十六位密码", password: "a".repeat(16) } }, response());
  assert.throws(() => registerAccount({ userId: guestId, headers: {}, body: { email: "removed@example.com", password: "test-password" } }, response()));
  assert.throws(() => loginAccount({ userId: guestId, headers: {}, body: { username: "Roamly", password: "wrong" } }, response()), (e) => e.status === 401);
  loginAccount({ userId: guestId, headers: {}, body: { username: "ROAMLY", password: "test-password" } }, res);
  assert.equal(res.data.id, userId);
  const guest = response();
  requireLogin({ userId: createGuest() }, guest, () => assert.fail("访客不能进入规划接口"));
  assert.equal(guest.code, 401);
  let authorized = false;
  requireLogin({ userId }, response(), () => { authorized = true; });
  assert.equal(authorized, true);
  assert.equal(db.prepare("SELECT password FROM users WHERE id=?").get(userId).password.includes("test-password"), false);
});

test("旧邮箱数据库迁移保留账号、密码和游客，重名自动分配唯一用户名，邮箱凭据清除", async () => {
  const temp = mkdtempSync(path.join(tmpdir(), "roamly-auth-migration-"));
  const file = path.join(temp, "legacy.sqlite");
  try {
    const legacy = new DatabaseSync(file);
    legacy.exec("CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT UNIQUE,password TEXT,nickname TEXT NOT NULL,preferences TEXT NOT NULL)");
    const insert = legacy.prepare("INSERT INTO users VALUES(?,?,?,?,?)");
    insert.run("one", "one@example.com", "old-hash", "旅行者", "{}");
    insert.run("two", "two@example.com", "old-hash-2", "旅行者", "{}");
    insert.run("guest", null, null, "旅行者", "{}");
    legacy.close();
    const moduleUrl = new URL("../server/db.mjs", import.meta.url).href;
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `const {db} = await import(${JSON.stringify(moduleUrl)}); db.close();`], { env: { ...process.env, ROAMLY_DB: file } });
    const migrated = new DatabaseSync(file);
    const rows = migrated.prepare("SELECT * FROM users ORDER BY id").all();
    assert.equal(rows.find((u) => u.id === "one").username, "旅行者");
    assert.equal(rows.find((u) => u.id === "two").username, "旅行者_a");
    assert.equal(rows.find((u) => u.id === "guest").username, null);
    assert.equal(rows.find((u) => u.id === "one").password, "old-hash");
    assert.equal(rows.every((u) => u.email === null), true);
    assert.throws(() => migrated.prepare("UPDATE users SET username_key='旅行者' WHERE id='two'").run());
    migrated.close();
    // Startup is idempotent after the old email values are removed.
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `const {db} = await import(${JSON.stringify(moduleUrl)}); db.close();`], { env: { ...process.env, ROAMLY_DB: file } });
  } finally {
    assert.ok(path.resolve(temp).startsWith(path.join(path.resolve(tmpdir()), "roamly-auth-migration-")));
    rmSync(temp, { recursive: true, force: true });
  }
});
