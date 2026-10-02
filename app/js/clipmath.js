/* The arithmetic behind the video: where the board sits, how long the clip
   runs, and which position is on screen at a given moment.

   Kept apart from clip.js because none of it needs a browser — no canvas, no
   codecs, no audio — so `npm test` can check the rules that actually have
   opinions in them: that the board always fits the frame whatever its shape,
   that a long game is shortened instead of running for two minutes, and that a
   short one is not padded out. */

export const W = 720, H = 1280;
export const FPS = 30;
export const RATE = 48000;                      // audio

// The slot the board is given. It is fitted inside rather than stretched to
// fill: the duel and the table of four are square, the race board is taller
// than it is wide, and a clip where the race board runs off the bottom is
// worse than one where it is a little smaller.
export const SLOT_Y = 175, SLOT_W = 690, SLOT_H = 810;

export const LEAD_MS = 500;                     // a moment on the opening position
export const END_MS = 2000;                     // the result, held long enough to read
export const MOVE_ANIM = 210;                   // same as the CSS transition on a pawn
export const WALL_ANIM = 160;
/* Long games are shortened rather than left to run: a clip nobody watches to
   the end is a clip nobody sends on. Short ones are not stretched — a six-move
   game is allowed to be short. */
export const SLOT_MAX = 620, SLOT_MIN = 300, BUDGET_MS = 17000;

/* A long game is not slowed into a long clip. Played at one even pace, a
   140-move game came out at 45 seconds and fifteen megabytes, with a pawn
   jumping every third of a second from start to finish — technically every
   move, practically nothing anyone could follow.

   So it is told the way a highlight is: the opening fast-forwards, and the last
   stretch, where the game was actually decided, plays at a pace a person can
   watch. The whole clip stays under half a minute whatever the game. */
export const LONG_AFTER = 40;      // up to this many moves, one even pace
export const TAIL_MOVES = 30;      // the end of a long game, played properly
export const TAIL_SLOT = 450;
export const HEAD_MS = 7000;       // everything before it, squeezed into this
// Below one frame a move (33ms at 30fps) some positions are never drawn on
// their own. In a fast-forward that is the point: the walls they put down
// are still there in the next frame, so nothing on the board is lost.
export const HEAD_SLOT_MIN = 15;

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// The same quarter turns the live board uses, so the clip matches the game the
// player actually watched rather than some other camera angle.
export function spin(r, c, k, n) {
  let p = { r, c };
  for (let i = 0; i < k; i++) p = { r: p.c, c: n - 1 - p.r };
  return p;
}
export function spinWall(w, k, m) {
  let p = { r: w.r, c: w.c, o: w.o };
  for (let i = 0; i < k; i++) p = { r: p.c, c: m - 1 - p.r, o: p.o === 'h' ? 'v' : 'h' };
  return p;
}

export function geometry(cols, rows) {
  const uw = cols * 1.3 + 0.3, uh = rows * 1.3 + 0.3;
  const u = Math.min(SLOT_W / uw, SLOT_H / uh);
  const bw = u * uw, bh = u * uh;
  return {
    u,
    g: 0.3 * u,
    pad: 0.3 * u,
    bw,
    bh,
    bx: (W - bw) / 2,
    by: SLOT_Y + (SLOT_H - bh) / 2,
  };
}

export function buildTimeline(history) {
  const steps = Math.max(0, history.length - 1);
  const slots = new Array(steps);
  let fast = 0;                          // how many of the first moves are fast-forwarded
  if (steps <= LONG_AFTER) {
    const even = steps
      ? Math.round(Math.max(SLOT_MIN, Math.min(SLOT_MAX, BUDGET_MS / steps)))
      : SLOT_MAX;
    slots.fill(even);
  } else {
    fast = steps - TAIL_MOVES;
    const quick = Math.max(HEAD_SLOT_MIN, Math.round(HEAD_MS / fast));
    for (let i = 0; i < steps; i++) slots[i] = i < fast ? quick : TAIL_SLOT;
  }
  const starts = new Array(steps);
  let at = LEAD_MS;
  for (let i = 0; i < steps; i++) { starts[i] = at; at += slots[i]; }
  return {
    steps,
    slots,
    starts,
    fast,
    // the first slot, for code and tests that only need "the pace"
    slot: steps ? slots[steps - 1] : SLOT_MAX,
    // how many times faster than the watchable pace the opening runs
    speedup: fast ? Math.max(1, Math.round(TAIL_SLOT / slots[0])) : 1,
    endOfMoves: at,
    total: at + END_MS,
  };
}

/* Two positions are the same position when the pawns, the walls and the turn
   agree. The game records a snapshot for every state message, and a resync or
   a reconnect can send the same position twice; left in, each repeat becomes a
   pause in the middle of the clip for no reason anyone watching could see. */
export function dedupeHistory(history) {
  const out = [];
  let prev = null;
  for (const s of history) {
    if (!s) continue;
    const key = JSON.stringify([s.pawns, (s.walls || []).length, s.turn, s.alive || null, s.winner ?? null]);
    if (key !== prev) out.push(s);
    prev = key;
  }
  return out;
}

/* Which two positions the frame at `ms` sits between, and how far along it is.
   `p` moves a pawn, `pWall` pops a wall in — two speeds because a wall appears
   quicker than a pawn walks. */
export function frameState(art, ms) {
  const { history } = art;
  const { steps, slots, starts, endOfMoves } = art.time;
  if (steps === 0) return { base: history[0], next: history[0], p: 1, pWall: 1, done: true, i: -1 };
  if (ms <= LEAD_MS) return { base: history[0], next: history[0], p: 0, pWall: 0, done: false, i: -1 };
  if (ms >= endOfMoves) return { base: history[steps], next: history[steps], p: 1, pWall: 1, done: true, i: steps };
  // which move is playing: the last one that has started
  let lo = 0, hi = steps - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= ms) lo = mid; else hi = mid - 1;
  }
  const i = lo;
  const into = ms - starts[i];
  const slot = slots[i];
  // A fast-forwarded move has less time than the walk takes; it then walks
  // across its whole slot instead of snapping there.
  const walk = Math.min(MOVE_ANIM, slot);
  const pop = Math.min(WALL_ANIM, slot);
  return {
    base: history[i],
    next: history[i + 1],
    p: clamp01(into / walk),
    pWall: clamp01(into / pop),
    done: false,
    i,
  };
}
