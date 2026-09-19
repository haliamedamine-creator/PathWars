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
  // ratings, likes and day rows die with the account — deletion means everything
  for (const o of [`u:${userId}`, ...devs]) {
    const rids = db.prepare('SELECT id FROM reviews WHERE owner = ?').all(o).map((r) => r.id);
    for (const id of rids) db.prepare('DELETE FROM review_likes WHERE review = ?').run(id);
    db.prepare('DELETE FROM reviews WHERE owner = ?').run(o);
    db.prepare('DELETE FROM day_points WHERE owner = ?').run(o);
  }
  const liked = db.prepare(`SELECT DISTINCT review FROM review_likes WHERE device IN (${devs.map(() => '?').join(',') || "''"})`).all(...devs);
  db.prepare(`DELETE FROM review_likes WHERE device IN (${devs.map(() => '?').join(',') || "''"})`).run(...devs);
  for (const r of liked) {
    const n = db.prepare('SELECT COUNT(*) AS c FROM review_likes WHERE review = ?').get(r.review).c;
    db.prepare('UPDATE reviews SET likes = ? WHERE id = ?').run(n, r.review);
  }
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

/* ---- streaks, daily tasks, push: one row per points-owner ----
   Owner keying matches the leaderboard (account id when linked, else the
   device), so one player is one streak everywhere. Days use Moscow. */
db.exec(`
CREATE TABLE IF NOT EXISTS streaks (
  owner TEXT PRIMARY KEY,
  days INTEGER NOT NULL DEFAULT 0,
  best INTEGER NOT NULL DEFAULT 0,
  last_day TEXT NOT NULL DEFAULT '',
  lost_days INTEGER NOT NULL DEFAULT 0,
  lost_at TEXT NOT NULL DEFAULT '',
  freeze_month TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS daily_progress (
  owner TEXT NOT NULL, day TEXT NOT NULL,
  games INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0,
  walls INTEGER NOT NULL DEFAULT 0, quad_games INTEGER NOT NULL DEFAULT 0,
  thrifty INTEGER NOT NULL DEFAULT 0, strong INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner, day)
);
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  device TEXT NOT NULL DEFAULT '',
  p256dh TEXT NOT NULL DEFAULT '',
  auth TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT 'en',
  created INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS push_log (
  owner TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (owner, day, kind)
);
`);

