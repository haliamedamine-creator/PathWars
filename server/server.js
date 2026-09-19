// PathWars match server: static hosting + guest accounts (SQLite) + WebSocket game loop.
//
// Protocol (mirrors what app/js/appb3b0.js speaks):
//   hello/lobby_sub/lobby_unsub/quick/create_room/join_room/join_code/leave_room
//   sync/move/resign/emoji/rematch/friend_*  ->  hello_ok/lobby/room_created/
//   room_wait/game_start/state/game_over/player_out/opp_disconnected/
//   opp_reconnected/rematch_offer/rematch_declined/room_closed/no_game/error/...
//
// Guests are identified by client device id. No auth yet — jwt is ignored.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import webpush from 'web-push';
import { initialState, applyMove, eliminate, nextAlive, aliveCount } from '../app/js/engine.js';
import { pointsDelta, quadPointsDelta } from '../app/js/ranks.js';
import { checkNick } from '../app/js/nick.js';
import {
  getDevice, upsertDevice, addGame,
  getUserById, getUserByNick, getUserByEmail, createUserRow, setUserNick,
  clearNickNotice, linkDevice, deleteUserLocal,
  ownerOf, recordDay, boardToday, todayMe, boardAll, accountRank, mskDay,
  deviceByNick, latestDevice,
  upsertReview, reviewStats, reviewRows, toggleLike,
  logVisit,
  yd, streakBreakCheck, advanceStreak, streakView, restoreStreak,
  todayTask, noteDailyGame, dailyState, grantPoints,
  savePushSub, removePushSub, subsForDevices, devicesOfOwner,
  streakRiskOwners, pushLogged, logPush,
  addFriendship, removeFriendship, friendIds, addRequest, answerRequest, incomingRequests,
} from './store.js';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_KEY || '';
const AUTH_ON = Boolean(SUPABASE_URL && SUPABASE_ANON);

const VAPID_PUBLIC = process.env.VAPID_PUBLIC || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || '';
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails('mailto:ads@pathwars.online', VAPID_PUBLIC, VAPID_PRIVATE);
}

/* ---- Supabase Auth (publishable key validates, service key administers) ---- */
const tokenCache = new Map(); // token -> { user, exp }
async function supaUser(token) {
  if (!token || !AUTH_ON) return null;
  const hit = tokenCache.get(token);
  if (hit && hit.exp > Date.now()) return hit.user;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const user = await r.json();
    if (!user?.id) return null;
    if (tokenCache.size > 500) tokenCache.clear();
    tokenCache.set(token, { user, exp: Date.now() + 60_000 });
    return user;
  } catch { return null; }
}
async function supaAdmin(path, method = 'GET', body = null) {
  if (!SUPABASE_SERVICE) return { error: 'no_service_key' };
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE, Authorization: `Bearer ${SUPABASE_SERVICE}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

const PORT = Number(process.env.PORT || 3000);
const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../app');
const MOVE_LIMIT = 30_000;            // per-move cap, matches client display
const BANKS = { 0: 3_600_000, 3: 180_000, 5: 300_000 };  // '0' = no limit: 1h bank
const FORFEIT_MS = 35_000;            // grace after a disconnect (client grants 30s)
const CODE_ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};
const PAGES = ['ru', 'reviews', 'rules', 'help', 'terms', 'privacy'];

/* Ratings a visitor can see: the home pill, the JSON-LD and the reviews
   score block stay empty until real ratings exist, then the server fills
   them on every serve. Cached copies go stale, exactly like the original. */
async function injectRatings(html, page) {
  let s;
  try { s = await reviewStats(); } catch { return html; }
  if (!s.count) return html;
  const agg = `"aggregateRating":{"@type":"AggregateRating","ratingValue":${s.avg},"ratingCount":${s.count},"bestRating":"5","worstRating":"1"}`;
  if (page === 'index') {
    html = html.replace('"@type": "VideoGame","name"', `"@type": "VideoGame",${agg},"name"`);
    html = html.replace('<a class="rating-pill" id="rating-pill" href="reviews.html" hidden>',
      `<a class="rating-pill" id="rating-pill" href="reviews.html" aria-label="${s.avg} of 5, ${s.count} ratings">`);
    html = html.replace('<span class="rp-star">★</span><b>–</b><small></small>',
      `<span class="rp-star">★</span><b>${s.avg}</b><small>${s.count}</small>`);
  } else if (page === 'reviews') {
    html = html.replace('"@type":"SoftwareApplication","name"', `"@type":"SoftwareApplication",${agg},"name"`);
    html = html.replace('No ratings yet — yours could be the first.', `${s.avg} out of 5 from ${s.count} players.`);
    html = html.replace('<div class="big"><b>–</b><div class="stars">★★★★★</div><small>No ratings yet</small></div>',
      `<div class="big"><b>${s.avg}</b><div class="stars">★★★★★</div><small>${s.count} ratings</small></div>`);
    const bars = [5, 4, 3, 2, 1].map((st) => {
      const b = s.spread.find((x) => x.stars === st) || { count: 0, pct: 0 };
      return `<div class="bar"><span class="bl">${'★'.repeat(st)}</span>` +
        `<span class="bt"><i style="width:${b.pct}%"></i></span>` +
        `<span class="bn">${b.count} <small>(${b.pct}%)</small></span></div>`;
    }).join('');
    html = html.replace('<div class="bars"><p class="lede">Ratings are left inside the game after a match. Play and leave the first one.</p></div>',
      `<div class="bars">${bars}</div>`);
  }
  return html;
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(AUTH_ON
      ? { auth: true, supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON,
          ...(VAPID_PUBLIC ? { vapid: VAPID_PUBLIC } : {}) }
      : { auth: false }));
    return;
  }
  if (url.pathname === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('User-agent: *\nAllow: /\nSitemap: https://pathwars.online/sitemap.xml\n');
    return;
  }
  if (url.pathname === '/sitemap.xml') {
    const pages = ['', '/ru', '/reviews', '/rules', '/help', '/terms', '/privacy',
      '/ru/pravila', '/ru/pomosh', '/ru/usloviya', '/ru/konfidencialnost'];
    const xml = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
      pages.map((q) => `<url><loc>https://pathwars.online${q}</loc></url>`).join('') + '</urlset>';
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(xml);
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  else if (PAGES.includes(p.slice(1))) p += '.html';
  else if (p.startsWith('/ru/')) p += '.html';
  const file = path.normalize(path.join(APP_DIR, p));
  if (!file.startsWith(APP_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' };
  if (p === '/sw.js') headers['Service-Worker-Allowed'] = '/';
  if (p === '/index.html' || p === '/reviews.html') {
    let html = fs.readFileSync(file, 'utf-8');
    html = await injectRatings(html, p === '/index.html' ? 'index' : 'reviews');
    res.writeHead(200, headers);
    res.end(html);
    return;
  }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

/* ================= account API (what the auth forms speak) ================= */
function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
const json = (res, code, o) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(o));
};
const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TYPO_DOMAINS = {
  'gmial.com': 'gmail.com', 'gmaill.com': 'gmail.com', 'gmail.con': 'gmail.com',
  'gmal.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmail.co': 'gmail.com',
  'yahooo.com': 'yahoo.com', 'yaho.com': 'yahoo.com', 'yahoo.con': 'yahoo.com',
  'hotmial.com': 'hotmail.com', 'hotmai.com': 'hotmail.com', 'hotmail.con': 'hotmail.com',
  'outlok.com': 'outlook.com', 'outlook.con': 'outlook.com',
  'iclod.com': 'icloud.com', 'icloud.con': 'icloud.com',
};
function emailProblem(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(e)) return { error: 'email_bad' };
  const [user, domain] = e.split('@');
  if (TYPO_DOMAINS[domain]) return { error: 'email_typo', suggest: `${user}@${TYPO_DOMAINS[domain]}` };
  return null;
}
async function nickProblem(nick, ignoreUserId = null) {
  const n = String(nick || '').trim();
  const bad = checkNick(n);
  if (bad === 'format') return { error: 'nick_bad' };
  if (bad === 'rude') return { error: 'nick_rude' };
  if (bad === 'reserved') return { error: 'nick_reserved' };
  if (bad) return { error: 'nick_bad' };
  const taken = await getUserByNick(n);
  if (taken && taken.id !== ignoreUserId) return { error: 'nick_taken' };
  return null;
}
const toProfile = (u) => u ? {
  nick: u.nick, wins: u.wins, losses: u.losses,
  ...(u.nick_notice ? { nick_notice: u.nick_notice } : {}),
} : null;

