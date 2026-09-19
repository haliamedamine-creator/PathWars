// Nickname rules. A nickname is shown to every opponent and sits on a public
// leaderboard, so it is the one piece of user text the game publishes.
//
// The list is deliberately narrow: slurs, sexual crudeness, hate symbols and
// names that pretend to speak for the game. It is not a politeness filter —
// blocking mild words drives people to spell around them and annoys everyone
// else. Checked on the server; the client uses the same file only so it can
// warn before the request is sent.

// Three lists, because how a word is matched matters as much as the word.
// These are unambiguous: no ordinary name contains them, so they are matched
// anywhere inside a nickname.
const BANNED_ANYWHERE = [
  'fuck', 'fck', 'shit', 'bitch', 'cunt', 'penis', 'pussy', 'pusy', 'dildo',
  'vagina', 'whore', 'slut', 'porn', 'rape',
  'nigg', 'nigr', 'faggot', 'fagot', 'retard', 'tranny',
  'hitler', 'nazi', 'swastika', 'fakislam', 'fuckislam', 'killislam',
  // russian and neighbours
  'hui', 'huy', 'huil', 'pizd', 'blyad', 'blyat',
  'mudak', 'pidor', 'pidar', 'pedik', 'gandon', 'dolboeb', 'dalboeb',
  'ubludok', 'zalupa', 'govn', 'nahui', 'pohui', 'petush', 'vrotdav', 'qotaq',
  // other languages
  'kurwa', 'mierda', 'merde', 'amcik', 'orospu', 'siktir', 'kahba',
];

// These are real words inside real names — "dick" in Dickson, "sex" in Essex
// and Sussex, "puto" in Caputo. Blocking them as fragments punishes people
// with ordinary names, so they only count when they stand alone.
const BANNED_ALONE = ['dick', 'cock', 'sex', 'puta', 'puto'];

// Short enough to appear by accident in the middle of an innocent name —
// "ebal" hides in Nice_ball — but never by accident at the edge of a word,
// which is where "Ebat" and "mamuebal" put it.
const BANNED_EDGE = ['eban', 'ebat', 'ebal'];

// Real words that happen to contain a banned fragment. Scunthorpe is a town
// in England; the filter that blocks it is the textbook example of getting
// this wrong. Cheaper to name the exceptions than to weaken the rule.
const ALLOWED = new Set(['scunthorpe', 'penistone', 'shitake', 'shiitake', 'cockburn', 'cockerell']);

// Hate codes are numbers, so they must match as a whole number rather than as
// digits inside one: 1488 is a symbol, 14880 is somebody's score.
const BANNED_CODES = ['1488', '8814'];

// Names that would let someone speak as the game or its staff. Only the game's
// own name is blocked anywhere — "PathWarsKing" still passes for the game.
// The rest are whole words, because "system" hides in Cellsystem and "root"
// in Grootiii, and neither of those pretends to be anybody.
const RESERVED_ANYWHERE = ['pathwars'];
const RESERVED_ALONE = [
  'admin', 'administrator', 'moderator', 'support', 'staff',
  'official', 'system', 'server', 'root', 'owner',
];

// Cyrillic and l33t both fold onto plain latin, so "п и д о р", "p1d0r" and
// "P!DOR" all end up as the same string before matching.
const CYR = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '@': 'a', '$': 's', '!': 'i' };

export function normalise(nick) {
  const lower = String(nick || '').toLowerCase();
  let out = '';
  for (const ch of lower) {
    if (CYR[ch] !== undefined) out += CYR[ch];
    else if (LEET[ch] !== undefined) out += LEET[ch];
    else if (/[a-z0-9]/.test(ch)) out += ch;
    // everything else (spaces, underscores, punctuation) is dropped, so
    // "f_u_c_k" and "f.u.c.k" cannot slip through
  }
  return out;
}

// Returns null when the nickname is fine, or a short reason code when it is not.
export function checkNick(nick) {
  const raw = String(nick || '').trim();
  if (!/^[A-Za-z0-9_Ѐ-ӿ]{3,16}$/.test(raw)) return 'format';
  const flat = normalise(raw);
  if (!flat) return 'format';
  if (ALLOWED.has(flat)) return null;
  for (const w of BANNED_ANYWHERE) if (flat.includes(w)) return 'rude';
  // whole words only: split on anything that is not a letter, then normalise
  const words = raw.toLowerCase().split(/[^a-zа-яё]+/i).filter(Boolean).map(normalise);
  for (const w of BANNED_ALONE) if (words.includes(w) || flat === w) return 'rude';
  const edges = [flat, ...words];
  for (const w of BANNED_EDGE) {
    if (edges.some((s) => s.startsWith(w) || s.endsWith(w))) return 'rude';
  }
  for (const w of RESERVED_ANYWHERE) if (flat.includes(w)) return 'reserved';
  for (const w of RESERVED_ALONE) if (words.includes(w) || flat === w) return 'reserved';
  const runs = raw.match(/\d+/g) || [];
  for (const code of BANNED_CODES) if (runs.includes(code)) return 'rude';
  return null;
}

export const nickOk = (nick) => checkNick(nick) === null;

// Guests are handed a name before they ever type one. Drawing it at random
// means the draw can land on a banned number, so it is checked like any other.
export function randomNick(rand = () => Math.random()) {
  for (let i = 0; i < 20; i++) {
    const nick = 'User' + (1000 + Math.floor(rand() * 9000));
    if (nickOk(nick)) return nick;
  }
  return 'Player';
}
