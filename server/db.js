// PathWars guest store (SQLite, local dev).
// Guests are keyed by the client device id (wr_device). Points, games and
// friendships live here; when Supabase auth arrives, rows gain a user id and
// devices merge into accounts — the protocol already speaks in stable ids.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
export const db = new DatabaseSync(path.join(dir, 'pathwars.sqlite'));

db.exec(`
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  nick TEXT NOT NULL DEFAULT '',
  points INTEGER NOT NULL DEFAULT 0,
  games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  token TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS friendships (
  a TEXT NOT NULL, b TEXT NOT NULL, since INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (a, b)
);
CREATE TABLE IF NOT EXISTS friend_requests (
  from_id TEXT NOT NULL, to_id TEXT NOT NULL, created INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (from_id, to_id)
);
`);

const pair = (x, y) => (x < y ? [x, y] : [y, x]);

/* ---- accounts (Supabase Auth owns the password; we own game data) ---- */
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL DEFAULT '',
  nick TEXT NOT NULL DEFAULT '',
  points INTEGER NOT NULL DEFAULT 0,
  games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  nick_notice TEXT,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_nick ON users(lower(nick));
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(lower(email));
`);
try { db.exec('ALTER TABLE devices ADD COLUMN user_id TEXT'); } catch { /* already there */ }

export function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}
export function getUserByNick(nick) {
  return db.prepare('SELECT * FROM users WHERE lower(nick) = lower(?)').get(nick) || null;
}
export function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(email) || null;
}
export function createUserRow({ id, email, nick }) {
  db.prepare('INSERT INTO users (id, email, nick, created_at) VALUES (?, ?, ?, ?)').run(id, email, nick, Date.now());
  return getUserById(id);
}
export function setUserNick(id, nick) {
  db.prepare('UPDATE users SET nick = ? WHERE id = ?').run(nick, id);
  return getUserById(id);
}
export function clearNickNotice(id) {
  db.prepare('UPDATE users SET nick_notice = NULL WHERE id = ?').run(id);
}
// First link moves the guest progress onto the account (the FAQ promises this).
// Later devices just attach: points must not move twice.
export function linkDevice(deviceId, userId) {
  const d = getDevice(deviceId);
  if (!d) return getUserById(userId);
  if (!d.user_id) {
    if (d.points) db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(d.points, userId);
    db.prepare('UPDATE devices SET user_id = ? WHERE id = ?').run(userId, deviceId);
  }
  return getUserById(userId);
}
export function deleteUserLocal(userId) {
  const devs = db.prepare('SELECT id FROM devices WHERE user_id = ?').all(userId).map((r) => r.id);
  for (const d of devs) {
    db.prepare('DELETE FROM friendships WHERE a = ? OR b = ?').run(d, d);
    db.prepare('DELETE FROM friend_requests WHERE from_id = ? OR to_id = ?').run(d, d);
    db.prepare('DELETE FROM devices WHERE id = ?').run(d);
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

export function getDevice(id) {
  return db.prepare('SELECT * FROM devices WHERE id = ?').get(id) || null;
}

export function upsertDevice(id, nick, token) {
  const now = Date.now();
  const cur = getDevice(id);
  if (!cur) {
    db.prepare('INSERT INTO devices (id, nick, points, token, updated_at) VALUES (?, ?, 0, ?, ?)')
      .run(id, nick || '', token, now);
    return getDevice(id);
  }
  db.prepare('UPDATE devices SET nick = ?, token = ?, updated_at = ? WHERE id = ?')
    .run(nick || cur.nick, token, now, id);
  return getDevice(id);
}

export function addGame(id, delta, won) {
  const d = getDevice(id);
  if (!d) return null;
  // logged-in guests play on the account row, so points follow them anywhere
  if (d.user_id) {
    const u = getUserById(d.user_id);
    if (!u) return d;
    const points = Math.max(0, u.points + delta);
    db.prepare('UPDATE users SET points = ?, games = games + 1, wins = wins + ?, losses = losses + ? WHERE id = ?')
      .run(points, won ? 1 : 0, won ? 0 : 1, d.user_id);
    return getUserById(d.user_id);
  }
  const points = Math.max(0, d.points + delta);
  db.prepare('UPDATE devices SET points = ?, games = games + 1, wins = wins + ?, losses = losses + ?, updated_at = ? WHERE id = ?')
    .run(points, won ? 1 : 0, won ? 0 : 1, Date.now(), id);
  return getDevice(id);
}

export function addFriendship(x, y) {
  const [a, b] = pair(x, y);
  if (a === b) return;
  db.prepare('INSERT OR IGNORE INTO friendships (a, b, since) VALUES (?, ?, ?)').run(a, b, Date.now());
  db.prepare('DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)').run(x, y, y, x);
}

export function removeFriendship(x, y) {
  const [a, b] = pair(x, y);
  db.prepare('DELETE FROM friendships WHERE a = ? AND b = ?').run(a, b);
}

export function friendIds(id) {
  const rows = db.prepare('SELECT a, b FROM friendships WHERE a = ? OR b = ?').all(id, id);
  return rows.map((r) => (r.a === id ? r.b : r.a));
}

export function addRequest(from, to) {
  if (from === to) return;
  const [a, b] = pair(from, to);
  if (db.prepare('SELECT 1 FROM friendships WHERE a = ? AND b = ?').get(a, b)) return;
  db.prepare('INSERT OR IGNORE INTO friend_requests (from_id, to_id, created) VALUES (?, ?, ?)').run(from, to, Date.now());
}

export function answerRequest(from, to, yes) {
  db.prepare('DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?').run(from, to);
  if (yes) addFriendship(from, to);
}

export function incomingRequests(id) {
  return db.prepare('SELECT from_id FROM friend_requests WHERE to_id = ?').all(id).map((r) => r.from_id);
}

/* ---- leaderboard: one row per points-owner per Moscow day ----
   Owner = the account when the device is linked, else the device itself,
   so one player is one line even across phones. The client counts its day
   as UTC+3 (mskToday) — the server uses the identical boundary. */
export function mskDay() {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}
export function ownerOf(deviceId) {
  const d = getDevice(deviceId);
  if (!d) return { id: deviceId, account: 0, nick: '?' };
  if (d.user_id) {
    const u = getUserById(d.user_id);
    return { id: 'u:' + d.user_id, account: 1, nick: u ? u.nick : d.nick };
  }
  return { id: deviceId, account: 0, nick: d.nick };
}
export function recordDay(owner, nick, delta, won) {
  db.prepare(`INSERT INTO day_points (owner, day, nick, points, games, wins, account)
    VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(owner, day) DO UPDATE SET nick = excluded.nick, points = points + excluded.points, games = games + 1, wins = wins + excluded.wins`)
    .run(owner.id, mskDay(), nick, delta, won ? 1 : 0, owner.account);
}
export function boardToday(limit = 50) {
  return db.prepare(`SELECT nick, points, wins FROM day_points
    WHERE day = ? AND points > 0 ORDER BY points DESC, wins DESC, nick ASC LIMIT ?`).all(mskDay(), limit);
}
export function todayRank(ownerId) {
  const rows = db.prepare(`SELECT owner FROM day_points
    WHERE day = ? AND points > 0 ORDER BY points DESC, wins DESC, nick ASC`).all(mskDay());
  const i = rows.findIndex((r) => r.owner === ownerId);
  return i < 0 ? null : i + 1;
}
export function todayMe(ownerId) {
  const r = db.prepare('SELECT points, wins FROM day_points WHERE owner = ? AND day = ?').get(ownerId, mskDay());
  if (!r) return { points: 0, wins: 0, rank: null };
  return { points: r.points, wins: r.wins, rank: todayRank(ownerId) };
}
// All-time board is accounts only (guests get their pinned row + note).
export function boardAll(limit = 50) {
  return db.prepare(`SELECT nick, points, wins FROM users
    WHERE games > 0 ORDER BY points DESC, wins DESC, nick ASC LIMIT ?`).all(limit);
}
export function accountRank(userId) {
  const rows = db.prepare('SELECT id FROM users WHERE games > 0 ORDER BY points DESC, wins DESC, nick ASC').all();
  const i = rows.findIndex((r) => r.id === userId);
  return i < 0 ? null : i + 1;
}
export function deviceByNick(nick) {
  return db.prepare('SELECT * FROM devices WHERE lower(nick) = lower(?) ORDER BY updated_at DESC LIMIT 1').get(nick) || null;
}
export function latestDevice(userId) {
  const r = db.prepare('SELECT id FROM devices WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1').get(userId);
  return r ? r.id : null;
}