async function handleApi(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/api/config') { serveStatic(req, res); return; }

  if (p === '/api/register' && req.method === 'POST') {
    const b = await readBody(req);
    const em = emailProblem(b.email);
    if (em) return json(res, 200, em);
    if (String(b.password || '').length < 6) return json(res, 200, { error: 'password_short' });
    const np = await nickProblem(b.nick);
    if (np) return json(res, 200, np);
    if (await getUserByEmail(b.email)) return json(res, 200, { error: 'email_taken' });
    // server-side signup: the account is created already confirmed
    const created = await supaAdmin('/users', 'POST', {
      email: String(b.email).trim().toLowerCase(),
      password: String(b.password),
      email_confirm: true,
      user_metadata: { nick: String(b.nick).trim() },
    });
    if (created.error) return json(res, 200, { error: 'unavailable' });
    if (!created.data?.id) {
      const msg = String(created.data?.msg || created.data?.message || '');
      if (/already (been )?registered|already exists|duplicate|taken/i.test(msg)) {
        return json(res, 200, { error: 'email_taken' });
      }
      return json(res, 200, { error: 'unavailable', detail: msg.slice(0, 120) });
    }
    await createUserRow({ id: created.data.id, email: String(b.email).trim().toLowerCase(), nick: String(b.nick).trim() });
    if (b.device) await linkDevice(String(b.device), created.data.id);
    return json(res, 200, {});
  }

  if (p === '/api/resolve-login' && req.method === 'POST') {
    const b = await readBody(req);
    const u = await getUserByNick(String(b.nick || ''));
    if (!u) return json(res, 200, { error: 'not_found' });
    return json(res, 200, { email: u.email });
  }

  if (p === '/api/profile' && req.method === 'GET') {
    const u = await supaUser(bearer(req));
    const row = u ? await getUserById(u.id) : null;
    return json(res, 200, { profile: toProfile(row) });
  }

  if (p === '/api/profile' && req.method === 'POST') {
    const u = await supaUser(bearer(req));
    if (!u) return json(res, 401, { error: 'auth' });
    const b = await readBody(req);
    const np = await nickProblem(b.nick, u.id);
    if (np) return json(res, 200, np);
    await setUserNick(u.id, String(b.nick).trim());
    if (b.device) await linkDevice(String(b.device), u.id);
    return json(res, 200, { profile: toProfile(await getUserById(u.id)) });
  }

  if (p === '/api/nick-notice/ack' && req.method === 'POST') {
    const u = await supaUser(bearer(req));
    if (u) await clearNickNotice(u.id);
    return json(res, 200, {});
  }

  if (p === '/api/account/delete' && req.method === 'POST') {
    const u = await supaUser(bearer(req));
    if (!u) return json(res, 401, { error: 'auth' });
    const b = await readBody(req);
    if (String(b.confirm || '').toUpperCase() !== 'DELETE') return json(res, 400, { error: 'confirm' });
    await deleteUserLocal(u.id);
    if (SUPABASE_SERVICE) {
      try { await supaAdmin(`/users/${u.id}`, 'DELETE'); } catch { /* local wipe already done */ }
    }
    for (const [k, v] of tokenCache) if (v.user?.id === u.id) tokenCache.delete(k);
    return json(res, 200, {});
  }

  if (p === '/api/leaderboard' && req.method === 'GET') {
    const scope = url.searchParams.get('scope') === 'today' ? 'today' : 'all';
    const day = mskDay();
    const u = await supaUser(bearer(req));
    const dev = String(req.headers['x-device'] || '');
    if (scope === 'today') {
      const owner = u ? { id: 'u:' + u.id, account: 1 } : await ownerOf(dev);
      return json(res, 200, { rows: await boardToday(), day, me: await todayMe(owner.id) });
    }
    const rows = await boardAll();
    if (u) {
      const row = await getUserById(u.id);
      return json(res, 200, {
        rows, day,
        me: row
          ? { points: row.points, wins: row.wins, rank: await accountRank(u.id), listed: true }
          : { points: 0, wins: 0, rank: null, listed: true },
      });
    }
    const d = dev ? await getDevice(dev) : null;
    return json(res, 200, {
      rows, day,
      me: { points: d?.points || 0, wins: d?.wins || 0, rank: null, listed: false },
    });
  }

  if (p === '/api/player' && req.method === 'GET') {
    const nick = String(url.searchParams.get('nick') || '');
    const u = await getUserByNick(nick);
    if (u) {
      return json(res, 200, {
        player: {
          id: u.id, nick: u.nick, points: u.points,
          wins: u.wins, losses: u.losses, place: await accountRank(u.id), streak: 0,
        },
      });
    }
    const d = await deviceByNick(nick);
    if (d) {
      return json(res, 200, {
        player: { nick: d.nick, points: d.points, wins: d.wins, losses: d.losses, place: null, streak: 0 },
      });
    }
    return json(res, 200, { player: null });
  }

  // fire-and-forget analytics: never break the game over a stat row
  if (p === '/api/visit' && req.method === 'POST') {
    const b = await readBody(req);
    await logVisit(b);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/review' && req.method === 'POST') {    const b = await readBody(req);
    const stars = Number(b.stars);
    if (!(stars >= 1 && stars <= 5)) return json(res, 400, { error: 'stars' });
    const device = String(b.device || '');
    const u = await supaUser(bearer(req));
    let owner;
    if (u) {
      owner = { id: 'u:' + u.id, account: 1 };
    } else {
      // the gate mirrors the client: an account, or ten games on the device
      if (!device) return json(res, 400, { error: 'device' });
      owner = await ownerOf(device);
      const d = await getDevice(device);
      if ((d?.games || 0) < 10) return json(res, 403, { error: 'gated' });
    }
    const nick = String(b.nick || owner.nick || '?').slice(0, 16);
    const text = String(b.text || '').slice(0, 400);
    const lang = String(b.lang || 'en').slice(0, 8);
    await upsertReview(owner.id, nick, stars, text, lang);
    return json(res, 200, {});
  }

  if (p === '/api/reviews' && req.method === 'GET') {
    const f = String(url.searchParams.get('f') || 'new');
    const device = String(url.searchParams.get('device') || '');
    const s = await reviewStats();
    return json(res, 200, {
      count: s.count, avg: s.avg, spread: s.spread,
      rows: await reviewRows(f, device),
    });
  }

  if (p === '/api/review/like' && req.method === 'POST') {
    const b = await readBody(req);
    const r = await toggleLike(Number(b.id), String(b.device || ''));
    if (!r) return json(res, 400, { error: 'like' });
    return json(res, 200, r);
  }

  if (p === '/api/streak/restore' && req.method === 'POST') {
    const b = await readBody(req);
    const u = await supaUser(bearer(req));
    const device = String(b.device || '');
    const owner = u ? 'u:' + u.id : (await ownerOf(device)).id;
    if (!u && !device) return json(res, 400, { error: 'device' });
    const r = await restoreStreak(owner);
    if (!r.ok) return json(res, 200, { ok: false });
    return json(res, 200, { ok: true, streak: r.streak });
  }

  if (p === '/api/push/subscribe' && req.method === 'POST') {
    const b = await readBody(req);
    const sub = b.sub || {};
    if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
      return json(res, 400, { error: 'sub' });
    }
    await savePushSub({
      endpoint: String(sub.endpoint).slice(0, 500),
      device: String(b.device || '').slice(0, 64),
      p256dh: String(sub.keys.p256dh).slice(0, 200),
      auth: String(sub.keys.auth).slice(0, 100),
      lang: String(b.lang || 'en').slice(0, 8),
    });
    return json(res, 200, { ok: true });
  }

  if (p === '/api/push/unsubscribe' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.endpoint) await removePushSub(String(b.endpoint));
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  (async () => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/')) { await handleApi(req, res); return; }
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
      await serveStatic(req, res);
    } catch { try { res.writeHead(500); res.end(); } catch {} }
  })();
});

