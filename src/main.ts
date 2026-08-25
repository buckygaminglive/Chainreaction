import './style.css';
import { GameEngine } from './game/GameEngine';
import type { EngineSnapshot, PlayerConfig, MoveEvent } from './game/types';
import { DEFAULT_MODE, GAME_MODES, MODE_ORDER, type GameModeKey } from './game/modes';
import { layoutForMode, randomSeed } from './game/cells';
import { chooseMove, skillForRound } from './game/ai';
import { BOTS, pickBot, type Bot } from './game/bots';
import { stats } from './game/stats';
import { rankFor, rankProgress, nextRankAt } from './game/rank';
import { prefs, type MotionPref } from './game/prefs';
// Three.js is the bulk of the bundle and nothing outside the board needs it,
// so the renderer is pulled in on demand when a match actually starts — the
// menu, the online screens and the join-by-link flow all load without it.
import type { ThreeRenderer, OrbStyle } from './render3d/ThreeRenderer';
import { EXPLOSION_SPIN_UP_MS } from './render3d/timing';
import { PLAYER_THEMES } from './render/theme';
import { modePreview } from './render/modePreview';
import { sfx } from './sfx/Sfx';
import { haptics } from './sfx/Haptics';
import { NetClient } from './net/NetClient';
import { account } from './net/account';
import { telemetry } from './net/telemetry';
import { TAUNTS, TAUNT_COOLDOWN_MS } from './net/taunts';
import type { BoardSizeKey, NetPlayer } from './net/protocol';

const BOARD_SIZES: Record<BoardSizeKey, { rows: number; cols: number }> = {
  small: { rows: 9, cols: 5 },
  medium: { rows: 11, cols: 6 },
  large: { rows: 13, cols: 7 },
};

/** A chain has to reach this depth before it's worth interrupting the board
 *  with a counter — below it, every ordinary move would flash a "×1". */
const CHAIN_CALLOUT_MIN = 2;
/** Depth at which a cascade also gets the screen-level vignette pulse. */
const CHAIN_FLASH_MIN = 4;

/** Team Battle pairs teammates into related emissions — cool side vs warm side
 *  — so you can read which half of the board is yours without counting names. */
const TEAM_COLOR_INDICES = [
  [0, 5],
  [1, 7],
];
const TEAM_NAMES = ['Team A', 'Team B'];

/** In Survival the human always holds seat 0 and the system holds seat 1. */
const AI_PLAYER_ID = 1;

/** Attract mode: two seats, because §18 asks for one or two controlled energy
 *  accents and rules out a rainbow. Slow enough to read as atmosphere rather
 *  than a demo running at speed. */
const ATTRACT_MOVE_MS = 620;
const ATTRACT_RESTART_MS = 2200;
/** How hard the attract seats play. Well short of 1: a perfect game is a
 *  cagey one, and the title screen wants cascades. */
const ATTRACT_SKILL = 0.55;
/** Pause between pops on the finished board under the result card. */
const VICTORY_LAP_MS = 1150;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const systemReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The effective setting: the player's choice where they made one, the
 *  operating system's where they left it on auto. */
const reducedMotion = () =>
  motionPref === 'reduced' || (motionPref === 'auto' && systemReducedMotion());

let numPlayers = 2;
let boardSizeKey: BoardSizeKey = 'medium';
let orbStyle: OrbStyle = 'dots';
let modeKey: GameModeKey = DEFAULT_MODE;
let engine: GameEngine | null = null;
let renderer: ThreeRenderer | null = null;
let animating = false;
let muted = false;
let motionPref: MotionPref = 'auto';
// Bumped whenever the current game is torn down (leaving to the menu,
// starting a new game). A cascade's explode sound is scheduled via
// setTimeout to land on the real blast moment, which can still be pending
// after the player has already navigated away — capturing the generation at
// schedule time and checking it when the timeout fires stops that stale
// sound from playing over whatever screen is showing now. The AI's think
// delay and the Blitz clock are gated on it for the same reason.
let soundGeneration = 0;

// ---------- Per-match telemetry (feeds the result card and local stats) ----------
let matchTurns = 0;
/** Wall-clock start of the mounted match, for the session/completion metrics
 *  §14 asks for. Zero between matches. */
let matchStartedAt = 0;
let matchBestChain = 0;
let matchBestCapture = 0;

// ---------- Series / run state ----------
/** Games won per player id in a Tournament series. */
let seriesScore = new Map<number, number>();
let seriesGame = 1;
let survivalRound = 1;

// ---------- Online state ----------
let net: NetClient | null = null;
let onlineMode = false;
let myPlayerId = -1;
let lobbyBoardSize: BoardSizeKey = 'medium';
let lobbyOrbStyle: OrbStyle = 'dots';
let lobbyMode: GameModeKey = DEFAULT_MODE;
let intentionalDisconnect = false;
/** True between asking for a quick match and that match starting. The host's
 *  client kicks the game off automatically once the room fills, so neither
 *  side has to find and press Start. */
let quickMatchPending = false;

function disconnectNet() {
  intentionalDisconnect = true;
  net?.disconnect();
  net = null;
  hideLobbyStatus();
}

// ---------- DOM refs ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const screenMenu = $('screen-menu');
const screenGame = $('screen-game');
const screenWin = $('screen-win');
const screenHowto = $('screen-howto');
const screenOnline = $('screen-online');
const screenLobby = $('screen-lobby');
const screenSetup = $('screen-setup');
const screenSettings = $('screen-settings');
const attractHost = $('attract-host');
const volumeRange = $<HTMLInputElement>('volume-range');
const volumeValueEl = $('volume-value');
const musicRange = $<HTMLInputElement>('music-range');
const musicValueEl = $('music-value');
const hapticsGroup = $('haptics-group');
const hapticsNoteEl = $('haptics-note');
const motionGroup = $('motion-group');
const telemetryGroup = $('telemetry-group');
const telemetryNoteEl = $('telemetry-note');
const ALL_SCREENS = [screenMenu, screenGame, screenOnline, screenLobby];

const playersCountEl = $('players-count');
const playersFieldEl = $('players-field');
const playersNoteEl = $('players-note');
const playerSwatchesEl = $('player-swatches');
const boardSizeGroup = $('board-size-group');
const orbStyleGroup = $('orb-style-group');
const modeGroup = $('mode-group');
const modeBlurbEl = $('mode-blurb');
const modePreviewEl = $('mode-preview');
const modeCaptionEl = $('mode-caption');
const modeLegendEl = $('mode-legend');
const profileStripEl = $('profile-strip');
const levelChipEl = $('level-chip');
const setupSummaryEl = $('setup-summary');
const playPillsEl = $('player-pills');
const boardHost = $('board-host');
const chainReadoutEl = $('chain-readout');
const boardFlashEl = $('board-flash');
const matchBannerEl = $('match-banner');
const turnClockEl = $('turn-clock');
const turnClockFill = $('turn-clock-fill');
const turnClockValue = $('turn-clock-value');
const tauntBarEl = $('taunt-bar');
const tauntToggleEl = $<HTMLButtonElement>('taunt-toggle');
const tauntPaletteEl = $('taunt-palette');
const tauntFeedEl = $('taunt-feed');
const rematchStateEl = $('rematch-state');
const winCardEl = document.querySelector('.win-card') as HTMLElement;
const winNameEl = $('win-name');
const winVerbEl = $('win-verb');
const winEyebrowEl = screenWin.querySelector('.win-eyebrow') as HTMLElement;
const winMetricsEl = $('win-metrics');
const winLeaderboardEl = $('win-leaderboard');
const playAgainBtn = $('play-again-btn');
const confettiLayer = $('confetti-layer');

const nameInput = $<HTMLInputElement>('name-input');
const joinCodeInput = $<HTMLInputElement>('join-code-input');
const createRoomBtn = $('create-room-btn');
const joinRoomBtn = $('join-room-btn');
const onlineErrorEl = $('online-error');
const quickModeGroup = $('quick-mode-group');
const quickSizeGroup = $('quick-size-group');
const quickMatchBtn = $<HTMLButtonElement>('quick-match-btn');
const quickStatusEl = $('quick-status');
const quickStatusText = $('quick-status-text');
const quickCancelBtn = $('quick-cancel-btn');
const roomsListEl = $('rooms-list');
const roomsRefreshBtn = $('rooms-refresh-btn');
const botsListEl = $('bots-list');
const presenceStripEl = $('presence-strip');
const quickFallbackEl = $('quick-fallback');
const quickFallbackMsg = $('quick-fallback-msg');
const quickFallbackBtn = $<HTMLButtonElement>('quick-fallback-btn');
const lobbyBotOfferEl = $('lobby-bot-offer');
const lobbyBotOfferBtn = $<HTMLButtonElement>('lobby-bot-offer-btn');
const lobbyVisibilityGroup = $('lobby-visibility-group');
const lobbyVisibilityField = $('lobby-visibility-field');
const roomCodeBtn = $('room-code-btn');
const lobbyHintEl = $('lobby-hint');
const lobbyPlayersEl = $('lobby-players');
const lobbyColorPickerEl = $('lobby-color-picker');
const lobbyHostControls = $('lobby-host-controls');
const lobbyBoardSizeGroup = $('lobby-board-size-group');
const lobbyOrbStyleGroup = $('lobby-orb-style-group');
const lobbyModeGroup = $('lobby-mode-group');
const lobbyModeBlurbEl = $('lobby-mode-blurb');
const lobbyStartBtn = $<HTMLButtonElement>('lobby-start-btn');
const lobbyWaitMsg = $('lobby-wait-msg');
const connStatusEl = $('conn-status');

// Before a game exists (menu swatches, lobby color picker) this is a plain index
// lookup. Once `engine` exists, it reflects that player's *actual* assigned
// color — which, in online play, may differ from their id if they picked one.
function colorOf(playerId: number) {
  const p = engine?.players.find((pl) => pl.id === playerId);
  if (p) {
    const match = PLAYER_THEMES.find((t) => t.base === p.color);
    if (match) return match;
  }
  return PLAYER_THEMES[playerId % PLAYER_THEMES.length];
}

/** Which palette entry a given seat gets before a game exists. Team modes
 *  override the usual one-colour-per-seat mapping so sides stay readable. */
function themeForSeat(seat: number, mode = modeKey) {
  if (GAME_MODES[mode].teams) {
    const team = seat % 2;
    const slot = Math.floor(seat / 2) % TEAM_COLOR_INDICES[team].length;
    return PLAYER_THEMES[TEAM_COLOR_INDICES[team][slot]];
  }
  return PLAYER_THEMES[seat % PLAYER_THEMES.length];
}

/** The seat whose results count towards this device's record. Online that's
 *  the socket's own player; in pass-and-play there is no "you", so the first
 *  seat stands in for the device owner. */
function localSeatId(): number {
  return onlineMode ? myPlayerId : 0;
}

// ---------- Menu setup ----------
function renderSwatches() {
  const mode = GAME_MODES[modeKey];
  playerSwatchesEl.innerHTML = '';
  for (let i = 0; i < numPlayers; i++) {
    const theme = themeForSeat(i);
    const el = document.createElement('div');
    el.className = 'swatch';
    el.style.background = `radial-gradient(circle at 35% 30%, ${theme.css}, ${theme.css}cc)`;
    el.style.boxShadow = `0 0 12px ${theme.css}66`;
    el.title = mode.teams ? `${theme.name} — ${TEAM_NAMES[i % 2]}` : theme.name;
    el.textContent = mode.solo ? (i === 0 ? 'YOU' : 'SYS') : mode.teams ? TEAM_NAMES[i % 2].slice(-1) : `P${i + 1}`;
    playerSwatchesEl.appendChild(el);
  }
}

