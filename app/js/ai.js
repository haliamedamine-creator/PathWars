// PathWars AI.
// Difficulty is a skill dial: the chance of playing the strong move vs a weak
// one. easy/normal/hard use a fast look-ahead; hardcore runs a real search
// engine (alpha-beta negamax + transposition table + iterative deepening) that
// looks many moves ahead — it examines the opponent's replies to every line and
// only plays into positions it can hold, so a human practically cannot win.
import { pawnMoves, canPlaceWall, distToGoal, goalRow, cloneState, applyMove, N } from './engine.js';

export const AI_LEVELS = {
  easy:     { skill: 0.34 },                 // ~20% AI win
  normal:   { skill: 0.50 },                 // ~50%
  hard:     { skill: 0.67 },                 // ~80%
  hardcore: { skill: 1.00, engine: true, budget: 1300 }, // deep search, full 1.3s of thinking per move
};

const dimsOf = (s) => [s.cols || 9, s.rows || 9];

function pawnDist(state, p) {
  const [cols, rows] = dimsOf(state);
  return distToGoal(state.walls, goalRow(p, state), cols, rows)[state.pawns[p].r * cols + state.pawns[p].c];
}

function myBestStep(state, p) {
  const [cols, rows] = dimsOf(state);
  const dist = distToGoal(state.walls, goalRow(p, state), cols, rows);
  const moves = pawnMoves(state, p);
  let bestD = Infinity;
  for (const m of moves) { const d = dist[m.r * cols + m.c]; if (d !== -1 && d < bestD) bestD = d; }
  const best = moves.filter(m => dist[m.r * cols + m.c] === bestD);
  const pool = best.length ? best : moves;
  return { move: pool[Math.floor(Math.random() * pool.length)], dist: bestD };
}

function shortestPathCells(state, p) {
  const [cols, rows] = dimsOf(state);
  const dist = distToGoal(state.walls, goalRow(p, state), cols, rows);
  const cells = [];
  let cur = { ...state.pawns[p] };
  let guard = 0;
  while (dist[cur.r * cols + cur.c] > 0 && guard++ < 160) {
    cells.push(cur);
    const opts = [[-1, 0], [1, 0], [0, -1], [0, 1]]
      .map(([dr, dc]) => ({ r: cur.r + dr, c: cur.c + dc }))
      .filter(m => m.r >= 0 && m.r < rows && m.c >= 0 && m.c < cols)
      .filter(m => dist[m.r * cols + m.c] === dist[cur.r * cols + cur.c] - 1);
    if (!opts.length) break;
    cur = opts[0];
  }
  return cells;
}

// Legal wall candidates that matter, each with its path-length gain, sorted best
// first (good move ordering makes alpha-beta prune hard so the search goes deep).
function candidateWalls(state, p, cap) {
  if (state.left[p] <= 0) return [];
  const [cols, rows] = dimsOf(state);
  const set = new Map();
  const add = (cells, span) => {
    for (const cell of cells.slice(0, span))
      for (let dr = -1; dr <= 0; dr++)
        for (let dc = -1; dc <= 0; dc++)
          for (const o of ['h', 'v']) {
            const w = { r: cell.r + dr, c: cell.c + dc, o };
            if (w.r < 0 || w.r > rows - 2 || w.c < 0 || w.c > cols - 2) continue;
            set.set(`${w.r},${w.c},${w.o}`, w);
          }
  };
  add(shortestPathCells(state, 1 - p), 8);
  add(shortestPathCells(state, p), 4);
  // extend existing walls (choke points)
  for (const e of state.walls)
    for (const o of ['h', 'v'])
      for (const d of [-2, -1, 1, 2]) {
        const w = o === 'h' ? { r: e.r, c: e.c + d, o } : { r: e.r + d, c: e.c, o };
        if (w.r < 0 || w.r > N - 2 || w.c < 0 || w.c > N - 2) continue;
        set.set(`${w.r},${w.c},${w.o}`, w);
      }

  const opp = 1 - p, oppPos = state.pawns[opp], myPos = state.pawns[p];
  const gOpp = goalRow(opp, state), gMy = goalRow(p, state);
  const dOpp0 = distToGoal(state.walls, gOpp, cols, rows)[oppPos.r * cols + oppPos.c];
  const dMy0 = distToGoal(state.walls, gMy, cols, rows)[myPos.r * cols + myPos.c];
  const scored = [];
  for (const w of set.values()) {
    if (!canPlaceWall(state, p, w)) continue;
    const walls = [...state.walls, w];
    const gain = (distToGoal(walls, gOpp, cols, rows)[oppPos.r * cols + oppPos.c] - dOpp0)
               - (distToGoal(walls, gMy, cols, rows)[myPos.r * cols + myPos.c] - dMy0);
    scored.push({ w, gain });
  }
  scored.sort((a, b) => b.gain - a.gain);
  return scored.slice(0, cap);
}