/* ---- streaks, daily tasks, push: per-owner helpers ---- */
async function ownerPoints(owner) {
  if (owner.startsWith('u:')) return (await getUserById(owner.slice(2)))?.points || 0;
  return (await getDevice(owner))?.points || 0;
}
async function dailyMsg(owner, extra = {}) {
  const d = await dailyState(owner);
  return {
    t: 'daily', task: d.task, target: d.target, progress: d.progress,
    done: d.done, reward: d.reward, points: await ownerPoints(owner), ...extra,
  };
}
// walls this seat owns on the finished board (thrifty wins need the count)
function wallsBy(state, seat) {
  let n = 0;
  for (const w of state.walls || []) if (w.by === seat) n++;
  return n;
}
async function sendPush(sub, payload) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return false;
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload));
    return true;
  } catch (e) {
    // dead endpoints go away: the client row turns itself off either way
    if (e?.statusCode === 404 || e?.statusCode === 410) {
      try { await removePushSub(sub.endpoint); } catch {}
    }
    return false;
  }
}

/* ================= live state ================= */
const socks = new Map();       // ws -> rec { device, conn, nick, roomId, seat, helloed, alive, ws }
const devConns = new Map();  // deviceId -> Set(rec); one device may hold several tabs
const rooms = new Map();     // roomId -> room
const byCode = new Map();    // code -> roomId
const lobbySubs = new Set(); // sockets
let quickWaiter = null;      // rec
const onlineCount = () => { let n = 0; for (const r of socks.values()) if (r.helloed) n++; return n; };
function devRecs(dev) { return devConns.get(dev) || new Set(); }
function recOf(device, conn) {
  for (const r of devRecs(device)) if (r.conn === conn) return r;
  return null;
}
function recOfSeat(room, i) {
  const s = room.seats[i];
  return s ? recOf(s.device, s.conn) : null;
}
function sendToDevice(device, o) { for (const r of devRecs(device)) send(r.ws, o); }

const seatsOf = (mode) => (mode === 'quad' ? 4 : 2);
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const rnd = (n) => crypto.randomInt(n);
const makeCode = () => Array.from({ length: 6 }, () => CODE_ABC[rnd(CODE_ABC.length)]).join('');
const nowMs = () => Date.now();

