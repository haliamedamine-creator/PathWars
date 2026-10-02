/* A finished game, turned into a video the player can keep or send on.

   Not a recording of the screen. The screen is built out of divs and CSS, and
   nothing can film those; what can be filmed is a canvas, so the match is drawn
   again here from the positions the game already kept (`game.history`). The
   sounds come from sfx.js — the same two the game makes, written into an
   offline audio context rather than played out loud.

   The file is made on the phone and stays there. Nothing is uploaded, the
   server never learns a clip was made, and the database is not touched. */

import { scheduleTick } from './sfx.js?v=162';

import {
  W, H, FPS, RATE,
  lerp, clamp01, spin, spinWall, geometry, buildTimeline, frameState, dedupeHistory,
} from './clipmath.js?v=162';

/* The picture is flat colour and slow gradients, which is exactly what a low
   ceiling turns into visible banding across the board. Raised until the board
   looked like the board. Nothing like this much is actually spent: most frames
   are identical to the one before, so a nineteen-second clip lands well under
   what this would allow. */
const BITRATE = 6_000_000;

const SEATS = {
  blue:   { ball: ['#cfe1ff', '#6f9cf9', '#2f6df6', '#143a8f'], wall: ['#7aa3fb', '#2f6df6', '#1a48b8'], flat: '#2f6df6' },
  red:    { ball: ['#ffd0d5', '#f57784', '#e33d52', '#8f1626'], wall: ['#f2808f', '#e33d52', '#ad1f33'], flat: '#e33d52' },
  yellow: { ball: ['#fff0c9', '#f8d271', '#f0b429', '#8a5f05'], wall: ['#f8d271', '#f0b429', '#b07f0d'], flat: '#f0b429' },
  green:  { ball: ['#c8f4da', '#5fd095', '#21a35a', '#0c5730'], wall: ['#5fd095', '#21a35a', '#14663a'], flat: '#21a35a' },
};
const NEUTRAL = { wall: ['#48547e', '#2b3355', '#161c34'], flat: '#2b3355' };

/* The two themes, copied out of style.css rather than invented. A clip in
   colours the game does not use reads as somebody else's game — and a player
   who set the dark theme and got back a bright blue video is right to say the
   colours are wrong.

   Every value here has a twin in the stylesheet: change one and change both.
   Search for `--bg`, `#board` and `.grid-line`. */
const THEMES = {
  light: {
    page: '#eef1f7',                                  // --bg
    wash: ['rgba(255,120,120,.06)', 'rgba(124,92,255,.04)', 'rgba(61,123,255,.06)'],
    paper: 'rgba(120,120,160,.07)',                   // the graph-paper grid on body
    text: '#1d2440',                                  // --text
    muted: 'rgba(139,147,175,.95)',                   // --muted
    board: ['#fdfdff', '#f0f1f8', '#e9ebf4'],
    bezel: '#c9d2e2',                                 // --bezel
    rim: '#98a5c0',
    lines: 'rgba(95, 115, 165, .30)',                 // .grid-line
    shade: 'rgba(45, 65, 120, .45)',
  },
  dark: {
    page: '#12141f',
    wash: ['rgba(90,110,220,.06)', 'rgba(40,50,110,.05)', 'rgba(47,109,246,.06)'],
    paper: 'rgba(140,150,210,.05)',
    text: '#e8eaf6',
    muted: 'rgba(139,147,180,.95)',
    board: ['#272e4a', '#1d2340', '#171c33'],
    bezel: '#2c3349',
    rim: '#1a2033',
    lines: 'rgba(185, 200, 235, .17)',
    shade: 'rgba(0, 0, 0, .55)',
  },
};

/* ---------- small drawing helpers ---------- */

// Safari did not have roundRect until 16, and the clip has to look the same on
// a phone that has not been updated in two years.
function rrect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

/* ---------- the board, drawn the way the player saw it ---------- */

