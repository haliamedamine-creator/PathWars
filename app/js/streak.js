// Daily streak. Shared by the server, which counts the days, and the client,
// which draws the flame — so neither can disagree about which tier you are on.
//
// The flame itself changes rather than turning into a different object: same
// 🔥, recoloured and grown by CSS. A blue flame at 30 days reads as a level up;
// swapping to a diamond would read as a different thing entirely.
export const FLAMES = [
  { min: 1, cls: 'fl-1' },     // small, pale orange
  { min: 7, cls: 'fl-7' },     // full orange — one week
  { min: 30, cls: 'fl-30' },   // blue
  { min: 50, cls: 'fl-50' },   // violet
  { min: 100, cls: 'fl-100' }, // white hot
  { min: 200, cls: 'fl-200' }, // gold
  { min: 365, cls: 'fl-365' }, // rainbow — a full year
];

// Days that earn a celebration of their own. Three is deliberately early:
// hardly anyone reaches a week, but almost everyone can reach three, and the
// first celebration is what teaches a player that the streak is worth keeping.
export const MILESTONES = [3, 7, 14, 30, 50, 100, 200, 365];

export function flameClass(days) {
  let cls = FLAMES[0].cls;
  for (const f of FLAMES) if (days >= f.min) cls = f.cls;
  return cls;
}

export function isMilestone(days) { return MILESTONES.includes(days); }

export function dayGap(lastDay, today) {
  return Math.round((Date.parse(today) - Date.parse(lastDay)) / 86400000);
}

/* Which of four situations a streak is in.

   There used to be a fifth, where a missed day was quietly forgiven and the
   number carried on unchanged. Nobody could tell that from a broken counter,
   so it is gone: a missed day always breaks the streak, and getting it back is
   something the player does on purpose, with one button.

     none  — nothing to show
     today — the day is closed, by a game or by the restore button
     risk  — played yesterday, will break tonight unless they play
     lost  — broken, and recent enough to be worth offering back            */
export function streakState(lastDay, today) {
  if (!lastDay) return 'none';
  const gap = dayGap(lastDay, today);
  if (gap <= 0) return 'today';
  if (gap === 1) return 'risk';
  return 'lost';
}

// The first restore of each calendar month costs nothing. After that the
// button asks for an ad first — but the player is never told which it will be,
// because from their side it is the same button doing the same thing.
export function freeRestore(freezeMonth, today) {
  return freezeMonth !== today.slice(0, 7);
}

/* How many days are waiting to be taken back, or 0 when nothing is.

   Two shapes mean the same thing. Before today's first game the broken run is
   still sitting in `streak` with an old date on it. Once a game is played the
   counter restarts at 1 and the old number moves to `streak_prev` — which is
   the only reason a player who started a match before noticing the button does
   not silently lose everything. */
export function pendingStreak(row, today) {
  if (!row) return 0;
  const prev = row.streak_prev || 0;
  if (prev > 0) return prev;
  const s = row.streak || 0;
  if (s > 0 && today && streakState(row.streak_day, today) === 'lost') return s;
  return 0;
}

// A week is the outer limit for offering a streak back. Beyond that the player
// has moved on and handing it over is meaningless.
export const RESTORE_MAX_GAP = 7;

export function canRestore(lastDay, today, streak) {
  return streak > 0 && !!lastDay && dayGap(lastDay, today) <= RESTORE_MAX_GAP;
}

export function streakAlive(lastDay, today) {
  const s = streakState(lastDay, today);
  return s === 'today' || s === 'risk';
}

// The player's own calendar day, from the offset their browser reports.
// Using their local midnight is the whole point: a streak that rolls over at
// Moscow midnight makes no sense to someone in Tehran or São Paulo.
export function localDay(tzOffsetMinutes) {
  const off = Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : 0;
  return new Date(Date.now() - off * 60000).toISOString().slice(0, 10);
}
