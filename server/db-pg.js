// PathWars store: Postgres backend (Supabase or any Postgres).
// Same export names and shapes as db.js (SQLite). Every function is async;
// server.js speaks to store.js and never knows which backend is live.
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});
pool.on('error', (e) => console.error('[db] pool error', e?.message || e));

await pool.query(`
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  nick TEXT NOT NULL DEFAULT '',
  points INTEGER NOT NULL DEFAULT 0,
  games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  token TEXT NOT NULL DEFAULT '',
  user_id TEXT,
  updated_at BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL DEFAULT '',
  nick TEXT NOT NULL DEFAULT '',
  points INTEGER NOT NULL DEFAULT 0,
  games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  nick_notice TEXT,
  created_at BIGINT NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_nick ON users(lower(nick));
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(lower(email));
CREATE TABLE IF NOT EXISTS friendships (
  a TEXT NOT NULL, b TEXT NOT NULL, since BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (a, b)
);
CREATE TABLE IF NOT EXISTS friend_requests (
  from_id TEXT NOT NULL, to_id TEXT NOT NULL, created BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (from_id, to_id)
);
CREATE TABLE IF NOT EXISTS day_points (
  owner TEXT NOT NULL, day TEXT NOT NULL,
  nick TEXT NOT NULL DEFAULT '',
  points INTEGER NOT NULL DEFAULT 0,
  games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  account INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner, day)
);
`);

const pair = (x, y) => (x < y ? [x, y] : [y, x]);

