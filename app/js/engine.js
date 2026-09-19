// PathWars game engine (Quoridor rules). Shared between browser and Node.
// Three modes:
//   duel (classic): 9x9, players start on opposite sides, each runs to the
//     other side; 10 walls each.
//   race: 9x13, BOTH players start on the bottom row and race to the top
//     row; 15 walls each.
//   quad: 11x11, FOUR players, one on the middle of each side, all racing to
//     the single golden cell in the centre; 7 walls each. One winner, and
//     whoever is left when everyone else is out.
// Walls: {r, c, o} with r in 0..rows-2, c in 0..cols-2.
//   o='h' — horizontal wall between rows r and r+1, spanning columns c and c+1
//   o='v' — vertical wall between columns c and c+1, spanning rows r and r+1

export const N = 9; // classic board size (legacy callers)
export const WALLS_PER_PLAYER = 10;

export const MODES = {
  duel: { cols: 9, rows: 9, walls: 10, players: 2 },
  race: { cols: 9, rows: 13, walls: 15, players: 2 }, // like the competitor: 9 wide, 13 tall
  quad: { cols: 11, rows: 11, walls: 7, players: 4 },
};

export const playersIn = (mode) => (MODES[mode] || MODES.duel).players;

// Seats, in turn order, going clockwise around the board: south, west, north,
// east. Everyone sees themselves at the bottom, so the seat also fixes how far
// that player's screen is rotated.
export const QUAD_SEATS = 4;

// opts.walls lets a room choose the wall count (race offers 10 or 15)
export function initialState(mode = 'duel', opts = {}) {
  const m = MODES[mode] || MODES.duel;
  const w = Number(opts.walls) || m.walls;
  if (mode === 'quad') {
    const mid = (m.rows - 1) / 2;   // 5 on an 11x11 board
    return {
      mode: 'quad', cols: m.cols, rows: m.rows,
      // south, west, north, east — each on the middle cell of their own side
      pawns: [
        { r: m.rows - 1, c: mid }, { r: mid, c: 0 },
        { r: 0, c: mid }, { r: mid, c: m.cols - 1 },
      ],
      walls: [],
      left: [w, w, w, w],
      alive: [true, true, true, true],
      goal: { r: mid, c: mid },
      turn: 0,
      winner: null,
    };
  }
  if (mode === 'race') {
    return {
      mode: 'race', cols: m.cols, rows: m.rows,
      pawns: [{ r: m.rows - 1, c: 2 }, { r: m.rows - 1, c: m.cols - 3 }],
      walls: [],
      left: [w, w],
      turn: 0,
      winner: null,
    };
  }
  return {
    mode: 'duel', cols: 9, rows: 9,
    pawns: [{ r: 8, c: 4 }, { r: 0, c: 4 }],
    walls: [],
    left: [w, w],
    turn: 0,
    winner: null,
  };
}

export const colsOf = (s) => s.cols || 9;
export const rowsOf = (s) => s.rows || 9;
export const playersOf = (s) => s.pawns.length;

// A player knocked out of a four-handed game is off the board: they block
// nobody, they are skipped, and no wall has to leave them a path any more.
export const isAlive = (s, p) => !s.alive || s.alive[p] !== false;
export function aliveCount(s) {
  if (!s.alive) return s.pawns.length;
  return s.alive.reduce((n, a) => n + (a ? 1 : 0), 0);
}

// Where player p is heading. In race mode everyone runs to the top row.
// Legacy calls without a state assume the classic 9x9 duel.
export function goalRow(p, state) {
  if (state && state.mode === 'race') return 0;
  return p === 0 ? 0 : (state ? rowsOf(state) - 1 : 8);
}

// The goal as the rest of the engine sees it: a whole row to reach, or — in
// the four-handed game — the one cell in the middle everybody is racing for.
export function goalOf(p, state) {
  if (state && state.mode === 'quad') {
    const g = state.goal || { r: (rowsOf(state) - 1) / 2, c: (colsOf(state) - 1) / 2 };
    return { cell: g };
  }
  return { row: goalRow(p, state) };
}