/* ---------- shallow strong move: easy / normal / hard ---------- */
function greedyMove(state, p) {
  const my = myBestStep(state, p);
  const oppDist = pawnDist(state, 1 - p);
  const walls = candidateWalls(state, p, 8);
  if (walls.length) {
    const { w, gain } = walls[0];
    const behindOrTied = my.dist >= oppDist;
    if (gain >= 2 || (behindOrTied && gain >= 1)) return { type: 'wall', ...w };
  }
  return { type: 'pawn', r: my.move.r, c: my.move.c };
}

/* ================= deep search engine (hardcore) =================
   Fast internal board: wall slots as bit arrays, incremental make/unmake,
   Zobrist hashing + transposition table, alpha-beta negamax with iterative
   deepening. 10-50x faster per node than the object representation, so it
   really does look many moves ahead — including defensive walls that guard
   its own path. */
const MATE = 1e6;

// --- Zobrist tables (deterministic PRNG so tests are reproducible) ---
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  };
}
const _rng = mulberry32(0xC0FFEE);
const Z_H = Array.from({ length: 64 }, () => _rng());
const Z_V = Array.from({ length: 64 }, () => _rng());
const Z_P = [Array.from({ length: 81 }, () => _rng()), Array.from({ length: 81 }, () => _rng())];
const Z_T = _rng();

class FastState {
  constructor(state) {
    this.h = new Uint8Array(64);
    this.v = new Uint8Array(64);
    for (const w of state.walls) (w.o === 'h' ? this.h : this.v)[w.r * 8 + w.c] = 1;
    this.pos = [state.pawns[0].r * 9 + state.pawns[0].c, state.pawns[1].r * 9 + state.pawns[1].c];
    this.left = [state.left[0], state.left[1]];
    this.turn = state.turn;
    this.hash = 0;
    for (let i = 0; i < 64; i++) { if (this.h[i]) this.hash ^= Z_H[i]; if (this.v[i]) this.hash ^= Z_V[i]; }
    this.hash ^= Z_P[0][this.pos[0]] ^ Z_P[1][this.pos[1]];
    if (this.turn) this.hash ^= Z_T;
  }
}

// is the step from cell (r,c) in direction (dr,dc) blocked by wall/edge?
function blockedF(fs, r, c, dr, dc) {
  if (dr === -1) { if (r === 0) return true; const rr = r - 1; return (c < 8 && fs.h[rr * 8 + c]) || (c > 0 && fs.h[rr * 8 + c - 1]); }
  if (dr === 1)  { if (r === 8) return true; return (c < 8 && fs.h[r * 8 + c]) || (c > 0 && fs.h[r * 8 + c - 1]); }
  if (dc === -1) { if (c === 0) return true; const cc = c - 1; return (r < 8 && fs.v[r * 8 + cc]) || (r > 0 && fs.v[(r - 1) * 8 + cc]); }
  { if (c === 8) return true; return (r < 8 && fs.v[r * 8 + c]) || (r > 0 && fs.v[(r - 1) * 8 + c]); }
}

