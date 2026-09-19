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
import { initialState, applyMove, eliminate, nextAlive, aliveCount } from '../app/js/engine.js';
import { pointsDelta, quadPointsDelta } from '../app/js/ranks.js';
import { checkNick } from '../app/js/nick.js';
import {
  getDevice, upsertDevice, addGame,
  getUserById, getUserByNick, getUserByEmail, createUserRow, setUserNick,
  clearNickNotice, linkDevice, deleteUserLocal,
  ownerOf, recordDay, boardToday, todayMe, boardAll, accountRank, mskDay,
  deviceByNick, latestDevice,
  addFriendship, removeFriendship, friendIds, addRequest, answerRequest, incomingRequests,
} from './store.js';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_KEY || '';
const AUTH_ON = Boolean(SUPABASE_URL && SUPABASE_ANON);

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

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(AUTH_ON
      ? { auth: true, supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON }
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

  return json(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) { handleApi(req, res); return; }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    serveStatic(req, res);
  } catch { res.writeHead(500); res.end(); }
});

/* ================= live state ================= */
const players = new Map();   // deviceId -> { ws, nick, roomId, seat, helloed }
const conns = new Set();     // helloed sockets (for online count)
const rooms = new Map();     // roomId -> room
const byCode = new Map();    // code -> roomId
const lobbySubs = new Set(); // sockets
let quickWaiter = null;      // deviceId

const seatsOf = (mode) => (mode === 'quad' ? 4 : 2);
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const rnd = (n) => crypto.randomInt(n);
const makeCode = () => Array.from({ length: 6 }, () => CODE_ABC[rnd(CODE_ABC.length)]).join('');
const nowMs = () => Date.now();