// The same quarter turns the live board uses, so the clip matches the game the
// player actually watched rather than some other camera angle.
/* A nickname can be sixteen characters long and a heading has a width. Shrink
   the type until it fits rather than letting it run off the side — the clip is
   the one thing here that gets seen by people who do not play. */
function fitFont(ctx, text, maxWidth, size, weight = 700) {
  let px = size;
  const set = () => { ctx.font = `${weight} ${px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`; };
  set();
  while (px > 14 && ctx.measureText(text).width > maxWidth) { px -= 2; set(); }
  return px;
}

function drawBoardBase(ctx, art) {
  const { cols, rows, geo } = art;
  const { bx: BX, by: BY, bw: BOARD, bh } = geo;

  const th = art.theme;

  ctx.save();
  ctx.shadowColor = th.shade;
  ctx.shadowBlur = 46;
  ctx.shadowOffsetY = 20;
  rrect(ctx, BX - 22, BY - 22, BOARD + 44, bh + 44, 34);
  ctx.fillStyle = th.rim;
  ctx.fill();
  ctx.restore();

  rrect(ctx, BX - 20, BY - 20, BOARD + 40, bh + 40, 32);
  ctx.fillStyle = th.bezel;
  ctx.fill();

  const bg = ctx.createLinearGradient(BX, BY, BX + BOARD * 0.35, BY + bh);
  bg.addColorStop(0, th.board[0]);
  bg.addColorStop(0.7, th.board[1]);
  bg.addColorStop(1, th.board[2]);
  rrect(ctx, BX, BY, BOARD, bh, 26);
  ctx.fillStyle = bg;
  ctx.fill();

  // the pencil grid, over one continuous surface
  ctx.save();
  rrect(ctx, BX, BY, BOARD, bh, 26);
  ctx.clip();
  ctx.fillStyle = th.lines;
  for (let i = 1; i < Math.max(cols, rows); i++) {
    const at = geo.pad + i * (geo.u + geo.g) - geo.g / 2;
    if (i < cols) ctx.fillRect(BX + at, BY + geo.pad / 2, 1.6, bh - geo.pad);
    if (i < rows) ctx.fillRect(BX + geo.pad / 2, BY + at, BOARD - geo.pad, 1.6);
  }
  ctx.restore();
}

// Where each player came from, and — at a table of four — the cell they are all
// running at.
function drawZones(ctx, art) {
  const { geo, quad, seatColors, turns, cols, rows, goal } = art;
  const { bx: BX, by: BY, bw: BOARD, bh } = geo;
  const band = geo.pad + geo.u + geo.g / 2;

  ctx.save();
  rrect(ctx, BX, BY, BOARD, bh, 26);
  ctx.clip();

  const paint = (side, color) => {
    const c = SEATS[color]?.flat || '#2f6df6';
    const vertical = side === 'top' || side === 'bottom';
    const x = side === 'right' ? BX + BOARD - band : BX;
    const y = side === 'bottom' ? BY + bh - band : BY;
    const w = vertical ? BOARD : band;
    const h = vertical ? band : bh;
    const from = side === 'top' ? [x, y] : side === 'bottom' ? [x, y + h] : side === 'left' ? [x, y] : [x + w, y];
    const to = side === 'top' ? [x, y + h] : side === 'bottom' ? [x, y] : side === 'left' ? [x + w, y] : [x, y];
    const grad = ctx.createLinearGradient(from[0], from[1], to[0], to[1]);
    grad.addColorStop(0, hexA(c, 0.30));
    grad.addColorStop(0.65, hexA(c, 0.10));
    grad.addColorStop(1, hexA(c, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w, h);
    // the bright bar right on the board's edge
    ctx.fillStyle = hexA(c, 0.85);
    if (side === 'top') ctx.fillRect(x, y, w, 4);
    else if (side === 'bottom') ctx.fillRect(x, y + h - 4, w, 4);
    else if (side === 'left') ctx.fillRect(x, y, 4, h);
    else ctx.fillRect(x + w - 4, y, 4, h);
  };

  if (quad) {
    const sides = ['bottom', 'left', 'top', 'right'];
    for (let seat = 0; seat < 4; seat++) paint(sides[(seat + turns) % 4], seatColors[seat]);
    const g = goal || { r: (rows - 1) / 2, c: (cols - 1) / 2 };
    const gv = spin(g.r, g.c, turns, Math.max(cols, rows));
    const at = cellXY(art, gv.r, gv.c);
    const cx = at.x + geo.u / 2, cy = at.y + geo.u * 0.45;
    const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, geo.u * 0.7);
    gr.addColorStop(0, 'rgba(255,201,60,.55)');
    gr.addColorStop(0.7, 'rgba(255,201,60,.18)');
    gr.addColorStop(1, 'rgba(255,201,60,0)');
    ctx.fillStyle = gr;
    rrect(ctx, at.x, at.y, geo.u, geo.u, 8);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,201,60,.9)';
    ctx.lineWidth = 3;
    rrect(ctx, at.x + 1.5, at.y + 1.5, geo.u - 3, geo.u - 3, 8);
    ctx.stroke();
  } else {
    // a duel is played up and down: my colour at my end, theirs at theirs
    paint('bottom', seatColors[0]);
    paint('top', seatColors[1]);
  }
  ctx.restore();
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function cellXY(art, r, c) {
  const { geo } = art;
  return { x: geo.bx + geo.pad + c * (geo.u + geo.g), y: geo.by + geo.pad + r * (geo.u + geo.g) };
}