const DIRS4 = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const _q = new Int16Array(81);
const _dist = new Int16Array(81);

// distance map from every cell to goal row (walls only)
function distMapF(fs, goal) {
  _dist.fill(-1);
  let head = 0, tail = 0;
  for (let c = 0; c < 9; c++) { _dist[goal * 9 + c] = 0; _q[tail++] = goal * 9 + c; }
  while (head < tail) {
    const cur = _q[head++]; const r = (cur / 9) | 0, c = cur % 9;
    for (let d = 0; d < 4; d++) {
      const dr = DIRS4[d][0], dc = DIRS4[d][1];
      if (blockedF(fs, r, c, dr, dc)) continue;
      const k = (r + dr) * 9 + (c + dc);
      if (_dist[k] !== -1) continue;
      _dist[k] = _dist[cur] + 1;
      _q[tail++] = k;
    }
  }
  return _dist;
}

function distOfF(fs, p) { return distMapF(fs, p === 0 ? 0 : 8)[fs.pos[p]]; }

const _seen = new Uint8Array(81);
function hasPathF(fs, p) {
  const goal = p === 0 ? 0 : 8;
  _seen.fill(0);
  let head = 0, tail = 0;
  _q[tail++] = fs.pos[p]; _seen[fs.pos[p]] = 1;
  while (head < tail) {
    const cur = _q[head++]; const r = (cur / 9) | 0, c = cur % 9;
    if (r === goal) return true;
    for (let d = 0; d < 4; d++) {
      const dr = DIRS4[d][0], dc = DIRS4[d][1];
      if (blockedF(fs, r, c, dr, dc)) continue;
      const k = (r + dr) * 9 + (c + dc);
      if (!_seen[k]) { _seen[k] = 1; _q[tail++] = k; }
    }
  }
  return false;
}

// pawn destination cells (with jumps), as cell indices
function pawnMovesF(fs, p) {
  const me = fs.pos[p], op = fs.pos[1 - p];
  const r = (me / 9) | 0, c = me % 9;
  const out = [];
  for (let d = 0; d < 4; d++) {
    const dr = DIRS4[d][0], dc = DIRS4[d][1];
    if (blockedF(fs, r, c, dr, dc)) continue;
    const r1 = r + dr, c1 = c + dc, k1 = r1 * 9 + c1;
    if (k1 !== op) { out.push(k1); continue; }
    if (!blockedF(fs, r1, c1, dr, dc)) { out.push((r1 + dr) * 9 + (c1 + dc)); continue; }
    const perps = dr === 0 ? [[-1, 0], [1, 0]] : [[0, -1], [0, 1]];
    for (const [pr, pc] of perps) {
      if (blockedF(fs, r1, c1, pr, pc)) continue;
      const k3 = (r1 + pr) * 9 + (c1 + pc);
      if (k3 !== me) out.push(k3);
    }
  }
  return out;
}

// slot occupancy rules (without path check)
function slotFree(fs, o, r, c) {
  const i = r * 8 + c;
  if (fs.h[i] || fs.v[i]) return false;
  if (o === 0) return !(c > 0 && fs.h[i - 1]) && !(c < 7 && fs.h[i + 1]);   // h
  return !(r > 0 && fs.v[i - 8]) && !(r < 7 && fs.v[i + 8]);                 // v
}

function canPlaceF(fs, o, r, c) {
  if (r < 0 || r > 7 || c < 0 || c > 7) return false;
  if (!slotFree(fs, o, r, c)) return false;
  const arr = o === 0 ? fs.h : fs.v;
  arr[r * 8 + c] = 1;
  const ok = hasPathF(fs, 0) && hasPathF(fs, 1);
  arr[r * 8 + c] = 0;
  return ok;
}