/** Moves a segmented control's highlight without going through its click
 *  handler — restoring a stored choice is not the player making one, and the
 *  handler would tap a sound and re-persist on every boot. */
function markSegment(group: HTMLElement, key: string, value: string) {
  group.querySelectorAll<HTMLElement>('.segment').forEach((seg) => {
    seg.classList.toggle('active', seg.dataset[key] === value);
  });
}

/** The menu forgot every choice between visits, which is what made defaulting
 *  Play to "whatever you played last" impossible. Returns the stored mode so
 *  init can hand it straight to selectMode. */
function applyStoredPrefs() {
  const stored = prefs.get();
  numPlayers = stored.players;
  boardSizeKey = stored.boardSize;
  orbStyle = stored.orbStyle;
  muted = stored.muted;
  motionPref = stored.motion;
  sfx.muted = muted;
  sfx.volume = stored.volume;
  sfx.musicVolume = stored.music;
  haptics.enabled = stored.haptics;
  markSegment(boardSizeGroup, 'size', boardSizeKey);
  markSegment(orbStyleGroup, 'style', orbStyle);
  renderSettings();
  applyMotionPref();
  sfx.startBed();
  return stored.mode;
}

function persistPrefs() {
  prefs.save({
    mode: modeKey,
    boardSize: boardSizeKey,
    players: numPlayers,
    orbStyle,
    muted,
    volume: sfx.volume,
    music: sfx.musicVolume,
    haptics: haptics.enabled,
    motion: motionPref,
  });
}

// ---------- Settings ----------
function renderSettings() {
  volumeRange.value = String(Math.round(sfx.volume * 100));
  volumeValueEl.textContent = `${Math.round(sfx.volume * 100)}%`;
  musicRange.value = String(Math.round(sfx.musicVolume * 100));
  musicValueEl.textContent = `${Math.round(sfx.musicVolume * 100)}%`;
  markSegment(hapticsGroup, 'haptics', haptics.enabled ? '1' : '0');
  hapticsNoteEl.classList.toggle('hidden', haptics.available);
  markSegment(telemetryGroup, 'telemetry', telemetry.enabled ? '1' : '0');
  // Saying "on" over a build that collects nothing would be a lie the player
  // has no way to check.
  telemetryNoteEl.textContent = telemetry.configured
    ? 'Counts and durations only — never your name, room codes or board positions.'
    : 'No collection endpoint is configured in this build, so nothing is being sent anywhere.';
}

/** Reduced motion is a class on the document rather than a bare media query,
 *  so the in-app setting and the system one drive exactly the same CSS. */
function applyMotionPref() {
  const reduced = reducedMotion();
  document.documentElement.classList.toggle('reduce-motion', reduced);
  // On auto, show which way the system resolved it rather than leaving both
  // segments dark and the player guessing.
  markSegment(motionGroup, 'motion', reduced ? 'reduced' : 'full');
  if (reduced) stopAttract();
  else if (!screenMenu.classList.contains('hidden')) void startAttract();
}

volumeRange.addEventListener('input', () => {
  sfx.unlock();
  sfx.volume = Number(volumeRange.value) / 100;
  volumeValueEl.textContent = `${volumeRange.value}%`;
  persistPrefs();
});

// Not on 'input': a tap per slider step would machine-gun the effect.
volumeRange.addEventListener('change', () => sfx.buttonTap());

musicRange.addEventListener('input', () => {
  sfx.unlock();
  sfx.musicVolume = Number(musicRange.value) / 100;
  musicValueEl.textContent = `${musicRange.value}%`;
  persistPrefs();
});

/** The one line on the title screen that says what Play will actually start. */
function renderSetupSummary() {
  const mode = GAME_MODES[modeKey];
  const size = BOARD_SIZES[boardSizeKey];
  const seats = mode.solo ? 'solo' : mode.teams ? '2v2' : `${numPlayers} players`;
  setupSummaryEl.textContent = `${mode.name} · ${size.rows}×${size.cols} · ${seats}`;
}

function renderProfileStrip() {
  const s = stats.get();
  levelChipEl.innerHTML = `<span class="lv">${stats.level(s)}</span>level`;
  const cells: [string, string, boolean][] = [
    [String(stats.level(s)), 'level', true],
    [String(s.matches), 'runs', false],
    [String(s.wins), 'wins', false],
    [s.bestChain > 0 ? `×${s.bestChain}` : '—', 'best chain', true],
  ];
  profileStripEl.innerHTML = cells
    .map(
      ([value, key, accent]) =>
        `<div class="profile-cell${accent ? ' is-accent' : ''}"><span class="pv">${value}</span><span class="pk">${key}</span></div>`
    )
    .join('');
}

/** Builds one of the two mode pickers. `onlineOnly` hides modes the relay
 *  can't referee rather than letting the host pick something that will be
 *  rejected. */
function renderModeGrid(host: HTMLElement, selected: GameModeKey, onlineOnly: boolean, pick: (m: GameModeKey) => void) {
  host.innerHTML = '';
  for (const key of MODE_ORDER) {
    const mode = GAME_MODES[key];
    if (onlineOnly && !mode.online) continue;
    const btn = document.createElement('button');
    btn.className = 'mode-chip' + (key === selected ? ' active' : '');
    btn.dataset.mode = key;
    btn.textContent = mode.name;
    if (!onlineOnly && !mode.online) {
      const tag = document.createElement('span');
      tag.className = 'local-tag';
      tag.textContent = 'local';
      btn.appendChild(tag);
    }
    btn.addEventListener('click', () => {
      sfx.unlock();
      sfx.buttonTap();
      pick(key);
    });
    host.appendChild(btn);
  }
}

function selectMode(key: GameModeKey) {
  modeKey = key;
  const mode = GAME_MODES[key];
  // Modes with a fixed roster (2v2, one-v-system) own the player count.
  if (mode.fixedPlayers !== null) numPlayers = mode.fixedPlayers;
  else numPlayers = Math.min(6, Math.max(2, numPlayers));
  playersCountEl.textContent = String(numPlayers);
  playersFieldEl.classList.toggle('dimmed', mode.fixedPlayers !== null);
  playersNoteEl.classList.toggle('hidden', mode.fixedPlayers === null);
  if (mode.fixedPlayers !== null) {
    playersNoteEl.textContent = mode.solo
      ? 'Survival is you against the system — one seat each.'
      : 'Team Battle is fixed at two against two.';
  }
  modeBlurbEl.textContent = mode.blurb;
  renderModeGrid(modeGroup, modeKey, false, selectMode);
  renderSwatches();
  renderModePreview();
  renderSetupSummary();
  persistPrefs();
}

/** Draws the lattice the current mode and board size would actually produce. */
function renderModePreview() {
  const size = BOARD_SIZES[boardSizeKey];
  const { svg, caption, hasSpecials } = modePreview(modeKey, size.rows, size.cols, survivalRound);
  modePreviewEl.innerHTML = svg;
  modeCaptionEl.textContent = caption;
  modeLegendEl.classList.toggle('hidden', !hasSpecials);
}

function selectLobbyMode(key: GameModeKey) {
  lobbyMode = key;
  lobbyModeBlurbEl.textContent = GAME_MODES[key].blurb;
  renderModeGrid(lobbyModeGroup, lobbyMode, true, selectLobbyMode);
  // Tell the relay too, so a public listing advertises the mode people will
  // actually be playing rather than the room's default.
  net?.setLobby({ mode: key });
}

/** Quick match only offers modes the relay can referee — queueing for one it
 *  would reject is a guaranteed dead end. */
function selectQuickMode(key: GameModeKey) {
  quickMode = key;
  renderModeGrid(quickModeGroup, quickMode, true, selectQuickMode);
}

function stepPlayers(delta: number) {
  if (GAME_MODES[modeKey].fixedPlayers !== null) return;
  sfx.unlock();
  sfx.buttonTap();
  numPlayers = Math.min(6, Math.max(2, numPlayers + delta));
  playersCountEl.textContent = String(numPlayers);
  renderSwatches();
  renderSetupSummary();
  persistPrefs();
}

$('players-minus').addEventListener('click', () => stepPlayers(-1));
$('players-plus').addEventListener('click', () => stepPlayers(1));

/** Shared behaviour for every segmented control: highlight the tapped segment
 *  and hand its dataset back to the caller. */
function onSegmentPick(group: HTMLElement, apply: (el: HTMLElement) => void) {
  group.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('.segment');
    if (!target || !group.contains(target)) return;
    sfx.unlock();
    sfx.buttonTap();
    group.querySelectorAll('.segment').forEach((s) => s.classList.remove('active'));
    target.classList.add('active');
    apply(target);
  });
}

onSegmentPick(boardSizeGroup, (el) => {
  boardSizeKey = el.dataset.size as BoardSizeKey;
  // The preview is the real lattice, so it has to follow the board size too.
  renderModePreview();
  renderSetupSummary();
  persistPrefs();
});

onSegmentPick(orbStyleGroup, (el) => {
  orbStyle = el.dataset.style as OrbStyle;
  renderer?.setOrbStyle(orbStyle);
  persistPrefs();
});

onSegmentPick(lobbyBoardSizeGroup, (el) => {
  lobbyBoardSize = el.dataset.size as BoardSizeKey;
  net?.setLobby({ boardSize: lobbyBoardSize });
});

onSegmentPick(lobbyOrbStyleGroup, (el) => {
  lobbyOrbStyle = el.dataset.style as OrbStyle;
});

onSegmentPick(lobbyVisibilityGroup, (el) => {
  net?.setLobby({ isPublic: el.dataset.public === '1' });
});

onSegmentPick(hapticsGroup, (el) => {
  haptics.enabled = el.dataset.haptics === '1';
  if (haptics.enabled) haptics.place();
  persistPrefs();
});

onSegmentPick(telemetryGroup, (el) => {
  // Kept outside prefs on purpose: a consent choice should not be reset by
  // anything that resets game settings.
  telemetry.enabled = el.dataset.telemetry === '1';
});

onSegmentPick(motionGroup, (el) => {
  motionPref = el.dataset.motion === 'reduced' ? 'reduced' : 'full';
  applyMotionPref();
  persistPrefs();
});

// ---------- How to play ----------
/* One idea per page rather than four rules in a list. The last page starts a
 * game rather than returning to the title screen: someone who has just read
 * how to play wants to play, and making them find Play again is a step that
 * exists only because the overlay was built as a document. */
const howtoPages = Array.from(document.querySelectorAll<HTMLElement>('.howto-page'));
const howtoStepEl = $('howto-step');
const howtoDotsEl = $('howto-dots');
const howtoPrevBtn = $<HTMLButtonElement>('howto-prev');
const howtoNextBtn = $<HTMLButtonElement>('howto-next');
let howtoPage = 0;

for (let i = 0; i < howtoPages.length; i++) {
  const dot = document.createElement('button');
  dot.className = 'howto-dot';
  dot.setAttribute('aria-label', `Page ${i + 1}`);
  dot.addEventListener('click', () => {
    sfx.buttonTap();
    showHowtoPage(i);
  });
  howtoDotsEl.appendChild(dot);
}

function showHowtoPage(index: number) {
  howtoPage = Math.min(howtoPages.length - 1, Math.max(0, index));
  howtoPages.forEach((page, i) => page.classList.toggle('on', i === howtoPage));
  howtoDotsEl.querySelectorAll('.howto-dot').forEach((dot, i) => {
    dot.classList.toggle('on', i === howtoPage);
  });
  howtoStepEl.textContent = `${howtoPage + 1} / ${howtoPages.length}`;
  howtoPrevBtn.toggleAttribute('disabled', howtoPage === 0);
  howtoNextBtn.textContent = howtoPage === howtoPages.length - 1 ? 'Start playing' : 'Next';
}

