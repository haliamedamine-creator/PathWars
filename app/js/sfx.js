/* The two sounds the game makes, and nothing else.

   A pawn is a short high tick, like a chess clock; a wall is a lower wooden
   knock. Both are built out of one oscillator — there are no sound files to
   download, and on a slow connection that matters more than the fidelity.

   This lives on its own so the video of a finished game can be given the same
   sounds as the game itself. Written into an OfflineAudioContext they come out
   identical to what was heard while playing, which is the whole point: a clip
   that sounds like something else is a clip of some other game. */

// mine  — my move rings higher than theirs
// wall  — a wall going down rather than a pawn moving
// soft  — somebody else's move at a table of four, three seats away from
//         mattering to me yet: audible, but not the sound that means "your turn"
export function scheduleTick(ctx, out, t0, { mine = true, wall = false, soft = false } = {}) {
  const vol = soft ? 0.35 : 1;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  if (wall) {
    o.type = 'sine';
    o.frequency.setValueAtTime(mine ? 340 : 270, t0);
    o.frequency.exponentialRampToValueAtTime(mine ? 180 : 140, t0 + 0.1);  // falling thud
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.3 * vol, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.14);
    o.connect(g).connect(out);
    o.start(t0);
    o.stop(t0 + 0.15);
    return;
  }
  o.type = 'triangle';
  o.frequency.value = mine ? 660 : 500;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(0.22 * vol, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
  o.connect(g).connect(out);
  o.start(t0);
  o.stop(t0 + 0.1);
}