// make / unmake
function makePawn(fs, p, to) {
  const from = fs.pos[p];
  fs.hash ^= Z_P[p][from] ^ Z_P[p][to] ^ Z_T;
  fs.pos[p] = to; fs.turn = 1 - fs.turn;
  return from;
}
function unmakePawn(fs, p, from) {
  const to = fs.pos[p];
  fs.hash ^= Z_P[p][from] ^ Z_P[p][to] ^ Z_T;
  fs.pos[p] = from; fs.turn = 1 - fs.turn;
}
function makeWall(fs, p, o, r, c) {
  const i = r * 8 + c;
  (o === 0 ? fs.h : fs.v)[i] = 1;
  fs.hash ^= (o === 0 ? Z_H : Z_V)[i] ^ Z_T;
  fs.left[p]--; fs.turn = 1 - fs.turn;
}
function unmakeWall(fs, p, o, r, c) {
  const i = r * 8 + c;
  (o === 0 ? fs.h : fs.v)[i] = 0;
  fs.hash ^= (o === 0 ? Z_H : Z_V)[i] ^ Z_T;
  fs.left[p]++; fs.turn = 1 - fs.turn;
}

// one shortest path for p as cell list (greedy descent over the dist map)
function pathCellsF(fs, p, cap) {
  const goal = p === 0 ? 0 : 8;
  const dm = distMapF(fs, goal);
  const cells = [];
  let cur = fs.pos[p], guard = 0;
  while (dm[cur] > 0 && guard++ < 90 && cells.length < cap) {
    cells.push(cur);
    const r = (cur / 9) | 0, c = cur % 9;
    let next = -1;
    for (let d = 0; d < 4; d++) {
      const dr = DIRS4[d][0], dc = DIRS4[d][1];
      if (blockedF(fs, r, c, dr, dc)) continue;
      const k = (r + dr) * 9 + (c + dc);
      if (dm[k] === dm[cur] - 1) { next = k; break; }
    }
    if (next < 0) break;
    cur = next;
  }
  cells.push(cur);
  return cells;
}

// candidate wall slots: hugging both players' shortest paths + around pawns
function candSlotsF(fs, p) {
  const out = new Set();
  const addAround = (cell) => {
    const r = (cell / 9) | 0, c = cell % 9;
    for (let dr = -1; dr <= 0; dr++)
      for (let dc = -1; dc <= 0; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue;
        out.add(rr * 8 + cc);         // h slot id 0..63
        out.add(64 + rr * 8 + cc);    // v slot id 64..127
      }
  };
  for (const cell of pathCellsF(fs, 1 - p, 10)) addAround(cell);   // attack their route
  for (const cell of pathCellsF(fs, p, 6)) addAround(cell);        // guard my route
  addAround(fs.pos[1 - p]); addAround(fs.pos[p]);
  return out;
}

// scored & filtered wall moves for player p, best first
function wallMovesF(fs, p, cap, withGain) {
  if (fs.left[p] <= 0) return [];
  const res = [];
  const d0me = distOfF(fs, p);
  const d0op = distOfF(fs, 1 - p);
  for (const id of candSlotsF(fs, p)) {
    const o = id >= 64 ? 1 : 0, i = id & 63, r = (i / 8) | 0, c = i % 8;
    if (!canPlaceF(fs, o, r, c)) continue;
    let score = 0;
    if (withGain) {
      const arr = o === 0 ? fs.h : fs.v;
      arr[i] = 1;
      score = (distOfF(fs, 1 - p) - d0op) - (distOfF(fs, p) - d0me);
      arr[i] = 0;
    }
    res.push({ o, r, c, score });
  }
  res.sort((a, b) => b.score - a.score);
  return res.slice(0, cap);
}

function fsKey(fs) {
  const p0 = fs.pos[0], p1 = fs.pos[1];
  return `${(p0 / 9) | 0},${p0 % 9}|${(p1 / 9) | 0},${p1 % 9}|${fs.left[0]},${fs.left[1]}`;
}