async function liveNick(dev) {
  for (const r of devRecs(dev)) return r.nick;
  return (await getDevice(dev))?.nick || '?';
}
async function livePoints(dev) {
  return (await getDevice(dev))?.points || 0;
}
function isBusy(dev) {
  for (const r of devRecs(dev)) {
    if (r.roomId == null) continue;
    const rm = rooms.get(r.roomId);
    if (rm && rm.live && !rm.over) return true;
  }
  return false;
}

async function occupant(room, i) {
  const s = room.seats[i];
  if (!s) return null;
  return { nick: await liveNick(s.device), id: s.device, points: await livePoints(s.device) };
}
async function seatPlayers(room) {
  return Promise.all(room.seats.map((_, i) => occupant(room, i)));
}

function clocksFor(room) {
  const now = nowMs();
  return {
    bank: [...room.banks], turn: room.state.turn,
    turnStarted: room.turnStartedAt - room.turnSpent, serverNow: now,
    moveLimit: MOVE_LIMIT, moveSpent: room.turnSpent, paused: room.paused,
  };
}

function broadcastRoom(room, o, except = null) {
  for (const s of room.seats) {
    if (!s) continue;
    const rec = recOf(s.device, s.conn);
    if (rec && rec.ws !== except && rec.roomId === room.id) send(rec.ws, o);
  }
}

async function lobbyRooms() {
  const out = [];
  for (const r of rooms.values()) {
    if (r.private || r.live || r.over) continue;
    const taken = r.seats.filter(Boolean).length;
    if (taken === 0) continue;
    const host = r.seats.find(Boolean);
    out.push({
      id: r.id, nick: await liveNick(host.device), points: await livePoints(host.device),
      mode: r.mode, walls: String(r.walls), time: r.timeMin,
      seats: seatsOf(r.mode), taken,
    });
  }
  return out;
}
async function broadcastLobby() {
  try {
    const msg = { t: 'lobby', online: onlineCount(), rooms: await lobbyRooms() };
    for (const ws of lobbySubs) send(ws, msg);
  } catch (e) { console.error('[lobby]', e?.message || e); }
}

/* ================= timers ================= */
function clearTurnTimer(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
}
function spentThisTurn(room) {
  return room.turnSpent + (room.paused ? 0 : nowMs() - room.turnStartedAt);
}
function scheduleTurn(room) {
  clearTurnTimer(room);
  if (room.over || !room.live || room.paused) return;
  const spent = spentThisTurn(room);
  const left = Math.min(MOVE_LIMIT - spent, room.banks[room.state.turn] - spent);
  room.timer = setTimeout(() => {
    const s2 = spentThisTurn(room);
    const bankOut = room.banks[room.state.turn] - s2 <= 0;
    forfeitSeat(room, room.state.turn, bankOut ? 'timeout' : 'move_timeout')
      .catch((e) => console.error('[turn]', e?.message || e));
  }, Math.max(0, left));
}
function pauseRoom(room) {
  if (room.paused) return;
  room.turnSpent += nowMs() - room.turnStartedAt;
  room.paused = true;
  clearTurnTimer(room);
}
function resumeRoom(room) {
  if (!room.paused) return;
  room.paused = false;
  room.turnStartedAt = nowMs();
  scheduleTurn(room);
}
function anyoneAway(room) {
  return room.seats.some((s) => {
    if (!s) return false;
    const r = recOf(s.device, s.conn);
    return !r || !r.ws;
  });
}

/* ================= rooms ================= */
function newRoom({ mode, walls, timeMin, isPrivate, code }) {
  const id = 'r' + crypto.randomBytes(4).toString('hex');
  const room = {
    id, mode, walls, timeMin, bankMs: BANKS[timeMin] ?? BANKS[5],
    private: isPrivate, code: code || null,
    seats: Array(seatsOf(mode)).fill(null),
    state: null, banks: [], turnStartedAt: 0, turnSpent: 0, paused: false,
    live: false, over: false, winner: null, out: {}, rematch: new Set(),
    timer: null, forfeits: new Map(), starter: 0,
  };
  rooms.set(id, room);
  if (room.code) byCode.set(room.code, id);
  return room;
}
function deleteRoom(room) {
  clearTurnTimer(room);
  for (const t of room.forfeits.values()) clearTimeout(t);
  room.forfeits.clear();
  if (room.code) byCode.delete(room.code);
  rooms.delete(room.id);
}
function freeSeat(room) {
  return room.seats.findIndex((s) => !s);
}
function leaveSeat(room, seat) {
  room.seats[seat] = null;
  room.rematch.delete(seat);
}

function seatPlayer(room, device, conn, nick) {
  const i = freeSeat(room);
  if (i < 0) return -1;
  room.seats[i] = { device, conn, nick };
  const rec = recOf(device, conn);
  if (rec) { rec.roomId = room.id; rec.seat = i; }
  return i;
}

async function sendRoomWait(room) {
  broadcastRoom(room, {
    t: 'room_wait', room: room.id, seats: seatsOf(room.mode), players: await seatPlayers(room),
  });
}

async function gameStartMsg(room, seat) {
  const occ = room.seats[seat];
  const me = { points: await livePoints(occ.device), veteran: ((await getDevice(occ.device))?.games || 0) > 0 };
  const base = {
    t: 'game_start', room: room.id, state: room.state, you: seat,
    clocks: clocksFor(room), me, ranked: true, resumed: false,
  };
  if (room.mode === 'quad') return { ...base, players: await seatPlayers(room) };
  const o = room.seats[1 - seat];
  return { ...base, opp: o ? { nick: await liveNick(o.device), id: o.device, points: await livePoints(o.device) } : { nick: '???' } };
}

async function startGame(room) {
  room.state = initialState(room.mode, { walls: room.walls });
  if (room.mode !== 'quad') room.state.turn = room.starter;
  room.banks = room.seats.map(() => room.bankMs);
  room.turnStartedAt = nowMs();
  room.turnSpent = 0;
  room.paused = false;
  room.live = true;
  room.over = false;
  room.winner = null;
  room.out = {};
  room.rematch.clear();
  broadcastLobby();
  for (let i = 0; i < room.seats.length; i++) {
    const rec = recOfSeat(room, i);
    if (rec) send(rec.ws, await gameStartMsg(room, i));
  }
  scheduleTurn(room);
}