function wallRect(art, vw) {
  const { geo } = art;
  const thick = geo.g * 0.78;
  const inset = -geo.g / 2;
  const len = 2 * geo.u + geo.g - 2 * inset;
  const a = cellXY(art, vw.r, vw.c);
  if (vw.o === 'h') return { x: a.x + inset, y: a.y + geo.u + geo.g / 2 - thick / 2, w: len, h: thick };
  return { x: a.x + geo.u + geo.g / 2 - thick / 2, y: a.y + inset, w: thick, h: len };
}

function drawWall(ctx, art, wall, scale = 1, alpha = 1) {
  const m = Math.max(art.cols, art.rows) - 1;
  const vw = spinWall(wall, art.turns, m);
  const r = wallRect(art, vw);
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  const paint = (typeof wall.by === 'number' ? SEATS[art.seatColors[wall.by]] : null) || NEUTRAL;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  ctx.translate(-cx, -cy);
  ctx.shadowColor = 'rgba(12, 18, 40, .45)';
  ctx.shadowBlur = 9;
  ctx.shadowOffsetY = 5;
  const grad = ctx.createLinearGradient(r.x, r.y, r.x, r.y + r.h);
  grad.addColorStop(0, paint.wall[0]);
  grad.addColorStop(0.45, paint.wall[1]);
  grad.addColorStop(1, paint.wall[2]);
  ctx.fillStyle = grad;
  rrect(ctx, r.x, r.y, r.w, r.h, Math.min(r.w, r.h) / 2);
  ctx.fill();
  ctx.restore();
}

