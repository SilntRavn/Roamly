import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import {
  randomUUID,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import path from "node:path";
import { root } from "./config.mjs";
import { featured, demoPlaces } from "./seed.mjs";
import { PreferencesSchema } from "../shared/requirements.mjs";
import { profilePreferences } from "../shared/profile-preferences.mjs";
import { limitCharacters, USERNAME_MAX_LENGTH } from "../shared/account-rules.mjs";
mkdirSync(path.join(root, "data"), { recursive: true });
export const db = new DatabaseSync(
  process.env.ROAMLY_DB || path.join(root, "data", "roamly.sqlite"),
);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT, username_key TEXT, password TEXT, nickname TEXT NOT NULL, preferences TEXT NOT NULL, deleted_at TEXT);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS places(id TEXT PRIMARY KEY, payload TEXT NOT NULL, expires INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS trips(id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), payload TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'saved');
CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), trip_id TEXT, messages TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS favorites(user_id TEXT REFERENCES users(id), place_id TEXT REFERENCES places(id), PRIMARY KEY(user_id,place_id));
CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), place_id TEXT REFERENCES places(id), rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5), content TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(user_id,place_id));
CREATE TABLE IF NOT EXISTS shares(token TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), trip_id TEXT, payload TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS route_cache(cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS search_cache(cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS place_content_cache(place_id TEXT PRIMARY KEY, payload TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS trip_audits(trip_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_trips_user ON trips(user_id);
CREATE INDEX IF NOT EXISTS idx_review_place ON reviews(place_id);`);
// Upgrade existing databases without losing guest trips or registered accounts.
const tripColumns = new Set(db.prepare("PRAGMA table_info(trips)").all().map((c) => c.name));
if (!tripColumns.has("saved_visible")) db.exec("ALTER TABLE trips ADD COLUMN saved_visible INTEGER NOT NULL DEFAULT 1");
if (!tripColumns.has("footprint_visible")) {
  db.exec("ALTER TABLE trips ADD COLUMN footprint_visible INTEGER NOT NULL DEFAULT 0");
  db.exec("UPDATE trips SET footprint_visible=1 WHERE status='completed'");
}
const userColumns = new Set(db.prepare("PRAGMA table_info(users)").all().map((c) => c.name));
if (!userColumns.has("username")) db.exec("ALTER TABLE users ADD COLUMN username TEXT");
if (!userColumns.has("username_key")) db.exec("ALTER TABLE users ADD COLUMN username_key TEXT");
if (!userColumns.has("deleted_at")) db.exec("ALTER TABLE users ADD COLUMN deleted_at TEXT");
export const usernameKey = (name) => name.normalize("NFKC").trim().toLowerCase();
db.exec("BEGIN");
try {
  const used = new Set(db.prepare("SELECT username_key FROM users WHERE username_key IS NOT NULL").all().map((u) => u.username_key));
  const legacyAccounts = userColumns.has("email")
    ? db.prepare("SELECT id,nickname FROM users WHERE email IS NOT NULL AND username IS NULL AND deleted_at IS NULL ORDER BY rowid").all() : [];
  for (const user of legacyAccounts) {
    const base = limitCharacters(user.nickname.normalize("NFKC").trim().replace(/[^\p{Script=Han}A-Za-z_]/gu, ""), USERNAME_MAX_LENGTH) || "旅行者";
    let name = base === "用户已注销" ? "旅行者" : base;
    let suffix = 0;
    while (used.has(usernameKey(name))) {
      // Use letters for collision suffixes, matching the username character rules.
      let value = suffix++;
      let letters = "";
      do { letters = String.fromCharCode(97 + value % 26) + letters; value = Math.floor(value / 26) - 1; } while (value >= 0);
      const ending = `_${letters}`;
      name = `${limitCharacters(base, USERNAME_MAX_LENGTH - ending.length)}${ending}`;
    }
    used.add(usernameKey(name));
    db.prepare("UPDATE users SET username=?,username_key=?,nickname=? WHERE id=?").run(name, usernameKey(name), name, user.id);
  }
  if (userColumns.has("email")) db.exec("UPDATE users SET email=NULL");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username_key); COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}
export function savePlace(p, ttl = 0) {
  db.prepare(
    "INSERT INTO places(id,payload,expires) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, expires=excluded.expires",
  ).run(p.id, JSON.stringify(p), ttl ? Date.now() + ttl : 0);
  return p;
}
export function getPlace(id) {
  const r = db.prepare("SELECT payload FROM places WHERE id=?").get(id);
  return r ? JSON.parse(r.payload) : null;
}
for (const p of [...featured, ...demoPlaces]) savePlace(p);
export const defaultPreferences = PreferencesSchema.parse({});
export function createGuest() {
  const id = randomUUID();
  db.prepare("INSERT INTO users(id,nickname,preferences) VALUES(?,?,?)").run(
    id,
    "旅行者",
    JSON.stringify(defaultPreferences),
  );
  return id;
}
export function newSession(userId) {
  const token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    token,
    userId,
    Date.now() + 30 * 24 * 3600 * 1000,
  );
  return token;
}
export function getUser(id) {
  if (!id) return null;
  const r = db
    .prepare("SELECT id,username,nickname,preferences FROM users WHERE id=? AND deleted_at IS NULL")
    .get(id);
  return r ? { ...r, nickname: r.username || r.nickname, preferences: profilePreferences(JSON.parse(r.preferences)) } : null;
}
export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function verifyPassword(password, hash) {
  if (!hash) return false;
  const [salt, key] = hash.split(":");
  return timingSafeEqual(
    scryptSync(password, salt, 64),
    Buffer.from(key, "hex"),
  );
}
export function getTrip(id, userId) {
  const r = db
    .prepare(
      "SELECT payload,favorite,status,saved_visible,footprint_visible FROM trips WHERE id=? AND user_id=?",
    )
    .get(id, userId);
  return r
    ? {
        ...JSON.parse(r.payload),
        favorite: Boolean(r.favorite),
        status: r.status,
        savedVisible: Boolean(r.saved_visible),
        footprintVisible: Boolean(r.footprint_visible),
      }
    : null;
}
export function saveTrip(trip, userId) {
  db.prepare(
    "INSERT INTO trips(id,user_id,payload) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload WHERE user_id=excluded.user_id",
  ).run(trip.id, userId, JSON.stringify(trip));
  db.prepare("DELETE FROM trip_audits WHERE trip_id=?").run(trip.id);
  return trip;
}
export function saveAudit(tripId, audit) {
  db.prepare("INSERT OR REPLACE INTO trip_audits VALUES(?,?)").run(
    tripId,
    JSON.stringify(audit),
  );
  return audit;
}
export function getAudit(tripId) {
  const row = db
    .prepare("SELECT payload FROM trip_audits WHERE trip_id=?")
    .get(tripId);
  return row ? JSON.parse(row.payload) : null;
}
export function tripPlaces(trip) {
  const ids = new Set(
    trip.days.flatMap((d) => d.items.map((i) => i.placeId)).filter(Boolean),
  );
  return [...ids].map(getPlace).filter(Boolean);
}
