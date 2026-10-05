import { z } from "zod";
import { db, getUser, hashPassword, newSession, usernameKey, verifyPassword } from "./db.mjs";
import { ServiceError } from "./amap.mjs";
import { characterCount, usernameCharacters, USERNAME_MAX_LENGTH, PASSWORD_MAX_LENGTH } from "../shared/account-rules.mjs";

export const UsernameSchema = z.string().trim().transform((s) => s.normalize("NFKC"))
  .pipe(z.string().min(1).regex(usernameCharacters))
  .refine((s) => characterCount(s) <= USERNAME_MAX_LENGTH, "用户名最多 12 个字")
  .refine((s) => s !== "用户已注销", "请更换用户名");
const passwordSchema = (min) => z.string().refine((s) => characterCount(s) >= min && characterCount(s) <= PASSWORD_MAX_LENGTH, `密码须为 ${min}–16 位`);

export function sessionToken(req) {
  return req.headers.cookie?.split(";").map((s) => s.trim())
    .find((s) => s.startsWith("roamly_session="))?.slice("roamly_session=".length);
}

export function setSession(req, res, userId) {
  const token = sessionToken(req);
  if (token) db.prepare("DELETE FROM sessions WHERE token=?").run(token);
  res.cookie("roamly_session", newSession(userId), {
    httpOnly: true, sameSite: "lax", secure: req.secure,
    maxAge: 30 * 24 * 3600 * 1000, path: "/",
  });
}

export function requireLogin(req, res, next) {
  if (!getUser(req.userId)?.username)
    return res.status(401).json({ error: "请先登录，再与 AI 对话生成或修改路线", code: "LOGIN_REQUIRED" });
  next();
}

export function registerAccount(req, res) {
  const data = z.object({ username: UsernameSchema, password: passwordSchema(8) }).parse(req.body);
  if (getUser(req.userId).username) throw new ServiceError("当前账号已注册，请先退出登录", 409);
  const key = usernameKey(data.username);
  if (db.prepare("SELECT id FROM users WHERE username_key=?").get(key))
    throw new ServiceError("这个用户名已被使用，请更换用户名", 409);
  const passwordHash = hashPassword(data.password);
  try {
    db.prepare("UPDATE users SET username=?,username_key=?,nickname=?,password=? WHERE id=?").run(
      data.username, key, data.username, passwordHash, req.userId,
    );
  } catch (error) {
    if (db.prepare("SELECT id FROM users WHERE username_key=?").get(key))
      throw new ServiceError("这个用户名已被使用，请更换用户名", 409);
    throw error;
  }
  setSession(req, res, req.userId);
  res.json(getUser(req.userId));
}

export function loginAccount(req, res) {
  const data = z.object({ username: UsernameSchema, password: passwordSchema(1) }).parse(req.body);
  const user = db.prepare("SELECT id,password FROM users WHERE username_key=? AND deleted_at IS NULL").get(usernameKey(data.username));
  if (!user || !verifyPassword(data.password, user.password))
    throw new ServiceError("用户名或密码不正确", 401);
  const guest = getUser(req.userId);
  if (!guest.username && guest.id !== user.id) {
    db.exec("BEGIN");
    try {
      for (const table of ["trips", "conversations", "shares"])
        db.prepare(`UPDATE ${table} SET user_id=? WHERE user_id=?`).run(user.id, guest.id);
      db.prepare("INSERT OR IGNORE INTO favorites SELECT ?,place_id FROM favorites WHERE user_id=?").run(user.id, guest.id);
      db.prepare("DELETE FROM favorites WHERE user_id=?").run(guest.id);
      db.prepare("DELETE FROM sessions WHERE user_id=?").run(guest.id);
      db.prepare("DELETE FROM users WHERE id=?").run(guest.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  setSession(req, res, user.id);
  res.json(getUser(user.id));
}

export function deleteAccount(req, res) {
  const { password } = z.object({ password: passwordSchema(1) }).parse(req.body);
  const user = db.prepare("SELECT password FROM users WHERE id=?").get(req.userId);
  if (!verifyPassword(password, user.password)) throw new ServiceError("密码不正确，账号未注销", 401);
  db.exec("BEGIN");
  try {
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_traces'").get()) {
      db.prepare("DELETE FROM ai_trace_events WHERE trace_id IN (SELECT id FROM ai_traces WHERE user_id=?)").run(req.userId);
      db.prepare("DELETE FROM ai_traces WHERE user_id=?").run(req.userId);
    }
    db.prepare("DELETE FROM trip_audits WHERE trip_id IN (SELECT id FROM trips WHERE user_id=?)").run(req.userId);
    for (const table of ["sessions", "conversations", "shares", "favorites", "trips"])
      db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(req.userId);
    // Keep a tombstone ID so old reviews never belong to a new owner of the username.
    db.prepare("UPDATE users SET username=NULL,username_key=NULL,password=NULL,nickname='用户已注销',preferences='{}',deleted_at=? WHERE id=?")
      .run(new Date().toISOString(), req.userId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  res.clearCookie("roamly_session", { path: "/" });
  res.json({ ok: true });
}