function sendState(room, to = null) {
  const msg = { t: 'state', room: room.id, state: room.state, clocks: clocksFor(room) };
  if (to) { send(to, msg); return; }
  broadcastRoom(room, msg);
}

/* ================= scoring & endings ================= */
async function endDuel(room, winner, reason, loserReason) {
  room.over = true;
  room.live = false;
  clearTurnTimer(room);
  // pre-game ratings first: the loop itself moves points around
  const pre = {};
  for (const s of room.seats) if (s) pre[s.device] = await livePoints(s.device);
  const tw = todayTask();
  for (let i = 0; i < room.seats.length; i++) {
    const s = room.seats[i];
    if (!s) continue;
    const opp = room.seats[1 - i];
    const won = i === winner;
    const delta = pointsDelta(pre[s.device] || 0, opp ? pre[opp.device] || 0 : 0, won);
    const d = await addGame(s.device, delta, won);
    const owner = await ownerOf(s.device);
    await recordDay(owner, s.nick, delta, won);
    const adv = await advanceStreak(owner.id);
    const wb = wallsBy(room.state, i);
    const dn = await noteDailyGame(owner.id, {
      won, walls: wb, quad: false,
      thrifty: won && wb <= 3,
      strong: won && (opp ? pre[opp.device] || 0 : 0) > (pre[s.device] || 0),
    });
    let total = d ? d.points : 0;
    if (dn.justDone) total = await grantPoints(owner.id, tw.reward);
    const rec = recOfSeat(room, i);
    if (rec && rec.roomId === room.id) {
      send(rec.ws, {
        t: 'game_over', room: room.id, winner, you: i,
        reason: won ? reason : (loserReason || reason),
        ...(won ? {} : (loserReason ? { yourReason: loserReason } : {})),
        points: { total },
      });
      send(rec.ws, { t: 'streak', room: room.id, streak: adv.days, best: adv.best, advanced: adv.advanced, froze: false });
      send(rec.ws, await dailyMsg(owner.id, dn.justDone ? { justDone: true } : {}));
    }
  }
}

function quadDecided(room) {
  if (room.state.winner != null) return room.state.winner;
  if (!room.state.alive) return null;
  if (room.state.alive.filter(Boolean).length === 1) {
    const w = room.state.alive.findIndex(Boolean);
    room.state.winner = w;
    return w;
  }
  return null;
}

async function endQuad(room, winner, reason) {
  room.over = true;
  room.live = false;
  clearTurnTimer(room);
  const field = Math.max(...await Promise.all(room.seats.filter(Boolean).map((s) => livePoints(s.device))));
  const pre = {};
  for (const s of room.seats) if (s) pre[s.device] = await livePoints(s.device);
  const tw = todayTask();
  for (let i = 0; i < room.seats.length; i++) {
    const s = room.seats[i];
    if (!s) continue;
    const won = i === winner;
    const out = room.out[i];
    const outcome = won ? 'win' : (out === 'left' || out === 'resign' || out === 'time' ? 'quit' : 'loss');
    const delta = quadPointsDelta(pre[s.device] || 0, field, outcome);
    const d = await addGame(s.device, delta, won);
    const owner = await ownerOf(s.device);
    await recordDay(owner, s.nick, delta, won);
    const adv = await advanceStreak(owner.id);
    const wb = wallsBy(room.state, i);
    const dn = await noteDailyGame(owner.id, {
      won, walls: wb, quad: true,
      thrifty: won && wb <= 3,
      strong: won && field > (pre[s.device] || 0),
    });
    let total = d ? d.points : 0;
    if (dn.justDone) total = await grantPoints(owner.id, tw.reward);
    const rec = recOfSeat(room, i);
    if (rec && rec.roomId === room.id) {
      send(rec.ws, {
        t: 'game_over', room: room.id, winner, you: i, reason,
        points: { total },
        players: await seatPlayers(room), out: { ...room.out },
      });
      send(rec.ws, { t: 'streak', room: room.id, streak: adv.days, best: adv.best, advanced: adv.advanced, froze: false });
      send(rec.ws, await dailyMsg(owner.id, dn.justDone ? { justDone: true } : {}));
    }
  }
}

async function forfeitSeat(room, seat, reason) {
  if (room.over || !room.live) return;
  if (!room.seats[seat]) return;
  if (room.mode === 'quad') {
    room.out[seat] = reason === 'move_timeout' || reason === 'timeout' ? 'time' : reason;
    eliminate(room.state, seat);
    broadcastRoom(room, { t: 'player_out', room: room.id, seat, reason: room.out[seat] });
    const w = quadDecided(room);
    if (w != null) { await endQuad(room, w, w === seat ? reason : 'last_standing'); return; }
    if (room.state.turn === seat) room.state.turn = nextAlive(room.state, seat);
    sendState(room);
    scheduleTurn(room);
    return;
  }
  const winner = 1 - seat;
  if (reason === 'resign') await endDuel(room, winner, 'resign', 'left');
  else await endDuel(room, winner, reason === 'left' ? 'opponent_left' : reason);
}

// voluntary resign from a still-connected player
async function resignSeat(room, seat) {
  if (room.over || !room.live) return;
  if (room.mode === 'quad') {
    room.out[seat] = 'resign';
    eliminate(room.state, seat);
    broadcastRoom(room, { t: 'player_out', room: room.id, seat, reason: 'resign' });
    const w = quadDecided(room);
    if (w != null) { await endQuad(room, w, 'last_standing'); return; }
    if (room.state.turn === seat) room.state.turn = nextAlive(room.state, seat);
    sendState(room);
    scheduleTurn(room);
    return;
  }
  forfeitSeat(room, seat, 'resign');
}

