// PathWars ladder. Shared by the server, which awards the points, and by the
// client, which draws the badge — so the two can never disagree about a rank.
//
// The thresholds are set against real play: the average player finishes about
// 13 games, ~400 people have passed 100 games, 4 have passed 500 and exactly
// one has passed 3000. That one player is the only GOAT in the world, and the
// top of the ladder stays worth chasing.
export const RANKS = [
  { key: 'rank_rookie', icon: '🟢', min: 0 },
  { key: 'rank_student', icon: '🔵', min: 100 },
  { key: 'rank_strategist', icon: '🟣', min: 500 },
  { key: 'rank_master', icon: '🟠', min: 1500 },
  { key: 'rank_pro', icon: '🔴', min: 4000 },
  { key: 'rank_legend', icon: '💎', min: 10000 },
  { key: 'rank_goat', icon: '🐐', min: 20000 },
];

export function rankIndex(points) {
  const p = Math.max(0, points | 0);
  let i = 0;
  for (let k = 0; k < RANKS.length; k++) if (p >= RANKS[k].min) i = k;
  return i;
}

export function rankOf(points) { return RANKS[rankIndex(points)]; }

export function nextRank(points) { return RANKS[rankIndex(points) + 1] || null; }

// Beating someone ranked above you pays more; losing to someone below costs
// more. Wins outweigh losses on purpose — a casual player who wins half their
// games still needs to climb, or they stop playing.
export function pointsDelta(myPoints, oppPoints, won) {
  const me = rankIndex(myPoints);
  const opp = rankIndex(oppPoints);
  if (won) return opp > me ? 40 : 25;
  return opp < me ? -20 : -10;
}

/* The four-handed game pays differently, because it is a different bet: you
   are up against three people, not one, so the win is worth more and each of
   the three losses costs less than a duel loss would.

   `field` is the rating of the strongest opponent at the table — beating a
   table with someone above you in it is the harder win.

   Walking out mid-game costs nearly twice a played-out loss. Three people are
   left staring at an empty seat, and that has to be worth avoiding. */
export function quadPointsDelta(myPoints, fieldPoints, outcome) {
  const me = rankIndex(myPoints);
  const field = rankIndex(fieldPoints);
  if (outcome === 'win') return field > me ? 55 : 40;
  if (outcome === 'quit') return field < me ? -30 : -25;
  return field < me ? -20 : -15;
}