export const atGoal = (state, p, r, c) => {
  const g = goalOf(p, state);
  return g.cell ? (r === g.cell.r && c === g.cell.c) : r === g.row;
};

export function cloneState(s) {
  return {
    mode: s.mode || 'duel', cols: colsOf(s), rows: rowsOf(s),
    pawns: s.pawns.map(p => ({ ...p })),
    walls: s.walls.map(w => ({ ...w })),
    left: [...s.left],
    ...(s.alive ? { alive: [...s.alive] } : {}),
    ...(s.goal ? { goal: { ...s.goal } } : {}),
    turn: s.turn,
    winner: s.winner,
  };
}

// Is the edge between two ADJACENT cells blocked by a wall?
export function isBlocked(walls, r1, c1, r2, c2) {
  if (r1 === r2) {
    // horizontal step: crossing vertical boundary between min(c) and min(c)+1
    const c = Math.min(c1, c2);
    for (const w of walls) {
      if (w.o === 'v' && w.c === c && (w.r === r1 || w.r === r1 - 1)) return true;
    }
  } else {
    // vertical step: crossing horizontal boundary between min(r) and min(r)+1
    const r = Math.min(r1, r2);
    for (const w of walls) {
      if (w.o === 'h' && w.r === r && (w.c === c1 || w.c === c1 - 1)) return true;
    }
  }
  return false;
}

/* Which wall is standing between two neighbouring cells — the wall itself,
   not just the fact of it. isBlocked answers "can I go", this answers "what is
   stopping me", which is what a player who tapped and nothing happened wants
   to know. Returns null when the way is clear. */
export function wallBetween(walls, r1, c1, r2, c2) {
  if (r1 === r2) {
    const c = Math.min(c1, c2);
    for (const w of walls) {
      if (w.o === 'v' && w.c === c && (w.r === r1 || w.r === r1 - 1)) return w;
    }
  } else {
    const r = Math.min(r1, r2);
    for (const w of walls) {
      if (w.o === 'h' && w.r === r && (w.c === c1 || w.c === c1 - 1)) return w;
    }
  }
  return null;
}

const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

/* Legal pawn destinations for player p.

   Jumps follow the classic rules: an adjacent pawn is jumped straight over,
   and when a wall or the board edge stands right behind it, you step round it
   diagonally instead.

   Four-handed play adds a case two players never meet — two pawns standing
   in a line right in front of you. Jumping over both is allowed only when
   there is nothing else to do but go backwards; if any move that does not
   lose ground exists, that move has to be played instead. */
