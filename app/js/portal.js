/* Everything CrazyGames, kept in one file.

   The same build serves two places. On pathwars.online the game is its own
   page and nothing in here runs: `embedded` comes out false, the SDK is never
   fetched, and every function below returns immediately. Inside the portal the
   game sits in a frame on their page, and then the rules are theirs — our own
   banners must not appear, and the money comes from ads we ask them for.

   Two different questions, deliberately answered separately:

     embedded   — are we inside anybody's frame? Decides whether our banners
                  are allowed. Every portal forbids them, not only this one,
                  so the answer must not depend on recognising CrazyGames.
     inPortal() — is this really CrazyGames, with a working SDK? Decides
                  whether their calls do anything.

   Nothing here is allowed to throw. A portal is somebody else's page that can
   change without warning, and a game that dies because an ad call went
   missing is worse than a game with no ads. */

const SDK_SRC = 'https://sdk.crazygames.com/crazygames-sdk-v3.js';

// A cross-origin parent makes even reading window.top throw, and that throw is
// itself the answer: something is framing us.
export const embedded = (() => {
  try { return window.self !== window.top; } catch { return true; }
})();

let sdk = null;      // set only once init has succeeded on their site
let ready = null;    // the in-flight init, so a second call waits rather than repeats

function loadScript() {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SDK_SRC;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('sdk script failed'));
    document.head.appendChild(s);
    // their servers going slow must not hold the game on a loading screen
    setTimeout(() => reject(new Error('sdk script timeout')), 8000);
  });
}

/* Fetched on demand rather than sitting in the page as a tag, so a visitor to
   pathwars.online never downloads it and never gets touched by it. */
export function initPortal() {
  if (ready) return ready;
  ready = (async () => {
    if (!embedded) return null;
    try {
      await loadScript();
      const s = window.CrazyGames && window.CrazyGames.SDK;
      if (!s) return null;
      await s.init();
      // 'crazygames' on their site; 'local' or 'disabled' anywhere else, and
      // in those cases their calls are not ours to make
      if (s.environment !== 'crazygames') return null;
      sdk = s;
      return s;
    } catch (e) {
      console.warn('portal: SDK unavailable —', e.message);
      return null;
    }
  })();
  return ready;
}

export const inPortal = () => Boolean(sdk);

/* ---------- their ads ----------
   Resolves true only when an ad actually played through. Everything else —
   no fill, a blocker, their SDK having a bad day — resolves false, and the
   caller carries on as if nothing had been asked for. */
export function portalAd(kind = 'midgame') {
  return new Promise((resolve) => {
    if (!sdk) { resolve(false); return; }
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    try {
      sdk.ad.requestAd(kind, {
        adStarted: () => {},
        adFinished: () => done(true),
        adError: () => done(false),
      });
    } catch { done(false); }
    // a callback that never comes must not strand the player mid-menu
    setTimeout(() => done(false), 45000);
  });
}

/* ---------- signals they use to place their own ads well ----------
   Telling them when a match is actually being played is what keeps their ads
   out of the middle of one. */
export function portalPlaying(on) {
  try {
    if (!sdk) return;
    if (on) sdk.game.gameplayStart(); else sdk.game.gameplayStop();
  } catch { /* their call, their problem */ }
}

// a good moment — a win. They use it to pick when not to interrupt.
export function portalHappy() {
  try { sdk && sdk.game.happytime(); } catch {}
}

// v3 renamed these from sdkGameLoadingStart/Stop. Both are tried: whichever
// the loaded SDK actually has is the one that runs.
export function portalLoaded() {
  try {
    if (!sdk) return;
    (sdk.game.loadingStop || sdk.game.sdkGameLoadingStop).call(sdk.game);
  } catch {}
}

/* ---------- playing with friends, their way ----------

   Their model has three ways into the same room and all three must work.

     A friend taps an invite notification, or opens an invite link — the game
     starts with the room already named in the launch parameters.

     A friend already inside the game presses Join in the CrazyGames friends
     drawer — nothing restarts, the running game is handed the room and has to
     move there itself.

     A group leader arrives with isInstantMultiplayer set and must land in a
     fresh private room without seeing a menu at all.

   Our private rooms already behave this way; what follows is only the
   translation between their vocabulary and ours. */

// Their launch parameters, whether the game was opened from a link or a
// notification. `code` is ours — the private-room code.
export function portalInviteCode() {
  try {
    if (!sdk) return '';
    const direct = sdk.game.getInviteParam && sdk.game.getInviteParam('code');
    if (direct) return String(direct);
    const params = sdk.game.inviteParams;
    return (params && params.code) ? String(params.code) : '';
  } catch { return ''; }
}

/* Where this player is right now, and whether anyone may join them.

   This is what lights up Join beside their name in a friend's list, so it has
   to be told the truth at every turn: on entering a room, when the room fills
   up, and when the player walks out. A room left marked joinable after the
   second player arrives sends friends into a room that will refuse them. */
export function portalRoom(code, joinable) {
  try {
    if (!sdk || !sdk.game.updateRoom) return;
    if (!code) { sdk.game.updateRoom({ isJoinable: false }); return; }
    sdk.game.updateRoom({
      room: String(code),
      isJoinable: Boolean(joinable),
      inviteParams: { code: String(code) },
    });
  } catch {}
}

// A friend pressing Join while we are already running. No reload happens, so
// the game has to notice and move rooms on its own.
export function portalOnJoin(handler) {
  try {
    if (!sdk || !sdk.game.addJoinRoomListener) return;
    sdk.game.addJoinRoomListener((params) => {
      const code = params && (params.code || params.roomId);
      if (code) handler(String(code).toUpperCase());
    });
  } catch {}
}

// A link the player can copy and paste anywhere, alongside their own button.
export async function portalInviteLink(code) {
  try {
    if (!sdk || !sdk.game.inviteLink) return '';
    return (await sdk.game.inviteLink({ code: String(code) })) || '';
  } catch { return ''; }
}

export function portalShowInvite(code) {
  try { sdk && sdk.game.showInviteButton({ code }); } catch {}
}

export function portalHideInvite() {
  try { sdk && sdk.game.hideInviteButton(); } catch {}
}

// Set when a group arrives together: open straight into a room, no menu.
export function portalInstant() {
  try { return Boolean(sdk && sdk.game.isInstantMultiplayer); } catch { return false; }
}

/* ---------- their sound switch ----------
   The mute control sits on their page, outside the frame, and the player
   expects it to silence everything on it. Their setting outranks ours: a game
   that keeps ticking after the page was muted reads as broken. */
export function portalMuted() {
  try { return Boolean(sdk && sdk.game.settings && sdk.game.settings.muteAudio); } catch { return false; }
}

export function portalOnMute(handler) {
  try {
    if (!sdk || !sdk.game.addSettingsChangeListener) return;
    sdk.game.addSettingsChangeListener((s) => handler(Boolean(s && s.muteAudio)));
  } catch {}
}

/* ---------- who they are on CrazyGames ----------
   Their requirement, and a fair one: friends have to be able to recognise
   each other. A player signed in to CrazyGames plays under that name, so the
   person across the board is the person they meant to play. */
export async function portalUserName() {
  try {
    if (!sdk || !sdk.user) return '';
    if (sdk.user.isUserAccountAvailable === false) return '';
    const u = await sdk.user.getUser();
    return (u && u.username) ? String(u.username) : '';
  } catch { return ''; }
}