$('howto-btn').addEventListener('click', () => {
  sfx.unlock();
  sfx.buttonTap();
  showHowtoPage(0);
  showOverlay(screenHowto);
});

howtoPrevBtn.addEventListener('click', () => {
  sfx.buttonTap();
  showHowtoPage(howtoPage - 1);
});

howtoNextBtn.addEventListener('click', () => {
  sfx.buttonTap();
  if (howtoPage < howtoPages.length - 1) {
    showHowtoPage(howtoPage + 1);
    return;
  }
  hideOverlay(screenHowto);
  startLocalRun();
});

$('howto-close-btn').addEventListener('click', () => {
  sfx.buttonTap();
  hideOverlay(screenHowto);
});

// Arrow keys page it, for anyone reading this on a keyboard.
window.addEventListener('keydown', (e) => {
  if (screenHowto.classList.contains('hidden')) return;
  if (e.key === 'ArrowRight') showHowtoPage(howtoPage + 1);
  else if (e.key === 'ArrowLeft') showHowtoPage(howtoPage - 1);
  else if (e.key === 'Escape') hideOverlay(screenHowto);
});

function updateMuteIcon() {
  const icon = muted ? '🔇' : '🔊';
  $('mute-btn-menu').textContent = icon;
  $('mute-btn-game').textContent = icon;
}
function toggleMute() {
  muted = !muted;
  sfx.muted = muted;
  updateMuteIcon();
  persistPrefs();
}

// A system-level motion change while the game is open should still be picked
// up — but only while the player is on auto, or their own choice is not a
// choice at all.
if (typeof matchMedia === 'function') {
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => {
    if (motionPref === 'auto') applyMotionPref();
  });
}
$('mute-btn-menu').addEventListener('click', toggleMute);
$('mute-btn-game').addEventListener('click', toggleMute);

$('back-btn').addEventListener('click', () => {
  sfx.buttonTap();
  if (onlineMode) leaveOnlineGame();
  leaveGameScreen();
  showScreen(screenMenu);
});

playAgainBtn.addEventListener('click', () => {
  sfx.buttonTap();
  if (onlineMode) {
    // A vote, not a command. The card stays up showing who else has agreed,
    // and the relay starts the next game once everyone has — going back to the
    // lobby in between is what made a rematch feel like starting over.
    net?.rematch();
    playAgainBtn.textContent = 'Waiting…';
    playAgainBtn.toggleAttribute('disabled', true);
    return;
  }
  hideOverlay(screenWin);
  // A rematch against a bot is another game against *that* bot — falling
  // through to startLocalGame would silently turn it into pass-and-play.
  if (activeBot) {
    void startBotMatch(activeBot);
    return;
  }
  const mode = GAME_MODES[modeKey];
  if (mode.seriesLength > 1 && !seriesDecided()) seriesGame++;
  else if (mode.seriesLength > 1) resetSeries();
  void startLocalGame();
});

$('win-menu-btn').addEventListener('click', () => {
  sfx.buttonTap();
  hideOverlay(screenWin);
  if (onlineMode) leaveOnlineGame();
  leaveGameScreen();
  resetSeries();
  showScreen(screenMenu);
});

/** Play, from the title screen or from the bottom of the setup sheet. */
function startLocalRun() {
  sfx.unlock();
  sfx.buttonTap();
  if (net) disconnectNet();
  onlineMode = false;
  resetSeries();
  void startLocalGame();
  showScreen(screenGame);
}

$('play-btn').addEventListener('click', startLocalRun);
$('setup-start-btn').addEventListener('click', startLocalRun);

$('setup-btn').addEventListener('click', () => {
  sfx.unlock();
  sfx.buttonTap();
  showOverlay(screenSetup);
});

$('setup-close-btn').addEventListener('click', () => {
  sfx.buttonTap();
  hideOverlay(screenSetup);
});

$('settings-btn').addEventListener('click', () => {
  sfx.unlock();
  sfx.buttonTap();
  renderSettings();
  showOverlay(screenSettings);
});

$('settings-close-btn').addEventListener('click', () => {
  sfx.buttonTap();
  hideOverlay(screenSettings);
});

function showScreen(el: HTMLElement) {
  const from = ALL_SCREENS.find((s) => !s.classList.contains('hidden')) ?? null;
  ALL_SCREENS.forEach((s) => s.classList.add('hidden'));
  // The result card sits over the finished board with pointer-events:none, so
  // the HUD's back button stays clickable underneath it. Clearing it on every
  // screen change stops it being left floating over the menu.
  hideOverlay(screenWin);
  hideOverlay(screenSetup);
  hideOverlay(screenSettings);
  el.classList.remove('hidden');
  // The bed sits forward everywhere except over a live board, where the
  // effects need the room.
  sfx.setBedMood(el === screenGame ? 'match' : 'menu');
  if (el === screenMenu) {
    renderProfileStrip();
    renderSetupSummary();
    void startAttract();
  } else {
    stopAttract();
  }
  syncBenchGrid();
  if (from !== el) playScreenIn(el);
}

/** The page's measurement grid is the bench the UI sits on — but only while
 *  there is no board on screen. A board draws its own lattice, and the two
 *  grids do not line up, which reads as a rendering fault rather than as
 *  texture. Applies equally to the attract match behind the title screen. */
function syncBenchGrid() {
  const boardOnScreen = !screenGame.classList.contains('hidden') || attractRenderer !== null;
  document.body.classList.toggle('board-showing', boardOnScreen);
}

/** Screens used to swap by toggling display, which is instant in the wrong
 *  way — nothing carries across the cut. A short fade and rise is enough for
 *  one screen to read as handing over to the next. Done with a class rather
 *  than GSAP so the menu keeps loading without the animation library. */
function playScreenIn(el: HTMLElement) {
  el.classList.remove('screen-in');
  void el.offsetWidth; // restart the animation even on a repeated target
  el.classList.add('screen-in');
}
function showOverlay(el: HTMLElement) {
  el.classList.remove('hidden');
}
function hideOverlay(el: HTMLElement) {
  el.classList.add('hidden');
}

// ---------- Attract mode ----------
/** The title screen runs a real match behind it: a live GameEngine, two AI
 *  seats and the same renderer the game uses. Three things at once — it is the
 *  brief's motion language (§18) where the menu had none, it shows a
 *  first-time player the mechanic before they have read a word, and because it
 *  pulls in the renderer chunk while they are still looking at the menu, the
 *  first Start no longer waits on a 600 KB download behind an empty screen. */
let attractEngine: GameEngine | null = null;
let attractRenderer: ThreeRenderer | null = null;
/** Bumped on every stop, so an attract loop or a pending chunk load can tell
 *  that the player has moved on and bail rather than mounting over them. */
let attractToken = 0;

function newAttractEngine(): GameEngine {
  const size = BOARD_SIZES.medium;
  const players: PlayerConfig[] = [0, 1].map((i) => ({
    id: i,
    name: PLAYER_THEMES[i].name,
    color: PLAYER_THEMES[i].base,
    colorLight: PLAYER_THEMES[i].light,
    isAlive: true,
  }));
  return new GameEngine({ rows: size.rows, cols: size.cols, players });
}

async function startAttract() {
  if (attractRenderer || renderer || reducedMotion()) return;
  const token = ++attractToken;
  const { ThreeRenderer: Renderer } = await import('./render3d/ThreeRenderer');
  if (token !== attractToken) return;
  attractEngine = newAttractEngine();
  const board = new Renderer(attractEngine, colorOf, 'dots');
  await board.init(attractHost);
  if (token !== attractToken) {
    board.destroy();
    return;
  }
  attractRenderer = board;
  board.resetVisual();
  board.setTurnColor(PLAYER_THEMES[0].base, true);
  attractHost.classList.remove('hidden');
  syncBenchGrid();
  // Next frame, so the opacity transition has a start value to run from.
  requestAnimationFrame(() => attractHost.classList.add('live'));
  void runAttract(token);
}

function stopAttract() {
  attractToken++;
  attractHost.classList.remove('live');
  attractHost.classList.add('hidden');
  attractRenderer?.destroy();
  attractRenderer = null;
  attractEngine = null;
  attractHost.querySelectorAll('canvas').forEach((c) => c.remove());
  syncBenchGrid();
}

async function runAttract(token: number) {
  while (token === attractToken && attractRenderer && attractEngine) {
    await wait(ATTRACT_MOVE_MS);
    if (token !== attractToken) return;
    // A hidden tab throttles requestAnimationFrame, so the renderer's
    // animations would never settle and every queued move would pile up
    // behind them. Wait it out instead.
    if (document.hidden) continue;
    const board = attractRenderer;
    const game = attractEngine;
    if (!board || !game) return;

    if (game.gameOver) {
      await wait(ATTRACT_RESTART_MS);
      if (token !== attractToken || !attractRenderer || !attractEngine) return;
      // Reload rather than rebuild: the renderer holds this engine object, and
      // swapping it would mean tearing down a WebGL context every match.
      attractEngine.loadSnapshot(newAttractEngine().getSnapshot());
      attractRenderer.resetVisual();
      attractRenderer.setTurnColor(PLAYER_THEMES[0].base, true);
      continue;
    }

    const move = chooseMove(game, game.currentPlayer().id, ATTRACT_SKILL);
    if (!move) return;
    const result = game.applyMove(move.row, move.col);
    await board.playEvents(result.events).catch(() => {});
    if (token !== attractToken || !attractRenderer) return;
    if (!game.gameOver) attractRenderer.setTurnColor(colorOf(game.currentPlayer().id).base);
  }
}

// ---------- Series / run bookkeeping ----------
function resetSeries() {
  seriesScore = new Map();
  seriesGame = 1;
  survivalRound = 1;
}

/** Games needed to take a best-of-N. */
function seriesTarget(): number {
  return Math.ceil(GAME_MODES[modeKey].seriesLength / 2);
}

function seriesDecided(): boolean {
  if (GAME_MODES[modeKey].seriesLength <= 1) return true;
  for (const wins of seriesScore.values()) if (wins >= seriesTarget()) return true;
  return false;
}

function renderMatchBanner() {
  const mode = GAME_MODES[modeKey];
  const parts: string[] = [];

  if (!onlineMode && mode.seriesLength > 1) {
    const line = engine
      ? engine.players.map((p) => `<span class="bv">${seriesScore.get(p.id) ?? 0}</span>`).join('–')
      : '';
    parts.push(`game <span class="bv">${seriesGame}</span>/${mode.seriesLength}`, line);
  }
  if (!onlineMode && mode.solo) {
    parts.push(
      `round <span class="bv">${survivalRound}</span>`,
      `system <span class="bv">${Math.round(skillForRound(survivalRound) * 100)}%</span>`
    );
  }
  if (engine?.isTeamGame) parts.push(`${TEAM_NAMES[0]} <span class="sep">vs</span> ${TEAM_NAMES[1]}`);

  // Never left implicit: you should always be able to see that the opponent is
  // a bot without having to remember how the match started.
  if (activeBot) {
    parts.push(`vs <span class="bv">${escapeHtml(activeBot.name)}</span> · bot · unranked`);
  }

  // Head-to-head across rematches in this room, kept by the relay.
  if (onlineMode && engine && roomScore.size > 0) {
    const line = engine.players.map((p) => `<span class="bv">${roomScore.get(p.id) ?? 0}</span>`).join('–');
    parts.push(`series ${line}`);
  }

  // Turn order is authoritative on the relay, so a dropped player's turn just
  // stops the match rather than skipping. Say whose turn everyone is waiting
  // on, otherwise the board looks frozen for no reason.
  if (engine && !engine.gameOver && isOffline(engine.currentPlayer().id)) {
    parts.push(`<span class="bv">waiting for ${escapeHtml(engine.currentPlayer().name)}</span>`);
  }

  matchBannerEl.classList.toggle('hidden', parts.length === 0);
  matchBannerEl.innerHTML = parts.join(' <span class="sep">·</span> ');
}