function drawPawn(ctx, art, seat, r, c, alpha = 1) {
  const { geo } = art;
  const n = Math.max(art.cols, art.rows);
  // the position is interpolated, so it is turned as a pair of floats rather
  // than as a cell: a quarter turn of (r, c) is the same arithmetic either way
  let p = { r, c };
  for (let i = 0; i < art.turns; i++) p = { r: p.c, c: n - 1 - p.r };
  const at = { x: geo.bx + geo.pad + p.c * (geo.u + geo.g), y: geo.by + geo.pad + p.r * (geo.u + geo.g) };
  const d = geo.u * 0.82;
  const off = geo.u * 0.09;
  const x = at.x + off, y = at.y + off;
  const cx = x + d / 2, cy = y + d / 2;
  const paint = SEATS[art.seatColors[seat]] || SEATS.blue;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = 'rgba(10, 20, 50, .45)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 8;
  const gx = x + d * 0.31, gy = y + d * 0.24;
  const grad = ctx.createRadialGradient(gx, gy, d * 0.02, gx, gy, d * 0.92);
  grad.addColorStop(0, paint.ball[0]);
  grad.addColorStop(0.22, paint.ball[1]);
  grad.addColorStop(0.55, paint.ball[2]);
  grad.addColorStop(1, paint.ball[3]);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // the specular dot that makes it read as a billiard ball rather than a disc
  ctx.save();
  ctx.globalAlpha = alpha;
  const hx = x + d * 0.35, hy = y + d * 0.24;
  const hg = ctx.createRadialGradient(hx, hy, 0, hx, hy, d * 0.17);
  hg.addColorStop(0, 'rgba(255,255,255,.95)');
  hg.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = hg;
  ctx.beginPath();
  ctx.ellipse(hx, hy, d * 0.17, d * 0.13, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/* ---------- everything around the board ---------- */

function drawChrome(ctx, art) {
  const th = art.theme;

  /* The page behind the board, and it is the game's own page: the flat colour,
     the three faint tints over it, and the graph paper. Copied rather than
     approximated, because "almost the right background" is exactly what makes a
     clip look like it belongs to some other game. */
  ctx.fillStyle = th.page;
  ctx.fillRect(0, 0, W, H);
  const wash = ctx.createLinearGradient(0, 0, 0, H);
  wash.addColorStop(0, th.wash[0]);
  wash.addColorStop(0.4, th.wash[1]);
  wash.addColorStop(1, th.wash[2]);
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = th.paper;
  for (let x = 40; x < W; x += 40) ctx.fillRect(x, 0, 1, H);
  for (let y = 40; y < H; y += 40) ctx.fillRect(0, y, W, 1);

  ctx.textAlign = 'center';
  ctx.fillStyle = th.text;
  ctx.font = '800 44px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.fillText('PathWars', W / 2, 76);
  ctx.textAlign = 'left';

  // who played, in their own colours
  const names = art.names;
  const PAD = 34;               // never closer than this to either edge
  const ROW = 124;
  if (names.length <= 2) {
    const a = names[0] || '', b = names[1] || '';
    // one line, measured as one line: "vs" has a space either side of it, and
    // the whole thing shrinks together so the two names stay the same size
    fitFont(ctx, `${a}  vs  ${b}`, W - 2 * PAD, 32);
    const sep = ctx.measureText('  vs  ').width;
    const wa = ctx.measureText(a).width, wb = ctx.measureText(b).width;
    let x = (W - (wa + sep + wb)) / 2;
    ctx.fillStyle = SEATS[art.seatColors[0]]?.flat || '#2f6df6';
    ctx.fillText(a, x, ROW);
    x += wa;
    ctx.fillStyle = th.muted;
    ctx.fillText('vs', x + (sep - ctx.measureText('vs').width) / 2, ROW);
    x += sep;
    ctx.fillStyle = SEATS[art.seatColors[1]]?.flat || '#e33d52';
    ctx.fillText(b, x, ROW);
  } else {
    const dot = 8, lead = 24, gap = 18;
    const px = fitFont(ctx, names.join(''), W - 2 * PAD - names.length * lead - (names.length - 1) * gap, 26);
    const widths = names.map(n => ctx.measureText(n).width + lead);
    const total = widths.reduce((sum, v) => sum + v, 0) + gap * (names.length - 1);
    let x = (W - total) / 2;
    for (let i = 0; i < names.length; i++) {
      ctx.fillStyle = SEATS[art.seatColors[i]]?.flat || '#2f6df6';
      ctx.beginPath();
      ctx.arc(x + dot, ROW - px * 0.32, dot, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = th.text;
      ctx.fillText(names[i], x + lead, ROW);
      x += widths[i] + gap;
    }
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = th.muted;
  ctx.font = '600 28px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.fillText('pathwars.online', W / 2, H - 52);
}

function drawResult(ctx, art, alpha) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textAlign = 'center';
  const color = art.winner !== null && art.winner !== undefined
    ? (SEATS[art.seatColors[art.winner]]?.flat || art.theme.text) : art.theme.text;
  ctx.fillStyle = color;
  fitFont(ctx, art.resultLine, W - 68, 44, 800);
  ctx.fillText(art.resultLine, W / 2, 1068);
  if (art.movesLine) {
    ctx.fillStyle = art.theme.muted;
    fitFont(ctx, art.movesLine, W - 68, 26, 600);
    ctx.fillText(art.movesLine, W / 2, 1110);
  }
  ctx.restore();
}

/* ---------- the timeline ---------- */

function drawFrame(ctx, art, ms) {
  const f = frameState(art, ms);
  drawChrome(ctx, art);
  drawBoardBase(ctx, art);
  drawZones(ctx, art);

  const oldWalls = f.base.walls || [];
  const newWalls = f.next.walls || [];
  for (let i = 0; i < newWalls.length; i++) {
    const fresh = i >= oldWalls.length;
    if (fresh) drawWall(ctx, art, newWalls[i], 0.6 + 0.4 * f.pWall, f.pWall);
    else drawWall(ctx, art, newWalls[i]);
  }

  const pawns = f.next.pawns || [];
  for (let i = 0; i < pawns.length; i++) {
    const wasAlive = !f.base.alive || f.base.alive[i] !== false;
    const isAlive = !f.next.alive || f.next.alive[i] !== false;
    if (!wasAlive && !isAlive) continue;
    const alpha = wasAlive && !isAlive ? 1 - f.p : 1;
    const a = f.base.pawns[i], b = pawns[i];
    drawPawn(ctx, art, i, lerp(a.r, b.r, f.p), lerp(a.c, b.c, f.p), alpha);
  }

  // Say when it is fast-forwarding. Without it the opening of a long game looks
  // like a broken video rather than a quick one.
  if (art.time.fast && f.i >= 0 && f.i < art.time.fast) drawFastBadge(ctx, art);

  drawResult(ctx, art, clamp01((ms - art.time.endOfMoves) / 320));
}

// "⏩ ×6" under the board — numbers and a symbol, so it needs no translation
function drawFastBadge(ctx, art) {
  const { geo } = art;
  const text = `⏩ ×${art.time.speedup}`;
  ctx.save();
  ctx.font = '700 26px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const w = ctx.measureText(text).width + 34, h = 44;
  const x = (W - w) / 2, y = geo.by + geo.bh + 34;
  rrect(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = art.theme.text;
  ctx.globalAlpha = 0.86;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = art.theme.page;
  ctx.textAlign = 'center';
  ctx.fillText(text, W / 2, y + 31);
  ctx.restore();
}

/* ---------- the sound of it ---------- */

async function renderAudio(art) {
  const seconds = art.time.total / 1000;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) return null;
  const ctx = new OAC(1, Math.ceil(RATE * seconds), RATE);
  const { steps, starts, fast } = art.time;
  for (let i = 0; i < steps; i++) {
    const before = art.history[i], after = art.history[i + 1];
    const wall = (after.walls || []).length > (before.walls || []).length;
    /* While the opening fast-forwards, a tick for every pawn step is a machine
       gun. Walls still knock — they are what changes the board — and the
       pawns are silent until the game is back at its own pace. */
    if (i < fast && !wall) continue;
    const mover = before.turn;
    scheduleTick(ctx, ctx.destination, starts[i] / 1000, {
      mine: mover === art.mySeat,
      wall,
      soft: (art.quad && mover !== art.mySeat) || i < fast,
    });
  }
  return ctx.startRendering();
}

/* ---------- putting a file together ---------- */

const codecSupported = async (config) => {
  try { return Boolean((await VideoEncoder.isConfigSupported(config))?.supported); }
  catch { return false; }
};

async function encodeMp4(art, audio, onProgress) {
  const { Muxer, ArrayBufferTarget } = await import('../vendor/mp4-muxer.js?v=162');

  /* H.264 baseline first: it is the one profile every phone made in the last
     decade can play, and on an iPhone it is decoded in hardware. Main and high
     follow for the few that refuse baseline at this size.

     VP9 last, and only as a rescue. It is a legal thing to put in an mp4 and
     Android plays it, but an iPhone does not — which is survivable, because an
     iPhone without H.264 encoding does not exist. Reaching this line means the
     browser had no H.264 at all, and a video that plays on that phone beats a
     button that does nothing. */
  const tries = [
    ['avc1.42002a', 'avc'], ['avc1.4d0028', 'avc'], ['avc1.640028', 'avc'],
    ['vp09.00.10.08', 'vp9'],
  ];
  let codec = null, family = null;
  for (const [c, f] of tries) {
    if (await codecSupported({ codec: c, width: W, height: H, bitrate: BITRATE, framerate: FPS })) {
      codec = c; family = f; break;
    }
  }
  if (!codec) throw new Error('no_video_codec');

  // AAC for the same reason, Opus for the same rescue.
  let sfmt = null;
  if (audio && typeof AudioEncoder !== 'undefined') {
    for (const [c, f] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
      try {
        const q = await AudioEncoder.isConfigSupported({
          codec: c, sampleRate: RATE, numberOfChannels: 1, bitrate: 96_000,
        });
        if (q?.supported) { sfmt = { codec: c, family: f }; break; }
      } catch { /* try the next one */ }
    }
  }
  const audioOk = Boolean(sfmt);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: family, width: W, height: H, frameRate: FPS },
    ...(audioOk ? { audio: { codec: sfmt.family, numberOfChannels: 1, sampleRate: RATE } } : {}),
    fastStart: 'in-memory',        // playable the moment it is opened
  });

  let failure = null;
  const video = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { failure = e; },
  });
  video.configure({
    codec, width: W, height: H, bitrate: BITRATE, framerate: FPS,
    /* Variable, not constant. Most of this clip is a board that does not move,
       so a constant rate would spend the same bits on a still frame as on a
       pawn crossing it. Letting it vary puts the bits where something happens
       and costs nothing where nothing does. */
    bitrateMode: 'variable',
    latencyMode: 'quality',
  });

  let sound = null;
  if (audioOk) {
    sound = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => { failure = e; },
    });
    sound.configure({ codec: sfmt.codec, sampleRate: RATE, numberOfChannels: 1, bitrate: 96_000 });
  }

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });

  const frames = Math.ceil((art.time.total / 1000) * FPS);
  for (let f = 0; f < frames; f++) {
    if (failure) break;
    drawFrame(ctx, art, (f / FPS) * 1000);
    const frame = new VideoFrame(canvas, {
      timestamp: Math.round((f * 1e6) / FPS),
      duration: Math.round(1e6 / FPS),
    });
    video.encode(frame, { keyFrame: f % (FPS * 2) === 0 });
    frame.close();
    // Room to breathe: without this the encoder queue grows until the phone
    // runs out of memory, and the page is frozen the whole time either way.
    if (video.encodeQueueSize > 6 || f % 15 === 0) {
      onProgress?.(f / frames);
      await new Promise(r => setTimeout(r, 0));
    }
  }

  if (audioOk && audio) {
    const pcm = audio.getChannelData(0);
    const block = 4096;
    for (let i = 0; i < pcm.length; i += block) {
      const slice = pcm.slice(i, Math.min(i + block, pcm.length));
      const data = new AudioData({
        format: 'f32-planar',
        sampleRate: RATE,
        numberOfFrames: slice.length,
        numberOfChannels: 1,
        timestamp: Math.round((i / RATE) * 1e6),
        data: slice,
      });
      sound.encode(data);
      data.close();
      if (sound.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 0));
    }
  }

  await video.flush();
  if (sound) await sound.flush();
  if (failure) throw failure;
  muxer.finalize();
  onProgress?.(1);
  return { blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }), ext: 'mp4', mime: 'video/mp4' };
}