export function yd() {
  return new Date(Date.now() + 3 * 3600 * 1000 - 24 * 3600 * 1000).toISOString().slice(0, 10);
}
export function ym() {
  return mskDay().slice(0, 7);
}
function streakRow(owner) {
  return db.prepare('SELECT * FROM streaks WHERE owner = ?').get(owner)
    || { owner, days: 0, best: 0, last_day: '', lost_days: 0, lost_at: '', freeze_month: '' };
}
// Idempotent: reading a stale streak archives an offerable one (>=3 days)
// and zeroes the rest. Never invents a day without a finished game.
export function streakBreakCheck(owner) {
  const r = streakRow(owner);
  const td = mskDay(), y = yd();
  if (r.last_day && r.last_day !== td && r.last_day !== y) {
    if (r.days >= 3 && !r.lost_days) {
      db.prepare(`INSERT INTO streaks (owner, days, best, last_day, lost_days, lost_at, freeze_month)
        VALUES (?, 0, ?, '', ?, ?, ?)
        ON CONFLICT(owner) DO UPDATE SET days = 0, last_day = '', lost_days = excluded.lost_days, lost_at = excluded.lost_at`)
        .run(owner, r.best, r.days, td, r.freeze_month);
      return { ...r, days: 0, last_day: '', lost_days: r.days, lost_at: td };
    }
    if (r.days) {
      db.prepare('UPDATE streaks SET days = 0, last_day = ? WHERE owner = ?').run('', owner);
      return { ...r, days: 0, last_day: '' };
    }
  }
  return r;
}
export function advanceStreak(owner) {
  let r = streakBreakCheck(owner);
  const td = mskDay(), y = yd();
  if (r.last_day === td) return { days: r.days, best: r.best, advanced: false };
  let days, advanced = true;
  if (r.last_day === y && r.days > 0) days = r.days + 1;
  else {
    if (r.days >= 3 && !r.lost_days) {
      db.prepare(`INSERT INTO streaks (owner, lost_days, lost_at)
        VALUES (?, ?, ?) ON CONFLICT(owner) DO UPDATE SET lost_days = excluded.lost_days, lost_at = excluded.lost_at`)
        .run(owner, r.days, td);
      r = { ...r, lost_days: r.days, lost_at: td };
    }
    days = 1;
  }
  const best = Math.max(r.best, days);
  db.prepare(`INSERT INTO streaks (owner, days, best, last_day, freeze_month)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner) DO UPDATE SET days = excluded.days,
    best = excluded.best, last_day = excluded.last_day`)
    .run(owner, days, best, td, r.freeze_month);
  return { days, best, advanced };
}
export function streakView(owner) {
  const r = streakBreakCheck(owner);
  const td = mskDay(), y = yd();
  const state = !r.days && !r.lost_days ? 'none'
    : r.last_day === td ? 'today'
    : r.last_day === y ? 'risk'
    : r.lost_days ? 'lost' : 'none';
  return {
    streak: r.days, streakBest: r.best, streakToday: r.last_day === td,
    streakState: state, streakLost: r.lost_days || 0,
    streakFree: (r.freeze_month || '') !== ym(),
  };
}
export function restoreStreak(owner) {
  const r = streakRow(owner);
  if (!r.lost_days) return { ok: false };
  const td = mskDay(), month = ym();
  const days = r.lost_days;
  const best = Math.max(r.best, days);
  db.prepare(`INSERT INTO streaks (owner, days, best, last_day, lost_days, lost_at, freeze_month)
    VALUES (?, ?, ?, ?, 0, '', ?) ON CONFLICT(owner) DO UPDATE SET days = excluded.days,
    best = excluded.best, last_day = excluded.last_day, lost_days = 0, lost_at = '',
    freeze_month = excluded.freeze_month`)
    .run(owner, days, best, td, month);
  return { ok: true, streak: days };
}
const DAY_TASKS = [
  { task: 'play4', target: 4, reward: 10 },
  { task: 'win2', target: 2, reward: 15 },
  { task: 'walls12', target: 12, reward: 10 },
  { task: 'win_human', target: 2, reward: 15 },
  { task: 'win_thrifty', target: 1, reward: 20 },
  { task: 'win3', target: 3, reward: 25 },
  { task: 'win_strong', target: 1, reward: 30 },
  { task: 'quad_play', target: 2, reward: 15 },
];
export function todayTask() {
  const start = Date.UTC(Number(mskDay().slice(0, 4)), 0, 0);
  const doy = Math.floor((Date.now() + 3 * 3600 * 1000 - start) / 86400000);
  return DAY_TASKS[((doy % DAY_TASKS.length) + DAY_TASKS.length) % DAY_TASKS.length];
}
function dailyRow(owner) {
  const day = mskDay();
  db.prepare(`INSERT INTO daily_progress (owner, day) VALUES (?, ?)
    ON CONFLICT(owner, day) DO NOTHING`).run(owner, day);
  return db.prepare('SELECT * FROM daily_progress WHERE owner = ? AND day = ?').get(owner, day);
}
function taskProgress(task, row) {
  switch (task) {
    case 'play4': return row.games;
    case 'win2': case 'win3': case 'win_human': return row.wins;
    case 'walls12': return row.walls;
    case 'win_thrifty': return row.thrifty;
    case 'win_strong': return row.strong;
    case 'quad_play': return row.quad_games;
    default: return row.games;
  }
}
// One finished online game. Returns the progress line for the daily card;
// justDone is true exactly on the game that closed the task.
export function noteDailyGame(owner, { won, walls, quad, thrifty, strong }) {
  const t = todayTask();
  const day = mskDay();
  dailyRow(owner); // ensure first: UPDATE on a missing row would drop this game
  db.prepare(`UPDATE daily_progress SET games = games + 1, wins = wins + ?,
    walls = walls + ?, quad_games = quad_games + ?, thrifty = thrifty + ?,
    strong = strong + ? WHERE owner = ? AND day = ?`)
    .run(won ? 1 : 0, walls, quad ? 1 : 0, thrifty ? 1 : 0, strong ? 1 : 0, owner, day);
  const row = dailyRow(owner);
  const progress = taskProgress(t.task, row);
  const wasDone = Boolean(row.done);
  const justDone = !wasDone && progress >= t.target;
  if (justDone) db.prepare('UPDATE daily_progress SET done = 1 WHERE owner = ? AND day = ?').run(owner, day);
  return { progress, done: wasDone || justDone, justDone };
}
export function dailyState(owner) {
  const t = todayTask();
  const row = dailyRow(owner);
  return { task: t.task, target: t.target, progress: taskProgress(t.task, row), done: Boolean(row.done), reward: t.reward };
}
export function grantPoints(owner, n) {
  if (owner.startsWith('u:')) {
    db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(n, owner.slice(2));
    return getUserById(owner.slice(2))?.points || 0;
  }
  db.prepare('UPDATE devices SET points = points + ? WHERE id = ?').run(n, owner);
  return getDevice(owner)?.points || 0;
}
export function savePushSub({ endpoint, device, p256dh, auth, lang }) {
  db.prepare(`INSERT INTO push_subs (endpoint, device, p256dh, auth, lang, created)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET device = excluded.device,
    p256dh = excluded.p256dh, auth = excluded.auth, lang = excluded.lang`)
    .run(endpoint, device, p256dh, auth, lang, Date.now());
}
export function removePushSub(endpoint) {
  db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(endpoint);
}
export function subsForDevices(devices) {
  if (!devices.length) return [];
  const q = devices.map(() => '?').join(',');
  return db.prepare(`SELECT endpoint, p256dh, auth FROM push_subs WHERE device IN (${q})`).all(...devices);
}
export function devicesOfOwner(owner) {
  if (owner.startsWith('u:')) {
    return db.prepare('SELECT id FROM devices WHERE user_id = ?').all(owner.slice(2)).map((r) => r.id);
  }
  return getDevice(owner) ? [owner] : [];
}
export function streakRiskOwners() {
  // alive streaks whose day is not yet closed: they must play before midnight
  return db.prepare('SELECT owner FROM streaks WHERE days > 0 AND last_day = ?').all(yd()).map((r) => r.owner);
}
export function pushLogged(owner, day, kind) {
  return Boolean(db.prepare('SELECT 1 FROM push_log WHERE owner = ? AND day = ? AND kind = ?').get(owner, day, kind));
}
export function logPush(owner, day, kind) {
  db.prepare('INSERT OR IGNORE INTO push_log (owner, day, kind) VALUES (?, ?, ?)').run(owner, day, kind);
}