/** Pushes the current turn onto the board itself. Once a match is over the
 *  board holds the winner's colour rather than reverting — the finished board
 *  is the result, and blanking it would take that away. */
function syncBoardTurnColor(immediate = false) {
  if (!engine || !renderer) return;
  const owner = engine.gameOver && engine.winner !== null ? engine.winner : engine.currentPlayer().id;
  renderer.setTurnColor(colorOf(owner).base, immediate);
}

// ---------- HUD ----------
function renderPills() {
  if (!engine) return;
  const teamGame = engine.isTeamGame;
  playPillsEl.innerHTML = '';
  engine.players.forEach((p) => {
    const theme = colorOf(p.id);
    const pill = document.createElement('div');
    pill.className = 'pill';
    if (p.id === engine!.currentPlayer().id && !engine!.gameOver) pill.classList.add('active');
    if (!p.isAlive) pill.classList.add('eliminated');
    if (isOffline(p.id)) pill.classList.add('offline');
    const orbCount = countOrbs(p.id);
    const youTag = onlineMode && p.id === myPlayerId ? ' · you' : '';
    const teamTag = teamGame ? `<span class="pteam">${TEAM_NAMES[p.team ?? 0].slice(-1)}</span>` : '';
    pill.innerHTML =
      `<span class="dot" style="background:${theme.css};box-shadow:0 0 7px ${theme.css}"></span>` +
      `<span class="pname">${escapeHtml(p.name)}${youTag}</span>${teamTag}` +
      `<span class="pscore">${orbCount}</span>`;
    if (pill.classList.contains('active')) {
      pill.style.borderColor = theme.css;
      pill.style.boxShadow = `0 0 0 1px ${theme.css}44`;
    }
    playPillsEl.appendChild(pill);
  });
}

/** Whether an online player is currently dropped. Their seat is held and they
 *  may well be reconnecting, so the board marks them rather than removing them. */
function isOffline(playerId: number): boolean {
  if (!onlineMode || !net) return false;
  const entry = net.players.find((p) => p.id === playerId);
  return !!entry && !entry.connected;
}

/** Player names come off the wire in online play, so they can't go into
 *  innerHTML raw. */