/* ================= presence ================= */
async function detach(rec) {
  const room = rec.roomId != null ? rooms.get(rec.roomId) : null;
  rec.ws = null;
  if (!room) return;
  if (!room.live) {
    // waiting seats evaporate; the room dies empty
    leaveSeat(room, rec.seat);
    rec.roomId = null; rec.seat = -1;
    if (room.seats.every((s) => !s)) deleteRoom(room);
    else if (room.mode === 'quad') await sendRoomWait(room);
    broadcastLobby();
    return;
  }
  // mid-game disconnect: freeze the clocks, warn the table, start the clock on absence
  pauseRoom(room);
  broadcastRoom(room, { t: 'opp_disconnected', room: room.id, clocks: clocksFor(room), nick: rec.nick });
  clearTimeout(room.forfeits.get(rec.seat));
  room.forfeits.set(rec.seat, setTimeout(() => {
    const gone = !rec.ws && room.seats[rec.seat]?.device === rec.device && room.seats[rec.seat]?.conn === rec.conn;
    if (gone && !room.over && room.live) {
      forfeitSeat(room, rec.seat, 'left').catch((e) => console.error('[forfeit]', e?.message || e));
    }
  }, FORFEIT_MS));
}

async function attach(rec) {
  const room = rec.roomId != null ? rooms.get(rec.roomId) : null;
  if (!room || !room.live || room.over) return;
  clearTimeout(room.forfeits.get(rec.seat));
  room.forfeits.delete(rec.seat);
  if (!anyoneAway(room)) resumeRoom(room);
  const msg = await gameStartMsg(room, rec.seat);
  msg.resumed = true;
  send(rec.ws, msg);
  broadcastRoom(room, { t: 'opp_reconnected', room: room.id, clocks: clocksFor(room), nick: rec.nick }, rec.ws);
}

/* ================= friends (device-scoped guests) ================= */
async function friendEntry(id) {
  let nick = null, online = false;
  for (const r of devRecs(id)) { nick = r.nick; if (r.ws) online = true; }
  const d = await getDevice(id);
  return {
    id, nick: nick || d?.nick || '?', points: d?.points || 0,
    online, busy: isBusy(id), streak: 0,
  };
}
async function pushFriends(device) {
  const recs = [...devRecs(device)].filter((r) => r.ws);
  if (!recs.length) return;
  const list = await Promise.all((await friendIds(device)).map(friendEntry));
  const reqs = await Promise.all((await incomingRequests(device)).map(async (id) => {
    const d = await getDevice(id);
    return { id, nick: d?.nick || '?', points: d?.points || 0 };
  }));
  for (const r of recs) {
    send(r.ws, { t: 'friends', room: undefined, list });
    send(r.ws, { t: 'friend_requests', room: undefined, list: reqs });
  }
}

// Friend ops name devices, but player cards hand out account ids —
// resolve those to the account's current device so adds and calls land.
async function resolveTarget(id) {
  if (await getDevice(id)) return id;
  const u = await getUserById(id);
  if (u) return latestDevice(u.id);
  return null;
}

/* ================= handlers ================= */
async function handleHello(ws, m) {
  const device = String(m.device || '');
  if (!device) return;
  const conn = String(m.conn || '');
  if (!conn) return;
  const nick = String(m.nick || '?').slice(0, 16);
  const token = crypto.randomUUID();
  const d = await upsertDevice(device, nick, token);
  // a signed-in device plays on its account row (guest progress merges once)
  let user = null;
  if (m.jwt) {
    const su = await supaUser(String(m.jwt));
    if (su) {
      if (!(await getUserById(su.id))) {
        await createUserRow({ id: su.id, email: String(su.email || ''), nick: d.nick });
      }
      user = await linkDevice(device, su.id);
    }
  }
  const pts = user ? user.points : d.points;
  const games = user ? user.games : d.games;
  const owner = user ? 'u:' + user.id : (await ownerOf(device)).id;
  const sv = await streakView(owner);
  // same tab reloaded: take over the old socket instead of haunting the count
  const old = recOf(device, conn);
  if (old) {
    if (old.ws && old.ws !== ws) { try { old.ws.close(); } catch {} }
    old.ws = null; old.roomId = null; old.seat = -1;
    const set = devConns.get(device);
    if (set) set.delete(old);
  }
  const rec = { ws, device, conn, nick: d.nick, roomId: old?.roomId ?? null, seat: old?.seat ?? -1, helloed: true, alive: true };
  socks.set(ws, rec);
  if (!devConns.has(device)) devConns.set(device, new Set());
  devConns.get(device).add(rec);
  send(ws, {
    t: 'hello_ok', token, online: onlineCount(),
    points: pts, veteran: games > 0,
    streak: sv.streak, streakBest: sv.streakBest, streakToday: sv.streakToday,
    streakState: sv.streakState, streakLost: sv.streakLost, streakFree: sv.streakFree,
  });
  await attach(rec);
  send(ws, await dailyMsg(owner));
  broadcastLobby();
}

function mySeat(ws) {
  const p = socks.get(ws);
  if (!p || p.roomId == null) return { p: null, room: null };
  const room = rooms.get(p.roomId);
  if (!room) { p.roomId = null; p.seat = -1; return { p, room: null }; }
  return { p, room };
}

function validRoomCfg(m) {
  const mode = ['duel', 'race', 'quad'].includes(m.mode) ? m.mode : 'duel';
  let walls = mode === 'quad' ? 7 : 10;
  if (mode === 'race' && (m.walls === 15 || m.walls === '15')) walls = 15;
  if (mode === 'duel') walls = 10;
  const timeMin = ['0', '3', '5'].includes(String(m.time)) ? String(m.time) : '5';
  return { mode, walls, timeMin };
}

async function handleCreate(ws, m) {
  const p = socks.get(ws);
  if (!p) return;
  await leaveCurrentRoom(p, true);
  const { mode, walls, timeMin } = validRoomCfg(m);
  const isPrivate = Boolean(m.private);
  const room = newRoom({ mode, walls, timeMin, isPrivate, code: isPrivate ? makeCode() : null });
  seatPlayer(room, p.device, p.conn, p.nick);
  send(ws, { t: 'room_created', room: room.id, mode, ...(room.code ? { code: room.code } : {}) });
  if (room.mode === 'quad') await sendRoomWait(room);
  broadcastLobby();
}

async function fillSeat(room, device, conn, nick) {
  const seat = seatPlayer(room, device, conn, nick);
  if (seat < 0) return -1;
  const taken = room.seats.filter(Boolean).length;
  if (taken >= seatsOf(room.mode)) await startGame(room);
  else if (room.mode === 'quad') await sendRoomWait(room);
  broadcastLobby();
  return seat;
}