/* The way back for a browser without WebCodecs. Slower — it plays the clip
   through once in real time and records what comes out — and the format is
   whichever one that browser makes, which on Safari is mp4 and on the rest is
   webm. Worth having: it is the difference between an old phone getting a
   video and getting an apology. */
async function recordLive(art, audio, onProgress) {
  if (typeof MediaRecorder === 'undefined') throw new Error('no_recorder');
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!canvas.captureStream) throw new Error('no_capture');
  const stream = canvas.captureStream(FPS);

  const AC = window.AudioContext || window.webkitAudioContext;
  let ac = null;
  if (audio && AC) {
    try {
      ac = new AC();
      const dest = ac.createMediaStreamDestination();
      const src = ac.createBufferSource();
      src.buffer = audio;
      src.connect(dest);
      for (const tr of dest.stream.getAudioTracks()) stream.addTrack(tr);
      src.start();
    } catch { ac = null; }
  }

  /* Order matters, and the obvious order is wrong. Asking a browser for plain
     "video/mp4" can get an mp4 container with VP9 inside it — which no iPhone
     will play, and the .mp4 on the end makes that impossible to guess. So H.264
     is asked for by name first, webm is preferred over a container whose
     contents are a surprise, and bare "video/mp4" is last: Safari does not take
     the explicit spelling, and Safari's own mp4 really is H.264. */
  const types = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01E',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ];
  const mime = types.find(t => MediaRecorder.isTypeSupported?.(t)) || '';
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: BITRATE } : {});
  const parts = [];
  rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  const stopped = new Promise(r => { rec.onstop = r; });
  rec.start();

  const began = performance.now();
  await new Promise((done) => {
    const step = () => {
      const ms = performance.now() - began;
      drawFrame(ctx, art, Math.min(ms, art.time.total));
      onProgress?.(Math.min(1, ms / art.time.total));
      if (ms >= art.time.total) done();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

  rec.stop();
  await stopped;
  try { ac?.close(); } catch { /* it has done its job */ }
  const type = parts[0]?.type || mime || 'video/webm';
  const ext = type.includes('mp4') ? 'mp4' : 'webm';
  return { blob: new Blob(parts, { type }), ext, mime: type };
}

/* ---------- what the page calls ---------- */

export async function makeClip(opts, onProgress) {
  const history = dedupeHistory(opts.history || []);
  if (history.length < 2) throw new Error('nothing_to_show');
  const first = history[0];
  const cols = first.cols || 9, rows = first.rows || 9;
  const quad = first.mode === 'quad';
  const art = {
    history,
    cols,
    rows,
    quad,
    goal: first.goal || null,
    turns: opts.turns || 0,
    seatColors: opts.seatColors || (quad ? ['blue', 'red', 'yellow', 'green'] : ['blue', 'red']),
    names: opts.names || [],
    mySeat: opts.mySeat ?? 0,
    winner: opts.winner ?? null,
    resultLine: opts.resultLine || '',
    movesLine: opts.movesLine || '',
    theme: THEMES[opts.theme === 'dark' ? 'dark' : 'light'],
  };
  art.geo = geometry(cols, rows);
  art.time = buildTimeline(history);

  let audio = null;
  try { audio = await renderAudio(art); } catch { audio = null; }

  if (typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined') {
    try { return await encodeMp4(art, audio, onProgress); }
    catch (e) { console.warn('mp4 encode failed, recording instead:', e?.message || e); }
  }
  return recordLive(art, audio, onProgress);
}