export function mskDay() {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

export async function getDevice(id) {
  const r = await pool.query('SELECT * FROM devices WHERE id = $1', [id]);
  return r.rows[0] || null;
}

export async function upsertDevice(id, nick, token) {
  const now = Date.now();
  const cur = await getDevice(id);
  if (!cur) {
    await pool.query(
      'INSERT INTO devices (id, nick, points, token, updated_at) VALUES ($1, $2, 0, $3, $4)',
      [id, nick || '', token, now]);
    return getDevice(id);
  }
  await pool.query('UPDATE devices SET nick = $1, token = $2, updated_at = $3 WHERE id = $4',
    [nick || cur.nick, token, now, id]);
  return getDevice(id);
}

export async function addGame(id, delta, won) {
  const d = await getDevice(id);
  if (!d) return null;
  if (d.user_id) {
    const u = await getUserById(d.user_id);
    if (!u) return d;
    const points = Math.max(0, u.points + delta);
    await pool.query(
      'UPDATE users SET points = $1, games = games + 1, wins = wins + $2, losses = losses + $3 WHERE id = $4',
      [points, won ? 1 : 0, won ? 0 : 1, d.user_id]);
    return getUserById(d.user_id);
  }
  const points = Math.max(0, d.points + delta);
  await pool.query(
    'UPDATE devices SET points = $1, games = games + 1, wins = wins + $2, losses = losses + $3, updated_at = $4 WHERE id = $5',
    [points, won ? 1 : 0, won ? 0 : 1, Date.now(), id]);
  return getDevice(id);
}

export async function getUserById(id) {
  const r = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return r.rows[0] || null;
}
export async function getUserByNick(nick) {
  const r = await pool.query('SELECT * FROM users WHERE lower(nick) = lower($1)', [nick]);
  return r.rows[0] || null;
}
export async function getUserByEmail(email) {
  const r = await pool.query('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
  return r.rows[0] || null;
}
export async function createUserRow({ id, email, nick }) {
  await pool.query('INSERT INTO users (id, email, nick, created_at) VALUES ($1, $2, $3, $4)',
    [id, email, nick, Date.now()]);
  return getUserById(id);
}
export async function setUserNick(id, nick) {
  await pool.query('UPDATE users SET nick = $1 WHERE id = $2', [nick, id]);
  return getUserById(id);
}
export async function clearNickNotice(id) {
  await pool.query('UPDATE users SET nick_notice = NULL WHERE id = $1', [id]);
}
export async function linkDevice(deviceId, userId) {
  const d = await getDevice(deviceId);
  if (!d) return getUserById(userId);
  if (!d.user_id) {
    if (d.points) await pool.query('UPDATE users SET points = points + $1 WHERE id = $2', [d.points, userId]);
    await pool.query('UPDATE devices SET user_id = $1 WHERE id = $2', [userId, deviceId]);
  }
  return getUserById(userId);
}
export async function deleteUserLocal(userId) {
  const devs = (await pool.query('SELECT id FROM devices WHERE user_id = $1', [userId])).rows.map((r) => r.id);
  for (const o of [`u:${userId}`, ...devs]) {
    const rids = (await pool.query('SELECT id FROM reviews WHERE owner = $1', [o])).rows;
    for (const r of rids) await pool.query('DELETE FROM review_likes WHERE review = $1', [r.id]);
    await pool.query('DELETE FROM reviews WHERE owner = $1', [o]);
    await pool.query('DELETE FROM day_points WHERE owner = $1', [o]);
  }
  if (devs.length) {
    const liked = (await pool.query('SELECT DISTINCT review FROM review_likes WHERE device = ANY($1)', [devs])).rows;
    await pool.query('DELETE FROM review_likes WHERE device = ANY($1)', [devs]);
    for (const r of liked) {
      const n = await pool.query('SELECT COUNT(*) AS c FROM review_likes WHERE review = $1', [r.review]);
      await pool.query('UPDATE reviews SET likes = $1 WHERE id = $2', [Number(n.rows[0].c), r.review]);
    }
  }
  for (const d of devs) {
    await pool.query('DELETE FROM friendships WHERE a = $1 OR b = $1', [d]);
    await pool.query('DELETE FROM friend_requests WHERE from_id = $1 OR to_id = $1', [d]);
    await pool.query('DELETE FROM devices WHERE id = $1', [d]);
  }
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
}

export async function ownerOf(deviceId) {
  const d = await getDevice(deviceId);
  if (!d) return { id: deviceId, account: 0, nick: '?' };
  if (d.user_id) {
    const u = await getUserById(d.user_id);
    return { id: 'u:' + d.user_id, account: 1, nick: u ? u.nick : d.nick };
  }
  return { id: deviceId, account: 0, nick: d.nick };
}
export async function recordDay(owner, nick, delta, won) {
  await pool.query(`INSERT INTO day_points (owner, day, nick, points, games, wins, account)
    VALUES ($1, $2, $3, $4, 1, $5, $6)
    ON CONFLICT(owner, day) DO UPDATE SET nick = excluded.nick, points = day_points.points + excluded.points, games = day_points.games + 1, wins = day_points.wins + excluded.wins`,
    [owner.id, mskDay(), nick, delta, won ? 1 : 0, owner.account]);
}
export async function boardToday(limit = 50) {
  const r = await pool.query(`SELECT nick, points, wins FROM day_points
    WHERE day = $1 AND points > 0 ORDER BY points DESC, wins DESC, nick ASC LIMIT $2`, [mskDay(), limit]);
  return r.rows;
}
export async function todayRank(ownerId) {
  const r = await pool.query(`SELECT owner FROM day_points
    WHERE day = $1 AND points > 0 ORDER BY points DESC, wins DESC, nick ASC`, [mskDay()]);
  const i = r.rows.findIndex((x) => x.owner === ownerId);
  return i < 0 ? null : i + 1;
}
export async function todayMe(ownerId) {
  const r = await pool.query('SELECT points, wins FROM day_points WHERE owner = $1 AND day = $2', [ownerId, mskDay()]);
  if (!r.rows[0]) return { points: 0, wins: 0, rank: null };
  return { points: r.rows[0].points, wins: r.rows[0].wins, rank: await todayRank(ownerId) };
}
export async function boardAll(limit = 50) {
  const r = await pool.query(`SELECT nick, points, wins FROM users
    WHERE games > 0 ORDER BY points DESC, wins DESC, nick ASC LIMIT $1`, [limit]);
  return r.rows;
}
export async function accountRank(userId) {
  const r = await pool.query('SELECT id FROM users WHERE games > 0 ORDER BY points DESC, wins DESC, nick ASC');
  const i = r.rows.findIndex((x) => x.id === userId);
  return i < 0 ? null : i + 1;
}
export async function deviceByNick(nick) {
  const r = await pool.query('SELECT * FROM devices WHERE lower(nick) = lower($1) ORDER BY updated_at DESC LIMIT 1', [nick]);
  return r.rows[0] || null;
}
export async function latestDevice(userId) {
  const r = await pool.query('SELECT id FROM devices WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1', [userId]);
  return r.rows[0] ? r.rows[0].id : null;
}

export async function addFriendship(x, y) {
  const [a, b] = pair(x, y);
  if (a === b) return;
  await pool.query('INSERT INTO friendships (a, b, since) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [a, b, Date.now()]);
  await pool.query('DELETE FROM friend_requests WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1)', [x, y]);
}
export async function removeFriendship(x, y) {
  const [a, b] = pair(x, y);
  await pool.query('DELETE FROM friendships WHERE a = $1 AND b = $2', [a, b]);
}
export async function friendIds(id) {
  const r = await pool.query('SELECT a, b FROM friendships WHERE a = $1 OR b = $1', [id]);
  return r.rows.map((x) => (x.a === id ? x.b : x.a));
}
export async function addRequest(from, to) {
  if (from === to) return;
  const [a, b] = pair(from, to);
  const ex = await pool.query('SELECT 1 FROM friendships WHERE a = $1 AND b = $2', [a, b]);
  if (ex.rows[0]) return;
  await pool.query('INSERT INTO friend_requests (from_id, to_id, created) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [from, to, Date.now()]);
}
export async function answerRequest(from, to, yes) {
  await pool.query('DELETE FROM friend_requests WHERE from_id = $1 AND to_id = $2', [from, to]);
  if (yes) await addFriendship(from, to);
}
export async function incomingRequests(id) {
  const r = await pool.query('SELECT from_id FROM friend_requests WHERE to_id = $1', [id]);
  return r.rows.map((x) => x.from_id);
}

await pool.query(`
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
  created BIGINT NOT NULL DEFAULT 0
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
async function streakRow(owner) {
  const r = await pool.query('SELECT * FROM streaks WHERE owner = $1', [owner]);
  return r.rows[0] || { owner, days: 0, best: 0, last_day: '', lost_days: 0, lost_at: '', freeze_month: '' };
}
export async function streakBreakCheck(owner) {
  const r = await streakRow(owner);
  const td = mskDay(), y = yd();
  if (r.last_day && r.last_day !== td && r.last_day !== y) {
    if (Number(r.days) >= 3 && !Number(r.lost_days)) {
      await pool.query(`INSERT INTO streaks (owner, days, best, last_day, lost_days, lost_at, freeze_month)
        VALUES ($1, 0, $2, '', $3, $4, $5)
        ON CONFLICT(owner) DO UPDATE SET days = 0, last_day = '', lost_days = excluded.lost_days, lost_at = excluded.lost_at`,
        [owner, r.best, r.days, td, r.freeze_month]);
      return { ...r, days: 0, last_day: '', lost_days: r.days, lost_at: td };
    }
    if (Number(r.days)) {
      await pool.query('UPDATE streaks SET days = 0, last_day = $1 WHERE owner = $2', ['', owner]);
      return { ...r, days: 0, last_day: '' };
    }
  }
  return r;
}
export async function advanceStreak(owner) {
  let r = await streakBreakCheck(owner);
  const td = mskDay(), y = yd();
  if (r.last_day === td) return { days: Number(r.days), best: Number(r.best), advanced: false };
  let days, advanced = true;
  if (r.last_day === y && Number(r.days) > 0) days = Number(r.days) + 1;
  else {
    if (Number(r.days) >= 3 && !Number(r.lost_days)) {
      await pool.query(`INSERT INTO streaks (owner, lost_days, lost_at)
        VALUES ($1, $2, $3) ON CONFLICT(owner) DO UPDATE SET lost_days = excluded.lost_days, lost_at = excluded.lost_at`,
        [owner, r.days, td]);
      r = { ...r, lost_days: r.days, lost_at: td };
    }
    days = 1;
  }
  const best = Math.max(Number(r.best), days);
  await pool.query(`INSERT INTO streaks (owner, days, best, last_day, freeze_month)
    VALUES ($1, $2, $3, $4, $5) ON CONFLICT(owner) DO UPDATE SET days = excluded.days,
    best = excluded.best, last_day = excluded.last_day`,
    [owner, days, best, td, r.freeze_month]);
  return { days, best, advanced };
}
export async function streakView(owner) {
  const r = await streakBreakCheck(owner);
  const td = mskDay(), y = yd();
  const days = Number(r.days), lost = Number(r.lost_days);
  const state = !days && !lost ? 'none'
    : r.last_day === td ? 'today'
    : r.last_day === y ? 'risk'
    : lost ? 'lost' : 'none';
  return {
    streak: days, streakBest: Number(r.best), streakToday: r.last_day === td,
    streakState: state, streakLost: lost,
    streakFree: (r.freeze_month || '') !== ym(),
  };
}
export async function restoreStreak(owner) {
  const r = await streakRow(owner);
  if (!Number(r.lost_days)) return { ok: false };
  const td = mskDay(), month = ym();
  const days = Number(r.lost_days);
  const best = Math.max(Number(r.best), days);
  await pool.query(`INSERT INTO streaks (owner, days, best, last_day, lost_days, lost_at, freeze_month)
    VALUES ($1, $2, $3, $4, 0, '', $5) ON CONFLICT(owner) DO UPDATE SET days = excluded.days,
    best = excluded.best, last_day = excluded.last_day, lost_days = 0, lost_at = '',
    freeze_month = excluded.freeze_month`,
    [owner, days, best, td, month]);
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
async function dailyRowPg(owner) {
  const day = mskDay();
  await pool.query('INSERT INTO daily_progress (owner, day) VALUES ($1, $2) ON CONFLICT DO NOTHING', [owner, day]);
  const r = await pool.query('SELECT * FROM daily_progress WHERE owner = $1 AND day = $2', [owner, day]);
  return r.rows[0];
}
function taskProgress(task, row) {
  const n = (k) => Number(row[k]);
  switch (task) {
    case 'play4': return n('games');
    case 'win2': case 'win3': case 'win_human': return n('wins');
    case 'walls12': return n('walls');
    case 'win_thrifty': return n('thrifty');
    case 'win_strong': return n('strong');
    case 'quad_play': return n('quad_games');
    default: return n('games');
  }
}
export async function noteDailyGame(owner, ev) {
  const t = todayTask();
  const day = mskDay();
  await dailyRowPg(owner);
  await pool.query(`UPDATE daily_progress SET games = games + 1, wins = wins + $1,
    walls = walls + $2, quad_games = quad_games + $3, thrifty = thrifty + $4,
    strong = strong + $5 WHERE owner = $6 AND day = $7`,
    [ev.won ? 1 : 0, ev.walls, ev.quad ? 1 : 0, ev.thrifty ? 1 : 0, ev.strong ? 1 : 0, owner, day]);
  const row = await dailyRowPg(owner);
  const progress = taskProgress(t.task, row);
  const wasDone = Boolean(row.done);
  const justDone = !wasDone && progress >= t.target;
  if (justDone) await pool.query('UPDATE daily_progress SET done = 1 WHERE owner = $1 AND day = $2', [owner, day]);
  return { progress, done: wasDone || justDone, justDone };
}
export async function dailyState(owner) {
  const t = todayTask();
  const row = await dailyRowPg(owner);
  return { task: t.task, target: t.target, progress: taskProgress(t.task, row), done: Boolean(row.done), reward: t.reward };
}
export async function grantPoints(owner, n) {
  if (owner.startsWith('u:')) {
    await pool.query('UPDATE users SET points = points + $1 WHERE id = $2', [n, owner.slice(2)]);
    const u = await getUserById(owner.slice(2));
    return u ? u.points : 0;
  }
  await pool.query('UPDATE devices SET points = points + $1 WHERE id = $2', [n, owner]);
  const d = await getDevice(owner);
  return d ? d.points : 0;
}
export async function savePushSub({ endpoint, device, p256dh, auth, lang }) {
  await pool.query(`INSERT INTO push_subs (endpoint, device, p256dh, auth, lang, created)
    VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT(endpoint) DO UPDATE SET device = excluded.device,
    p256dh = excluded.p256dh, auth = excluded.auth, lang = excluded.lang`,
    [endpoint, device, p256dh, auth, lang, Date.now()]);
}
export async function removePushSub(endpoint) {
  await pool.query('DELETE FROM push_subs WHERE endpoint = $1', [endpoint]);
}
export async function subsForDevices(devices) {
  if (!devices.length) return [];
  const r = await pool.query('SELECT endpoint, p256dh, auth FROM push_subs WHERE device = ANY($1)', [devices]);
  return r.rows;
}
export async function devicesOfOwner(owner) {
  if (owner.startsWith('u:')) {
    const r = await pool.query('SELECT id FROM devices WHERE user_id = $1', [owner.slice(2)]);
    return r.rows.map((x) => x.id);
  }
  const d = await getDevice(owner);
  return d ? [owner] : [];
}
export async function streakRiskOwners() {
  const r = await pool.query('SELECT owner FROM streaks WHERE days > 0 AND last_day = $1', [yd()]);
  return r.rows.map((x) => x.owner);
}
export async function pushLogged(owner, day, kind) {
  const r = await pool.query('SELECT 1 FROM push_log WHERE owner = $1 AND day = $2 AND kind = $3', [owner, day, kind]);
  return Boolean(r.rows[0]);
}
export async function logPush(owner, day, kind) {
  await pool.query('INSERT INTO push_log (owner, day, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [owner, day, kind]);
}

await pool.query(`
CREATE TABLE IF NOT EXISTS visits (
  id SERIAL PRIMARY KEY,
  device TEXT NOT NULL DEFAULT '',
  nick TEXT NOT NULL DEFAULT '',
  game INTEGER NOT NULL DEFAULT 0,
  lang TEXT NOT NULL DEFAULT '',
  tz TEXT NOT NULL DEFAULT '',
  installed INTEGER NOT NULL DEFAULT 0,
  src TEXT NOT NULL DEFAULT '',
  day TEXT NOT NULL DEFAULT '',
  at BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_visits_day ON visits(day);
`);

export async function logVisit(v) {
  try {
    await pool.query(`INSERT INTO visits (device, nick, game, lang, tz, installed, src, day, at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [String(v.device || '').slice(0, 64), String(v.nick || '').slice(0, 16),
        v.game ? 1 : 0, String(v.lang || '').slice(0, 16), String(v.tz || '').slice(0, 64),
        v.installed ? 1 : 0, String(v.src || '').slice(0, 40),
        mskDay(), Date.now()]);
  } catch (e) { console.error('[visit]', e?.message || e); }
}

await pool.query(`
CREATE TABLE IF NOT EXISTS reviews (
  id SERIAL PRIMARY KEY,
  owner TEXT NOT NULL UNIQUE,
  nick TEXT NOT NULL DEFAULT '',
  stars INTEGER NOT NULL DEFAULT 5,
  text TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT 'en',
  reply TEXT,
  likes INTEGER NOT NULL DEFAULT 0,
  at BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS review_likes (
  review INTEGER NOT NULL, device TEXT NOT NULL,
  PRIMARY KEY (review, device)
);
`);

export async function upsertReview(owner, nick, stars, text, lang) {
  const now = Date.now();
  await pool.query(`INSERT INTO reviews (owner, nick, stars, text, lang, at)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT(owner) DO UPDATE SET nick = excluded.nick, stars = excluded.stars,
      text = excluded.text, lang = excluded.lang, at = excluded.at`,
    [owner, nick, stars, text, lang, now]);
  const r = await pool.query('SELECT id FROM reviews WHERE owner = $1', [owner]);
  return r.rows[0] ? r.rows[0].id : null;
}
export async function reviewStats() {
  const r = await pool.query('SELECT stars, COUNT(*) AS c FROM reviews GROUP BY stars');
  const byStar = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let count = 0, sum = 0;
  for (const row of r.rows) {
    const s = Number(row.stars), c = Number(row.c);
    if (!(s in byStar)) continue;
    byStar[s] = c; count += c; sum += s * c;
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
export async function reviewRows(filter, device, limit = 100) {
  const f = REVIEW_FILTERS[filter] || REVIEW_FILTERS.new;
  const r = await pool.query(`SELECT r.id, r.nick, r.stars, r.text, r.reply, r.at, r.likes,
      CASE WHEN l.device IS NULL THEN 0 ELSE 1 END AS liked
    FROM reviews r LEFT JOIN review_likes l ON l.review = r.id AND l.device = $1
    WHERE 1 = 1 ${f.w} ORDER BY ${f.o} LIMIT $2`, [device || '', limit]);
  return r.rows.map((x) => ({ ...x, at: new Date(Number(x.at)).toISOString(), liked: Boolean(x.liked) }));
}
export async function toggleLike(id, device) {
  if (!id || !device) return null;
  const has = await pool.query('SELECT 1 FROM review_likes WHERE review = $1 AND device = $2', [id, device]);
  if (has.rows[0]) {
    await pool.query('DELETE FROM review_likes WHERE review = $1 AND device = $2', [id, device]);
  } else {
    const ok = await pool.query('SELECT 1 FROM reviews WHERE id = $1', [id]);
    if (!ok.rows[0]) return null;
    await pool.query('INSERT INTO review_likes (review, device) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, device]);
  }
  const n = await pool.query('SELECT COUNT(*) AS c FROM review_likes WHERE review = $1', [id]);
  const likes = Number(n.rows[0].c);
  await pool.query('UPDATE reviews SET likes = $1 WHERE id = $2', [likes, id]);
  return { likes, liked: !has.rows[0] };
}