export function pawnMoves(state, p) {
  const cols = colsOf(state), rows = rowsOf(state);
  const inB = (r, c) => r >= 0 && r < rows && c >= 0 && c < cols;
  const me = state.pawns[p];
  const taken = new Set();
  for (let i = 0; i < state.pawns.length; i++) {
    if (i === p || !isAlive(state, i)) continue;
    taken.add(state.pawns[i].r * cols + state.pawns[i].c);
  }
  const occupied = (r, c) => taken.has(r * cols + c);
  const out = [];
  const overTwo = [];   // jumps over two pawns, kept back until they are needed

  const sideSteps = (r1, c1, dr, dc) => {
    const perps = dr === 0 ? [[-1, 0], [1, 0]] : [[0, -1], [0, 1]];
    for (const [pr, pc] of perps) {
      const r3 = r1 + pr, c3 = c1 + pc;
      if (!inB(r3, c3)) continue;
      if (isBlocked(state.walls, r1, c1, r3, c3)) continue;
      if (r3 === me.r && c3 === me.c) continue;
      if (occupied(r3, c3)) continue;
      out.push({ r: r3, c: c3 });
    }
  };

  for (const [dr, dc] of DIRS) {
    const r1 = me.r + dr, c1 = me.c + dc;
    if (!inB(r1, c1) || isBlocked(state.walls, me.r, me.c, r1, c1)) continue;
    if (!occupied(r1, c1)) { out.push({ r: r1, c: c1 }); continue; }
    // somebody is standing there: try the straight jump over them
    const r2 = r1 + dr, c2 = c1 + dc;
    if (!inB(r2, c2) || isBlocked(state.walls, r1, c1, r2, c2)) { sideSteps(r1, c1, dr, dc); continue; }
    if (!occupied(r2, c2)) { out.push({ r: r2, c: c2 }); continue; }
    // a second pawn directly behind the first
    const r3 = r2 + dr, c3 = c2 + dc;
    if (inB(r3, c3) && !isBlocked(state.walls, r2, c2, r3, c3) && !occupied(r3, c3)) {
      overTwo.push({ r: r3, c: c3 });
    }
    sideSteps(r1, c1, dr, dc);
  }

  if (overTwo.length) {
    const g = goalOf(p, state);
    const dist = distToTarget(state.walls, g, cols, rows);
    const here = dist[me.r * cols + me.c];
    // "nothing but backwards": no ordinary move keeps us as close as we are
    const forward = out.some(m => {
      const d = dist[m.r * cols + m.c];
      return d !== -1 && here !== -1 && d <= here;
    });
    if (!forward) for (const m of overTwo) out.push(m);
  }
  return out;
}

function wallsConflict(a, b) {
  if (a.o === b.o) {
    if (a.o === 'h') return a.r === b.r && Math.abs(a.c - b.c) <= 1;
    return a.c === b.c && Math.abs(a.r - b.r) <= 1;
  }
  // h vs v cross at the same center point
  return a.r === b.r && a.c === b.c;
}

// BFS: does the pawn have any path to the goal row? (pawns don't block paths)
export function hasPath(walls, pawn, goal, cols = 9, rows = 9) {
  const seen = new Uint8Array(rows * cols);
  const q = [pawn.r * cols + pawn.c];
  seen[q[0]] = 1;
  while (q.length) {
    const cur = q.pop();
    const r = (cur / cols) | 0, c = cur % cols;
    if (r === goal) return true;
    for (const [dr, dc] of DIRS) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const k = nr * cols + nc;
      if (seen[k]) continue;
      if (isBlocked(walls, r, c, nr, nc)) continue;
      seen[k] = 1;
      q.push(k);
    }
  }
  return false;
}

// BFS distance map from every cell to the goal row (walls only).
// Index cells as r * cols + c.
export function distToGoal(walls, goal, cols = 9, rows = 9) {
  const dist = new Int16Array(rows * cols).fill(-1);
  const q = [];
  for (let c = 0; c < cols; c++) {
    dist[goal * cols + c] = 0;
    q.push(goal * cols + c);
  }
  let head = 0;
  while (head < q.length) {
    const cur = q[head++];
    const r = (cur / cols) | 0, c = cur % cols;
    for (const [dr, dc] of DIRS) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const k = nr * cols + nc;
      if (dist[k] !== -1) continue;
      if (isBlocked(walls, r, c, nr, nc)) continue;
      dist[k] = dist[cur] + 1;
      q.push(k);
    }
  }
  return dist;
}

/* Distance from every cell to a goal, where the goal is either a whole row
   (the two-handed games) or the single centre cell (the four-handed one).
   Walls only — pawns never block a path. Cells are indexed r * cols + c. */