async function liveNick(dev) {
  const p = players.get(dev);
  if (p) return p.nick;
  return (await getDevice(dev))?.nick || '?';
}
async function livePoints(dev) {
  return (await getDevice(dev))?.points || 0;
}
function isBusy(dev) {
  const p = players.get(dev);
  if (!p || p.roomId == null) return false;
  const r = rooms.get(p.roomId);
  return Boolean(r && r.live && !r.over);
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
    const p = players.get(s.device);
    if (p && p.ws !== except && p.roomId === room.id) send(p.ws, o);
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
    const msg = { t: 'lobby', online: conns.size, rooms: await lobbyRooms() };
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
    const p = players.get(s.device);
    return !p || p.roomId !== room.id;
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

function seatPlayer(room, device, nick) {
  const i = freeSeat(room);
  if (i < 0) return -1;
  room.seats[i] = { device, nick };
  const p = players.get(device);
  if (p) { p.roomId = room.id; p.seat = i; }
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
    const p = players.get(room.seats[i].device);
    if (p) send(p.ws, await gameStartMsg(room, i));
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
  for (let i = 0; i < room.seats.length; i++) {
    const s = room.seats[i];
    if (!s) continue;
    const opp = room.seats[1 - i];
    const won = i === winner;
    const delta = pointsDelta(await livePoints(s.device), opp ? await livePoints(opp.device) : 0, won);
    const d = await addGame(s.device, delta, won);
    recordDay(await ownerOf(s.device), s.nick, delta, won);
    const p = players.get(s.device);
    if (p && p.roomId === room.id) {
      send(p.ws, {
        t: 'game_over', room: room.id, winner, you: i,
        reason: won ? reason : (loserReason || reason),
        ...(won ? {} : (loserReason ? { yourReason: loserReason } : {})),
        points: { total: d ? d.points : 0 },
      });
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
  const field = Math.max(...room.seats.filter(Boolean).map((s) => livePoints(s.device)));
  for (let i = 0; i < room.seats.length; i++) {
    const s = room.seats[i];
    if (!s) continue;
    const won = i === winner;
    const out = room.out[i];
    const outcome = won ? 'win' : (out === 'left' || out === 'resign' || out === 'time' ? 'quit' : 'loss');
    const delta = quadPointsDelta(await livePoints(s.device), field, outcome);
    const d = await addGame(s.device, delta, won);
    recordDay(await ownerOf(s.device), s.nick, delta, won);
    const p = players.get(s.device);
    if (p && p.roomId === room.id) {
      send(p.ws, {
        t: 'game_over', room: room.id, winner, you: i, reason,
        points: { total: d ? d.points : 0 },
        players: seatPlayers(room), out: { ...room.out },
      });
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
async function detach(device, reason) {
  const p = players.get(device);
  if (!p) return;
  const room = p.roomId != null ? rooms.get(p.roomId) : null;
  p.ws = null;
  if (!room) return;
  if (!room.live) {
    // waiting seats evaporate; the room dies empty
    leaveSeat(room, p.seat);
    p.roomId = null; p.seat = -1;
    if (room.seats.every((s) => !s)) deleteRoom(room);
    else if (room.mode === 'quad') await sendRoomWait(room);
    broadcastLobby();
    return;
  }
  // mid-game disconnect: freeze the clocks, warn the table, start the clock on absence
  pauseRoom(room);
  broadcastRoom(room, { t: 'opp_disconnected', room: room.id, clocks: clocksFor(room), nick: p.nick });
  clearTimeout(room.forfeits.get(p.seat));
  room.forfeits.set(p.seat, setTimeout(() => {
    const pl = players.get(device);
    const stillAway = !pl || pl.roomId !== room.id;
    if (stillAway && !room.over && room.live && room.seats[p.seat]?.device === device) {
      forfeitSeat(room, p.seat, 'left').catch((e) => console.error('[forfeit]', e?.message || e));
    }
  }, FORFEIT_MS));
}

async function attach(device, ws) {
  const p = players.get(device);
  if (!p) return;
  p.ws = ws;
  const room = p.roomId != null ? rooms.get(p.roomId) : null;
  if (!room || !room.live || room.over) return;
  clearTimeout(room.forfeits.get(p.seat));
  room.forfeits.delete(p.seat);
  if (!anyoneAway(room)) resumeRoom(room);
  const msg = await gameStartMsg(room, p.seat);
  msg.resumed = true;
  send(ws, msg);
  broadcastRoom(room, { t: 'opp_reconnected', room: room.id, clocks: clocksFor(room), nick: p.nick }, ws);
}

/* ================= friends (device-scoped guests) ================= */
async function friendEntry(id) {
  const p = players.get(id);
  const d = await getDevice(id);
  return {
    id, nick: p ? p.nick : (d?.nick || '?'), points: d?.points || 0,
    online: Boolean(p && p.ws), busy: isBusy(id), streak: 0,
  };
}
async function pushFriends(device) {
  const p = players.get(device);
  if (!p || !p.ws) return;
  send(p.ws, { t: 'friends', room: undefined, list: await Promise.all((await friendIds(device)).map(friendEntry)) });
  send(p.ws, {
    t: 'friend_requests', room: undefined,
    list: await Promise.all((await incomingRequests(device)).map(async (id) => {
      const d = await getDevice(id);
      return { id, nick: d?.nick || '?', points: d?.points || 0 };
    })),
  });
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
  players.set(device, { ws, nick: d.nick, roomId: null, seat: -1, helloed: true });
  conns.add(ws);
  ws.device = device;
  send(ws, {
    t: 'hello_ok', token, online: conns.size,
    points: pts, veteran: games > 0,
    streak: 0, streakBest: 0, streakToday: false,
    streakState: 'none', streakLost: 0, streakFree: false,
  });
  await attach(device, ws);
  broadcastLobby();
}

function mySeat(ws) {
  const p = players.get(ws.device);
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
  const p = players.get(ws.device);
  if (!p) return;
  await leaveCurrentRoom(p, true);
  const { mode, walls, timeMin } = validRoomCfg(m);
  const isPrivate = Boolean(m.private);
  const room = newRoom({ mode, walls, timeMin, isPrivate, code: isPrivate ? makeCode() : null });
  seatPlayer(room, ws.device, p.nick);
  send(ws, { t: 'room_created', room: room.id, mode, ...(room.code ? { code: room.code } : {}) });
  if (room.mode === 'quad') await sendRoomWait(room);
  broadcastLobby();
}

async function fillSeat(room, device, nick) {
  const seat = seatPlayer(room, device, nick);
  if (seat < 0) return -1;
  const taken = room.seats.filter(Boolean).length;
  if (taken >= seatsOf(room.mode)) await startGame(room);
  else if (room.mode === 'quad') await sendRoomWait(room);
  broadcastLobby();
  return seat;
}

async function handleJoinId(ws, id) {
  const room = rooms.get(id);
  const p = players.get(ws.device);
  if (!p) return;
  if (!room || room.over) return send(ws, { t: 'error', code: 'room_not_found' });
  if (room.live) return send(ws, { t: 'error', code: 'room_full' });
  await leaveCurrentRoom(p, true);
  if (await fillSeat(room, ws.device, p.nick) < 0) return send(ws, { t: 'error', code: 'room_full' });
}

async function handleJoinCode(ws, code) {
  const id = byCode.get(String(code || '').toUpperCase());
  const p = players.get(ws.device);
  if (!p) return;
  const room = id ? rooms.get(id) : null;
  if (!room || room.over) return send(ws, { t: 'error', code: 'room_not_found' });
  if (room.live) return send(ws, { t: 'error', code: 'room_full' });
  await leaveCurrentRoom(p, true);
  if (await fillSeat(room, ws.device, p.nick) < 0) return send(ws, { t: 'error', code: 'room_full' });
}

async function handleQuick(ws) {
  const p = players.get(ws.device);
  if (!p) return;
  await leaveCurrentRoom(p, true);
  if (quickWaiter && quickWaiter !== ws.device && players.get(quickWaiter)?.ws) {
    const other = quickWaiter;
    quickWaiter = null;
    const room = newRoom({ mode: 'duel', walls: 10, timeMin: '5', isPrivate: true, code: null });
    seatPlayer(room, other, players.get(other).nick);
    seatPlayer(room, ws.device, p.nick);
    await startGame(room);
    return;
  }
  quickWaiter = ws.device;
}

async function leaveCurrentRoom(p, silent) {
  if (quickWaiter === pKey(p)) quickWaiter = null;
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
function pKey(p) {
  for (const [k, v] of players) if (v === p) return k;
  return null;
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
          const pl = players.get(r.seats[i].device);
          if (pl && pl.roomId === r.id) send(pl.ws, await gameStartMsg(r, i));
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
  const p = players.get(ws.device);
  if (!p) return;
  switch (m.t) {
    case 'lobby_sub': lobbySubs.add(ws); send(ws, { t: 'lobby', online: conns.size, rooms: await lobbyRooms() }); break;
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
    case 'friends': await pushFriends(ws.device); break;
    case 'friend_requests': await pushFriends(ws.device); break;
    case 'friend_add': {
      const id = await resolveTarget(String(m.id || ''));
      if (id) {
        await addFriendship(ws.device, id);
        send(ws, { t: 'friend_added' });
        await pushFriends(ws.device);
        const q = players.get(id);
        if (q?.ws) { send(q.ws, { t: 'friend_added_you', nick: p.nick }); await pushFriends(id); }
      }
      break;
    }
    case 'friend_request': {
      const id = await resolveTarget(String(m.id || ''));
      if (id) {
        await addRequest(ws.device, id);
        send(ws, { t: 'friend_requested' });
        const q = players.get(id);
        if (q?.ws) { send(q.ws, { t: 'friend_request_in', nick: p.nick }); await pushFriends(id); }
      }
      break;
    }
    case 'friend_answer': {
      const id = String(m.id || '');
      await answerRequest(id, ws.device, Boolean(m.yes));
      if (m.yes) {
        send(ws, { t: 'friend_added' });
        await pushFriends(ws.device);
        const q = players.get(id);
        if (q?.ws) { send(q.ws, { t: 'friend_added_you', nick: p.nick }); await pushFriends(id); }
      } else {
        await pushFriends(ws.device);
      }
      const q = players.get(id);
      if (q?.ws) send(q.ws, { t: 'friend_answered', yes: Boolean(m.yes) });
      break;
    }
    case 'friend_remove': {
      await removeFriendship(ws.device, String(m.id || ''));
      send(ws, { t: 'friend_removed', id: String(m.id || '') });
      await pushFriends(ws.device);
      break;
    }
    case 'friend_call': {
      const target = players.get(await resolveTarget(String(m.id || '')) || '');
      const cfg = validRoomCfg(m);
      const room = newRoom({ mode: cfg.mode, walls: cfg.walls, timeMin: cfg.timeMin, isPrivate: true, code: makeCode() });
      await leaveCurrentRoom(p, true);
      seatPlayer(room, ws.device, p.nick);
      send(ws, { t: 'room_created', room: room.id, mode: room.mode, code: room.code });
      if (target?.ws) {
        send(target.ws, {
          t: 'friend_call', from: p.nick, code: room.code,
          mode: room.mode, walls: String(room.walls), time: room.timeMin,
        });
      } else {
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
    ws.device = null;
    ws.on('message', (raw) => onMessage(ws, raw.toString()).catch((e) => console.error('[ws]', e?.message || e)));
    ws.on('close', () => {
      lobbySubs.delete(ws);
      conns.delete(ws);
      if (quickWaiter && players.get(quickWaiter)?.ws !== ws) void 0;
      if (ws.device) {
        if (quickWaiter === ws.device) quickWaiter = null;
        detach(ws.device).catch((e) => console.error('[close]', e?.message || e));
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

server.listen(PORT, () => {
  console.log(`PathWars server on http://127.0.0.1:${PORT} (app + /ws + /api)`);
});