function escapeHtml(value: string): string {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

function countOrbs(playerId: number): number {
  if (!engine) return 0;
  let total = 0;
  for (const row of engine.grid) {
    for (const cell of row) {
      if (cell.owner === playerId) total += cell.orbs;
    }
  }
  return total;
}

// ---------- Chain counter & screen feedback ----------
let chainHideTimer: ReturnType<typeof setTimeout> | null = null;

function showChain(depth: number, playerId: number) {
  if (depth < CHAIN_CALLOUT_MIN) return;
  const theme = colorOf(playerId);
  chainReadoutEl.innerHTML = `<span class="cv">×${depth}</span><span class="ck">chain</span>`;
  chainReadoutEl.style.borderColor = `${theme.css}66`;
  (chainReadoutEl.querySelector('.cv') as HTMLElement).style.color = theme.css;
  chainReadoutEl.classList.remove('show');
  void chainReadoutEl.offsetWidth; // restart the pop animation on each new wave
  chainReadoutEl.classList.add('show');
  sfx.chainTick(depth);

  if (depth >= CHAIN_FLASH_MIN) {
    boardFlashEl.style.color = theme.css;
    boardFlashEl.classList.remove('pulse');
    void boardFlashEl.offsetWidth;
    boardFlashEl.classList.add('pulse');
  }

  if (chainHideTimer) clearTimeout(chainHideTimer);
  chainHideTimer = setTimeout(() => chainReadoutEl.classList.remove('show'), 1100);
}

function hideChain() {
  if (chainHideTimer) clearTimeout(chainHideTimer);
  chainReadoutEl.classList.remove('show');
  boardFlashEl.classList.remove('pulse');
}

// ---------- Taunts ----------
/** Room head-to-head, kept by the relay and pushed down. */
let roomScore = new Map<number, number>();
let lastTauntAt = 0;

function buildTauntPalette() {
  tauntPaletteEl.innerHTML = '';
  TAUNTS.forEach((t, i) => {
    const btn = document.createElement('button');
    btn.textContent = t.emoji;
    btn.title = t.label;
    btn.setAttribute('aria-label', t.label);
    btn.addEventListener('click', () => sendTaunt(i));
    tauntPaletteEl.appendChild(btn);
  });
}

function setTauntPaletteOpen(open: boolean) {
  tauntPaletteEl.classList.toggle('hidden', !open);
  tauntToggleEl.setAttribute('aria-expanded', String(open));
}

function sendTaunt(index: number) {
  if (!net || !onlineMode) return;
  const now = performance.now();
  // Mirrors the relay's cooldown so the button visibly goes dead rather than
  // the taunt vanishing silently — the relay is still the one enforcing it.
  if (now - lastTauntAt < TAUNT_COOLDOWN_MS) return;
  if (!net.sendTaunt(index)) return;
  lastTauntAt = now;
  sfx.buttonTap();
  setTauntPaletteOpen(false);
  tauntToggleEl.disabled = true;
  setTimeout(() => {
    tauntToggleEl.disabled = false;
  }, TAUNT_COOLDOWN_MS);
}

function showTaunt(fromPlayerId: number, index: number) {
  const taunt = TAUNTS[index];
  if (!taunt) return;
  const who = engine?.players.find((p) => p.id === fromPlayerId);
  const theme = colorOf(fromPlayerId);
  const bubble = document.createElement('div');
  bubble.className = 'taunt-bubble';
  bubble.style.borderColor = `${theme.css}66`;
  bubble.innerHTML =
    `<span class="te">${taunt.emoji}</span>` +
    `<span class="tn" style="color:${theme.css}">${escapeHtml(who?.name ?? 'Player')}</span>`;
  tauntFeedEl.appendChild(bubble);
  // Keep the stack shallow; a burst of taunts should not cover the board.
  while (tauntFeedEl.childElementCount > 4) tauntFeedEl.firstElementChild?.remove();
  setTimeout(() => bubble.remove(), 2700);
}

tauntToggleEl.addEventListener('click', () => {
  sfx.buttonTap();
  setTauntPaletteOpen(tauntPaletteEl.classList.contains('hidden'));
});

// Tapping the board (or anywhere else) closes the palette.
document.addEventListener('pointerdown', (e) => {
  if (tauntPaletteEl.classList.contains('hidden')) return;
  if (tauntBarEl.contains(e.target as Node)) return;
  setTauntPaletteOpen(false);
});

function renderRematchState(votes: number[], needed: number) {
  if (!onlineMode || !engine?.gameOver || needed < 2) {
    rematchStateEl.classList.add('hidden');
    return;
  }
  rematchStateEl.classList.remove('hidden');
  const mine = votes.includes(myPlayerId);
  rematchStateEl.textContent = mine
    ? `waiting for opponents · ${votes.length}/${needed} ready`
    : `${votes.length}/${needed} want a rematch`;
}

// ---------- Blitz turn clock ----------
let clockRaf = 0;

function stopTurnClock() {
  if (clockRaf) cancelAnimationFrame(clockRaf);
  clockRaf = 0;
  turnClockEl.classList.add('hidden');
  turnClockEl.classList.remove('urgent');
}

/** Blitz is local-only for now: an online turn clock has to be enforced by the
 *  relay to stay server-authoritative, and running it client-side would hand
 *  every client its own idea of when a turn expired. */
/** The local clock. Online, the relay keeps time instead — see
 *  runTurnClock's `autoPlay` argument and net.onTurnClock below. */
function startTurnClock() {
  const seconds = GAME_MODES[modeKey].turnSeconds;
  stopTurnClock();
  if (!seconds || onlineMode || !engine || engine.gameOver) return;
  runTurnClock(seconds * 1000, true);
}

/**
 * Runs the visible countdown.
 *
 * `autoPlay` is what separates the two modes of this clock. Locally there is
 * nobody else to enforce it, so expiry plays the move. Online the relay owns
 * the deadline — it has to, or every client gets its own idea of when a turn
 * expired and the one with the slowest connection always loses the argument —
 * so expiry here just stops the counter and waits for the move to arrive.
 */
function runTurnClock(totalMs: number, autoPlay: boolean) {
  stopTurnClock();
  if (!engine || engine.gameOver) return;

  const deadline = performance.now() + totalMs;
  const generation = soundGeneration;
  let lastWholeSecond = -1;
  turnClockEl.classList.remove('hidden');

  const step = () => {
    if (generation !== soundGeneration || !engine || engine.gameOver) {
      stopTurnClock();
      return;
    }
    const left = Math.max(0, deadline - performance.now());
    turnClockFill.style.transform = `scaleX(${left / totalMs})`;
    turnClockValue.textContent = (left / 1000).toFixed(1);

    const urgent = left <= 3000;
    turnClockEl.classList.toggle('urgent', urgent);
    const whole = Math.ceil(left / 1000);
    if (urgent && whole > 0 && whole !== lastWholeSecond) {
      lastWholeSecond = whole;
      sfx.clockTick(whole <= 1);
    }

    if (left <= 0) {
      if (autoPlay) {
        stopTurnClock();
        void autoPlayTurn();
      } else {
        // Leave the readout sitting at zero: the relay's move is already on
        // its way, and hiding the clock first would look like the turn was
        // skipped rather than played.
        cancelAnimationFrame(clockRaf);
        turnClockValue.textContent = '0.0';
      }
      return;
    }
    clockRaf = requestAnimationFrame(step);
  };
  clockRaf = requestAnimationFrame(step);
}

/** Timeout plays a move rather than skipping the turn. Skipping would let a
 *  player who has never placed a particle sit un-eliminable forever, which
 *  stalls the win condition instead of resolving the match. */
async function autoPlayTurn() {
  if (!engine || !renderer || animating || engine.gameOver) return;
  const moves = engine.legalMoves();
  if (!moves.length) return;
  const pick = moves[Math.floor(Math.random() * moves.length)];
  animating = true;
  await applyAndAnimateMove(pick.row, pick.col);
}

/** Drives the AI seat, for both Survival and a match against the bot roster.
 *  The delay is deliberate: an instant reply reads as the board glitching
 *  rather than as an opponent taking their turn. */
function maybeRunAiTurn() {
  if (onlineMode) return;
  if (!activeBot && !GAME_MODES[modeKey].solo) return;
  if (!engine || renderer === null || engine.gameOver || animating) return;
  if (engine.currentPlayer().id !== AI_PLAYER_ID) return;

  const skill = activeBot ? activeBot.skill : skillForRound(survivalRound);
  // A roster bot varies its pace; Survival's system is steady, which suits
  // something that is meant to feel like a mechanism rather than a person.
  const think = activeBot
    ? activeBot.thinkMs[0] + Math.random() * (activeBot.thinkMs[1] - activeBot.thinkMs[0])
    : 420;

  const generation = soundGeneration;
  animating = true;
  setTimeout(() => {
    if (generation !== soundGeneration || !engine || engine.gameOver) {
      animating = false;
      return;
    }
    const move = chooseMove(engine, AI_PLAYER_ID, skill);
    if (!move) {
      animating = false;
      return;
    }
    void applyAndAnimateMove(move.row, move.col);
  }, think);
}

// ---------- Local game lifecycle ----------
function buildLocalPlayers(): PlayerConfig[] {
  const mode = GAME_MODES[modeKey];
  const players: PlayerConfig[] = [];
  for (let i = 0; i < numPlayers; i++) {
    const theme = themeForSeat(i);
    const name = mode.solo ? (i === 0 ? 'You' : 'System') : `Player ${i + 1}`;
    players.push({
      id: i,
      name,
      color: theme.base,
      colorLight: theme.light,
      isAlive: true,
      ...(mode.teams ? { team: i % 2 } : {}),
    });
  }
  return players;
}

async function startLocalGame() {
  // A pass-and-play game has no bot opponent, whatever the last match was.
  activeBot = null;
  const size = BOARD_SIZES[boardSizeKey];
  // A fresh seed per game, so Chaos re-rolls and a Tournament plays every game
  // on a different lattice. Power Cells ignores it by design.
  const seed = randomSeed();
  const newEngine = new GameEngine({
    rows: size.rows,
    cols: size.cols,
    players: buildLocalPlayers(),
    kinds: layoutForMode(modeKey, size.rows, size.cols, seed, survivalRound),
  });
  if (!(await mountGame(newEngine, orbStyle))) return;
  renderer!.setCellTapHandler(onCellTapLocal);
  renderMatchBanner();
  startTurnClock();
  maybeRunAiTurn();
}

/** Tears down whatever game is currently mounted — stops the renderer's
 *  animation loop and invalidates any sound still pending from it. Call this
 *  any time the player leaves the game screen without starting a new game
 *  (starting one already tears down the old game via mountGame below). */
function leaveGameScreen() {
  // A match left part-way is exactly what "match completion" in §14 measures
  // against, so it has to be reported as loudly as a finished one.
  if (matchStartedAt && engine && !engine.gameOver) {
    telemetry.event('match_abandoned', {
      mode: modeKey,
      online: onlineMode,
      seconds: Math.round((Date.now() - matchStartedAt) / 1000),
      turns: matchTurns,
    });
  }
  matchStartedAt = 0;
  soundGeneration++;
  stopTurnClock();
  hideChain();
  matchBannerEl.classList.add('hidden');
  tauntBarEl.classList.add('hidden');
  setTauntPaletteOpen(false);
  tauntFeedEl.innerHTML = '';
  rematchStateEl.classList.add('hidden');
  if (renderer) {
    renderer.destroy();
    renderer = null;
  }
  engine = null;
  animating = false;
}

/** Returns false if the player left before the renderer chunk finished
 *  loading, in which case nothing was mounted and the caller should stop. */
async function mountGame(
  newEngine: GameEngine,
  style: OrbStyle,
  opts: { fromSnapshot?: boolean } = {}
): Promise<boolean> {
  soundGeneration++;
  // Two WebGL contexts for one board is one too many, and the attract match
  // has no reason to keep running once a real one is starting.
  stopAttract();
  stopTurnClock();
  hideChain();
  // Hidden on every mount; the online paths turn it back on via
  // enterOnlineMatchUi. Doing it here means a local game can never inherit it
  // from a previous online one, whatever route the player took.
  tauntBarEl.classList.add('hidden');
  setTauntPaletteOpen(false);
  tauntFeedEl.innerHTML = '';
  if (renderer) {
    renderer.destroy();
    renderer = null;
  }
  // Keep the overlay children — only the canvas from the previous game goes.
  boardHost.querySelectorAll('canvas').forEach((c) => c.remove());
  engine = newEngine;
  matchTurns = 0;
  matchBestChain = 0;
  matchBestCapture = 0;
  const { ThreeRenderer: Renderer } = await import('./render3d/ThreeRenderer');
  // Awaiting the chunk gives the player time to hit Back — bail rather than
  // mounting a board over whatever screen they moved on to.
  if (engine !== newEngine) return false;
  renderer = new Renderer(engine, colorOf, style);
  await renderer.init(boardHost);
  renderer.resetVisual();
  // Keep the tiles-in animation either way, but a resumed match then adopts
  // the live position instead of starting from an empty lattice.
  if (opts.fromSnapshot) renderer.syncToEngine();
  renderPills();
  // Snapped, not eased: there is no previous turn to hand off from.
  syncBoardTurnColor(true);
  animating = false;
  matchStartedAt = Date.now();
  telemetry.event('match_start', {
    mode: modeKey,
    size: boardSizeKey,
    players: newEngine.players.length,
    online: onlineMode,
    // A bot match is neither a human match nor pass-and-play, and lumping it
    // in with either makes mode popularity meaningless.
    opponent: onlineMode ? 'human' : activeBot ? 'bot' : 'local',
    resumed: opts.fromSnapshot === true,
  });

  exposeDebug();
  return true;
}

function exposeDebug() {
  if (import.meta.env.DEV) {
    (window as any).__debug = { engine, renderer, net, sfx, haptics, onCellTapLocal, onCellTapOnline };
  }
}

async function onCellTapLocal(row: number, col: number) {
  if (!engine || !renderer || animating) return;
  if (!engine.canPlay(row, col)) return;
  animating = true;
  sfx.unlock();
  await applyAndAnimateMove(row, col);
}

async function onCellTapOnline(row: number, col: number) {
  if (!engine || !renderer || animating || !net) return;
  if (engine.currentPlayer().id !== myPlayerId) return;
  if (!engine.canPlay(row, col)) return;
  sfx.unlock();
  // The lock is only taken once the move is genuinely on the wire. Taking it
  // first would leave a player who tapped during a blip unable to move at all,
  // even after the connection came back — the move that was supposed to
  // release the lock never reached the relay, so no broadcast ever returns.
  if (net.sendMove(row, col)) animating = true;
}

async function applyAndAnimateMove(row: number, col: number) {
  if (!engine || !renderer) return;
  stopTurnClock();
  const mover = engine.currentPlayer().id;
  const result = engine.applyMove(row, col);
  const myGeneration = soundGeneration;

  matchTurns++;
  matchBestChain = Math.max(matchBestChain, result.chain);
  matchBestCapture = Math.max(matchBestCapture, result.captured);
  if (mover === localSeatId()) stats.recordChain(result.chain, result.captured);

  // The engine resolves the whole cascade synchronously, but the board
  // animates it wave by wave — so "who won" and "what the board visibly
  // shows" can briefly disagree mid-cascade. Reveal the winner at the exact
  // wave where the board actually matches that outcome (the loser's last
  // orb has visibly disappeared), not a frame before and not by waiting for
  // any further self-only cascading the winner's own cells keep doing.
  let winShown = false;
  const showWinIfBoardMatches = () => {
    if (myGeneration !== soundGeneration) return; // player has left this game
    if (winShown || !result.gameOver || result.winner === null || !engine || !renderer) return;
    // In Team Battle the payoff is the losing *side* being gone, so wait for
    // the last orb of the other team rather than of a single player.
    const winningTeam = engine.teamOf(result.winner);
    const stillHasEnemyOrbs = engine.players.some((p) => {
      const opposed = engine!.isTeamGame ? engine!.teamOf(p.id) !== winningTeam : p.id !== result.winner;
      return opposed && renderer!.getPlayerOrbCount(p.id) > 0;
    });
    if (!stillHasEnemyOrbs) {
      winShown = true;
      showWin(result.winner);
    }
  };

  const playPromise = renderer
    .playEvents(
      result.events,
      (ev: MoveEvent) => {
        if (myGeneration !== soundGeneration) return; // player has left this game
        if (ev.type === 'place') {
          sfx.place();
          haptics.place();
        } else if (ev.type === 'explode') {
          // The board visibly winds up (spinning) before it actually blasts —
          // play the charge whir now, but delay the boom/buzz to land on the
          // real blast moment instead of the start of the wind-up. That delay
          // can still be pending after the player has already left this
          // game, so re-check the generation before actually playing it.
          sfx.chargeUp(ev.wave);
          setTimeout(() => {
            if (myGeneration !== soundGeneration) return;
            sfx.explode(1, ev.wave);
            haptics.explode(ev.wave);
          }, EXPLOSION_SPIN_UP_MS);
        }
      },
      (depth) => {
        if (myGeneration !== soundGeneration) return;
        showChain(depth, mover);
        showWinIfBoardMatches();
      }
    )
    .catch((err) => {
      console.error('Board animation error (continuing anyway):', err);
    });

  await playPromise;
  if (myGeneration !== soundGeneration) return; // player has left this game

  // Safety net: if the board somehow never reported a matching state
  // mid-cascade (shouldn't happen for a real win), show it once everything
  // has settled rather than leave the player without a win screen.
  showWinIfBoardMatches();

  for (const ev of result.events) {
    if (ev.type === 'eliminate') {
      sfx.eliminate();
      haptics.eliminate();
    }
  }

  renderPills();
  // Deliberately here and not when the engine advanced the turn: the engine
  // resolves the whole move up front, so tinting then would hand the board to
  // the next player while the current player's cascade was still going off.
  syncBoardTurnColor();

  if (!result.gameOver) {
    sfx.turnChange();
    animating = false;
    startTurnClock();
    maybeRunAiTurn();
  }
}

/** What the result card says depends on whether this ended a game, a series,
 *  or a Survival run. */
function resultPresentation(winnerId: number) {
  const mode = GAME_MODES[modeKey];
  const winnerName = engine!.players.find((p) => p.id === winnerId)!.name;

  if (!onlineMode && mode.solo) {
    const cleared = winnerId !== AI_PLAYER_ID;
    return {
      eyebrow: cleared ? `round ${survivalRound} cleared` : 'run ended',
      name: cleared ? `Round ${survivalRound}` : 'The system',
      verb: cleared ? 'cleared' : `took round ${survivalRound}`,
      action: cleared ? `Round ${survivalRound + 1}` : 'Restart run',
    };
  }

  if (!onlineMode && mode.seriesLength > 1) {
    const score = engine!.players
      .map((p) => seriesScore.get(p.id) ?? 0)
      .join('–');
    if (seriesDecided()) {
      return {
        eyebrow: 'series complete',
        name: winnerName,
        verb: `takes the series ${score}`,
        action: 'New series',
      };
    }
    return {
      eyebrow: `game ${seriesGame} of ${mode.seriesLength} · ${score}`,
      name: winnerName,
      verb: `wins game ${seriesGame}`,
      action: 'Next game',
    };
  }

  if (engine!.isTeamGame) {
    const team = engine!.teamOf(winnerId) ?? 0;
    return { eyebrow: 'reaction complete', name: TEAM_NAMES[team], verb: 'wins', action: 'Run again' };
  }

  return { eyebrow: 'reaction complete', name: winnerName, verb: 'wins', action: 'Run again' };
}

function showWin(winnerId: number) {
  if (!engine) return;
  stopTurnClock();
  hideChain();
  sfx.win();
  haptics.win();
  const theme = colorOf(winnerId);
  // The board settles on the winner at the moment the win is revealed, rather
  // than waiting for the rest of the cascade to finish animating.
  renderer?.setTurnColor(theme.base);

  // Series bookkeeping has to land before the card is composed, so the score
  // it prints includes the game that just finished.
  const mode = GAME_MODES[modeKey];
  if (!onlineMode && mode.seriesLength > 1) {
    seriesScore.set(winnerId, (seriesScore.get(winnerId) ?? 0) + 1);
  }

  const view = resultPresentation(winnerId);
  winEyebrowEl.textContent = view.eyebrow;
  winNameEl.textContent = view.name;
  winVerbEl.textContent = view.verb;
  // One value drives the name, its glow and the rule under the head.
  winCardEl.style.setProperty('--win-color', theme.css);
  winCardEl.style.setProperty('--win-glow', `${theme.css}3d`);
  winCardEl.style.setProperty('--win-line', `${theme.css}40`);
  playAgainBtn.textContent = view.action;

  // A Survival round is one step of a run, not a match in its own right — only
  // record it against the profile when the run actually ends.
  const isSurvivalStep = !onlineMode && mode.solo && winnerId !== AI_PLAYER_ID;
  if (!isSurvivalStep) stats.recordMatch(winnerId === localSeatId());
  if (!onlineMode && mode.solo && winnerId !== AI_PLAYER_ID) survivalRound++;

  const metrics: [string, string][] = [
    [`×${matchBestChain}`, 'top chain'],
    [String(matchTurns), 'turns'],
    [String(matchBestCapture), 'best capture'],
  ];
  winMetricsEl.innerHTML = metrics
    .map(([v, k]) => `<div class="win-metric"><span class="mv">${v}</span><span class="mk">${k}</span></div>`)
    .join('');

  const standings = engine.players
    .map((p) => ({ ...p, orbs: countOrbs(p.id) }))
    .sort((a, b) => (b.id === winnerId ? 1 : 0) - (a.id === winnerId ? 1 : 0) || b.orbs - a.orbs);
  winLeaderboardEl.innerHTML = standings
    .map((p, i) => {
      const t = colorOf(p.id);
      const status = p.isAlive ? `${p.orbs}` : 'out';
      const teamTag = engine!.isTeamGame ? ` <span class="pteam">${TEAM_NAMES[p.team ?? 0].slice(-1)}</span>` : '';
      return `<div class="leaderboard-row${p.id === winnerId ? ' winner' : ''}">
        <span class="rank">${String(i + 1).padStart(2, '0')}</span>
        <span class="dot" style="background:${t.css};box-shadow:0 0 7px ${t.css}"></span>
        <span class="name">${escapeHtml(p.name)}${teamTag}</span>
        <span class="score">${status}</span>
      </div>`;
    })
    .join('');

  // The banner is otherwise only drawn at kick-off, which would leave it
  // showing the pre-game score next to a card announcing the new one.
  renderMatchBanner();

  telemetry.event('match_end', {
    mode: modeKey,
    online: onlineMode,
    seconds: matchStartedAt ? Math.round((Date.now() - matchStartedAt) / 1000) : undefined,
    turns: matchTurns,
    bestChain: matchBestChain,
    won: winnerId === localSeatId(),
  });
  matchStartedAt = 0;

  launchTraces(theme.css);
  const generation = soundGeneration;
  setTimeout(() => {
    if (generation !== soundGeneration) return;
    showOverlay(screenWin);
    void runVictoryLap(winnerId, generation);
  }, 450);
}

/** The board froze the instant the result card appeared, which is the least
 *  celebratory thing a chain-reaction game can do. It keeps reacting instead:
 *  the winner's own cells are pushed over critical, one every second or so,
 *  and allowed to cascade under the card.
 *
 *  It runs on a *copy* of the final position with the game-over flag cleared,
 *  because `canPlay` — correctly — refuses every move once a winner exists.
 *  Every pop is still a real engine move, so the cascade rules stay in one
 *  place, and the live engine keeps the position the match actually ended on
 *  for the result card and the stats to read. */
async function runVictoryLap(winnerId: number, generation: number) {
  if (!engine || reducedMotion()) return;
  const lap = new GameEngine({
    rows: engine.rows,
    cols: engine.cols,
    players: engine.players.map((p) => ({ ...p })),
    kinds: engine.kinds,
  });
  lap.loadSnapshot(engine.getSnapshot());
  const seat = lap.players.findIndex((p) => p.id === winnerId);
  if (seat < 0) return;

  while (generation === soundGeneration) {
    await wait(VICTORY_LAP_MS);
    const board = renderer;
    if (generation !== soundGeneration || !board) return;
    if (document.hidden) continue;

    lap.gameOver = false;
    lap.winner = null;
    lap.currentPlayerIndex = seat;
    const cell = pickVictoryCell(lap, winnerId);
    if (!cell) return;
    await board.playEvents(lap.applyMove(cell.row, cell.col).events).catch(() => {});
  }
}

/** Prefers a cell one particle short of critical, so most placements actually
 *  pop, but not every time — an unbroken string of explosions under the card
 *  reads as a stuck animation rather than a board still alive. */
function pickVictoryCell(lap: GameEngine, winnerId: number) {
  const primed: { row: number; col: number }[] = [];
  const held: { row: number; col: number }[] = [];
  for (let r = 0; r < lap.rows; r++) {
    for (let c = 0; c < lap.cols; c++) {
      const cell = lap.getCell(r, c);
      if (cell.owner !== winnerId || cell.orbs <= 0) continue;
      (cell.orbs >= lap.criticalMass(r, c) - 1 ? primed : held).push({ row: r, col: c });
    }
  }
  const pool = primed.length && (!held.length || Math.random() < 0.7) ? primed : held;
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Thin particle traces settling out of the reaction — the winner's emission
 *  colour plus a little of the rest of the spectrum, not party confetti. */
function launchTraces(winnerCss: string) {
  confettiLayer.innerHTML = '';
  const colors = [winnerCss, winnerCss, winnerCss, ...PLAYER_THEMES.map((t) => t.css)];
  for (let i = 0; i < 56; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.height = `${10 + Math.random() * 26}px`;
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.opacity = String(0.35 + Math.random() * 0.5);
    piece.style.animationDuration = `${1.6 + Math.random() * 1.8}s`;
    piece.style.animationDelay = `${Math.random() * 0.7}s`;
    confettiLayer.appendChild(piece);
  }
}

// ---------- Online: create / join ----------
function randomName() {
  return `Player${Math.floor(100 + Math.random() * 900)}`;
}
nameInput.value = randomName();

function showOnlineError(message: string) {
  onlineErrorEl.textContent = message;
  onlineErrorEl.classList.remove('hidden');
}
function clearOnlineError() {
  onlineErrorEl.classList.add('hidden');
}

// ---------- Account, leaderboards, friends ----------
const screenBoards = $('screen-boards');
const accountStripEl = $('account-strip');
const boardTabs = $('board-tabs');
const boardRowsEl = $('board-rows');
const friendToolsEl = $('friend-tools');
const friendCodeInput = $<HTMLInputElement>('friend-code-input');
const friendMsgEl = $('friend-msg');
const myCodeEl = $('my-code');
let boardTab: 'world' | 'friends' = 'world';

/** Name of the tier above this rating, for the "N to Gold" hint. */
function RANK_NEXT_NAME(rating: number): string {
  const at = nextRankAt(rating);
  return at === null ? '' : rankFor(at).name;
}

function renderAccountStrip() {
  const p = account.profile;
  if (!p) {
    accountStripEl.classList.add('hidden');
    return;
  }
  accountStripEl.classList.remove('hidden');
  // The rating was always here and always meaningless on its own: "1043" says
  // nothing about whether you are doing well. The tier is the same number with
  // a meaning, and the bar says how far through it you are.
  const rank = rankFor(p.rating);
  const next = nextRankAt(p.rating);
  accountStripEl.innerHTML =
    `<span class="brank" style="color:${rank.css}">${rank.name}</span>` +
    `<span>rating <span class="av">${p.rating}</span></span>` +
    `<span>${p.wins}W / ${p.losses}L</span>` +
    `<span style="margin-left:auto">code <span class="av">${escapeHtml(p.friendCode)}</span></span>` +
    `<div class="rank-bar" title="${next ? `${next - p.rating} to ${RANK_NEXT_NAME(p.rating)}` : 'Top tier'}">` +
    `<span style="width:${Math.round(rankProgress(p.rating) * 100)}%;background:${rank.css}"></span></div>`;
}

/** Called when the player opens the online screen. Minting the account here
 *  rather than at boot means a purely local player never gets one. */
async function ensureAccount() {
  await account.ensure(nameInput.value.trim() || undefined);
  if (account.profile) {
    // The relay is the source of truth for the display name; keep the input in
    // step so a rename sticks rather than silently reverting on next join.
    nameInput.value = account.profile.name;
  }
  renderAccountStrip();
}

async function renderBoards() {
  boardRowsEl.innerHTML = '<div class="board-empty">Loading…</div>';
  friendToolsEl.classList.toggle('hidden', boardTab !== 'friends');
  const me = account.profile;
  myCodeEl.classList.toggle('hidden', !me);
  if (me) myCodeEl.innerHTML = `Your friend code<b>${escapeHtml(me.friendCode)}</b>`;

  try {
    const rows = boardTab === 'world' ? await account.worldBoard() : await account.friendsBoard();
    if (rows.length === 0) {
      boardRowsEl.innerHTML =
        boardTab === 'world'
          ? '<div class="board-empty">Nobody has finished a ranked match yet. Quick match games count towards the ladder; private rooms do not.</div>'
          : '<div class="board-empty">No friends yet. Share your code below, or add someone else’s.</div>';
      return;
    }
    boardRowsEl.innerHTML = rows
      .map((r, i) => {
        const mine = me && r.id === me.id;
        const rank = rankFor(r.rating);
        return `<div class="board-row${mine ? ' me' : ''}">
          <span class="bpos">${String(i + 1).padStart(2, '0')}</span>
          <span class="bname">${escapeHtml(r.name)}</span>
          <span class="bstat"><span class="brank" style="color:${rank.css}">${rank.name}</span> · ${r.wins}W · ×${r.bestChain}</span>
          <span class="brating">${r.rating}</span>
        </div>`;
      })
      .join('');
  } catch {
    boardRowsEl.innerHTML = '<div class="board-empty">Could not load standings.</div>';
  }
}

onSegmentPick(boardTabs, (el) => {
  boardTab = el.dataset.board === 'friends' ? 'friends' : 'world';
  void renderBoards();
});

$('leaderboard-btn').addEventListener('click', async () => {
  sfx.buttonTap();
  friendMsgEl.textContent = '';
  showOverlay(screenBoards);
  await ensureAccount();
  void renderBoards();
});

$('boards-close-btn').addEventListener('click', () => {
  sfx.buttonTap();
  hideOverlay(screenBoards);
});

$('friend-add-btn').addEventListener('click', async () => {
  sfx.buttonTap();
  const code = friendCodeInput.value.trim().toUpperCase();
  if (!code) {
    friendMsgEl.textContent = 'Enter a friend code.';
    return;
  }
  let res: Awaited<ReturnType<typeof account.addFriend>>;
  try {
    res = await account.addFriend(code);
  } catch (err) {
    friendMsgEl.textContent = err instanceof Error ? err.message : 'Could not add that friend.';
    return;
  }
  if (res.error) {
    friendMsgEl.textContent = res.error;
    return;
  }
  friendMsgEl.textContent = res.added ? `Added ${res.added.name}.` : 'Added.';
  friendCodeInput.value = '';
  void renderBoards();
});

// A rename has to reach the relay, or the ladder keeps showing the old name.
nameInput.addEventListener('change', () => {
  const name = nameInput.value.trim();
  if (!name || !account.isSignedIn) return;
  void account.rename(name).then(renderAccountStrip);
});

// ---------- Quick match ----------
let quickMode: GameModeKey = DEFAULT_MODE;
let quickBoardSize: BoardSizeKey = 'medium';
/** The room code we parked in the matchmaker queue, if we are still waiting. */
let queuedCode: string | null = null;

function setQuickSearching(searching: boolean, text = 'Searching for an opponent…') {
  quickStatusEl.classList.toggle('hidden', !searching);
  quickStatusText.textContent = text;
  quickMatchBtn.toggleAttribute('disabled', searching);
}

async function startQuickMatch() {
  sfx.unlock();
  sfx.buttonTap();
  clearOnlineError();
  hideQuickFallback();
  if (net) disconnectNet();
  setQuickSearching(true);

  const client = new NetClient();
  wireNetHandlers(client);
  net = client;
  try {
    const { code, waiting } = await NetClient.quickMatch(quickMode, quickBoardSize);
    queuedCode = waiting ? code : null;
    // Quick-match rooms are listed, so a browser can fill one that is still
    // waiting on the queue — two routes into the same room.
    await client.connect(code, nameInput.value.trim() || randomName(), { publicRoom: true });
    if (waiting) {
      // We are the room now. Sit in the lobby until someone is matched in.
      lobbyMode = quickMode;
      lobbyBoardSize = quickBoardSize;
      selectLobbyMode(quickMode);
      // Publish the settings we queued on, so the listing matches the queue.
      client.setLobby({ mode: quickMode, boardSize: quickBoardSize, isPublic: true });
      quickMatchPending = true;
      enterLobby();
      setQuickSearching(false);
      startBotFallbackTimer();
    } else {
      // Somebody was already waiting — we joined their room and the host's
      // client starts it as soon as it sees us.
      quickMatchPending = true;
      enterLobby();
      setQuickSearching(false);
    }
    exposeDebug();
  } catch (err) {
    net = null;
    queuedCode = null;
    setQuickSearching(false);
    // The player pressed a button meaning "give me a game". Leaving them with
    // only an error is a dead end when a playable opponent is right there —
    // whether matchmaking is missing, down, or just unreachable from here.
    offerBotInstead(err instanceof Error ? err.message : 'Matchmaking failed.');
  }
}

/** Turns a matchmaking failure into a choice rather than a full stop. */
function offerBotInstead(reason: string) {
  const bot = pickBot(account.profile?.rating ?? null);
  quickFallbackMsg.textContent = `${reason} You can still play ${bot.name}, or open a private room and share the code.`;
  quickFallbackBtn.textContent = `Play ${bot.name} (bot)`;
  quickFallbackBtn.onclick = () => {
    hideQuickFallback();
    void startBotMatch(bot);
  };
  quickFallbackEl.classList.remove('hidden');
}

function hideQuickFallback() {
  quickFallbackEl.classList.add('hidden');
}

/** How long to hold out for a person before offering the roster. Long enough
 *  that a real opponent who is mid-join still wins the race, short enough that
 *  waiting never feels like the game is broken. */
const BOT_FALLBACK_MS = 12000;
let botFallbackTimer: ReturnType<typeof setTimeout> | null = null;

function stopBotFallbackTimer() {
  if (botFallbackTimer) clearTimeout(botFallbackTimer);
  botFallbackTimer = null;
}

/** Nobody queued on these settings, so after a wait the player is offered a
 *  game instead of more waiting. They still choose — being dropped into a bot
 *  match you did not ask for is how a player ends up unsure whether the
 *  opponent they just beat was a person. */
function startBotFallbackTimer() {
  stopBotFallbackTimer();
  botFallbackTimer = setTimeout(() => {
    if (!quickMatchPending) return;
    const bot = pickBot(account.profile?.rating ?? null);
    lobbyHintEl.textContent = `no one around — ${bot.name} (bot) is ready`;
    lobbyBotOfferEl.classList.remove('hidden');
    lobbyBotOfferBtn.textContent = `Play ${bot.name} (bot)`;
    lobbyBotOfferBtn.onclick = () => {
      stopBotFallbackTimer();
      if (queuedCode) void NetClient.cancelQuickMatch(queuedCode);
      queuedCode = null;
      disconnectNet();
      lobbyBotOfferEl.classList.add('hidden');
      void startBotMatch(bot);
    };
  }, BOT_FALLBACK_MS);
}

async function cancelQuickMatch() {
  sfx.buttonTap();
  stopBotFallbackTimer();
  lobbyBotOfferEl.classList.add('hidden');
  if (queuedCode) void NetClient.cancelQuickMatch(queuedCode);
  queuedCode = null;
  quickMatchPending = false;
  setQuickSearching(false);
}

quickMatchBtn.addEventListener('click', () => void startQuickMatch());
quickCancelBtn.addEventListener('click', () => void cancelQuickMatch());

onSegmentPick(quickSizeGroup, (el) => {
  quickBoardSize = el.dataset.size as BoardSizeKey;
});

// ---------- Bot matches ----------
/** The opponent when the current game is against the roster, else null. */
let activeBot: Bot | null = null;

function renderBotList() {
  botsListEl.innerHTML = '';
  const myRating = account.profile?.rating ?? null;
  // Nearest first, so the top of the list is the fairest fight available.
  const ordered = [...BOTS].sort(
    (a, b) => Math.abs(a.rating - (myRating ?? 1000)) - Math.abs(b.rating - (myRating ?? 1000))
  );
  for (const bot of ordered) {
    const row = document.createElement('button');
    row.className = 'room-row';
    row.innerHTML =
      `<span class="rh">${escapeHtml(bot.name)}</span>` +
      `<span class="bot-tag">BOT</span>` +
      `<span class="rp">${bot.rating}</span>`;
    row.addEventListener('click', () => void startBotMatch(bot));
    botsListEl.appendChild(row);
  }
}

async function renderPresence() {
  let live = '—';
  try {
    const p = await NetClient.presence();
    live = String(p.queued + p.inRooms);
  } catch {
    // Relay unreachable: say so rather than inventing a number.
    live = '—';
  }
  presenceStripEl.innerHTML =
    `<span class="dot-live"></span><span><span class="pv">${live}</span> players online</span>` +
    `<span style="margin-left:auto"><span class="pv">${BOTS.length}</span> bots ready</span>`;
}

/**
 * Starts a 1v1 against the roster. Runs entirely on this device — there is no
 * relay round trip and nothing is reported to the ladder, which is exactly why
 * a bot match can never move anyone's rating.
 */
async function startBotMatch(bot: Bot) {
  sfx.unlock();
  sfx.buttonTap();
  if (net) disconnectNet();
  onlineMode = false;
  activeBot = bot;
  quickMatchPending = false;
  setQuickSearching(false);
  resetSeries();

  const size = BOARD_SIZES[quickBoardSize];
  const myTheme = themeForSeat(0, quickMode);
  const botTheme = themeForSeat(1, quickMode);
  const players: PlayerConfig[] = [
    {
      id: 0,
      name: account.profile?.name || nameInput.value.trim() || 'You',
      color: myTheme.base,
      colorLight: myTheme.light,
      isAlive: true,
    },
    { id: 1, name: bot.name, color: botTheme.base, colorLight: botTheme.light, isAlive: true },
  ];

  // Bot matches use the mode picked for quick match, so practising is
  // practising the thing you are about to queue for.
  modeKey = GAME_MODES[quickMode].teams ? DEFAULT_MODE : quickMode;
  const seed = randomSeed();
  const newEngine = new GameEngine({
    rows: size.rows,
    cols: size.cols,
    players,
    kinds: layoutForMode(modeKey, size.rows, size.cols, seed),
  });
  if (!(await mountGame(newEngine, orbStyle))) return;
  renderer!.setCellTapHandler(onCellTapLocal);
  renderMatchBanner();
  showScreen(screenGame);
  maybeRunAiTurn();
}

// ---------- Public room browser ----------
async function refreshRooms() {
  roomsListEl.innerHTML = '<div class="rooms-empty">Loading…</div>';
  try {
    const rooms = await NetClient.listRooms();
    if (rooms.length === 0) {
      roomsListEl.innerHTML =
        '<div class="rooms-empty">No open rooms right now. Start a quick match, or create a room and list it publicly.</div>';
      return;
    }
    roomsListEl.innerHTML = '';
    for (const room of rooms) {
      const row = document.createElement('button');
      row.className = 'room-row';
      const size = BOARD_SIZES[room.boardSize];
      // rows×cols, matching how the board options are labelled everywhere else.
      const sizeLabel = size ? `${size.rows}×${size.cols}` : '';
      row.innerHTML =
        `<span class="rh">${escapeHtml(room.host)}</span>` +
        `<span class="rm">${escapeHtml(GAME_MODES[room.mode]?.name ?? room.mode)} · ${sizeLabel}</span>` +
        `<span class="rp">${room.players}/${room.maxPlayers}</span>`;
      row.addEventListener('click', () => void joinRoomByCode(room.code));
      roomsListEl.appendChild(row);
    }
  } catch (err) {
    // Says which of the two it is. "No rooms" and "can't ask about rooms" look
    // identical to a player otherwise, and only one of them is worth waiting out.
    const msg = err instanceof Error ? err.message : 'Could not load the room list.';
    roomsListEl.innerHTML = `<div class="rooms-empty">${escapeHtml(msg)} Practice opponents below still work.</div>`;
  }
}

roomsRefreshBtn.addEventListener('click', () => {
  sfx.buttonTap();
  void refreshRooms();
  void renderPresence();
});

$('play-online-btn').addEventListener('click', () => {
  sfx.unlock();
  sfx.buttonTap();
  clearOnlineError();
  setQuickSearching(false);
  showScreen(screenOnline);
  hideQuickFallback();
  void refreshRooms();
  void renderPresence();
  renderBotList();
  // Minting the guest account on entering the online screen, not at boot: a
  // player who only ever plays locally never gets one.
  void ensureAccount().then(renderBotList);
});
$('online-back-btn').addEventListener('click', () => {
  sfx.buttonTap();
  showScreen(screenMenu);
});

function setBusy(busy: boolean) {
  createRoomBtn.toggleAttribute('disabled', busy);
  joinRoomBtn.toggleAttribute('disabled', busy);
}

createRoomBtn.addEventListener('click', async () => {
  sfx.unlock();
  sfx.buttonTap();
  clearOnlineError();
  setBusy(true);
  const client = new NetClient();
  wireNetHandlers(client);
  try {
    const code = await client.createRoom();
    net = client;
    await client.connect(code, nameInput.value.trim() || randomName());
    enterLobby();
    exposeDebug();
  } catch (err) {
    net = null;
    showOnlineError(err instanceof Error ? err.message : 'Could not create a room.');
  } finally {
    setBusy(false);
  }
});

/** Shared by the code box and by tapping a row in the public room list. */
async function joinRoomByCode(code: string) {
  sfx.unlock();
  sfx.buttonTap();
  clearOnlineError();
  if (!code) {
    showOnlineError('Enter a room code.');
    return;
  }
  if (net) disconnectNet();
  setBusy(true);
  const client = new NetClient();
  wireNetHandlers(client);
  net = client;
  try {
    await client.connect(code, nameInput.value.trim() || randomName());
    // A reclaimed seat sends `resume` right behind the handshake and puts the
    // player straight back on the board, so only show the lobby if that
    // didn't happen.
    if (!onlineMode) enterLobby();
    exposeDebug();
  } catch (err) {
    net = null;
    showOnlineError(err instanceof Error ? err.message : 'Could not join that room.');
  } finally {
    setBusy(false);
  }
}

joinRoomBtn.addEventListener('click', () => void joinRoomByCode(joinCodeInput.value.trim()));

/** Wired before `connect()` rather than after: a client reclaiming a seat gets
 *  its `resume` immediately behind the handshake, and there must be a handler
 *  in place to catch it. */
function wireNetHandlers(client: NetClient) {
  client.onPlayers = (players, hostId, isPublic) => {
    if (isPublic !== undefined) syncVisibilityControl(isPublic);
    renderLobby(players, hostId);
    // The same roster message tells a live board who just dropped or returned.
    if (onlineMode && engine) {
      renderPills();
      renderMatchBanner();
    }
  };
  client.onError = (message) => showOnlineError(message);
  client.onGameStarted = (rows, cols, players, style, mode, seed) =>
    startOnlineGame(rows, cols, players, style, mode, seed);
  client.onMove = (row, col) => {
    void applyAndAnimateMove(row, col);
  };
  client.onResume = (rows, cols, style, mode, snapshot) => {
    void resumeOnlineGame(rows, cols, style, mode, snapshot);
  };
  client.onTaunt = (from, emoji) => showTaunt(from, emoji);
  client.onRematch = (votes, needed) => renderRematchState(votes, needed);
  client.onRoomScore = (score) => {
    roomScore = score;
    renderMatchBanner();
  };
  client.onDisconnect = () => {
    // Reaching here means the whole retry ladder was exhausted, not that a
    // single socket blipped.
    const wasInMatch = onlineMode && !!engine;
    net = null;
    hideLobbyStatus();
    if (intentionalDisconnect) {
      intentionalDisconnect = false;
      return;
    }
    onlineMode = false;
    myPlayerId = -1;
    if (wasInMatch) leaveGameScreen();
    showOnlineError(
      wasInMatch
        ? 'Could not get back into the match. Your seat is still held — rejoin with the same room code from this tab and you will be put back on the board.'
        : 'Lost connection to the room. Ask your friend for the code and try again.'
    );
    showScreen(screenOnline);
  };
  client.onTurnClock = (_player, ms) => {
    runTurnClock(ms, false);
  };
  client.onReconnecting = (attempt, max) => {
    // Only the first attempt: the ladder makes up to nine, and nine events per
    // bad connection would drown out everything else in the batch.
    if (attempt === 1) telemetry.event('disconnect', { inMatch: engine !== null && !engine.gameOver });
    connStatusEl.classList.remove('hidden', 'ok', 'bad');
    connStatusEl.innerHTML = `<span class="spin"></span> reconnecting ${attempt}/${max}`;
  };
  client.onReconnected = () => {
    telemetry.event('reconnected');
    connStatusEl.classList.remove('hidden', 'bad');
    connStatusEl.classList.add('ok');
    connStatusEl.textContent = 'back online';
    setTimeout(hideLobbyStatus, 1800);
  };
}

function hideLobbyStatus() {
  connStatusEl.classList.add('hidden');
}

function enterLobby() {
  showScreen(screenLobby);
  roomCodeBtn.textContent = net?.roomCode ?? '-----';
  hideLobbyStatus();
}

roomCodeBtn.addEventListener('click', async () => {
  if (!net) return;
  const link = `${location.origin}${location.pathname}?room=${net.roomCode}`;
  try {
    await navigator.clipboard.writeText(link);
    const original = lobbyHintEl.textContent;
    lobbyHintEl.textContent = 'invite link copied';
    setTimeout(() => {
      lobbyHintEl.textContent = original;
    }, 1600);
  } catch {
    showOnlineError('Could not copy the link — share the code instead.');
  }
});

lobbyStartBtn.addEventListener('click', () => {
  sfx.buttonTap();
  net?.startGame(lobbyBoardSize, lobbyOrbStyle, lobbyMode);
});

$('lobby-back-btn').addEventListener('click', () => {
  sfx.buttonTap();
  stopBotFallbackTimer();
  lobbyBotOfferEl.classList.add('hidden');
  // Leaving the lobby also gives up any queue slot, or the next quick-matcher
  // gets sent into an empty room.
  if (queuedCode) void NetClient.cancelQuickMatch(queuedCode);
  queuedCode = null;
  quickMatchPending = false;
  disconnectNet();
  showScreen(screenMenu);
});

function renderLobby(players: NetPlayer[], hostId: number) {
  lobbyPlayersEl.innerHTML = '';
  players.forEach((p) => {
    const theme = colorOf(p.colorIndex);
    const row = document.createElement('div');
    row.className = 'lobby-player' + (p.connected ? '' : ' offline');
    const you = net && p.id === net.myId ? ' · you' : '';
    const crown = p.id === hostId ? '<span class="crown">host</span>' : '';
    row.innerHTML =
      `<span class="dot" style="background:${theme.css};box-shadow:0 0 7px ${theme.css}"></span>` +
      `<span class="name">${escapeHtml(p.name)}${you}</span>${crown}`;
    lobbyPlayersEl.appendChild(row);
  });

  renderColorPicker(players);

  const isHost = !!net?.isHost;
  lobbyHostControls.classList.toggle('hidden', !isHost);
  // Only the host can change visibility (the relay enforces it), so showing
  // the control to everyone else is just a button that does nothing.
  lobbyVisibilityField.classList.toggle('hidden', !isHost);
  lobbyStartBtn.classList.toggle('hidden', !isHost);
  lobbyWaitMsg.classList.toggle('hidden', isHost);

  // Team Battle needs an even roster of at least four, and the relay will
  // refuse otherwise — so say so here rather than letting the host find out
  // by pressing start.
  const connectedCount = players.filter((p) => p.connected).length;
  const spec = GAME_MODES[lobbyMode];
  const enoughForMode = spec.teams ? connectedCount >= 4 && connectedCount % 2 === 0 : connectedCount >= 2;
  lobbyStartBtn.toggleAttribute('disabled', !enoughForMode);
  lobbyModeBlurbEl.textContent = enoughForMode
    ? spec.blurb
    : spec.teams
      ? 'Team Battle needs an even roster of at least 4.'
      : 'Need at least 2 players to start.';

  // A quick match should never make anyone hunt for a Start button — the point
  // of it is that you asked to play and then you are playing.
  if (quickMatchPending) {
    if (!enoughForMode) {
      lobbyHintEl.textContent = 'waiting for an opponent…';
      return;
    }
    quickMatchPending = false;
    queuedCode = null;
    if (isHost) net?.startGame(lobbyBoardSize, lobbyOrbStyle, lobbyMode);
  }
}

/** The relay owns visibility, so the control reflects it rather than guessing —
 *  a room opened by quick match is already public before the host touches it. */
function syncVisibilityControl(isPublic: boolean) {
  lobbyVisibilityGroup.querySelectorAll('.segment').forEach((s) => {
    const el = s as HTMLElement;
    el.classList.toggle('active', (el.dataset.public === '1') === isPublic);
  });
}

function renderColorPicker(players: NetPlayer[]) {
  lobbyColorPickerEl.innerHTML = '';
  const myId = net?.myId ?? -1;
  const mine = players.find((p) => p.id === myId);
  // Team Battle assigns side colours on the server, so an individual pick here
  // would just be silently overwritten.
  const locked = GAME_MODES[lobbyMode].teams;
  lobbyColorPickerEl.classList.toggle('dimmed', locked);
  PLAYER_THEMES.forEach((theme, idx) => {
    const takenBy = players.find((p) => p.connected && p.colorIndex === idx && p.id !== myId);
    const el = document.createElement('div');
    el.className = 'swatch';
    if (mine?.colorIndex === idx) el.className += ' mine';
    else if (takenBy || locked) el.className += ' taken';
    el.style.background = `radial-gradient(circle at 35% 30%, ${theme.css}, ${theme.css}cc)`;
    el.style.boxShadow = `0 0 12px ${theme.css}66`;
    el.textContent = mine?.colorIndex === idx ? '✓' : '';
    el.title = locked
      ? 'Team Battle assigns side colours'
      : takenBy
        ? `${theme.name} — taken by ${takenBy.name}`
        : theme.name;
    if (!takenBy && !locked) {
      el.addEventListener('click', () => {
        sfx.buttonTap();
        net?.pickColor(idx);
      });
    }
    lobbyColorPickerEl.appendChild(el);
  });
}

async function startOnlineGame(
  rows: number,
  cols: number,
  players: PlayerConfig[],
  style: OrbStyle,
  mode: GameModeKey,
  seed: number
) {
  if (!net) return;
  stopBotFallbackTimer();
  lobbyBotOfferEl.classList.add('hidden');
  // A real opponent turned up, so nothing here is a bot match any more.
  activeBot = null;
  onlineMode = true;
  myPlayerId = net.myId;
  orbStyle = style;
  // A relay older than this build, or a mode this build doesn't know, must not
  // leave modeKey pointing at nothing — every HUD read would throw.
  modeKey = GAME_MODES[mode] ? mode : DEFAULT_MODE;
  resetSeries();
  // Same generator, same seed as the relay used — so every client is playing
  // on the board the server is validating against.
  const newEngine = new GameEngine({
    rows,
    cols,
    players,
    kinds: layoutForMode(mode, rows, cols, seed),
  });
  if (!(await mountGame(newEngine, style))) return;
  renderer!.setCellTapHandler(onCellTapOnline);
  renderMatchBanner();
  enterOnlineMatchUi();
  showScreen(screenGame);
}

/** Shared setup for entering (or re-entering) an online board: the social
 *  controls only make sense with other people in the room. */
function enterOnlineMatchUi() {
  hideOverlay(screenWin);
  tauntBarEl.classList.remove('hidden');
  setTauntPaletteOpen(false);
  tauntFeedEl.innerHTML = '';
  rematchStateEl.classList.add('hidden');
  playAgainBtn.textContent = 'Rematch';
  playAgainBtn.toggleAttribute('disabled', false);
}

/** Rejoined a match that was already running. The relay sent the whole board
 *  rather than a move log, so there is nothing to replay — load it and show
 *  the position as it stands. */
async function resumeOnlineGame(
  rows: number,
  cols: number,
  style: OrbStyle,
  mode: GameModeKey,
  snapshot: EngineSnapshot
) {
  if (!net) return;
  onlineMode = true;
  myPlayerId = net.myId;
  orbStyle = style;
  modeKey = GAME_MODES[mode] ? mode : DEFAULT_MODE;
  resetSeries();
  const newEngine = new GameEngine({ rows, cols, players: snapshot.players, kinds: snapshot.kinds });
  newEngine.loadSnapshot(snapshot);
  if (!(await mountGame(newEngine, style, { fromSnapshot: true }))) return;
  renderer!.setCellTapHandler(onCellTapOnline);
  renderMatchBanner();
  enterOnlineMatchUi();
  showScreen(screenGame);
}

function leaveOnlineGame() {
  disconnectNet();
  onlineMode = false;
  myPlayerId = -1;
  roomScore = new Map();
}

// ---------- Join-via-link ----------
/** True when a ?room= link took the player straight to the online screen, so
 *  init knows not to open the title screen over the top of it. */
function checkRoomLinkParam(): boolean {
  const room = new URLSearchParams(location.search).get('room');
  if (!room) return false;
  joinCodeInput.value = room.toUpperCase();
  showScreen(screenOnline);
  return true;
}

// ---------- init ----------
selectMode(applyStoredPrefs());
selectLobbyMode(DEFAULT_MODE);
selectQuickMode(DEFAULT_MODE);
buildTauntPalette();
showHowtoPage(0);
renderProfileStrip();
renderSetupSummary();
updateMuteIcon();
// showScreen does more than reveal a section now — it starts and stops attract
// mode — so the title screen has to be entered through it like any other.
if (!checkRoomLinkParam()) showScreen(screenMenu);
telemetry.start();
exposeDebug();