async function handleJoinId(ws, id) {
  const room = rooms.get(id);
  const p = socks.get(ws);
  if (!p) return;
  if (!room || room.over) return send(ws, { t: 'error', code: 'room_not_found' });
  if (room.live) return send(ws, { t: 'error', code: 'room_full' });
  await leaveCurrentRoom(p, true);
  if (await fillSeat(room, p.device, p.conn, p.nick) < 0) return send(ws, { t: 'error', code: 'room_full' });
}

async function handleJoinCode(ws, code) {
  const id = byCode.get(String(code || '').toUpperCase());
  const p = socks.get(ws);
  if (!p) return;
  const room = id ? rooms.get(id) : null;
  if (!room || room.over) return send(ws, { t: 'error', code: 'room_not_found' });
  if (room.live) return send(ws, { t: 'error', code: 'room_full' });
  await leaveCurrentRoom(p, true);
  if (await fillSeat(room, p.device, p.conn, p.nick) < 0) return send(ws, { t: 'error', code: 'room_full' });
}

async function handleQuick(ws) {
  const p = socks.get(ws);
  if (!p) return;
  await leaveCurrentRoom(p, true);
  if (quickWaiter && quickWaiter !== p && quickWaiter.ws) {
    const other = quickWaiter;
    quickWaiter = null;
    const room = newRoom({ mode: 'duel', walls: 10, timeMin: '5', isPrivate: true, code: null });
    seatPlayer(room, other.device, other.conn, other.nick);
    seatPlayer(room, p.device, p.conn, p.nick);
    await startGame(room);
    return;
  }
  quickWaiter = p;
}

async function leaveCurrentRoom(p, silent) {
  if (quickWaiter === p) quickWaiter = null;
  if (p.roomId == null) return;
  const room = rooms.get(p.roomId);
  const seat = p.seat;
  p.roomId = null; p.seat = -1;
  if (!room) return;
  if (!room.live && !room.over) {
    leaveSeat(room, seat);
    if (room.seats.every((s) => !s)) deleteRoom(room);
    else {
      if (room.mode === 'quad') await sendRoomWait(room);
      broadcastLobby();
    }
    return;
  }
  if (!room.over && room.live) {
    // walking out of a live game counts as leaving it
    if (room.mode === 'quad') {
      room.out[seat] = 'left';
      eliminate(room.state, seat);
      broadcastRoom(room, { t: 'player_out', room: room.id, seat, reason: 'left' });
      const w = quadDecided(room);
      if (w != null) { await endQuad(room, w, 'last_standing'); return; }
      if (room.state.turn === seat) room.state.turn = nextAlive(room.state, seat);
      sendState(room);
      scheduleTurn(room);
    } else {
      await forfeitSeat(room, seat, 'left');
    }
  }
  if (!silent) broadcastLobby();
}

async function handleMove(ws, move) {
  const { p, room } = mySeat(ws);
  if (!p || !room || !room.live || room.over) return;
  if (!move || typeof move !== 'object') return;
  if (room.state.turn !== p.seat) return;
  const t0 = nowMs();
  const copy = JSON.parse(JSON.stringify(room.state));
  if (!applyMove(copy, move)) {
    send(ws, { t: 'error', code: 'bad_move' });
    sendState(room, ws);
    return;
  }
  // owner stamp: the client paints walls with seatColor(wall.by) and the
  // engine stores no owner, so an unstamped wall renders in the default dark.
  if (move.type === 'wall' && copy.walls.length) {
    copy.walls[copy.walls.length - 1].by = p.seat;
  }
  const spent = nowMs() - room.turnStartedAt + room.turnSpent;
  room.state = copy;
  room.turnSpent = 0;
  room.turnStartedAt = nowMs();
  if (room.state.winner != null) {
    if (room.mode === 'quad') await endQuad(room, room.state.winner, 'goal');
    else await endDuel(room, room.state.winner, 'goal');
    return;
  }
  sendState(room);
  scheduleTurn(room);
  const dt = nowMs() - t0;
  if (dt > 50) console.log(`[slow-move] ${dt}ms room=${room.id} seat=${p.seat}`);
}

async function handleRematch(ws, yes) {
  const { p, room } = mySeat(ws);
  if (!p || !room || room.over || !room.live) {
    // rematch arrives on the result screen: room is over but retained
    const r = p && p.roomId != null ? rooms.get(p.roomId) : null;
    if (!r || !r.over) return;
    if (yes) {
      r.rematch.add(p.seat);
      const need = r.seats.filter(Boolean).length;
      if (r.rematch.size >= need && need >= 2) {
        r.starter = r.starter === 0 ? 1 : 0;
        r.state = initialState(r.mode, { walls: r.walls });
        if (r.mode !== 'quad') r.state.turn = r.starter;
        r.banks = r.seats.map(() => r.bankMs);
        r.turnStartedAt = nowMs();
        r.turnSpent = 0; r.paused = false;
        r.live = true; r.over = false; r.winner = null; r.out = {};
        r.rematch.clear();
        broadcastLobby();
        for (let i = 0; i < r.seats.length; i++) {
          if (!r.seats[i]) continue;
          const rec = recOfSeat(r, i);
          if (rec && rec.roomId === r.id) send(rec.ws, await gameStartMsg(r, i));
        }
        scheduleTurn(r);
      } else {
        broadcastRoom(r, { t: 'rematch_offer', room: r.id }, ws);
      }
    } else {
      broadcastRoom(r, { t: 'rematch_declined', room: r.id }, ws);
      r.rematch.clear();
    }
    return;
  }
}

