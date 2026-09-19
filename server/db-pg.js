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