function evalF(fs) {
  const p = fs.turn;
  return (distOfF(fs, 1 - p) - distOfF(fs, p)) * 10 + 5 + (fs.left[p] - fs.left[1 - p]) * 2;
}

let TT, nodes, deadline, timedOut;

function negaF(fs, depth, alpha, beta, rootDepth) {
  if ((++nodes & 255) === 0 && Date.now() > deadline) { timedOut = true; return alpha; }
  const alpha0 = alpha;
  const tk = fs.hash;
  const hit = TT.get(tk);
  if (hit !== undefined && hit.d >= depth) {
    if (hit.f === 0) return hit.s;
    if (hit.f < 0 && hit.s <= alpha) return hit.s;
    if (hit.f > 0 && hit.s >= beta) return hit.s;
  }
  if (depth === 0) return evalF(fs);

  const p = fs.turn;
  const goal = p === 0 ? 0 : 8;
  // pawn moves ordered: best-by-distance first
  const dm = distMapF(fs, goal);
  const pmoves = pawnMovesF(fs, p).sort((a, b) => dm[a] - dm[b]);
  const withGain = depth >= 3;
  const cap = depth >= 4 ? 12 : depth >= 2 ? 8 : 5;
  const wmoves = depth >= 2 ? wallMovesF(fs, p, cap, withGain) : [];

  let best = -Infinity;
  // interleave: best pawn step, then walls, then other pawn steps
  const tryPawn = (to) => {
    const from = makePawn(fs, p, to);
    let s;
    if (((to / 9) | 0) === goal) s = MATE - (rootDepth - depth);
    else s = -negaF(fs, depth - 1, -beta, -alpha, rootDepth);
    unmakePawn(fs, p, from);
    return s;
  };
  const tryWall = (w) => {
    makeWall(fs, p, w.o, w.r, w.c);
    const s = -negaF(fs, depth - 1, -beta, -alpha, rootDepth);
    unmakeWall(fs, p, w.o, w.r, w.c);
    return s;
  };

  const seq = [];
  if (pmoves.length) seq.push({ t: 0, m: pmoves[0] });
  for (const w of wmoves) seq.push({ t: 1, m: w });
  for (let i = 1; i < pmoves.length; i++) seq.push({ t: 0, m: pmoves[i] });

  for (const it of seq) {
    const s = it.t === 0 ? tryPawn(it.m) : tryWall(it.m);
    if (timedOut) return alpha;
    if (s > best) best = s;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  const f = best <= alpha0 ? -1 : best >= beta ? 1 : 0;
  TT.set(tk, { d: depth, s: best, f });
  return best;
}

function searchRootF(fs, depth, recent) {
  const p = fs.turn;
  const goal = p === 0 ? 0 : 8;
  const dm = distMapF(fs, goal);
  const pmoves = pawnMovesF(fs, p).sort((a, b) => dm[a] - dm[b]);
  // dm aliases a shared buffer that deeper searches overwrite — snapshot the
  // progress of each pawn move NOW, before any recursion
  const progOf = new Map();
  for (const m of pmoves) progOf.set(m, dm[fs.pos[p]] - dm[m]);
  const wmoves = wallMovesF(fs, p, 16, true);

  let alpha = -Infinity;
  const scored = [];
  const consider = (mv, isWall) => {
    let s;
    if (isWall) {
      makeWall(fs, p, mv.o, mv.r, mv.c);
      s = -negaF(fs, depth - 1, -Infinity, -alpha, depth);
      unmakeWall(fs, p, mv.o, mv.r, mv.c);
    } else {
      const from = makePawn(fs, p, mv);
      if (((mv / 9) | 0) === goal) s = MATE;
      else s = -negaF(fs, depth - 1, -Infinity, -alpha, depth);
      unmakePawn(fs, p, from);
    }
    if (timedOut) return;
    // hard penalty for recreating a recent position — no back-and-forth, ever
    if (recent && !isWall) {
      const save = fs.pos[p]; fs.pos[p] = mv;
      if (recent.has(fsKey(fs))) s -= 40;
      fs.pos[p] = save;
    }
    scored.push({ mv, isWall, s, prog: isWall ? 0 : (progOf.get(mv) || 0) });
    if (s > alpha) alpha = s;
  };
  if (pmoves.length) consider(pmoves[0], false);
  for (const w of wmoves) { if (timedOut) break; consider(w, true); }
  for (let i = 1; i < pmoves.length; i++) { if (timedOut) break; consider(pmoves[i], false); }
  if (!scored.length) return null;
  scored.sort((a, b) => b.s - a.s || b.prog - a.prog);
  // among equal-best, prefer progress (kills shuffling), then random for variety
  const top = scored.filter(x => x.s >= scored[0].s - 0.001 && x.prog >= scored[0].prog);
  const pick = top[Math.floor(Math.random() * top.length)];
  return { pick, score: scored[0].s };
}

function engineMove(state, p, budgetMs, maxDepth, recent) {
  if (recent && !(recent instanceof Set)) recent = new Set(recent);
  const fs = new FastState(state);
  TT = new Map(); nodes = 0; timedOut = false;
  deadline = Date.now() + (budgetMs || 700);
  let best = null;
  for (let depth = 2; depth <= (maxDepth || 16); depth += 1) {
    const res = searchRootF(fs, depth, recent);
    if (timedOut) break;
    if (res) {
      best = res;
      if (res.score >= MATE - 1000) break;
    }
  }
  const { pick } = best;
  if (pick.isWall) return { type: 'wall', o: pick.mv.o === 0 ? 'h' : 'v', r: pick.mv.r, c: pick.mv.c };
  return { type: 'pawn', r: (pick.mv / 9) | 0, c: pick.mv % 9 };
}

/* ---------- casual move: always races toward the goal, never backward ----------
   The weak play still WANTS to win — it just doesn't bother placing walls and
   may take a harmless equal-distance sidestep now and then. It never walks the
   wrong way, so an easy opponent looks like a real (if unambitious) player. */
function weakMove(state, p) {
  const [cols, rows] = dimsOf(state);
  const dist = distToGoal(state.walls, goalRow(p, state), cols, rows);
  const moves = pawnMoves(state, p);
  const here = dist[state.pawns[p].r * cols + state.pawns[p].c];
  let bd = Infinity;
  for (const m of moves) { const d = dist[m.r * cols + m.c]; if (d !== -1 && d < bd) bd = d; }
  const best = moves.filter(m => dist[m.r * cols + m.c] === bd);
  // a little human variety: sometimes a sidestep that keeps distance, never one that loses ground
  if (Math.random() < 0.2) {
    const okay = moves.filter(m => { const d = dist[m.r * cols + m.c]; return d !== -1 && d <= here; });
    const pool = okay.length ? okay : best;
    const m = pool[Math.floor(Math.random() * pool.length)];
    return { type: 'pawn', r: m.r, c: m.c };
  }
  const m = best[Math.floor(Math.random() * best.length)];
  return { type: 'pawn', r: m.r, c: m.c };
}

export function aiMove(state, level = 'normal', opts = {}) {
  const cfg = AI_LEVELS[level] || AI_LEVELS.normal;
  const p = state.turn;
  // the deep engine is built for the classic 9x9 board; race mode (and any
  // non-standard board) plays the fast greedy line at full strength instead
  const classic = (state.cols || 9) === 9 && (state.rows || 9) === 9 && state.mode !== 'race';
  if (Math.random() < cfg.skill) {
    if (cfg.engine && classic) return engineMove(state, p, opts.budgetMs ?? cfg.budget, opts.maxDepth, opts.recent);
    return greedyMove(state, p);
  }
  return weakMove(state, p);
}