async function onMessage(ws, raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'hello') { handleHello(ws, m).catch(() => {}); return; }
  const p = socks.get(ws);
  if (!p) return;
  switch (m.t) {
    case 'lobby_sub': lobbySubs.add(ws); send(ws, { t: 'lobby', online: onlineCount(), rooms: await lobbyRooms() }); break;
    case 'lobby_unsub': lobbySubs.delete(ws); break;
    case 'quick': await handleQuick(ws); break;
    case 'create_room': await handleCreate(ws, m); break;
    case 'join_room': await handleJoinId(ws, m.roomId); break;
    case 'join_code': await handleJoinCode(ws, m.code); break;
    case 'leave_room': await leaveCurrentRoom(p); broadcastLobby(); break;
    case 'sync': {
      const { room } = mySeat(ws);
      if (room && room.live && !room.over) sendState(room, ws);
      else if (room && !room.live && room.mode === 'quad') await sendRoomWait(room);
      else if (!room) send(ws, { t: 'no_game' });
      break;
    }
    case 'move': await handleMove(ws, m.move); break;
    case 'resign': {
      const { room } = mySeat(ws);
      if (room && room.live && !room.over) await resignSeat(room, p.seat);
      break;
    }
    case 'emoji': {
      const { room } = mySeat(ws);
      if (room && room.live) broadcastRoom(room, { t: 'emoji', room: room.id, e: String(m.e || '').slice(0, 8), seat: p.seat }, ws);
      break;
    }
    case 'rematch': await handleRematch(ws, Boolean(m.yes)); break;
    case 'friends': await pushFriends(p.device); break;
    case 'friend_requests': await pushFriends(p.device); break;
    case 'friend_add': {
      const id = await resolveTarget(String(m.id || ''));
      if (id) {
        await addFriendship(p.device, id);
        send(ws, { t: 'friend_added' });
        await pushFriends(p.device);
        sendToDevice(id, { t: 'friend_added_you', nick: p.nick }); await pushFriends(id);
      }
      break;
    }
    case 'friend_request': {
      const id = await resolveTarget(String(m.id || ''));
      if (id) {
        await addRequest(p.device, id);
        send(ws, { t: 'friend_requested' });
        sendToDevice(id, { t: 'friend_request_in', nick: p.nick }); await pushFriends(id);
      }
      break;
    }
    case 'friend_answer': {
      const id = String(m.id || '');
      await answerRequest(id, p.device, Boolean(m.yes));
      if (m.yes) {
        send(ws, { t: 'friend_added' });
        await pushFriends(p.device);
        sendToDevice(id, { t: 'friend_added_you', nick: p.nick }); await pushFriends(id);
      } else {
        await pushFriends(p.device);
      }
      sendToDevice(id, { t: 'friend_answered', yes: Boolean(m.yes) });
      break;
    }
    case 'friend_remove': {
      await removeFriendship(p.device, String(m.id || ''));
      send(ws, { t: 'friend_removed', id: String(m.id || '') });
      await pushFriends(p.device);
      break;
    }
    case 'friend_call': {
      const targetId = await resolveTarget(String(m.id || ''));
      const targetOnline = targetId ? [...devRecs(targetId)].some((r) => r.ws) : false;
      const cfg = validRoomCfg(m);
      const room = newRoom({ mode: cfg.mode, walls: cfg.walls, timeMin: cfg.timeMin, isPrivate: true, code: makeCode() });
      await leaveCurrentRoom(p, true);
      seatPlayer(room, p.device, p.conn, p.nick);
      send(ws, { t: 'room_created', room: room.id, mode: room.mode, code: room.code });
      if (targetOnline) {
        sendToDevice(targetId, {
          t: 'friend_call', from: p.nick, code: room.code,
          mode: room.mode, walls: String(room.walls), time: room.timeMin,
        });
      } else {
        // offline but reachable: knock via push, the invite code rides along
        try {
          const devs = await devicesOfOwner(targetId);
          const subs = await subsForDevices(devs);
          for (const s of subs) {
            await sendPush(s, {
              title: `${p.nick} wants to play`,
              body: 'Tap to join their room before it fills.',
              url: `/#${room.code}`,
            });
          }
        } catch {}
        send(ws, { t: 'error' });
      }
      break;
    }
  }
}

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    // latency: small game frames must not wait for TCP delayed ACKs
    try { ws._socket?.setNoDelay?.(true); } catch {}
    ws.on('pong', () => { const r = socks.get(ws); if (r) r.alive = true; });
    ws.on('message', (raw) => onMessage(ws, raw.toString()).catch((e) => console.error('[ws]', e?.message || e)));
    ws.on('close', () => {
      const rec = socks.get(ws);
      lobbySubs.delete(ws);
      socks.delete(ws);
      if (rec) {
        const set = devConns.get(rec.device);
        if (set) { set.delete(rec); if (!set.size) devConns.delete(rec.device); }
        if (quickWaiter === rec) quickWaiter = null;
        detach(rec).catch((e) => console.error('[close]', e?.message || e));
      }
      broadcastLobby();
    });
    ws.on('error', () => {});
  });
});

process.on('unhandledRejection', (e) => console.error('[unhandled]', e?.message || e));

// Host health heartbeat: proves (or disproves) an underpowered box.
// Event-loop lag = how late this 60s timer fired; rss = real memory use.
// Read it in the host dashboard while a slow game is in progress.
let lastBeat = Date.now();
setInterval(() => {
  const now = Date.now();
  const lag = now - lastBeat - 60_000;
  lastBeat = now;
  console.log(`[perf] loop-lag=${lag}ms rss=${Math.round(process.memoryUsage().rss / 1048576)}MB`);
}, 60_000);

// Dead sockets (killed proxies, vanished phones) never send close:
// expect a pong to every ping, terminate whoever stays silent twice.
setInterval(() => {
  for (const [ws, rec] of socks) {
    if (!rec.helloed) continue;
    if (rec.alive === false) { try { ws.terminate(); } catch {} continue; }
    rec.alive = false;
    try { ws.ping(); } catch {}
  }
}, 25_000);

// Streaks at risk get one knock a day: alive yesterday, nothing today.
// Runs every half hour; push_log keeps it to a single knock per day.
async function streakScan() {
  try {
    if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
    const day = mskDay();
    for (const owner of await streakRiskOwners()) {
      if (await pushLogged(owner, day, 'streak')) continue;
      const subs = await subsForDevices(await devicesOfOwner(owner));
      if (!subs.length) continue;
      let sent = false;
      for (const s of subs) {
        if (await sendPush(s, {
          title: 'PathWars',
          body: 'Your streak ends tonight — play one game to keep the fire alive.',
          url: '/?go=quick',
        })) sent = true;
      }
      if (sent) await logPush(owner, day, 'streak');
    }
  } catch (e) { console.error('[streak-scan]', e?.message || e); }
}
setInterval(streakScan, 30 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`PathWars server on http://127.0.0.1:${PORT} (app + /ws + /api)`);
});
