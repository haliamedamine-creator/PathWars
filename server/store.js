// Store selector: Postgres when DATABASE_URL is set (hosting),
// otherwise the local SQLite file (dev). Same names, same shapes —
// server.js never knows which backend is live.
//
// Plus a write-through device cache: getDevice is the hottest read on the
// server (every lobby rebuild, every presence check). Hot rows stay in
// memory; writes go through to the backend immediately.
let backend;
if (process.env.DATABASE_URL) {
  console.log('[db] Postgres backend');
  backend = await import('./db-pg.js');
} else {
  console.log('[db] SQLite backend');
  backend = await import('./db.js');
}

export const {
  getUserById, getUserByNick, getUserByEmail, createUserRow, setUserNick,
  clearNickNotice, deleteUserLocal,
  ownerOf, recordDay, boardToday, todayMe, boardAll, accountRank, mskDay,
  deviceByNick, latestDevice,
  upsertReview, reviewStats, reviewRows, toggleLike,
  logVisit,
  yd, streakBreakCheck, advanceStreak, streakView, restoreStreak,
  todayTask, noteDailyGame, dailyState, grantPoints,
  savePushSub, removePushSub, subsForDevices, findSub, devicesOfOwner,
  streakRiskOwners, pushLogged, logPush,
  addFriendship, removeFriendship, friendIds, addRequest, answerRequest, incomingRequests,
} = backend;

const deviceCache = new Map(); // id -> row
const MAXC = 8000;
function cacheSet(id, row) {
  if (!row) return row;
  deviceCache.delete(id);
  deviceCache.set(id, row);
  if (deviceCache.size > MAXC) deviceCache.delete(deviceCache.keys().next().value);
  return row;
}

export async function getDevice(id) {
  if (deviceCache.has(id)) return deviceCache.get(id);
  return cacheSet(id, await backend.getDevice(id));
}

export async function upsertDevice(id, nick, token) {
  return cacheSet(id, await backend.upsertDevice(id, nick, token));
}

export async function addGame(id, delta, won) {
  const r = await backend.addGame(id, delta, won);
  if (!r) {
    // row may have been created elsewhere; refresh instead of trusting absence
    const d = await backend.getDevice(id);
    if (d) cacheSet(id, d);
    else deviceCache.delete(id);
    return r;
  }
  if (r.id === id) return cacheSet(id, r);
  // linked account: backend updated the user row; refresh the device entry
  const d = await backend.getDevice(id);
  if (d) cacheSet(id, d);
  else deviceCache.delete(id);
  return r;
}

export async function linkDevice(deviceId, userId) {
  const r = await backend.linkDevice(deviceId, userId);
  deviceCache.delete(deviceId); // user_id changed: never serve the stale row
  return r;
}