/* ---- visits: raw analytics rows behind /api/visit ----
   One row per call (the client fires on boot, per game and on install).
   Day uses the Moscow boundary like everything else. */
db.exec(`
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device TEXT NOT NULL DEFAULT '',
  nick TEXT NOT NULL DEFAULT '',
  game INTEGER NOT NULL DEFAULT 0,
  lang TEXT NOT NULL DEFAULT '',
  tz TEXT NOT NULL DEFAULT '',
  installed INTEGER NOT NULL DEFAULT 0,
  src TEXT NOT NULL DEFAULT '',
  day TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_visits_day ON visits(day);
`);

export function logVisit(v) {
  try {
    db.prepare(`INSERT INTO visits (device, nick, game, lang, tz, installed, src, day, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        String(v.device || '').slice(0, 64), String(v.nick || '').slice(0, 16),
        v.game ? 1 : 0, String(v.lang || '').slice(0, 16), String(v.tz || '').slice(0, 64),
        v.installed ? 1 : 0, String(v.src || '').slice(0, 40),
        mskDay(), Date.now());
  } catch (e) { console.error('[visit]', e?.message || e); }
}

/* ---- reviews: one rating per points-owner, likes per device ----
   The gate (account, or ten games on the device) is enforced by the
   endpoint; the table just keeps the latest word of each owner. */
db.exec(`
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL UNIQUE,
  nick TEXT NOT NULL DEFAULT '',
  stars INTEGER NOT NULL DEFAULT 5,
  text TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT 'en',
  reply TEXT,
  likes INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS review_likes (
  review INTEGER NOT NULL, device TEXT NOT NULL,
  PRIMARY KEY (review, device)
);
`);

export function upsertReview(owner, nick, stars, text, lang) {
  const now = Date.now();
  db.prepare(`INSERT INTO reviews (owner, nick, stars, text, lang, at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner) DO UPDATE SET nick = excluded.nick, stars = excluded.stars,
      text = excluded.text, lang = excluded.lang, at = excluded.at`)
    .run(owner, nick, stars, text, lang, now);
  return db.prepare('SELECT id FROM reviews WHERE owner = ?').get(owner)?.id ?? null;
}
export function reviewStats() {
  const rows = db.prepare('SELECT stars, COUNT(*) AS c FROM reviews GROUP BY stars').all();
  const byStar = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let count = 0, sum = 0;
  for (const r of rows) {
    if (!(r.stars in byStar)) continue;
    byStar[r.stars] = r.c; count += r.c; sum += r.stars * r.c;
  }
  const avg = count ? Math.round((sum / count) * 10) / 10 : 0;
  const spread = [5, 4, 3, 2, 1].map((s) => ({
    stars: s, count: byStar[s], pct: count ? Math.round((100 * byStar[s]) / count) : 0,
  }));
  return { count, avg, spread };
}
const REVIEW_FILTERS = {
  new:   { w: '', o: 'r.at DESC, r.id DESC' },
  old:   { w: '', o: 'r.at ASC, r.id ASC' },
  text:  { w: "AND r.text <> ''", o: 'r.at DESC, r.id DESC' },
  good:  { w: 'AND r.stars >= 4', o: 'r.at DESC, r.id DESC' },
  bad:   { w: 'AND r.stars <= 3', o: 'r.at DESC, r.id DESC' },
  liked: { w: '', o: 'r.likes DESC, r.at DESC, r.id DESC' },
};
export function reviewRows(filter, device, limit = 100) {
  const f = REVIEW_FILTERS[filter] || REVIEW_FILTERS.new;
  const rows = db.prepare(`SELECT r.id, r.nick, r.stars, r.text, r.reply, r.at, r.likes,
      CASE WHEN l.device IS NULL THEN 0 ELSE 1 END AS liked
    FROM reviews r LEFT JOIN review_likes l ON l.review = r.id AND l.device = ?
    WHERE 1 = 1 ${f.w} ORDER BY ${f.o} LIMIT ?`).all(device || '', limit);
  return rows.map((r) => ({ ...r, at: new Date(r.at).toISOString(), liked: Boolean(r.liked) }));
}
export function toggleLike(id, device) {
  if (!id || !device) return null;
  const has = db.prepare('SELECT 1 FROM review_likes WHERE review = ? AND device = ?').get(id, device);
  if (has) db.prepare('DELETE FROM review_likes WHERE review = ? AND device = ?').run(id, device);
  else {
    if (!db.prepare('SELECT 1 FROM reviews WHERE id = ?').get(id)) return null;
    db.prepare('INSERT OR IGNORE INTO review_likes (review, device) VALUES (?, ?)').run(id, device);
  }
  const n = db.prepare('SELECT COUNT(*) AS c FROM review_likes WHERE review = ?').get(id).c;
  db.prepare('UPDATE reviews SET likes = ? WHERE id = ?').run(n, id);
  return { likes: n, liked: !has };
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
