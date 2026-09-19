// Store selector: Postgres when DATABASE_URL is set (hosting),
// otherwise the local SQLite file (dev). Same names, same shapes —
// server.js never knows which backend is live.
let backend;
if (process.env.DATABASE_URL) {
  console.log('[db] Postgres backend');
  backend = await import('./db-pg.js');
} else {
  console.log('[db] SQLite backend');
  backend = await import('./db.js');
}
export const {
  getDevice, upsertDevice, addGame,
  getUserById, getUserByNick, getUserByEmail, createUserRow, setUserNick,
  clearNickNotice, linkDevice, deleteUserLocal,
  ownerOf, recordDay, boardToday, todayMe, boardAll, accountRank, mskDay,
  deviceByNick, latestDevice,
  upsertReview, reviewStats, reviewRows, toggleLike,
  addFriendship, removeFriendship, friendIds, addRequest, answerRequest, incomingRequests,
} = backend;