export function distToTarget(walls, goal, cols = 9, rows = 9) {
  const dist = new Int16Array(rows * cols).fill(-1);
  const q = [];
  if (goal && goal.cell) {
    const k = goal.cell.r * cols + goal.cell.c;
    dist[k] = 0;
    q.push(k);
  } else {
    const row = goal && typeof goal === 'object' ? goal.row : goal;
    for (let c = 0; c < cols; c++) { dist[row * cols + c] = 0; q.push(row * cols + c); }
  }
  let head = 0;
  while (head < q.length) {
    const cur = q[head++];
    const r = (cur / cols) | 0, c = cur % cols;
    for (const [dr, dc] of DIRS) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const k = nr * cols + nc;
      if (dist[k] !== -1) continue;
      if (isBlocked(walls, r, c, nr, nc)) continue;
      dist[k] = dist[cur] + 1;
      q.push(k);
    }
  }
  return dist;
}

// How far player p still has to travel, -1 if the way is shut.
export function distanceLeft(state, p, walls) {
  const cols = colsOf(state), rows = rowsOf(state);
  const dist = distToTarget(walls || state.walls, goalOf(p, state), cols, rows);
  return dist[state.pawns[p].r * cols + state.pawns[p].c];
}

// Does every player still standing have some way through? This is the rule
// that stops a wall from sealing anybody in — with four on the board it has
// to hold for all of them at once.
export function everyoneHasPath(state, walls) {
  const cols = colsOf(state), rows = rowsOf(state);
  if (state.mode === 'quad') {
    // one goal shared by everyone, so one search answers for all four
    const dist = distToTarget(walls, goalOf(0, state), cols, rows);
    for (let i = 0; i < state.pawns.length; i++) {
      if (!isAlive(state, i)) continue;
      if (dist[state.pawns[i].r * cols + state.pawns[i].c] === -1) return false;
    }
    return true;
  }
  for (let i = 0; i < state.pawns.length; i++) {
    if (!isAlive(state, i)) continue;
    if (!hasPath(walls, state.pawns[i], goalRow(i, state), cols, rows)) return false;
  }
  return true;
}

// Whose turn comes after p: the next player still in the game.
export function nextAlive(state, p) {
  const n = state.pawns.length;
  for (let i = 1; i <= n; i++) {
    const q = (p + i) % n;
    if (isAlive(state, q)) return q;
  }
  return p;
}

/* Knock a player out: they ran out of time, out of patience, or out of
   connection. Their pawn leaves the board, their walls stay where they are,
   and the turn moves on. Last one standing wins. */
export function eliminate(state, p) {
  if (!state.alive || !state.alive[p] || state.winner !== null) return false;
  state.alive[p] = false;
  if (aliveCount(state) <= 1) {
    for (let i = 0; i < state.pawns.length; i++) if (isAlive(state, i)) state.winner = i;
    return true;
  }
  if (state.turn === p) state.turn = nextAlive(state, p);
  return true;
}

// Can player p legally place wall w?
export function canPlaceWall(state, p, w) {
  const cols = colsOf(state), rows = rowsOf(state);
  if (state.left[p] <= 0) return false;
  if (w.r < 0 || w.r > rows - 2 || w.c < 0 || w.c > cols - 2) return false;
  if (w.o !== 'h' && w.o !== 'v') return false;
  for (const e of state.walls) if (wallsConflict(e, w)) return false;
  // everyone still playing must keep a path to their goal
  return everyoneHasPath(state, [...state.walls, w]);
}

// Apply a move for the player whose turn it is.
// move: {type:'pawn', r, c} | {type:'wall', r, c, o}
// Returns true if the move was legal and applied.
export function applyMove(state, move) {
  if (state.winner !== null) return false;
  const p = state.turn;
  if (move.type === 'pawn') {
    const ok = pawnMoves(state, p).some(m => m.r === move.r && m.c === move.c);
    if (!ok) return false;
    state.pawns[p] = { r: move.r, c: move.c };
    if (atGoal(state, p, move.r, move.c)) {
      state.winner = p;
      return true;
    }
  } else if (move.type === 'wall') {
    const w = { r: move.r, c: move.c, o: move.o };
    if (!canPlaceWall(state, p, w)) return false;
    state.walls.push(w);
    state.left[p]--;
  } else {
    return false;
  }
  state.turn = nextAlive(state, p);
  return true;
}
