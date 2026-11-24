import './style.css';
import { GameEngine } from './game/GameEngine';
import type { EngineSnapshot, PlayerConfig, MoveEvent, MoveResult } from './game/types';
import { DEFAULT_MODE, GAME_MODES, MODE_ORDER, type GameModeKey } from './game/modes';
import { layoutForMode, randomSeed } from './game/cells';
import { layoutFor } from './render/orbLayout';
import { chooseMove, chooseMoveDeep, skillForRound } from './game/ai';
import { pickBot, type Bot } from './game/bots';
import { stats, levelProgress } from './game/stats';
import {
  buildDailyPuzzle,
  dayNumber,
  msUntilNextDay,
  shareText,
  trySquare,
  DAILY_TRIES,
  type DailyPuzzle,
} from './game/daily';
import { dailyState } from './game/dailyState';
import {
  initNative,
  hideSplashWhenPainted,
  isNative,
  onBackButton,
  share,
  shareImage,
  roomLink,
  roomCodeFromUrl,
  PUBLIC_ORIGIN,
  exitApp,
} from './native';
import { RANKS, rankFor, rankProgress, nextRankAt } from './game/rank';
import { rankBadgeSvg } from './render/rankBadge';
import {
  prefs,
  MAX_NAME_LENGTH,
  MAX_CALLSIGN_LENGTH,
  type MotionPref,
  type OrientationPref,
} from './game/prefs';
// Three.js is the bulk of the bundle and nothing outside the board needs it,
// so the renderer is pulled in on demand when a match actually starts — the
// menu, the online screens and the join-by-link flow all load without it.
import type { ThreeRenderer, OrbStyle } from './render3d/ThreeRenderer';
import { PLAYER_THEMES } from './render/theme';
import { modePreview } from './render/modePreview';
import { modeArtSvg } from './art/modeArt';
import { sfx } from './sfx/Sfx';
import { haptics } from './sfx/Haptics';
import { NetClient } from './net/NetClient';
import { account } from './net/account';
import { initProfile, renderProfile } from './ui/profile';
import { attachSheet, attachSwipePager } from './ui/sheet';
import { ICON_SOUND_OFF, ICON_SOUND_ON } from './ui/icons';
import { avatarSvg, crewFor, defaultAvatarFor, DEFAULT_AVATAR } from './render/avatar';
import { renderShareCard } from './art/shareImage';
import type { ShareCardData, ShareCell } from './art/shareCard';
import { randomPlayerName } from './game/names';
import { Nova } from './guide/nova';
import { Commentator } from './guide/commentator';
import { novaFaceSvg } from './guide/novaFace';
import { pixelRatioFor, type GraphicsDetail, type OrbDetail, type ParticleLevel, type ShadowLevel } from './render3d/quality';
import { currentAutoTier, currentDetail, getGraphics, onGraphicsChange, setGraphics, type FpsCap, type GraphicsPreset } from './render3d/graphics';
import { telemetry } from './net/telemetry';
import {
  TAUNTS,
  TAUNT_COOLDOWN_MS,
  CHAT_GROUPS,
  CHAT_PHRASES,
  CHAT_COOLDOWN_MS,
} from './net/taunts';
import { TYPED_COOLDOWN_MS, TYPED_MAX, cleanTyped } from './net/chatFilter';
import { LEAVE_PENALTY, PLACE_POINTS, ordinal, type RankedPlayers } from './net/rankPoints';
import type { BoardSizeKey, NetPlayer } from './net/protocol';

const BOARD_SIZES: Record<BoardSizeKey, { rows: number; cols: number }> = {
  small: { rows: 9, cols: 5 },
  medium: { rows: 11, cols: 6 },
  large: { rows: 13, cols: 7 },
};

/** The shape the screen is asking for. A board is the whole screen here, so a
 *  portrait lattice on a monitor letterboxes into a strip down the middle with
 *  two thirds of the display doing nothing. 1.15 rather than 1.0 so a nearly
 *  square window does not flip back and forth on a few pixels of resize. */
function screenPrefersLandscape(): boolean {
  return window.innerWidth > window.innerHeight * 1.15;
}

/** Rows and columns swapped when playing wide. One definition of how big each
 *  board is; orientation is a transform on top of it, matching the relay. */
function orient(size: { rows: number; cols: number }, landscape: boolean) {
  return landscape ? { rows: size.cols, cols: size.rows } : size;
}

/** The player's choice, or the screen's if they left it on auto. */
function useLandscape(): boolean {
  if (orientationPref === 'landscape') return true;
  if (orientationPref === 'portrait') return false;
  return screenPrefersLandscape();
}

/** The dimensions a local game would actually be played on. */
function boardDims(size: BoardSizeKey = boardSizeKey) {
  return orient(BOARD_SIZES[size], useLandscape());
}

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
let orientationPref: OrientationPref = 'auto';
/** Names for local seats, indexed by seat. Empty means "not named", which
 *  falls back to Player N rather than storing the fallback as if it were a
 *  choice somebody made. */
let localNames: string[] = [];
/** The name this device plays online under. */
let callsign = '';
/** Set when the player asked to rename from the profile screen, so the name
 *  field is opened once the account round trip that follows has settled. */
let wantsRename = false;
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
/** The room's orientation. The host's choice, applied to everyone — a board
 *  cannot be tall for one player and wide for another. */
let lobbyLandscape = false;
let lobbyOrbStyle: OrbStyle = 'dots';
let lobbyMode: GameModeKey = DEFAULT_MODE;
let intentionalDisconnect = false;
/** True between asking for a quick match and that match starting. The host's
 *  client kicks the game off automatically once the room fills, so neither
 *  side has to find and press Start. */
let quickMatchPending = false;
/** True for a match that came from the ranked queue — leaving it costs points. */
let rankedMatch = false;

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
const screenProfile = $('screen-profile');
const screenRanked = $('screen-ranked');
const screenBoards = $('screen-boards');
const screenDailyPage = $('screen-daily-page');
const tabbarEl = $('tabbar');
const screenCpu = $('screen-cpu');
const screenDaily = $('screen-daily');
const homeXpFill = $('home-xp-fill');
const homeNameEl = $('home-name');
const homeAvatarEl = $('home-avatar');
const dailyBtn = $('daily-btn');
const dailySubEl = $('daily-sub');
const dailyStreakEl = $('daily-streak');
const cpuSubEl = $('cpu-sub');
const cpuLevelGroup = $('cpu-level-group');
const cpuBlurbEl = $('cpu-level-blurb');
const cpuSizeGroup = $('cpu-size-group');
const puzzleHudEl = $('puzzle-hud');
const nameFieldEl = $('name-field');
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
const ALL_SCREENS = [screenMenu, screenDailyPage, screenOnline, screenBoards, screenProfile, screenGame, screenLobby, screenRanked];

const playersCountEl = $('players-count');
const playersFieldEl = $('players-field');
const playersNoteEl = $('players-note');
const playerRosterEl = $('player-roster');
const boardSizeGroup = $('board-size-group');
const orientationGroup = $('orientation-group');
const lobbyOrientationGroup = $('lobby-orientation-group');
const modeGroup = $('mode-group');
const modeBlurbEl = $('mode-blurb');
const modePreviewEl = $('mode-preview');
const modeCaptionEl = $('mode-caption');
const modeLegendEl = $('mode-legend');

const levelChipEl = $('level-chip');

const playPillsEl = $('player-pills');
const boardHost = $('board-host');
const chainReadoutEl = $('chain-readout');
const boardToastEl = $('board-toast');
const boardFlashEl = $('board-flash');
const matchBannerEl = $('match-banner');
const turnClockEl = $('turn-clock');
const turnClockFill = $('turn-clock-fill');
const turnClockValue = $('turn-clock-value');
const tauntBarEl = $('taunt-bar');
const tauntToggleEl = $<HTMLButtonElement>('taunt-toggle');
const tauntPaletteEl = $('taunt-palette');
const tauntFeedEl = $('taunt-feed');
const chatToggleEl = $<HTMLButtonElement>('chat-toggle');
const chatPaletteEl = $('chat-palette');
const rematchStateEl = $('rematch-state');
const winCardEl = document.querySelector('.win-card') as HTMLElement;
const winNameEl = $('win-name');
const winVerbEl = $('win-verb');
const winEyebrowEl = screenWin.querySelector('.win-eyebrow') as HTMLElement;
const winMetricsEl = $('win-metrics');
const winLeaderboardEl = $('win-leaderboard');
const winRankEl = $('win-rank');
const playAgainBtn = $('play-again-btn');
const confettiLayer = $('confetti-layer');

// ---------- Nova ----------
/** The computer has a face and a voice: Nova guides the lesson and talks
 *  through every match against her. */
const nova = new Nova(sfx);
const commentator = new Commentator(nova);
const novaDockEl = $('nova-dock');
const winNovaEl = $('win-nova');
const lessonBarEl = $('lesson-bar');
const lessonStepEl = $('lesson-step');
const lessonActionsEl = $('lesson-actions');
document.querySelectorAll<HTMLElement>('.nova-stage .nova-pfp').forEach((el) => {
  el.innerHTML = novaFaceSvg(128);
});
const NOVA_GAMES_KEY = 'fissile.nova.games';
/** Finished games against Nova — the first few get coaching tips. */
let novaGames = 0;
try {
  novaGames = Math.max(0, Number(localStorage.getItem(NOVA_GAMES_KEY)) || 0);
} catch {
  /* storage unavailable */
}
/** How the last game against her went, so a rematch opens with the right line. */
let novaLastResult: 'won' | 'lost' | null = null;
let novaLastLevel: number | null = null;
/** The interactive lesson is mounted. Like a Daily puzzle, it uses a real
 *  board but scores nothing and never shows the result card. */
let lessonMode = false;
/** Bumped whenever a lesson starts or is abandoned, so a script still
 *  awaiting a tap from an old lesson does nothing when it resumes. */
let lessonToken = 0;

function startNovaCommentary(level: number) {
  nova.attach(novaDockEl);
  const rematch = novaLastLevel === level ? novaLastResult : null;
  novaLastLevel = level;
  commentator.start({ level, aiId: AI_PLAYER_ID, humanId: 0, rematch, gamesPlayed: novaGames });
  commentator.armIdle();
}

const nameInput = $<HTMLInputElement>('name-input');
const nameSaveBtn = $('name-save-btn');
const nameNoteEl = $('name-note');
const joinCodeInput = $<HTMLInputElement>('join-code-input');
const createRoomBtn = $('create-room-btn');
const joinRoomBtn = $('join-room-btn');
const onlineErrorEl = $('online-error');
const quickModeGroup = $('quick-mode-group');
const quickSizeGroup = $('quick-size-group');
const quickPreviewEl = $('quick-preview');
const quickCaptionEl = $('quick-caption');
const quickLegendEl = $('quick-legend');
const quickModeBlurbEl = $('quick-mode-blurb');
const quickMatchBtn = $<HTMLButtonElement>('quick-match-btn');
const quickStatusEl = $('quick-status');
const quickStatusText = $('quick-status-text');
const quickCancelBtn = $('quick-cancel-btn');
const roomsListEl = $('rooms-list');
const roomsRefreshBtn = $('rooms-refresh-btn');

const presenceStripEl = $('presence-strip');
const quickFallbackEl = $('quick-fallback');
const quickFallbackMsg = $('quick-fallback-msg');
const quickFallbackBtn = $<HTMLButtonElement>('quick-fallback-btn');
const lobbyVisibilityGroup = $('lobby-visibility-group');
const lobbyVisibilityField = $('lobby-visibility-field');
const roomCodeBtn = $('room-code-btn');
const lobbyHintEl = $('lobby-hint');
const lobbyPlayersEl = $('lobby-players');
const lobbyColorPickerEl = $('lobby-color-picker');
const lobbyHostControls = $('lobby-host-controls');
const lobbyBoardSizeGroup = $('lobby-board-size-group');
const lobbyModeGroup = $('lobby-mode-group');
const lobbyModeBlurbEl = $('lobby-mode-blurb');
const lobbyStartBtn = $<HTMLButtonElement>('lobby-start-btn');
const lobbyInviteField = $('lobby-invite-field');
const lobbyInviteListEl = $('lobby-invite-list');
const inviteInboxEl = $('invite-inbox');
const lobbyWaitMsg = $('lobby-wait-msg');
const lobbyStartHint = $('lobby-start-hint');
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

/** How the last ranked match moved this device's rating, or null if the
 *  match was not ranked. Held until the next one starts rather than shown and
 *  forgotten — the result card is composed before the relay has finished
 *  talking to the ladder, so the number arrives after the card is already up. */
let lastRated: { rating: number; delta: number; place?: number; left?: boolean } | null = null;

/**
 * The ranked readout on the result card: the tier you are now, and what this
 * match did to get you there. A ladder that only ever shows a total is a
 * ladder nobody can feel themselves climbing.
 */
function renderWinRank() {
  if (!lastRated) {
    winRankEl.classList.add('hidden');
    winRankEl.innerHTML = '';
    return;
  }
  const rank = rankFor(lastRated.rating);
  const { delta } = lastRated;
  // Zero is a real outcome in a free-for-all, where only head-to-head results
  // move the ladder — saying "+0" would imply the match was rated and worth
  // nothing, which is the wrong story.
  const sign = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  const label = delta === 0 ? 'no change' : `${delta > 0 ? '+' : ''}${delta}`;
  winRankEl.classList.remove('hidden');
  winRankEl.innerHTML =
    `<div class="win-rank-badge">${rankBadgeSvg(rank, 40)}</div>` +
    `<div class="win-rank-meta">` +
    `<span class="win-rank-name" style="color:${rank.css}">${rank.name}</span>` +
    `<span class="win-rank-rating">${lastRated.place ? `${ordinal(lastRated.place)}${lastRated.left ? ' (left)' : ''} · ` : ''}${lastRated.rating} pts</span>` +
    `</div>` +
    `<span class="win-rank-delta is-${sign}">${label}</span>`;
}

/** The seat whose results count towards this device's record. Online that's
 *  the socket's own player; in pass-and-play there is no "you", so the first
 *  seat stands in for the device owner. */
function localSeatId(): number {
  return onlineMode ? myPlayerId : 0;
}

// ---------- Menu setup ----------
/** What a seat is actually called. Survival's two seats are the player and
 *  the system and are not up for naming; everywhere else an unnamed seat is
 *  Player N. */
function seatName(seat: number): string {
  if (GAME_MODES[modeKey].solo) return seat === 0 ? 'You' : 'System';
  return localNames[seat]?.trim() || `Player ${seat + 1}`;
}

/** One row per seat: its emission, and the name it plays under. Naming the
 *  seats is what turns pass-and-play from "Player 1 wins" into something with
 *  the people in the room in it — the result card, the HUD pills and the
 *  standings all read from here. */
function renderRoster() {
  const mode = GAME_MODES[modeKey];
  playerRosterEl.innerHTML = '';

  for (let i = 0; i < numPlayers; i++) {
    const theme = themeForSeat(i);
    const row = document.createElement('div');
    row.className = 'roster-row';

    const dot = document.createElement('span');
    dot.className = 'roster-dot';
    dot.style.background = `radial-gradient(circle at 35% 30%, ${theme.css}, ${theme.css}cc)`;
    dot.style.boxShadow = `0 0 10px ${theme.css}66`;
    dot.title = mode.teams ? `${theme.name} — ${TEAM_NAMES[i % 2]}` : theme.name;
    row.appendChild(dot);

    const input = document.createElement('input');
    input.className = 'roster-name';
    input.type = 'text';
    input.maxLength = MAX_NAME_LENGTH;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', `Name for seat ${i + 1}`);
    if (mode.solo) {
      // The roster still shows both seats, but neither is yours to rename.
      input.value = seatName(i);
      input.disabled = true;
    } else {
      // The stored name, not the fallback: the placeholder carries "Player N"
      // so an empty box reads as unnamed rather than as a name to delete.
      input.value = localNames[i] ?? '';
      input.placeholder = `Player ${i + 1}`;
      input.addEventListener('input', () => {
        localNames[i] = input.value;
        persistPrefs();
      });
      // Tapping the dot is the affordance the row advertises, so make it work.
      dot.addEventListener('click', () => input.focus());
    }
    row.appendChild(input);

    if (mode.teams) {
      const tag = document.createElement('span');
      tag.className = 'roster-team';
      tag.textContent = TEAM_NAMES[i % 2].slice(-1);
      row.appendChild(tag);
    }

    playerRosterEl.appendChild(row);
  }
}

/** Moves a segmented control's highlight without going through its click
 *  handler — restoring a stored choice is not the player making one, and the
 *  handler would tap a sound and re-persist on every boot. */
/** Retitles a board-size control so the numbers match the orientation the
 *  board will actually be built at. Showing "11×6" next to a Wide selection
 *  would be a straightforward lie about what Start produces. */
function relabelSizes(group: HTMLElement, landscape: boolean) {
  group.querySelectorAll<HTMLElement>('.segment').forEach((seg) => {
    const key = seg.dataset.size as BoardSizeKey | undefined;
    if (!key || !BOARD_SIZES[key]) return;
    const dims = orient(BOARD_SIZES[key], landscape);
    seg.textContent = `${dims.rows}×${dims.cols}`;
  });
}

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
  muted = stored.muted;
  motionPref = stored.motion;
  orientationPref = stored.orientation;
  localNames = stored.names;
  callsign = stored.callsign;
  if (!callsign) {
    // First launch: hand out a proper name straight away and keep it, so the
    // home screen, the ladder and every room agree on who this is.
    callsign = randomName();
    prefs.save({ ...stored, callsign });
  }
  // Set here rather than at module load: prefs are not read until this runs,
  // so anywhere earlier the stored callsign is still empty and the random
  // fallback wins every time.
  nameInput.value = callsign || randomName();
  sfx.muted = muted;
  sfx.volume = stored.volume;
  sfx.musicVolume = stored.music;
  haptics.enabled = stored.haptics;
  markSegment(boardSizeGroup, 'size', boardSizeKey);
  // 'auto' resolves against this screen, so the control shows what will
  // actually happen rather than the word "auto".
  const landscape = useLandscape();
  markSegment(orientationGroup, 'orient', landscape ? 'landscape' : 'portrait');
  relabelSizes(boardSizeGroup, landscape);
  lobbyLandscape = landscape;
  markSegment(lobbyOrientationGroup, 'orient', landscape ? 'landscape' : 'portrait');
  relabelSizes(lobbyBoardSizeGroup, landscape);
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
    orientation: orientationPref,
    names: localNames,
    callsign,
  });
}

// ---------- Settings ----------
function renderSettings() {
  renderGraphicsSettings();
  markSegment(novaChatterGroup, 'chatter', nova.prefs.chatter);
  markSegment(novaVoiceGroup, 'novavoice', nova.prefs.voice ? '1' : '0');
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
  else if (!screenMenu.classList.contains('hidden')) scheduleAttract();
}

const novaChatterGroup = $('nova-chatter-group');
const novaVoiceGroup = $('nova-voice-group');
onSegmentPick(novaChatterGroup, (el) => {
  const chatter = el.dataset.chatter;
  if (chatter === 'lots' || chatter === 'some' || chatter === 'off') nova.setPrefs({ chatter });
});
onSegmentPick(novaVoiceGroup, (el) => {
  nova.setPrefs({ voice: el.dataset.novavoice === '1' });
});

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

function renderProfileStrip() {
  renderHome();
}

/** Builds one of the two mode pickers. `onlineOnly` hides modes the relay
 *  can't referee rather than letting the host pick something that will be
 *  rejected. */
function renderModeGrid(host: HTMLElement, selected: GameModeKey, onlineOnly: boolean, pick: (m: GameModeKey) => void, freeForAllOnly = false) {
  // Cards with key art, in a row that scrolls sideways and snaps — seven
  // modes are too many to read as a grid of words on a phone.
  const keepScroll = host.scrollLeft;
  host.innerHTML = '';
  host.classList.add('mode-cards');
  let active: HTMLElement | null = null;
  for (const key of MODE_ORDER) {
    const mode = GAME_MODES[key];
    if (onlineOnly && !mode.online) continue;
    if (freeForAllOnly && mode.teams) continue;
    const btn = document.createElement('button');
    btn.className = 'mode-card' + (key === selected ? ' active' : '');
    btn.dataset.mode = key;
    btn.setAttribute('aria-pressed', String(key === selected));
    btn.innerHTML =
      `<span class="mc-art">${modeArtSvg(key, 160)}</span>` +
      `<span class="mc-name">${mode.name}${!onlineOnly && !mode.online ? '<span class="local-tag">local</span>' : ''}</span>`;
    btn.addEventListener('click', () => {
      sfx.unlock();
      sfx.buttonTap();
      pick(key);
    });
    if (key === selected) active = btn;
    host.appendChild(btn);
  }
  host.scrollLeft = keepScroll;
  // Bring the picked card fully into view without yanking the page.
  if (active) {
    const card = active;
    requestAnimationFrame(() => {
      const left = card.offsetLeft - host.offsetLeft;
      const right = left + card.offsetWidth;
      if (left < host.scrollLeft || right > host.scrollLeft + host.clientWidth) {
        host.scrollTo({ left: Math.max(0, left - 12), behavior: reducedMotion() ? 'auto' : 'smooth' });
      }
    });
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
  renderRoster();
  renderModePreview();
  persistPrefs();
}

/** Draws the lattice the current mode and board size would actually produce. */
function renderModePreview() {
  const size = boardDims();
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
  renderModeGrid(quickModeGroup, quickMode, true, selectQuickMode, true);
  renderQuickPreview();
}

/**
 * The board a ranked queue would actually produce.
 *
 * Drawn by the same generator the local setup uses, from the same mode table,
 * so the two previews cannot drift into showing different things for the same
 * mode. It matters more here than in local setup: a ranked match starts the
 * moment an opponent is found, so this is the last point at which the choice
 * can still be changed.
 */
/** A mode's description as it plays online, where every turn is on a clock:
 *  20 seconds unless the mode sets its own. */
function onlineBlurb(key: GameModeKey): string {
  const spec = GAME_MODES[key];
  if (spec.turnSeconds) return spec.blurb;
  return `${spec.blurb.replace(/^Untimed\.\s*/, '')} Online: 20 seconds per turn; miss three and you're out.`;
}

function renderQuickPreview() {
  const size = boardDims(quickBoardSize === 'auto' ? 'medium' : quickBoardSize);
  const { svg, caption, hasSpecials } = modePreview(quickMode, size.rows, size.cols);
  quickPreviewEl.innerHTML = svg;
  quickCaptionEl.textContent = quickBoardSize === 'auto' ? 'Auto: any board size. Shown at 11×6.' : caption;
  quickLegendEl.classList.toggle('hidden', !hasSpecials);
  quickModeBlurbEl.textContent = onlineBlurb(quickMode);
}

function stepPlayers(delta: number) {
  if (GAME_MODES[modeKey].fixedPlayers !== null) return;
  sfx.unlock();
  sfx.buttonTap();
  numPlayers = Math.min(6, Math.max(2, numPlayers + delta));
  playersCountEl.textContent = String(numPlayers);
  renderRoster();
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
  persistPrefs();
});

onSegmentPick(orientationGroup, (el) => {
  orientationPref = el.dataset.orient === 'landscape' ? 'landscape' : 'portrait';
  relabelSizes(boardSizeGroup, useLandscape());
  renderModePreview();
  persistPrefs();
});

onSegmentPick(lobbyOrientationGroup, (el) => {
  lobbyLandscape = el.dataset.orient === 'landscape';
  relabelSizes(lobbyBoardSizeGroup, lobbyLandscape);
  net?.setLobby({ landscape: lobbyLandscape });
});

onSegmentPick(lobbyBoardSizeGroup, (el) => {
  lobbyBoardSize = el.dataset.size as BoardSizeKey;
  net?.setLobby({ boardSize: lobbyBoardSize, landscape: lobbyLandscape });
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
  const icon = muted ? ICON_SOUND_OFF : ICON_SOUND_ON;
  for (const id of ['mute-btn-menu', 'mute-btn-game']) {
    const btn = $(id);
    btn.innerHTML = icon;
    btn.setAttribute('aria-pressed', String(muted));
    btn.setAttribute('aria-label', muted ? 'Sound off — tap to turn on' : 'Sound on — tap to mute');
  }
}
function toggleMute() {
  muted = !muted;
  sfx.muted = muted;
  updateMuteIcon();
  persistPrefs();
}

// ---------- Sound menu ----------
/**
 * The speaker button opens a small menu instead of muting everything at once:
 * game sounds, music and Nova's voice each switch on their own, plus a mute
 * for all of it. Game-sound and music switches are kept on this device.
 */
const SOUND_KEY = 'fissile.sound.v1';
const soundMenuEl = $('sound-menu');
try {
  const saved = JSON.parse(localStorage.getItem(SOUND_KEY) ?? '{}');
  sfx.fxMuted = saved.fx === false;
  sfx.musicMuted = saved.music === false;
} catch {
  // Unreadable storage: everything stays on.
}
function saveSoundPrefs() {
  try {
    localStorage.setItem(SOUND_KEY, JSON.stringify({ fx: !sfx.fxMuted, music: !sfx.musicMuted }));
  } catch {
    // Private mode: lasts for this session.
  }
}

function renderSoundMenu() {
  const state: Record<string, boolean> = { fx: !sfx.fxMuted, music: !sfx.musicMuted, nova: nova.prefs.voice };
  soundMenuEl.querySelectorAll<HTMLInputElement>('input[data-sound]').forEach((el) => {
    el.checked = state[el.dataset.sound ?? ''] ?? true;
    el.disabled = muted;
  });
  soundMenuEl.classList.toggle('all-muted', muted);
  soundMenuEl.querySelector('.sound-all')!.textContent = muted ? 'Turn sound back on' : 'Mute everything';
}

function openSoundMenu(anchor: HTMLElement) {
  sfx.unlock();
  renderSoundMenu();
  soundMenuEl.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  const w = soundMenuEl.offsetWidth;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
  soundMenuEl.style.left = `${left}px`;
  soundMenuEl.style.top = `${r.bottom + 8}px`;
}

function closeSoundMenu() {
  soundMenuEl.classList.add('hidden');
}

soundMenuEl.addEventListener('change', (e) => {
  const el = e.target as HTMLInputElement;
  const which = el.dataset.sound;
  if (which === 'fx') sfx.fxMuted = !el.checked;
  else if (which === 'music') sfx.musicMuted = !el.checked;
  else if (which === 'nova') {
    nova.setPrefs({ voice: el.checked });
    markSegment(novaVoiceGroup, 'novavoice', el.checked ? '1' : '0');
  }
  saveSoundPrefs();
  if (!sfx.fxMuted) sfx.buttonTap();
});
soundMenuEl.querySelector('.sound-all')!.addEventListener('click', () => {
  toggleMute();
  renderSoundMenu();
  if (!muted) sfx.buttonTap();
});
document.addEventListener('pointerdown', (e) => {
  if (soundMenuEl.classList.contains('hidden')) return;
  const t = e.target as HTMLElement;
  if (soundMenuEl.contains(t) || t.closest('#mute-btn-menu, #mute-btn-game')) return;
  closeSoundMenu();
});

// A system-level motion change while the game is open should still be picked
// up — but only while the player is on auto, or their own choice is not a
// choice at all.
if (typeof matchMedia === 'function') {
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => {
    if (motionPref === 'auto') applyMotionPref();
  });
}
for (const id of ['mute-btn-menu', 'mute-btn-game']) {
  const btn = $(id);
  btn.addEventListener('click', () => {
    if (soundMenuEl.classList.contains('hidden')) openSoundMenu(btn);
    else closeSoundMenu();
  });
}

$('back-btn').addEventListener('click', () => {
  sfx.buttonTap();
  void confirmLeaveMatch().then((ok) => {
    if (ok) leaveMatchNow();
  });
});

/** Leaves the board for the menu. In a live online match the relay is told
 *  first, so the seat comes out of the game straight away rather than the
 *  others waiting out three turn clocks on someone who has gone. */
function leaveMatchNow() {
  if (onlineMode) {
    if (engine && !engine.gameOver) net?.sendLeave();
    leaveOnlineGame();
  }
  leaveGameScreen();
  showScreen(screenMenu);
}

/** Whether leaving now would abandon a match that is still being played. */
function matchIsLive(): boolean {
  return !!engine && !engine.gameOver && !lessonMode && screenWin.classList.contains('hidden');
}

function confirmLeaveMatch(): Promise<boolean> {
  if (!matchIsLive()) return Promise.resolve(true);
  const ranked = onlineMode && rankedMatch;
  return confirmDialog({
    title: 'Leave this match?',
    body: ranked
      ? `This is a ranked match. Leaving counts as a loss and costs you ${-LEAVE_PENALTY} points.`
      : onlineMode
        ? "You'll be taken out of the match and the others will carry on without you."
        : 'This game will end and its progress will be lost.',
    ok: 'Leave',
    cancel: 'Keep playing',
    danger: true,
  });
}

// ---------- Confirm dialog ----------
const screenConfirm = $('screen-confirm');
let confirmResolve: ((ok: boolean) => void) | null = null;

/** A small yes/no sheet. Resolves false when dismissed any other way (Back,
 *  tapping outside), so a stray tap never confirms anything. */
function confirmDialog(opts: { title: string; body: string; ok: string; cancel: string; danger?: boolean }): Promise<boolean> {
  confirmResolve?.(false);
  $('confirm-title').textContent = opts.title;
  $('confirm-body').textContent = opts.body;
  const okBtn = $('confirm-ok-btn');
  okBtn.textContent = opts.ok;
  okBtn.classList.toggle('danger-btn', opts.danger === true);
  $('confirm-cancel-btn').textContent = opts.cancel;
  showOverlay(screenConfirm);
  okBtn.focus();
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

function closeConfirm(ok: boolean) {
  hideOverlay(screenConfirm);
  const r = confirmResolve;
  confirmResolve = null;
  r?.(ok);
}

$('confirm-ok-btn').addEventListener('click', () => {
  sfx.buttonTap();
  closeConfirm(true);
});
$('confirm-cancel-btn').addEventListener('click', () => {
  sfx.buttonTap();
  closeConfirm(false);
});
screenConfirm.addEventListener('click', (e) => {
  if (e.target === screenConfirm) closeConfirm(false);
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
    // The vs-computer sheet's own size and mode, not quick match's.
    const cpu = activeBot.id.startsWith('cpu-');
    void startBotMatch(activeBot, cpu ? { size: cpuSize, mode: DEFAULT_MODE } : {});
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

/** Play local opens the setup rather than starting straight away. Choosing to
 *  play locally is exactly the moment you want to say who is playing and on
 *  what — asking beforehand, on the title screen, is asking too early. */
$('play-btn').addEventListener('click', () => {
  sfx.unlock();
  sfx.buttonTap();
  renderRoster();
  showOverlay(screenSetup);
});

$('setup-start-btn').addEventListener('click', startLocalRun);

$('setup-close-btn').addEventListener('click', () => {
  sfx.buttonTap();
  hideOverlay(screenSetup);
});

// Two entry points, one overlay: the title screen and the online screen. Both
// are places a player asks "how am I doing", and an overlay returns them to
// whichever one they came from rather than replacing it.
$('profile-btn').addEventListener('click', () => {
  sfx.buttonTap();
  goTab('profile');
});

$('settings-btn').addEventListener('click', () => openSettings());

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
  hideOverlay(screenCpu);
  hideOverlay(screenDaily);
  el.classList.remove('hidden');
  // The bed sits forward everywhere except over a live board, where the
  // effects need the room.
  sfx.setBedMood(el === screenGame ? 'match' : 'menu');
  if (el === screenMenu) {
    renderProfileStrip();
    scheduleAttract();
  } else {
    cancelScheduledAttract();
    stopAttract();
  }
  syncBenchGrid();
  syncTabbar(el);
  if (from !== el) playScreenIn(el, transitionFor(from, el));
  onScreenEnter(el, from);
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
function playScreenIn(el: HTMLElement, transition = 'screen-in') {
  el.classList.remove(...TRANSITIONS);
  void el.offsetWidth; // restart the animation even on a repeated target
  el.classList.add(transition);
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

/** Pending idle callback for attract mode, so leaving the menu can cancel it. */
let attractIdle = 0;

/**
 * Brings up attract mode once the app has finished being useful.
 *
 * Attract mode is decoration — a real match playing itself behind the title —
 * but it needs the 3D renderer, which is by far the largest thing the app
 * ships. Starting it from `showScreen` meant the menu pulled ~630 kB of
 * Three.js, parsed it and created a WebGL context before the player had asked
 * for anything: measured, the chunk began downloading in the same millisecond
 * the DOM became ready. On a phone that is seconds of a menu that looks
 * finished but is not yet responsive.
 *
 * Deferring to idle costs the animation a moment of delay — it fades in, so
 * arriving late is not visible — and gives the menu back to the player
 * immediately. Tapping Play first loads the renderer then, exactly as before.
 */
function scheduleAttract() {
  if (attractIdle || attractRenderer || renderer) return;

  const idle = (window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  }).requestIdleCallback;

  const begin = () => {
    attractIdle = 0;
    void startAttract();
  };

  const thenIdle = () => {
    attractIdle = idle ? idle(begin, { timeout: 2000 }) : window.setTimeout(begin, 200);
  };

  // Waiting for the actual first-contentful-paint entry, rather than guessing
  // at it. Two things were tried first and both were measured to be wrong:
  //
  //   Idle alone   — the browser is idle in the gap before it paints, so under
  //                  CPU throttling this fired 47ms *before* first paint.
  //   Two frames   — fine locally, where the stylesheet is already there. On
  //                  the deployed site, with render-blocking CSS still in
  //                  flight, frames are committed before any content is
  //                  painted, and this fired 26ms too early again.
  //
  // The paint entry is the thing actually being waited for, so it is what gets
  // observed. If it has already happened, there is nothing to wait for.
  const painted = performance
    .getEntriesByType('paint')
    .some((e) => e.name === 'first-contentful-paint');

  if (painted || typeof PerformanceObserver === 'undefined') {
    attractIdle = window.setTimeout(thenIdle, 0);
    return;
  }

  const observer = new PerformanceObserver((list) => {
    if (!list.getEntries().some((e) => e.name === 'first-contentful-paint')) return;
    observer.disconnect();
    thenIdle();
  });
  observer.observe({ type: 'paint', buffered: true });

  // A browser that never reports the entry must not mean the board never
  // arrives; this is the floor, not the expected path.
  attractIdle = window.setTimeout(() => {
    observer.disconnect();
    thenIdle();
  }, 2500);
}

function cancelScheduledAttract() {
  if (!attractIdle) return;
  const cancel = (window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
  if (cancel) cancel(attractIdle);
  else clearTimeout(attractIdle);
  attractIdle = 0;
}

async function startAttract() {
  if (attractRenderer || renderer || reducedMotion()) return;
  // Decoration is the first thing to go on a device that cannot afford it.
  // The same measurement that picks the render tier answers this: a phone
  // that will be dropped to 'low' should not be spending its first seconds
  // downloading and compiling a 3D engine to animate a menu background.
  const gfx = getGraphics();
  if (gfx.preset === 'low' || (gfx.preset === 'auto' && currentAutoTier() === 'low')) return;
  const token = ++attractToken;
  const { ThreeRenderer: Renderer } = await import('./render3d/ThreeRenderer');
  if (token !== attractToken) return;
  attractEngine = newAttractEngine();
  const board = new Renderer(attractEngine, colorOf, 'dots', { background: true });
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
    const cpu = activeBot.id.startsWith('cpu-') ? CPU_LEVELS[Number(activeBot.id.slice(4))] : null;
    parts.push(
      cpu
        ? `vs <span class="bv">${escapeHtml(activeBot.name)}</span> · ${cpu.name.toLowerCase()} computer`
        : `vs <span class="bv">${escapeHtml(activeBot.name)}</span> · bot · unranked`
    );
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

/** Named chain milestones. Crossing one is announced — a word, a chord and
 *  a haptic — so a big cascade has a peak you can feel, not just a number
 *  ticking up. Ordered by depth. */
const CHAIN_TIERS: { at: number; word: string; level: number }[] = [
  { at: 2, word: 'chain', level: 0 },
  { at: 3, word: 'combo!', level: 0 },
  { at: 5, word: 'chain reaction!', level: 1 },
  { at: 8, word: 'meltdown!', level: 2 },
  { at: 12, word: 'supercritical!', level: 3 },
  { at: 16, word: 'nuclear!!', level: 4 },
  { at: 22, word: 'unstoppable', level: 5 },
];

function chainTier(depth: number) {
  let tier = CHAIN_TIERS[0];
  for (const t of CHAIN_TIERS) if (depth >= t.at) tier = t;
  return tier;
}

function showChain(depth: number, playerId: number) {
  if (depth < CHAIN_CALLOUT_MIN) return;
  const theme = colorOf(playerId);
  const tier = chainTier(depth);
  const milestone = CHAIN_TIERS.some((t) => t.at === depth && t.level > 0);
  chainReadoutEl.innerHTML = `<span class="cv">×${depth}</span><span class="ck">${tier.word}</span>`;
  chainReadoutEl.style.setProperty('--chain-color', theme.css);
  chainReadoutEl.dataset.level = String(tier.level);
  chainReadoutEl.classList.remove('show', 'milestone');
  void chainReadoutEl.offsetWidth; // restart the pop animation on each new wave
  chainReadoutEl.classList.add('show');
  if (milestone) {
    chainReadoutEl.classList.add('milestone');
    sfx.combo(tier.level);
    haptics.combo();
  } else {
    sfx.chainTick(depth);
  }

  if (depth >= CHAIN_FLASH_MIN) {
    boardFlashEl.style.color = theme.css;
    boardFlashEl.classList.remove('pulse');
    void boardFlashEl.offsetWidth;
    boardFlashEl.classList.add('pulse');
  }

  if (chainHideTimer) clearTimeout(chainHideTimer);
  chainHideTimer = setTimeout(() => chainReadoutEl.classList.remove('show', 'milestone'), 1300);
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
/** A short line over the board — a knock-out, a puzzle hint. */
function showBoardToast(text: string, color = 'var(--accent)') {
  boardToastEl.textContent = text;
  boardToastEl.style.setProperty('--toast-color', color);
  boardToastEl.classList.remove('show');
  void boardToastEl.offsetWidth;
  boardToastEl.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => boardToastEl.classList.remove('show'), 1800);
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
let lastChatAt = 0;

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

/** Quick chat, grouped so it can be scanned. The index sent on the wire is
 *  the position in CHAT_PHRASES, so the buttons are built from that flattened
 *  list rather than from a per-group counter. */
function buildChatPalette() {
  chatPaletteEl.innerHTML = '';
  const tabs = document.createElement('div');
  tabs.className = 'segmented chat-tabs';
  tabs.innerHTML =
    '<button class="segment" data-chat-tab="quick">Quick</button>' + '<button class="segment" data-chat-tab="type">Type ✏️</button>';
  tabs.addEventListener('click', (e) => {
    const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-chat-tab]')?.dataset.chatTab;
    if (tab !== 'quick' && tab !== 'type') return;
    sfx.buttonTap();
    setChatTab(tab);
  });
  chatPaletteEl.appendChild(tabs);

  const quick = document.createElement('div');
  quick.className = 'chat-pane';
  quick.dataset.pane = 'quick';
  chatPaletteEl.appendChild(quick);
  const typePane = document.createElement('div');
  typePane.className = 'chat-pane chat-type-pane';
  typePane.dataset.pane = 'type';
  chatPaletteEl.appendChild(typePane);

  let index = 0;
  for (const group of CHAT_GROUPS) {
    const heading = document.createElement('div');
    heading.className = 'chat-group-label';
    heading.textContent = group.label;
    quick.appendChild(heading);

    const row = document.createElement('div');
    row.className = 'chat-group';
    for (const phrase of group.phrases) {
      const i = index++;
      const btn = document.createElement('button');
      btn.className = 'chat-phrase';
      btn.textContent = phrase;
      btn.addEventListener('click', () => sendChat(i));
      row.appendChild(btn);
    }
    quick.appendChild(row);
  }
  setChatTab(chatPrefs.tab);
}

// ---------- Typed chat ----------
/**
 * Free-text chat, opt-in. Off by default; the player turns it on (from the
 * chat panel's Type tab or in Settings) and can turn it off again mid-match.
 * Off means both directions: you cannot type, and other players' typed
 * messages are not shown to you, so nobody receives free text they did not
 * ask for. The relay filters every message before broadcasting
 * (src/net/chatFilter.ts); this side filters again and adds per-player mute
 * and report.
 */
interface ChatPrefs {
  typed: boolean;
  tab: 'quick' | 'type';
}
const CHAT_PREFS_KEY = 'fissile.chat.v1';
const chatPrefs: ChatPrefs = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(CHAT_PREFS_KEY) ?? '{}');
    return { typed: raw.typed === true, tab: raw.tab === 'type' ? 'type' : 'quick' };
  } catch {
    return { typed: false, tab: 'quick' };
  }
})();
function saveChatPrefs() {
  try {
    localStorage.setItem(CHAT_PREFS_KEY, JSON.stringify(chatPrefs));
  } catch {
    // Private mode: the choice lasts for this session only.
  }
}
/** Seats whose typed messages this player has muted, for the current room. */
const mutedSeats = new Set<number>();
const typedChatGroup = $('typed-chat-group');

function setTypedChat(on: boolean) {
  chatPrefs.typed = on;
  saveChatPrefs();
  markSegment(typedChatGroup, 'typed', on ? '1' : '0');
  renderTypePane();
}

function setChatTab(tab: 'quick' | 'type') {
  chatPrefs.tab = tab;
  saveChatPrefs();
  chatPaletteEl
    .querySelectorAll<HTMLElement>('[data-chat-tab]')
    .forEach((b) => b.classList.toggle('active', b.dataset.chatTab === tab));
  chatPaletteEl
    .querySelectorAll<HTMLElement>('.chat-pane')
    .forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== tab));
  if (tab === 'type') renderTypePane();
}

function renderTypePane() {
  const pane = chatPaletteEl.querySelector<HTMLElement>('.chat-type-pane');
  if (!pane) return;
  if (!chatPrefs.typed) {
    pane.innerHTML =
      '<p class="chat-type-note">Write your own messages. They are filtered, links and numbers are removed, and anyone can mute or report you, so keep it friendly.</p>' +
      '<p class="chat-type-note dim">While this is off, other players’ typed messages stay hidden from you.</p>' +
      '<button type="button" class="primary-btn chat-type-on">Turn on typed chat</button>';
    pane.querySelector('.chat-type-on')!.addEventListener('click', () => {
      sfx.buttonTap();
      setTypedChat(true);
      pane.querySelector<HTMLInputElement>('.chat-input')?.focus();
    });
    return;
  }
  pane.innerHTML =
    '<form class="chat-type-form" autocomplete="off">' +
    `<input class="text-input chat-input" maxlength="${TYPED_MAX}" placeholder="Say something…" enterkeyhint="send" aria-label="Type a message" />` +
    '<button type="submit" class="primary-btn chat-send">Send</button>' +
    '</form>' +
    '<div class="chat-type-foot"><span class="chat-type-hint"></span><button type="button" class="chat-type-off">Turn off typed chat</button></div>';
  const form = pane.querySelector<HTMLFormElement>('form')!;
  const input = pane.querySelector<HTMLInputElement>('.chat-input')!;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (sendSay(input.value)) input.value = '';
  });
  pane.querySelector('.chat-type-off')!.addEventListener('click', () => {
    sfx.buttonTap();
    setTypedChat(false);
  });
}

function typedHint(text: string) {
  const el = chatPaletteEl.querySelector<HTMLElement>('.chat-type-hint');
  if (!el) return;
  el.textContent = text;
  setTimeout(() => {
    if (el.textContent === text) el.textContent = '';
  }, 2200);
}

function sendSay(raw: string): boolean {
  if (!net || !onlineMode || !chatPrefs.typed) return false;
  const text = cleanTyped(raw);
  if (!text) {
    typedHint(raw.trim() ? 'That can’t be sent.' : '');
    return false;
  }
  const now = performance.now();
  // Shares the quick-chat clock, the same as the relay does.
  if (now - lastChatAt < TYPED_COOLDOWN_MS) {
    typedHint('Slow down a moment…');
    return false;
  }
  if (!net.sendSay(text)) return false;
  lastChatAt = now;
  sfx.buttonTap();
  setChatPaletteOpen(false);
  showSay(myPlayerId, text);
  return true;
}

function receiveSay(from: number, raw: string) {
  if (from === myPlayerId || !chatPrefs.typed || mutedSeats.has(from)) return;
  const text = cleanTyped(raw);
  if (text) showSay(from, text);
}

/** A typed bubble. Someone else's can be tapped for Mute / Report, and it
 *  stays up while those are showing. */
function showSay(fromPlayerId: number, text: string) {
  const who = engine?.players.find((p) => p.id === fromPlayerId);
  const name = who?.name ?? 'Player';
  const theme = colorOf(fromPlayerId);
  const mine = fromPlayerId === myPlayerId;
  const bubble = document.createElement('div');
  bubble.className = 'taunt-bubble chat-bubble typed-bubble' + (mine ? '' : ' can-act');
  bubble.dataset.from = String(fromPlayerId);
  bubble.style.borderColor = `${theme.css}66`;
  bubble.innerHTML =
    `<span class="tn" style="color:${theme.css}">${escapeHtml(name)}</span>` +
    `<span class="cp">${escapeHtml(text)}</span>`;
  tauntFeedEl.appendChild(bubble);
  while (tauntFeedEl.childElementCount > 4) tauntFeedEl.firstElementChild?.remove();
  let timer = setTimeout(() => bubble.remove(), 5200);
  if (mine) return;
  bubble.addEventListener('click', () => {
    if (bubble.querySelector('.chat-actions')) return;
    clearTimeout(timer);
    bubble.classList.add('held');
    const actions = document.createElement('div');
    actions.className = 'chat-actions';
    actions.innerHTML = '<button type="button" data-act="mute">Mute</button><button type="button" data-act="report">Report</button>';
    actions.addEventListener('click', (e) => {
      e.stopPropagation();
      const act = (e.target as HTMLElement).dataset.act;
      if (act !== 'mute' && act !== 'report') return;
      if (act === 'report') net?.sendReport(fromPlayerId, text);
      mutedSeats.add(fromPlayerId);
      // Everything they said that is still on screen goes too.
      tauntFeedEl.querySelectorAll(`.typed-bubble[data-from="${fromPlayerId}"]`).forEach((b) => b.remove());
      showTypedNotice(act === 'report' ? `Reported and muted ${name}. Thanks for flagging it.` : `${name} muted for this room.`);
    });
    bubble.appendChild(actions);
    timer = setTimeout(() => bubble.remove(), 6000);
  });
}

function showTypedNotice(text: string) {
  const note = document.createElement('div');
  note.className = 'taunt-bubble chat-bubble';
  note.innerHTML = `<span class="cp">${escapeHtml(text)}</span>`;
  tauntFeedEl.appendChild(note);
  setTimeout(() => note.remove(), 3200);
}

onSegmentPick(typedChatGroup, (el) => setTypedChat(el.dataset.typed === '1'));
markSegment(typedChatGroup, 'typed', chatPrefs.typed ? '1' : '0');

function setTauntPaletteOpen(open: boolean) {
  tauntPaletteEl.classList.toggle('hidden', !open);
  tauntToggleEl.setAttribute('aria-expanded', String(open));
  // Only one palette at a time: they occupy the same corner, and two open at
  // once would cover most of the board.
  if (open) setChatPaletteOpen(false);
}

function setChatPaletteOpen(open: boolean) {
  chatPaletteEl.classList.toggle('hidden', !open);
  chatToggleEl.setAttribute('aria-expanded', String(open));
  if (open) setTauntPaletteOpen(false);
}

function sendChat(index: number) {
  if (!net || !onlineMode) return;
  const now = performance.now();
  // Mirrors the relay's cooldown so the button visibly goes dead rather than
  // the message vanishing silently — the relay is still the one enforcing it.
  if (now - lastChatAt < CHAT_COOLDOWN_MS) return;
  if (!net.sendChat(index)) return;
  lastChatAt = now;
  sfx.buttonTap();
  setChatPaletteOpen(false);
  chatToggleEl.disabled = true;
  setTimeout(() => {
    chatToggleEl.disabled = false;
  }, CHAT_COOLDOWN_MS);
  // Shown locally too. Without it the sender has no confirmation the message
  // went anywhere, and the room reads as one-sided.
  showChat(myPlayerId, index);
}

/**
 * A speech bubble from one player, coloured as their seat.
 *
 * Reuses the taunt feed so emoji and sentences stack in one column in the
 * order they were said — two separate feeds would let a reply appear above the
 * thing it was replying to.
 */
function showChat(fromPlayerId: number, index: number) {
  const phrase = CHAT_PHRASES[index];
  if (!phrase) return;
  const who = engine?.players.find((p) => p.id === fromPlayerId);
  const theme = colorOf(fromPlayerId);
  const bubble = document.createElement('div');
  bubble.className = 'taunt-bubble chat-bubble';
  bubble.style.borderColor = `${theme.css}66`;
  bubble.innerHTML =
    `<span class="tn" style="color:${theme.css}">${escapeHtml(who?.name ?? 'Player')}</span>` +
    `<span class="cp">${escapeHtml(phrase)}</span>`;
  tauntFeedEl.appendChild(bubble);
  while (tauntFeedEl.childElementCount > 4) tauntFeedEl.firstElementChild?.remove();
  // Longer than a taunt: a sentence takes longer to read than an emoji.
  setTimeout(() => bubble.remove(), 4200);
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

chatToggleEl.addEventListener('click', () => {
  sfx.buttonTap();
  setChatPaletteOpen(chatPaletteEl.classList.contains('hidden'));
});

// Tapping the board (or anywhere else) closes the palette.
document.addEventListener('pointerdown', (e) => {
  // Cheap guard first: this fires on every board tap, and with both palettes
  // already closed there is nothing to do but four needless DOM writes.
  if (tauntPaletteEl.classList.contains('hidden') && chatPaletteEl.classList.contains('hidden')) return;
  if (tauntBarEl.contains(e.target as Node)) return;
  setTauntPaletteOpen(false);
  setChatPaletteOpen(false);
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
  if (!seconds || onlineMode || lessonMode || !engine || engine.gameOver) return;
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
  commentator.beforeAiMove();
  setTimeout(() => {
    if (generation !== soundGeneration || !engine || engine.gameOver) {
      animating = false;
      return;
    }
    const move =
      activeBot?.deep && engine.players.length === 2
        ? chooseMoveDeep(engine, AI_PLAYER_ID)
        : chooseMove(engine, AI_PLAYER_ID, skill);
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
    const name = seatName(i);
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
  const size = boardDims();
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
  renderer!.setHoverTest(localHoverTest);
  renderMatchBanner();
  startTurnClock();
  if (GAME_MODES[modeKey].solo) startNovaCommentary(-1);
  maybeRunAiTurn();
}

/** Tears down whatever game is currently mounted — stops the renderer's
 *  animation loop and invalidates any sound still pending from it. Call this
 *  any time the player leaves the game screen without starting a new game
 *  (starting one already tears down the old game via mountGame below). */
function leaveGameScreen() {
  commentator.stop();
  nova.stop();
  const wasLesson = lessonMode;
  lessonMode = false;
  lessonToken++;
  lessonBarEl.classList.add('hidden');
  lessonActionsEl.classList.add('hidden');
  novaDockEl.classList.remove('lesson');
  screenGame.classList.remove('lesson-on');
  // A match left part-way is exactly what "match completion" in §14 measures
  // against, so it has to be reported as loudly as a finished one.
  if (matchStartedAt && engine && !engine.gameOver && !wasLesson) {
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
  dailyMode = false;
  dailyPuzzle = null;
  puzzleHudEl.classList.add('hidden');
  boardToastEl.classList.remove('show');
}

/** Returns false if the player left before the renderer chunk finished
 *  loading, in which case nothing was mounted and the caller should stop. */
async function mountGame(
  newEngine: GameEngine,
  style: OrbStyle,
  opts: { fromSnapshot?: boolean; daily?: boolean; lesson?: boolean } = {}
): Promise<boolean> {
  soundGeneration++;
  commentator.stop();
  nova.stop();
  winNovaEl.classList.add('hidden');
  lessonMode = opts.lesson === true;
  if (!lessonMode) lessonToken++;
  lessonBarEl.classList.toggle('hidden', !lessonMode);
  lessonActionsEl.classList.add('hidden');
  novaDockEl.classList.toggle('lesson', lessonMode);
  screenGame.classList.toggle('lesson-on', lessonMode);
  // Only startDailyPuzzle mounts a puzzle; every other way onto a board is a
  // normal match and clears any puzzle left over.
  dailyMode = opts.daily === true;
  if (!dailyMode) dailyPuzzle = null;
  puzzleHudEl.classList.toggle('hidden', !dailyMode);
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
  renderer.onStats = (fps) => {
    fpsMeterEl.textContent = `${fps} FPS`;
  };
  fpsMeterEl.textContent = '';
  fpsMeterEl.classList.toggle('hidden', !getGraphics().showFps);
  renderer.resetVisual();
  // Keep the tiles-in animation either way, but a resumed match then adopts
  // the live position instead of starting from an empty lattice.
  if (opts.fromSnapshot) renderer.syncToEngine();
  renderPills();
  // Snapped, not eased: there is no previous turn to hand off from.
  syncBoardTurnColor(true);
  animating = false;
  matchStartedAt = Date.now();
  lastRated = null;
  renderWinRank();
  telemetry.event('match_start', {
    mode: modeKey,
    size: boardSizeKey,
    players: newEngine.players.length,
    online: onlineMode,
    // A bot match is neither a human match nor pass-and-play, and lumping it
    // in with either makes mode popularity meaningless.
    opponent: dailyMode ? 'daily' : onlineMode ? 'human' : activeBot ? 'bot' : 'local',
    resumed: opts.fromSnapshot === true,
  });

  exposeDebug();
  return true;
}

function exposeDebug() {
  if (import.meta.env.DEV) {
    // Getters, so the console sees the live match rather than whatever was
    // mounted when this ran (nothing, at boot).
    (window as any).__debug = {
      get engine() {
        return engine;
      },
      get renderer() {
        return renderer;
      },
      get net() {
        return net;
      },
      sfx,
      haptics,
      nova,
      commentator,
      onCellTapLocal,
      onCellTapOnline,
      onCellTapLesson,
    };
  }
}

async function onCellTapLocal(row: number, col: number) {
  if (!engine || !renderer || animating) return;
  if (!engine.canPlay(row, col)) return;
  animating = true;
  sfx.unlock();
  await applyAndAnimateMove(row, col);
}

/**
 * Whether a cell is worth lighting under the cursor.
 *
 * Not simply "is this a legal move": during the AI's or a bot's turn the board
 * is not yours to act on, and a cell that lifts when you cannot use it is a
 * promise the game does not keep.
 */
function localHoverTest(row: number, col: number): boolean {
  if (!engine || animating || engine.gameOver) return false;
  const current = engine.currentPlayer().id;
  if (activeBot && current !== 0) return false;
  if (GAME_MODES[modeKey].solo && current === AI_PLAYER_ID) return false;
  return engine.canPlay(row, col);
}

/** Online, the same idea: only on your own turn. */
function onlineHoverTest(row: number, col: number): boolean {
  if (!engine || animating || engine.gameOver) return false;
  if (engine.currentPlayer().id !== myPlayerId) return false;
  return engine.canPlay(row, col);
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

async function applyAndAnimateMove(row: number, col: number): Promise<MoveResult | null> {
  if (!engine || !renderer) return null;
  // The board is locked from the first orb to the last wave of the cascade,
  // whoever made the move. Callers used to take this lock themselves, and the
  // one that did not — a move arriving from the other player online — left
  // the board open: the engine already says it is your turn the instant their
  // move is applied, so you could fire your own reaction into the middle of
  // theirs. Released below once the cascade has finished playing.
  animating = true;
  stopTurnClock();
  commentator.disarmIdle();
  const mover = engine.currentPlayer().id;
  const result = engine.applyMove(row, col);
  const myGeneration = soundGeneration;

  matchTurns++;
  matchBestChain = Math.max(matchBestChain, result.chain);
  matchBestCapture = Math.max(matchBestCapture, result.captured);
  if (mover === localSeatId() && !dailyMode && !lessonMode) stats.recordChain(result.chain, result.captured);

  // The engine resolves the whole cascade synchronously, but the board
  // animates it wave by wave — so "who won" and "what the board visibly
  // shows" can briefly disagree mid-cascade. Reveal the winner at the exact
  // wave where the board actually matches that outcome (the loser's last
  // orb has visibly disappeared), not a frame before and not by waiting for
  // any further self-only cascading the winner's own cells keep doing.
  let winShown = false;
  const showWinIfBoardMatches = () => {
    if (myGeneration !== soundGeneration) return; // player has left this game
    if (dailyMode || lessonMode) return; // a puzzle try is scored, not won; a lesson is neither
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
          sfx.place(ev.orbs / Math.max(1, engine?.criticalMass(ev.row, ev.col) ?? 4));
          haptics.place();
        } else if (ev.type === 'explode') {
          // The wind-up whir plays now; the boom waits for onBlast below, the
          // instant the board actually detonates.
          sfx.chargeUp(ev.wave);
        }
      },
      (depth, _cells, captured) => {
        if (myGeneration !== soundGeneration) return;
        if (captured > 0) sfx.capture();
        showChain(depth, mover);
        showWinIfBoardMatches();
      },
      (wave, cells) => {
        if (myGeneration !== soundGeneration) return;
        sfx.explode(1, wave, cells);
        haptics.explode(wave);
      }
    )
    .catch((err) => {
      console.error('Board animation error (continuing anyway):', err);
    });

  await playPromise;
  if (myGeneration !== soundGeneration) return null; // player has left this game
  if (dailyMode) return result;
  if (lessonMode) {
    // The lesson script decides what happens next; just leave the board ready.
    renderPills();
    syncBoardTurnColor();
    animating = false;
    return result;
  }

  // Safety net: if the board somehow never reported a matching state
  // mid-cascade (shouldn't happen for a real win), show it once everything
  // has settled rather than leave the player without a win screen.
  showWinIfBoardMatches();

  for (const ev of result.events) {
    if (ev.type === 'eliminate') {
      sfx.eliminate();
      haptics.eliminate();
      const out = engine?.players.find((p) => p.id === ev.player);
      // A knock-out in a three-plus player game is a moment; in a duel it is
      // the win itself, which the result card announces instead.
      if (out && (engine?.players.length ?? 0) > 2 && !result.gameOver) {
        showBoardToast(`${out.name} eliminated`, colorOf(out.id).css);
      }
    }
  }

  if (commentator.active && engine) commentator.afterMove(engine, mover, result);

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
    if (commentator.active && engine && engine.currentPlayer().id !== AI_PLAYER_ID) commentator.armIdle();
  }
  return result;
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
  if (commentator.active) {
    commentator.end();
    const won = winnerId !== AI_PLAYER_ID;
    novaLastResult = won ? 'won' : 'lost';
    novaGames++;
    try {
      localStorage.setItem(NOVA_GAMES_KEY, String(novaGames));
    } catch {
      /* storage unavailable */
    }
    winNovaEl.classList.remove('hidden');
    nova.attach(winNovaEl);
    const textEl = winNovaEl.querySelector<HTMLElement>('.nova-text');
    if (textEl) textEl.textContent = '';
    window.setTimeout(() => void nova.say(won ? 'player_win' : 'cpu_win', { priority: 3, persist: true }), 500);
  } else {
    winNovaEl.classList.add('hidden');
  }
  if (!engine) return;
  stopTurnClock();
  hideChain();
  sfx.win();
  haptics.win();
  const theme = colorOf(winnerId);
  // The board settles on the winner at the moment the win is revealed, rather
  // than waiting for the rest of the cascade to finish animating.
  renderer?.setTurnColor(theme.base);
  if (!reducedMotion()) renderer?.celebrate(winnerId);

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
  return randomPlayerName();
}


function showOnlineError(message: string) {
  onlineErrorEl.textContent = message;
  onlineErrorEl.classList.remove('hidden');
}
function clearOnlineError() {
  onlineErrorEl.classList.add('hidden');
}

// ---------- Account, leaderboards, friends ----------
const accountStripEl = $('account-strip');
const accountOfflineEl = $('account-offline');
const boardTabs = $('board-tabs');
const boardRowsEl = $('board-rows');
const friendToolsEl = $('friend-tools');
const friendCodeInput = $<HTMLInputElement>('friend-code-input');
const friendMsgEl = $('friend-msg');
const myCodeEl = $('my-code');
let boardTab: 'world' | 'friends' = 'world';

/**
 * The rank card: emblem, tier, record, and how far through the tier you are.
 *
 * A rating on its own says nothing — "1043" is not information a player can
 * act on. The tier gives the number a meaning, the bar gives it a direction,
 * and the emblem gives it something to want.
 */
/**
 * Holds the rank card's space open while the account is being fetched.
 *
 * The card used to be `display: none` until the profile arrived, so it went
 * from outside the layout to inside it in a single frame — appearing all at
 * once and shoving every button below it down as it landed. Reserving the
 * height it is going to need, and showing the shape of what is coming, turns
 * that into something arriving rather than something interrupting.
 *
 * Called synchronously on entering the online screen, before the round trip,
 * because the whole point is to be there first.
 */
function showAccountSkeleton() {
  if (account.profile) return; // already have it — nothing to wait for
  accountOfflineEl.classList.add('hidden');
  accountStripEl.classList.remove('hidden');
  accountStripEl.classList.add('is-loading');
  accountStripEl.innerHTML =
    '<div class="skeleton skeleton-emblem"></div>' +
    '<div class="skeleton-meta">' +
    '<div class="skeleton skeleton-line w-40"></div>' +
    '<div class="skeleton skeleton-line w-70"></div>' +
    '<div class="skeleton skeleton-line w-90"></div>' +
    '</div>';
}

function renderAccountStrip() {
  const p = account.profile;
  // An empty panel reads as a missing feature rather than a missing server,
  // which is exactly the wrong conclusion for a player to draw.
  accountOfflineEl.classList.toggle('hidden', Boolean(p));
  if (!p) {
    accountStripEl.classList.remove('is-loading');
    accountStripEl.classList.add('hidden');
    return;
  }
  accountStripEl.classList.remove('hidden');
  // Dropping the skeleton class releases the reserved height and lets the real
  // card fade up in its place.
  accountStripEl.classList.remove('is-loading');
  accountStripEl.classList.add('is-in');

  const rank = rankFor(p.rating);
  const next = nextRankAt(p.rating);
  const toNext = next === null ? null : next - p.rating;
  const progress = Math.round(rankProgress(p.rating) * 100);

  accountStripEl.innerHTML =
    `<div class="rank-emblem">${rankBadgeSvg(rank, 62)}</div>` +
    `<div class="rank-meta">` +
    // The name leads now: with the input collapsed, this card is the only
    // place the player can confirm who they are about to play as.
    `<div class="rank-who">` +
    `<span class="rank-player">${escapeHtml(p.name)}</span>` +
    `<button id="name-edit-btn" class="mini-btn" aria-controls="name-field">Edit</button>` +
    `</div>` +
    `<div class="rank-name" style="color:${rank.css}">${rank.name}</div>` +
    `<div class="rank-stats"><span class="av">${p.rating}</span> pts · ${p.wins}W / ${p.losses}L</div>` +
    // scaleX rather than width: a transform animates on the compositor,
    // where width re-runs layout on every frame.
    `<div class="rank-bar"><span style="transform:scaleX(${progress / 100});background:${rank.css}"></span></div>` +
    `<div class="rank-next">${
      toNext === null ? 'Top tier' : `${toNext} pts to ${rankFor(next!).name}`
    }</div>` +
    `</div>` +
    `<div class="rank-code">friend code<b>${escapeHtml(p.friendCode)}</b></div>`;

  // Rebuilt with the strip, so it is bound here rather than once at boot.
  document.getElementById('name-edit-btn')?.addEventListener('click', () => {
    sfx.buttonTap();
    setNameFieldOpen(true);
  });
}

/**
 * Shows or hides the name editor.
 *
 * Open when there is no name yet — that is the one moment it is the most
 * important thing on the screen — and closed afterwards, because a filled-in
 * form is clutter sitting where the rank card should be.
 */
function setNameFieldOpen(open: boolean) {
  nameFieldEl.classList.toggle('hidden', !open);
  if (open) {
    nameInput.focus();
    nameInput.select();
  }
}

/** Called when the player opens the online screen. Minting the account here
 *  rather than at boot means a purely local player never gets one. */
async function ensureAccount() {
  await account.ensure(nameInput.value.trim() || undefined);
  if (account.profile) {
    // The relay is the source of truth for the display name; keep the input in
    // step so a rename sticks rather than silently reverting on next join.
    nameInput.value = account.profile.name;
    // And keep the device's copy in step with it, so the two cannot drift into
    // disagreeing about who this player is.
    if (account.profile.name !== callsign) {
      callsign = account.profile.name;
      persistPrefs();
    }
  }
  renderAccountStrip();
  // Open only for someone who has never chosen a name — that one moment is
  // when the field is the most useful thing here. Everyone else gets the rank
  // card, and Edit if they want it back. `renderAccountStrip` has to run first:
  // with no account there is no strip, and hiding the field as well would leave
  // an offline player nothing at all.
  //
  // The request flag wins over both. Somebody who pressed "Change name" is
  // owed the field regardless of whether they already have a name — and it has
  // to be honoured *here*, after the account round trip, because this function
  // is what closes the field and it would otherwise undo a caller that opened
  // it a moment earlier.
  if (wantsRename) {
    wantsRename = false;
    setNameFieldOpen(true);
  } else {
    setNameFieldOpen(!account.profile || !callsign);
  }
}

const rankHeroEl = $('rank-hero');
const rankLadderEl = $('rank-ladder');

/** The top of the Ranks page: your emblem, how far into the tier you are, and
 *  the whole ladder with your place on it. */
function renderRankHero() {
  const me = account.profile;
  const rating = me?.rating ?? 0;
  const rank = rankFor(rating);
  const next = nextRankAt(rating);
  const progress = rankProgress(rating);
  if (me) {
    rankHeroEl.innerHTML =
      `<div class="rh-emblem">${rankBadgeSvg(rank, 112)}</div>` +
      `<div class="rh-meta">` +
      `<div class="rh-tier" style="color:${rank.css}">${rank.name}</div>` +
      `<div class="rh-rating"><b>${rating}</b> pts · ${me.wins}W ${me.losses}L</div>` +
      `<div class="rh-bar"><span style="transform:scaleX(${progress.toFixed(3)});background:${rank.css}"></span></div>` +
      `<div class="rh-next">${next === null ? 'Top tier — hold it' : `${next - rating} pts to ${rankFor(next).name}`}</div>` +
      `</div>`;
  } else {
    rankHeroEl.innerHTML =
      `<div class="rh-emblem dim">${rankBadgeSvg(RANKS[0], 112)}</div>` +
      `<div class="rh-meta"><div class="rh-tier">Unranked</div>` +
      `<div class="rh-next">Everyone starts Unranked at 0 points. Play ranked matches online to climb: finishing higher earns more. Private rooms and the computer do not count.</div></div>`;
  }
  const current = me ? RANKS.indexOf(rank) : -1;
  rankLadderEl.innerHTML = RANKS.map((r, i) => {
    const state = i === current ? 'now' : i < current ? 'done' : 'locked';
    return `<div class="rl-tier ${state}"><span class="rl-emblem">${rankBadgeSvg(r, 40)}</span><span class="rl-name">${r.name}</span><span class="rl-min">${r.min || 0}+</span></div>`;
  }).join('');
}

/** Friend code card: big, copyable, shareable. */
function renderFriendCard() {
  const me = account.profile;
  myCodeEl.classList.toggle('hidden', !me);
  if (!me) return;
  myCodeEl.innerHTML =
    `<div class="fc-label">Your friend code</div>` +
    `<div class="fc-code">${escapeHtml(me.friendCode)}</div>` +
    `<div class="fc-actions">` +
    `<button id="fc-copy" class="ghost-btn small-btn">Copy</button>` +
    `<button id="fc-share" class="primary-btn small-btn">Share</button>` +
    `</div>`;
  $('fc-copy').addEventListener('click', async () => {
    sfx.buttonTap();
    try {
      await navigator.clipboard.writeText(me.friendCode);
      $('fc-copy').textContent = 'Copied';
    } catch {
      $('fc-copy').textContent = 'Copy failed';
    }
    setTimeout(() => {
      const btn = document.getElementById('fc-copy');
      if (btn) btn.textContent = 'Copy';
    }, 1600);
  });
  $('fc-share').addEventListener('click', () => {
    sfx.buttonTap();
    void share({
      title: 'Add me on FISSILE',
      text: `Add me on FISSILE — my friend code is ${me.friendCode}. Let's see who sets off the bigger chain.`,
      url: PUBLIC_ORIGIN,
    });
  });
}

async function renderBoards() {
  boardRowsEl.innerHTML = '<div class="board-empty">Loading…</div>';
  friendToolsEl.classList.toggle('hidden', boardTab !== 'friends');
  const me = account.profile;
  renderRankHero();
  renderFriendCard();

  try {
    const rows = boardTab === 'world' ? await account.worldBoard() : await account.friendsBoard();
    if (rows.length === 0) {
      boardRowsEl.innerHTML =
        boardTab === 'world'
          ? '<div class="board-empty">Nobody has earned ranked points yet. Ranked matches count towards the ladder; private rooms do not.</div>'
          : '<div class="board-empty">No friends yet. Share your code below, or add someone else’s.</div>';
      return;
    }
    boardRowsEl.innerHTML = rows
      .map((r, i) => {
        const mine = me && r.id === me.id;
        const rank = rankFor(r.rating);
        const podium = i < 3 ? ` podium p${i + 1}` : '';
        return `<div class="board-row${mine ? ' me' : ''}${podium}">
          <span class="bpos">${i + 1}</span>
          <span class="bavatar">${avatarSvg(r.avatar || defaultAvatarFor(r.id), 34)}</span>
          <span class="bname">${escapeHtml(r.name)}${mine ? ' <i>you</i>' : ''}</span>
          <span class="bstat"><span class="brank" style="color:${rank.css}">${rank.name}</span> · ${r.wins}W · best ×${r.bestChain}</span>
          <span class="bbadge">${rankBadgeSvg(rank, 30)}</span>
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

/**
 * Saves the callsign in both places it has to live: on this device, so a
 * returning player is not handed a fresh random name, and on the relay, so the
 * ladder stops showing the old one. Silence is the enemy here — a name field
 * that saves invisibly is one people re-type every visit to be sure.
 */
async function saveCallsign(announce: boolean) {
  const name = nameInput.value.trim().slice(0, MAX_CALLSIGN_LENGTH);
  if (!name) {
    nameInput.value = callsign;
    return;
  }
  if (name === callsign && !announce) return;
  callsign = name;
  persistPrefs();

  if (!account.isSignedIn) {
    // No account yet — it will be minted under this name the first time the
    // player does something online.
    if (announce) flashNameNote('Saved on this device.');
    return;
  }
  try {
    await account.rename(name);
    renderAccountStrip();
    if (announce) flashNameNote('Saved.');
  } catch (err) {
    // The local half already succeeded, so say what is actually true rather
    // than implying nothing was kept.
    flashNameNote(err instanceof Error ? err.message : 'Saved here, but the ladder could not be reached.');
  }
}

let nameNoteTimer = 0;
function flashNameNote(message: string) {
  nameNoteEl.textContent = message;
  clearTimeout(nameNoteTimer);
  nameNoteTimer = window.setTimeout(() => {
    nameNoteEl.textContent = '';
  }, 2600);
}

nameSaveBtn.addEventListener('click', () => {
  sfx.buttonTap();
  void saveCallsign(true);
  // Saving is the end of the interaction, so the field gets out of the way.
  setNameFieldOpen(false);
});

// The ranked flow is its own screen. It has one decision, one action, and a
// live searching state that wants the room — as a panel it was permanently the
// tallest thing on the hub.
$('open-ranked-btn').addEventListener('click', () => {
  sfx.unlock();
  sfx.buttonTap();
  clearOnlineError();
  setQuickSearching(false);
  hideQuickFallback();
  renderQuickPreview();
  showScreen(screenRanked);
  void renderPresence();
});

// The searching counts stay live while the ranked screen is open.
let presenceTimer = 0;
setInterval(() => {
  if (screenRanked.classList.contains('hidden') || document.hidden) return;
  if (++presenceTimer % 2 === 0) void renderPresence();
}, 6000);

$('ranked-back-btn').addEventListener('click', () => {
  sfx.buttonTap();
  // Leaving the screen abandons the search rather than leaving it running
  // invisibly, which would drop the player into a match from a screen they
  // had walked away from.
  if (quickMatchPending || queuedCode) void cancelQuickMatch();
  showScreen(screenOnline);
});

// Blurring the field saves too — the button is reassurance, not the only way.
nameInput.addEventListener('change', () => void saveCallsign(false));

nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    nameInput.blur();
    void saveCallsign(true);
  }
});

// ---------- Quick match ----------
let quickMode: GameModeKey = DEFAULT_MODE;
let quickBoardSize: BoardSizeKey | 'auto' = 'auto';
let quickPlayers: RankedPlayers = 2;
const quickPlayersGroup = $('quick-players-group');
const quickPointsEl = $('quick-points');

/** The points table for the chosen player count, so a player knows what a
 *  finish is worth before they queue. */
function renderQuickPoints() {
  const table = PLACE_POINTS[quickPlayers];
  quickPointsEl.innerHTML =
    table
      .map((pts, i) => `<span class="pt ${pts >= 0 ? 'up' : 'down'}"><b>${ordinal(i + 1)}</b>${pts > 0 ? '+' : ''}${pts}</span>`)
      .join('') + `<span class="pt down left"><b>Leave</b>${LEAVE_PENALTY}</span>`;
}

onSegmentPick(quickPlayersGroup, (el) => {
  const n = Number(el.dataset.players);
  quickPlayers = (n === 3 || n === 4 ? n : 2) as RankedPlayers;
  renderQuickPoints();
});
renderQuickPoints();
/** The room code we parked in the matchmaker queue, if we are still waiting. */
let queuedCode: string | null = null;

function setQuickSearching(searching: boolean, text = quickPlayers === 2 ? 'Searching for an opponent…' : `Searching for ${quickPlayers - 1} opponents…`) {
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
    const { code, waiting, boardSize } = await NetClient.quickMatch(
      quickMode,
      quickBoardSize,
      account.credentials?.id,
      quickPlayers
    );
    queuedCode = waiting ? code : null;
    rankedMatch = true;
    // Ranked rooms are private: the queue is the only way in, so nobody can
    // walk into one from the public list.
    await client.connect(code, nameInput.value.trim() || randomName());
    if (waiting) {
      // We are the room now. The relay starts it once it has its players.
      lobbyMode = quickMode;
      lobbyBoardSize = boardSize === 'small' || boardSize === 'large' ? boardSize : 'medium';
      selectLobbyMode(quickMode);
      quickMatchPending = true;
      // Deliberately *not* the lobby. A room is created behind the scenes so
      // an opponent has somewhere to be matched into, but showing it would put
      // the player in a one-person lobby with a Start button — which reads as
      // "set up a game" when what they asked for was to be matched. The honest
      // state is still searching, so that is what stays on screen.
      setQuickSearching(true);
      // A practice bot only makes sense in place of one opponent.
      if (quickPlayers === 2) startBotFallbackTimer();
    } else {
      // Somebody was already waiting — we joined their room and the host's
      // client starts it as soon as it sees us. Still no lobby: the game is
      // about to begin on its own.
      quickMatchPending = true;
      setQuickSearching(true, quickPlayers === 2 ? 'Opponent found — starting…' : 'Joined a group — waiting for the rest…');
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
  const bot = pickBot(null);
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
    const bot = pickBot(null);
    // Offered on the search, not in the lobby. A queued player now waits on the
    // online screen, so an offer rendered into the lobby would sit on a screen
    // nobody is looking at — a solo player would simply wait forever.
    quickFallbackMsg.textContent = `No one is queued on these settings yet. Keep waiting, or play ${bot.name} now.`;
    quickFallbackBtn.textContent = `Play ${bot.name} (bot)`;
    quickFallbackBtn.onclick = () => {
      stopBotFallbackTimer();
      if (queuedCode) void NetClient.cancelQuickMatch(queuedCode);
      queuedCode = null;
      // Cleared before disconnecting: the socket closing triggers a roster
      // render, and a stale pending flag would have it try to start a match
      // that is being abandoned.
      quickMatchPending = false;
      disconnectNet();
      hideQuickFallback();
      setQuickSearching(false);
      void startBotMatch(bot);
    };
    // The search stays running underneath: the offer is an alternative, not a
    // replacement, and a real opponent arriving still wins.
    quickFallbackEl.classList.remove('hidden');
  }, BOT_FALLBACK_MS);
}

async function cancelQuickMatch() {
  sfx.buttonTap();
  stopBotFallbackTimer();
  if (queuedCode) void NetClient.cancelQuickMatch(queuedCode);
  queuedCode = null;
  quickMatchPending = false;
  setQuickSearching(false);
}

quickMatchBtn.addEventListener('click', () => void startQuickMatch());
quickCancelBtn.addEventListener('click', () => void cancelQuickMatch());

onSegmentPick(quickSizeGroup, (el) => {
  quickBoardSize = el.dataset.size as BoardSizeKey | 'auto';
  renderQuickPreview();
});

// ---------- Bot matches ----------
/** The opponent when the current game is against the roster, else null. */
let activeBot: Bot | null = null;

/* The roster used to be browsable here. It is not any more: picking your own
 * opponent off a list is not matchmaking, and a screen that leads with rows of
 * bots reads as a game with nobody in it. Quick match still falls back to one
 * — see offerBotInstead — because the alternative for a player who finds an
 * empty queue is nothing at all. It still *offers* rather than substituting
 * silently, so a win is never ambiguous about who it was against.
 */

async function renderPresence() {
  let live = '—';
  try {
    const p = await NetClient.presence();
    live = String(p.queued + p.inRooms);
    quickPlayersGroup.querySelectorAll<HTMLElement>('.seg-count').forEach((el) => {
      const n = p.searching?.[el.dataset.count ?? ''] ?? 0;
      el.textContent = n > 0 ? `${n} searching` : '';
    });
  } catch {
    // Relay unreachable: say so rather than inventing a number.
    live = '—';
  }
  // The real count, allowed to read zero. Inflating it is worse than useless:
  // someone shown a busy lobby who then waits without a match learns the
  // number was invented and stops believing anything else on the screen.
  presenceStripEl.innerHTML =
    `<span class="dot-live"></span><span><span class="pv">${live}</span> players online</span>`;
  $('online-presence-n').textContent = live;
}

/**
 * Starts a 1v1 against the roster. Runs entirely on this device — there is no
 * relay round trip and nothing is reported to the ladder, which is exactly why
 * a bot match can never move anyone's rating.
 */
async function startBotMatch(bot: Bot, opts: { size?: BoardSizeKey; mode?: GameModeKey } = {}) {
  sfx.unlock();
  sfx.buttonTap();
  if (net) disconnectNet();
  onlineMode = false;
  activeBot = bot;
  quickMatchPending = false;
  setQuickSearching(false);
  resetSeries();

  const pickedMode = opts.mode ?? quickMode;
  const size = opts.size ? boardDims(opts.size) : BOARD_SIZES[quickBoardSize === 'auto' ? 'medium' : quickBoardSize];
  const myTheme = themeForSeat(0, pickedMode);
  const botTheme = themeForSeat(1, pickedMode);
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
  modeKey = GAME_MODES[pickedMode].teams ? DEFAULT_MODE : pickedMode;
  const seed = randomSeed();
  const newEngine = new GameEngine({
    rows: size.rows,
    cols: size.cols,
    players,
    kinds: layoutForMode(modeKey, size.rows, size.cols, seed),
  });
  if (!(await mountGame(newEngine, orbStyle))) return;
  renderer!.setCellTapHandler(onCellTapLocal);
  renderer!.setHoverTest(localHoverTest);
  renderMatchBanner();
  showScreen(screenGame);
  if (bot.id.startsWith('cpu-')) startNovaCommentary(Number(bot.id.slice(4)));
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
    roomsListEl.innerHTML = `<div class="rooms-empty">${escapeHtml(msg)} Quick match and private rooms still work.</div>`;
  }
}

roomsRefreshBtn.addEventListener('click', () => {
  sfx.buttonTap();
  void refreshRooms();
  void renderPresence();
});

$('play-online-btn').addEventListener('click', () => {
  sfx.buttonTap();
  goTab('online');
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
    rankedMatch = false;
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
    rankedMatch = false;
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
  // Errors land where the player is looking: in the lobby under its Start
  // button, otherwise on the Online page.
  client.onError = (message) => {
    if (!screenLobby.classList.contains('hidden')) {
      lobbyStartHint.textContent = message;
      lobbyStartHint.classList.add('lobby-start-error');
      lobbyStartHint.classList.remove('hidden');
      return;
    }
    showOnlineError(message);
  };
  client.onGameStarted = (rows, cols, players, style, mode, seed) =>
    startOnlineGame(rows, cols, players, style, mode, seed);
  client.onMove = (row, col) => queueRemoteMove(row, col);
  client.onResume = (rows, cols, style, mode, snapshot) => {
    void resumeOnlineGame(rows, cols, style, mode, snapshot);
  };
  client.onTaunt = (from, emoji) => showTaunt(from, emoji);
  // Own messages are already shown on send, so echoing the broadcast back
  // would double every bubble the sender posts.
  client.onChat = (from, phrase) => {
    if (from !== myPlayerId) showChat(from, phrase);
  };
  client.onSay = (from, text) => receiveSay(from, text);
  // Mutes are per room; a new connection starts with a clean slate.
  mutedSeats.clear();
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
  client.onStrike = (player, count, limit) => {
    const who = engine?.players.find((p) => p.id === player);
    if (player === myPlayerId) {
      showBoardToast(
        count >= limit - 1
          ? `Out of time! Last chance: miss one more turn and you're out.`
          : `Out of time: a move was played for you (${count} of ${limit}).`,
        '#ffb454'
      );
      haptics.eliminate();
    } else if (who) {
      showBoardToast(`${who.name} ran out of time (${count}/${limit})`, colorOf(player).css);
    }
  };
  client.onForfeit = (player, reason) => queueForfeit(player, reason);
  client.onRated = (results) => {
    const mine = results.find((r) => r.player === myPlayerId);
    if (!mine) return;
    lastRated = { rating: mine.rating, delta: mine.delta, place: mine.place, left: mine.left };
    renderWinRank();
    // Re-read the profile so the panel behind the card agrees with the number
    // on it — wins and losses moved too, not just the rating. ensure() re-reads
    // an existing account rather than minting a second one.
    void account.ensure().then(renderAccountStrip);
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
  void renderLobbyInvites();
}

/**
 * The friends who can be pulled straight into this room.
 *
 * The room already has a shareable code, but sharing it means leaving the game
 * to go and find the person. The people already on your list get a button
 * instead. Hidden entirely when there is nobody to show: a panel promising a
 * feature you cannot use is worse than no panel.
 */
async function renderLobbyInvites() {
  const code = net?.roomCode;
  if (!code || !account.credentials) {
    lobbyInviteField.classList.add('hidden');
    return;
  }

  const rows = await account.friendsBoard();
  // friendsBoard puts you on your own board, which is right for a leaderboard
  // and wrong for a list of people to invite.
  const friends = rows.filter((r) => r.id !== account.profile?.id);
  if (!friends.length) {
    lobbyInviteField.classList.add('hidden');
    return;
  }

  lobbyInviteField.classList.remove('hidden');
  lobbyInviteListEl.innerHTML = friends
    .map((f) => {
      const avatar = avatarSvg(f.avatar || defaultAvatarFor(f.id), 26);
      return [
        '<div class="invite-row">',
        `<span class="invite-avatar">${avatar}</span>`,
        `<span class="invite-name">${escapeHtml(f.name)}</span>`,
        `<button class="mini-btn invite-send" data-friend="${escapeHtml(f.id)}">Invite</button>`,
        '</div>',
      ].join('');
    })
    .join('');
}

lobbyInviteListEl.addEventListener('click', async (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('.invite-send');
  const friendId = button?.dataset.friend;
  if (!button || !friendId || !net?.roomCode) return;
  sfx.buttonTap();
  // Disabled while in flight, then left saying what happened. The only
  // feedback an invite can give is on the sender's screen — the result of it
  // lands on somebody else's.
  button.disabled = true;
  const res = await account.invite(friendId, net.roomCode);
  button.textContent = res.ok ? 'Sent' : (res.error ?? 'Failed');
  if (!res.ok) {
    setTimeout(() => {
      button.textContent = 'Invite';
      button.disabled = false;
    }, 2400);
  }
});

/**
 * Invites waiting for this player, shown on the online screen.
 *
 * Collected rather than pushed: someone who is not in a room has no socket to
 * push down, and this screen is the only place an invite is actionable anyway.
 */
async function renderInvites() {
  if (!account.credentials) {
    inviteInboxEl.classList.add('hidden');
    return;
  }
  const invites = await account.invites();
  $('tab-dot-online').classList.toggle('hidden', invites.length === 0);
  if (!invites.length) {
    inviteInboxEl.classList.add('hidden');
    inviteInboxEl.innerHTML = '';
    return;
  }
  inviteInboxEl.classList.remove('hidden');
  inviteInboxEl.innerHTML = invites
    .map((i) => {
      const avatar = avatarSvg(i.fromAvatar || defaultAvatarFor(i.fromId), 26);
      const from = escapeHtml(i.fromId);
      return [
        '<div class="invite-row incoming">',
        `<span class="invite-avatar">${avatar}</span>`,
        `<span class="invite-name"><strong>${escapeHtml(i.fromName)}</strong> invited you</span>`,
        `<button class="mini-btn invite-join" data-code="${escapeHtml(i.code)}" data-from="${from}">Join</button>`,
        `<button class="mini-btn invite-dismiss" data-from="${from}" aria-label="Dismiss">×</button>`,
        '</div>',
      ].join('');
    })
    .join('');
}

inviteInboxEl.addEventListener('click', async (e) => {
  const target = e.target as HTMLElement;
  const join = target.closest<HTMLButtonElement>('.invite-join');
  const dismiss = target.closest<HTMLButtonElement>('.invite-dismiss');

  if (join?.dataset.code && join.dataset.from) {
    sfx.buttonTap();
    // Cleared before joining rather than after: coming back to this screen
    // later and being invited into a room you are already in reads as a bug.
    void account.dismissInvite(join.dataset.from);
    inviteInboxEl.classList.add('hidden');
    await joinRoomByCode(join.dataset.code);
    return;
  }

  if (dismiss?.dataset.from) {
    sfx.buttonTap();
    await account.dismissInvite(dismiss.dataset.from);
    void renderInvites();
  }
});

roomCodeBtn.addEventListener('click', async () => {
  if (!net) return;
  const code = net.roomCode;
  // The system share sheet first: sending a room to a group chat should be
  // one tap, not copy-switch-app-paste.
  const outcome = await share({
    title: 'Join my FISSILE room',
    text: `Join my FISSILE room — code ${code} 💥`,
    url: roomLink(code),
  });
  if (outcome === 'failed') return;
  const original = lobbyHintEl.textContent;
  lobbyHintEl.textContent = outcome === 'copied' ? 'invite link copied' : 'invite sent';
  setTimeout(() => {
    lobbyHintEl.textContent = original;
  }, 1600);
});

lobbyStartBtn.addEventListener('click', () => {
  sfx.buttonTap();
  net?.startGame(lobbyBoardSize, lobbyOrbStyle, lobbyMode, lobbyLandscape);
});

$('lobby-back-btn').addEventListener('click', () => {
  sfx.buttonTap();
  stopBotFallbackTimer();
  // Leaving the lobby also gives up any queue slot, or the next quick-matcher
  // gets sent into an empty room.
  if (queuedCode) void NetClient.cancelQuickMatch(queuedCode);
  queuedCode = null;
  quickMatchPending = false;
  disconnectNet();
  showScreen(screenOnline);
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
  // Said on the button and right under it: a greyed-out Start with the reason
  // printed half a screen away read as the button being broken.
  lobbyStartBtn.textContent = enoughForMode ? 'Start reaction' : 'Waiting for players…';
  lobbyStartHint.classList.toggle('lobby-start-error', false);
  lobbyStartHint.textContent = !isHost || enoughForMode
    ? ''
    : spec.teams
      ? `Team Battle needs 4 or 6 players — ${connectedCount} here. Tap the code above to invite more.`
      : 'Waiting for a friend to join. Tap the room code above to send it to them.';
  lobbyStartHint.classList.toggle('hidden', !lobbyStartHint.textContent);
  lobbyModeBlurbEl.textContent = enoughForMode
    ? onlineBlurb(lobbyMode)
    : spec.teams
      ? 'Team Battle needs an even roster of at least 4.'
      : 'Need at least 2 players to start.';

  // A quick match should never make anyone hunt for a Start button — the point
  // of it is that you asked to play and then you are playing.
  if (quickMatchPending) {
    if (connectedCount < quickPlayers) {
      // The player is watching the search, not this lobby, so the status they
      // can actually see is the one worth updating.
      setQuickSearching(
        true,
        quickPlayers === 2 ? 'Searching for an opponent…' : `Found ${connectedCount} of ${quickPlayers} players — searching…`
      );
      lobbyHintEl.textContent = 'waiting for players…';
      return;
    }
    // Full: the relay starts a ranked room on its own.
    quickMatchPending = false;
    queuedCode = null;
    stopBotFallbackTimer();
    setQuickSearching(true, 'Match found — starting…');
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

/**
 * Moves from the relay play strictly one after another. The relay has no
 * animation to wait for, so a quick reply — or the Blitz clock playing a
 * timed-out turn — can arrive while the previous cascade is still on screen.
 * Played at once, the two animate over each other and the board shows neither
 * correctly; queued, the second simply waits for the first to finish.
 */
let remoteMoves: Promise<unknown> = Promise.resolve();
function queueRemoteMove(row: number, col: number) {
  const generation = soundGeneration;
  remoteMoves = remoteMoves
    .then(() => (generation === soundGeneration ? applyAndAnimateMove(row, col) : null))
    .catch((err) => console.error('online move failed to play:', err));
}

/** A forfeit joins the same queue as moves, so it lands after any cascade the
 *  board is still animating — never in the middle of one. */
function queueForfeit(playerId: number, reason: 'timeout' | 'left') {
  const generation = soundGeneration;
  remoteMoves = remoteMoves
    .then(() => (generation === soundGeneration ? applyForfeit(playerId, reason) : null))
    .catch((err) => console.error('forfeit failed to apply:', err));
}

function applyForfeit(playerId: number, reason: 'timeout' | 'left') {
  if (!engine || !renderer) return;
  const who = engine.players.find((p) => p.id === playerId);
  const result = engine.forfeit(playerId);
  if (!result.events.length) return;
  stopTurnClock();
  renderer.syncToEngine();
  sfx.eliminate();
  const me = playerId === myPlayerId;
  const name = who?.name ?? 'A player';
  showBoardToast(
    me
      ? reason === 'timeout'
        ? 'You missed 3 turns and are out of this match'
        : 'You left the match'
      : `${name} ${reason === 'timeout' ? 'missed 3 turns and is out' : 'left the match'}`,
    colorOf(playerId).css
  );
  renderPills();
  syncBoardTurnColor();
  if (result.gameOver && result.winner !== null) showWin(result.winner);
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
  // A new match starts with an empty move queue, never behind the previous
  // match's last animation.
  remoteMoves = Promise.resolve();
  stopBotFallbackTimer();
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
  renderer!.setHoverTest(onlineHoverTest);
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
  remoteMoves = Promise.resolve();
  onlineMode = true;
  myPlayerId = net.myId;
  orbStyle = style;
  modeKey = GAME_MODES[mode] ? mode : DEFAULT_MODE;
  resetSeries();
  const newEngine = new GameEngine({ rows, cols, players: snapshot.players, kinds: snapshot.kinds });
  newEngine.loadSnapshot(snapshot);
  if (!(await mountGame(newEngine, style, { fromSnapshot: true }))) return;
  renderer!.setCellTapHandler(onCellTapOnline);
  renderer!.setHoverTest(onlineHoverTest);
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
  const room = roomCodeFromUrl(location.href);
  if (!room) return false;
  joinCodeInput.value = room;
  showScreen(screenOnline);
  return true;
}

// ---------- Home ----------
/** The title screen's top bar and cards: who you are, how far along, and
 *  what today's puzzle and the computer are set to. */
function renderHome() {
  const s = stats.get();
  levelChipEl.textContent = `Level ${stats.level(s)}`;
  homeXpFill.style.transform = `scaleX(${levelProgress(s)})`;
  const profile = account.profile;
  homeNameEl.textContent = profile?.name || callsign || 'Player';
  const avatarKey = profile?.avatar || (profile ? defaultAvatarFor(profile.id) : 'c1');
  homeAvatarEl.innerHTML = avatarSvg(avatarKey, 40);

  const today = dayNumber();
  const rec = dailyState.day(today);
  const streak = dailyState.liveStreak(today);
  const streakNote = streak > 1 ? ` · ${streak}-day streak` : '';
  if (rec?.done) {
    const top = Math.max(0, ...rec.tries);
    dailySubEl.textContent = `${top >= rec.best ? 'Solved' : `Best ×${top} of ×${rec.best}`}${streakNote}`;
  } else if (rec && rec.tries.length) {
    const left = 3 - rec.tries.length;
    dailySubEl.textContent = `${left} ${left === 1 ? 'try' : 'tries'} left today`;
  } else {
    dailySubEl.textContent = `Find today's biggest chain${streakNote}`;
  }
  dailyStreakEl.textContent = `#${today}`;
  dailyBtn.classList.toggle('is-done', !!rec?.done);
  $('tab-dot-daily').classList.toggle('hidden', !!rec?.done);
  cpuSubEl.textContent = `${CPU_LEVELS[cpuLevel].name} difficulty`;
}


// Every button press gets a light tap under the finger on a phone. One
// delegated listener rather than a call in fifty handlers.
document.addEventListener(
  'click',
  (e) => {
    if ((e.target as HTMLElement | null)?.closest('button')) haptics.tap();
  },
  { capture: true, passive: true }
);

// ---------- vs Computer ----------
interface CpuLevel {
  name: string;
  /** Nova's mood at this level — what the picker shows under the name. */
  mood: string;
  blurb: string;
  skill: number;
  deep: boolean;
  bot: string;
  rating: number;
}

const CPU_LEVELS: CpuLevel[] = [
  { name: 'Easy', mood: 'Chill', blurb: 'Nova plays sensible moves and misses plenty. Good for learning the ropes.', skill: 0.15, deep: false, bot: 'Nova', rating: 800 },
  { name: 'Normal', mood: 'Focused', blurb: 'Nova spots the obvious captures. A fair fight.', skill: 0.6, deep: false, bot: 'Nova', rating: 1050 },
  { name: 'Hard', mood: 'Ruthless', blurb: 'Nova always plays her best move. You will need a plan.', skill: 1, deep: false, bot: 'Nova', rating: 1300 },
  { name: 'Insane', mood: 'Unhinged', blurb: 'Nova plays out your reply before she moves. Good luck.', skill: 1, deep: true, bot: 'Nova', rating: 1550 },
];

const CPU_KEY = 'fissile.cpu.v1';
let cpuLevel = 1;
let cpuSize: BoardSizeKey = 'medium';
try {
  const raw = JSON.parse(localStorage.getItem(CPU_KEY) || '{}') as { level?: unknown; size?: unknown };
  const lv = Number(raw.level);
  if (Number.isInteger(lv) && lv >= 0 && lv < CPU_LEVELS.length) cpuLevel = lv;
  if (raw.size === 'small' || raw.size === 'medium' || raw.size === 'large') cpuSize = raw.size;
} catch {
  /* defaults */
}

function saveCpuPrefs() {
  try {
    localStorage.setItem(CPU_KEY, JSON.stringify({ level: cpuLevel, size: cpuSize }));
  } catch {
    /* storage unavailable */
  }
}

function renderCpuSheet() {
  cpuLevelGroup.innerHTML = '';
  CPU_LEVELS.forEach((lv, i) => {
    const btn = document.createElement('button');
    btn.className = `cpu-level${i === cpuLevel ? ' active' : ''}`;
    btn.dataset.level = String(i);
    btn.innerHTML =
      `<span class="cpu-pips">${'<i></i>'.repeat(i + 1)}</span>` +
      `<span class="cpu-name">${lv.name}</span><span class="cpu-bot">${lv.mood}</span>`;
    cpuLevelGroup.appendChild(btn);
  });
  cpuBlurbEl.textContent = CPU_LEVELS[cpuLevel].blurb;
  markSegment(cpuSizeGroup, 'size', cpuSize);
  relabelSizes(cpuSizeGroup, useLandscape());
}

cpuLevelGroup.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('.cpu-level');
  if (!btn) return;
  sfx.buttonTap();
  cpuLevel = Number(btn.dataset.level) || 0;
  saveCpuPrefs();
  renderCpuSheet();
  renderHome();
});

onSegmentPick(cpuSizeGroup, (el) => {
  cpuSize = el.dataset.size as BoardSizeKey;
  saveCpuPrefs();
});

$('cpu-btn').addEventListener('click', () => {
  sfx.unlock();
  sfx.buttonTap();
  renderCpuSheet();
  showOverlay(screenCpu);
});

$('cpu-close-btn').addEventListener('click', () => {
  sfx.buttonTap();
  hideOverlay(screenCpu);
});

$('cpu-start-btn').addEventListener('click', () => {
  hideOverlay(screenCpu);
  startCpuMatch();
});

function startCpuMatch() {
  const lv = CPU_LEVELS[cpuLevel];
  const bot: Bot = {
    id: `cpu-${cpuLevel}`,
    name: lv.bot,
    skill: lv.skill,
    rating: lv.rating,
    deep: lv.deep,
    thinkMs: lv.deep ? [500, 900] : [380 + lv.skill * 240, 760 + lv.skill * 480],
  };
  void startBotMatch(bot, { size: cpuSize, mode: DEFAULT_MODE });
}

// ---------- Nova: welcome and lesson ----------
const WELCOMED_KEY = 'fissile.nova.welcomed';
const screenNovaWelcome = $('screen-nova-welcome');
const novaWelcomeStage = $('nova-welcome-stage');
const LESSON_ROWS = 4;
const LESSON_COLS = 4;
const LESSON_STEPS = 5;
/** The one cell the current lesson step accepts, or null between steps. */
let lessonTarget: { row: number; col: number } | null = null;
let lessonWrongTaps = 0;
let lessonTapped: (() => void) | null = null;

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string) {
  try {
    localStorage.setItem(key, '1');
  } catch {
    /* storage unavailable */
  }
}

/** First launch: Nova says hello and offers the lesson. Once per install. */
function maybeWelcome() {
  if (readFlag(WELCOMED_KEY) || screenMenu.classList.contains('hidden')) return;
  writeFlag(WELCOMED_KEY);
  showOverlay(screenNovaWelcome);
  nova.attach(novaWelcomeStage);
  void nova.say('welcome', { index: 0, priority: 3, persist: true });
}

$('nova-lesson-btn').addEventListener('click', () => {
  sfx.unlock();
  sfx.buttonTap();
  nova.stop();
  hideOverlay(screenNovaWelcome);
  void startLesson();
});

$('nova-later-btn').addEventListener('click', async () => {
  sfx.unlock();
  sfx.buttonTap();
  const buttons = screenNovaWelcome.querySelectorAll<HTMLButtonElement>('button');
  buttons.forEach((b) => (b.disabled = true));
  nova.stop();
  // Her goodbye, capped so "later" never feels like being held hostage.
  await Promise.race([nova.say('tut', { index: 14, priority: 3, persist: true }), wait(2600)]);
  nova.stop();
  hideOverlay(screenNovaWelcome);
  buttons.forEach((b) => (b.disabled = false));
});

function lessonPlayers(): PlayerConfig[] {
  return [0, 1].map((i) => {
    const theme = themeForSeat(i, DEFAULT_MODE);
    return { id: i, name: i === 0 ? 'You' : 'Nova', color: theme.base, colorLight: theme.light, isAlive: true };
  });
}

/** A lesson position: [row, col, owner, orbs] for every occupied cell. */
function lessonSnapshot(cells: [number, number, number, number][]): EngineSnapshot {
  const grid = Array.from({ length: LESSON_ROWS }, (_, row) =>
    Array.from({ length: LESSON_COLS }, (_, col) => ({ row, col, owner: null as number | null, orbs: 0 }))
  );
  for (const [row, col, owner, orbs] of cells) grid[row][col] = { row, col, owner, orbs };
  return {
    grid,
    currentPlayerIndex: 0,
    gameOver: false,
    winner: null,
    players: lessonPlayers(),
    // Both have "moved", so taking all of Nova's orbs counts as knocking her out.
    hasMoved: [0, 1],
    kinds: grid.map((row) => row.map(() => 'normal' as const)),
  };
}

const lessonLive = (token: number) => lessonMode && token === lessonToken;

async function lessonSay(token: number, index: number) {
  if (!lessonLive(token)) return;
  nova.stop();
  await nova.say('tut', { index, priority: 3, persist: true });
}

function lessonButtons(buttons: { label: string; primary?: boolean; onClick: () => void }[]) {
  lessonActionsEl.innerHTML = '';
  for (const b of buttons) {
    const el = document.createElement('button');
    el.className = `${b.primary ? 'primary-btn' : 'ghost-btn'} small-btn`;
    el.textContent = b.label;
    el.addEventListener('click', () => {
      sfx.buttonTap();
      b.onClick();
    });
    lessonActionsEl.appendChild(el);
  }
  lessonActionsEl.classList.remove('hidden');
}

function lessonNext(token: number): Promise<void> {
  return new Promise((resolve) => {
    if (!lessonLive(token)) return resolve();
    lessonButtons([
      {
        label: 'Next',
        primary: true,
        onClick: () => {
          lessonActionsEl.classList.add('hidden');
          resolve();
        },
      },
    ]);
  });
}

/** Lights one cell and waits for the player to tap it. */
function lessonTap(token: number, row: number, col: number): Promise<void> {
  return new Promise((resolve) => {
    if (!lessonLive(token) || !renderer) return resolve();
    lessonTarget = { row, col };
    lessonWrongTaps = 0;
    renderer.setHint(lessonTarget, colorOf(0).base);
    lessonTapped = resolve;
  });
}

async function onCellTapLesson(row: number, col: number) {
  if (!engine || !renderer || animating || !lessonMode || !lessonTarget) return;
  if (row !== lessonTarget.row || col !== lessonTarget.col) {
    haptics.tap();
    nova.stop();
    void nova.say('tut', { index: 15 + (lessonWrongTaps++ % 3), priority: 3, persist: true });
    return;
  }
  lessonTarget = null;
  renderer.setHint(null);
  const done = lessonTapped;
  lessonTapped = null;
  await applyAndAnimateMove(row, col);
  done?.();
}

async function lessonMove(token: number, row: number, col: number) {
  if (!lessonLive(token) || !engine) return;
  await applyAndAnimateMove(row, col);
}

function lessonLoad(token: number, cells: [number, number, number, number][]) {
  if (!lessonLive(token) || !engine || !renderer) return;
  engine.loadSnapshot(lessonSnapshot(cells));
  renderer.syncToEngine();
  renderPills();
  syncBoardTurnColor(true);
}

function endLessonToMenu() {
  leaveGameScreen();
  showScreen(screenMenu);
}

async function startLesson() {
  sfx.unlock();
  sfx.buttonTap();
  if (net) disconnectNet();
  onlineMode = false;
  activeBot = null;
  resetSeries();
  const token = ++lessonToken;
  const lessonEngine = new GameEngine({ rows: LESSON_ROWS, cols: LESSON_COLS, players: lessonPlayers() });
  if (!(await mountGame(lessonEngine, orbStyle, { lesson: true }))) return;
  if (token !== lessonToken) return;
  renderer!.setCellTapHandler(onCellTapLesson);
  renderer!.setHoverTest((r, c) => lessonTarget !== null && r === lessonTarget.row && c === lessonTarget.col);
  matchBannerEl.classList.add('hidden');
  nova.attach(novaDockEl);
  showScreen(screenGame);
  await runLesson(token);
}

async function runLesson(token: number) {
  const step = (n: number) => {
    if (lessonLive(token)) lessonStepEl.textContent = `Lesson · ${n} of ${LESSON_STEPS}`;
  };

  // 1. Placing an orb, and Nova's reply.
  step(1);
  await wait(700);
  await lessonSay(token, 0);
  await lessonNext(token);
  void lessonSay(token, 1);
  await lessonTap(token, 1, 1);
  await lessonSay(token, 2);
  void lessonSay(token, 3);
  await wait(1500);
  await lessonMove(token, 2, 2);
  await lessonSay(token, 4);
  await lessonNext(token);

  // 2. A full cell bursts.
  step(2);
  lessonLoad(token, [
    [0, 0, 0, 1],
    [3, 3, 1, 1],
  ]);
  void lessonSay(token, 5);
  await lessonTap(token, 0, 0);
  await lessonSay(token, 6);
  await lessonSay(token, 7);
  await lessonNext(token);

  // 3. A burst captures what it lands on.
  step(3);
  lessonLoad(token, [
    [0, 1, 0, 2],
    [0, 2, 1, 1],
    [1, 1, 1, 1],
    [3, 0, 0, 1],
    [3, 3, 1, 1],
  ]);
  void lessonSay(token, 8);
  await lessonTap(token, 0, 1);
  await lessonSay(token, 9);
  await lessonNext(token);

  // 4. A chain that takes every one of her orbs.
  step(4);
  lessonLoad(token, [
    [0, 0, 0, 1],
    [0, 1, 0, 2],
    [1, 0, 0, 2],
    [0, 2, 1, 1],
    [1, 1, 1, 2],
    [2, 0, 1, 1],
  ]);
  void lessonSay(token, 10);
  await lessonTap(token, 0, 0);
  await lessonSay(token, 11);
  await lessonSay(token, 12);

  // 5. Done — straight into a real game, or back to the menu.
  step(5);
  if (!lessonLive(token)) return;
  void lessonSay(token, 13);
  lessonButtons([
    {
      label: 'Play Nova',
      primary: true,
      onClick: () => {
        cpuLevel = 0;
        saveCpuPrefs();
        renderHome();
        startCpuMatch();
      },
    },
    { label: 'Done', onClick: endLessonToMenu },
  ]);
}

$('lesson-skip').addEventListener('click', () => {
  sfx.buttonTap();
  endLessonToMenu();
});

// ---------- Daily Blast ----------
let dailyMode = false;
let dailyPuzzle: DailyPuzzle | null = null;
let dailyCountdownTimer = 0;

function dailyPlayers(): PlayerConfig[] {
  return [0, 1].map((i) => ({
    id: i,
    name: i === 0 ? 'You' : 'Rival',
    color: PLAYER_THEMES[i].base,
    colorLight: PLAYER_THEMES[i].light,
    isAlive: true,
  }));
}

function renderPuzzleHud() {
  if (!dailyPuzzle) return;
  const rec = dailyState.day(dailyPuzzle.day);
  const used = rec?.tries.length ?? 0;
  const tries = Array.from({ length: DAILY_TRIES }, (_, i) => {
    const chain = rec?.tries[i];
    const cls = chain === undefined ? (i === used ? 'now' : '') : chain >= dailyPuzzle!.best ? 'win' : 'used';
    return `<i class="${cls}">${chain === undefined ? '' : chain}</i>`;
  }).join('');
  puzzleHudEl.innerHTML =
    `<div class="ph-title">Daily Blast <span>#${dailyPuzzle.day}</span></div>` +
    `<div class="ph-goal">Find the move with the <b>biggest chain</b> · best is ×${dailyPuzzle.best}</div>` +
    `<div class="ph-tries">${tries}</div>`;
  puzzleHudEl.classList.remove('hidden');
}

async function startDailyPuzzle() {
  sfx.unlock();
  if (net) disconnectNet();
  onlineMode = false;
  activeBot = null;
  resetSeries();
  const day = dayNumber();
  dailyPuzzle = buildDailyPuzzle(day, dailyPlayers());
  const e = new GameEngine({ rows: dailyPuzzle.rows, cols: dailyPuzzle.cols, players: dailyPuzzle.players });
  e.loadSnapshot(structuredClone(dailyPuzzle.snapshot));
  showScreen(screenGame);
  if (!(await mountGame(e, orbStyle, { fromSnapshot: true, daily: true }))) return;
  renderer!.setCellTapHandler(onCellTapDaily);
  renderer!.setHoverTest((r, c) => !animating && !!engine && engine.canPlay(r, c));
  matchBannerEl.classList.add('hidden');
  renderPuzzleHud();
  showBoardToast('Tap a cell to set it off');
}

async function onCellTapDaily(row: number, col: number) {
  if (!engine || !renderer || animating || !dailyPuzzle) return;
  if (!engine.canPlay(row, col)) return;
  const puzzle = dailyPuzzle;
  animating = true;
  sfx.unlock();
  const generation = soundGeneration;
  const result = await applyAndAnimateMove(row, col);
  if (!result || generation !== soundGeneration || !dailyMode) return;

  const rec = dailyState.recordTry(puzzle.day, puzzle.best, result.chain);
  renderPuzzleHud();
  const perfect = result.chain >= puzzle.best;
  if (perfect) {
    showBoardToast(`×${result.chain} — perfect!`, PLAYER_THEMES[0].css);
    sfx.win();
    haptics.win();
    renderer.celebrate(0, { row, col });
  } else {
    const left = DAILY_TRIES - rec.tries.length;
    showBoardToast(
      result.chain === 0
        ? `No reaction · ${left} ${left === 1 ? 'try' : 'tries'} left`
        : `×${result.chain} · the best is ×${puzzle.best}${left ? ` · ${left} left` : ''}`
    );
  }

  await wait(perfect ? 1500 : 1300);
  if (generation !== soundGeneration || !dailyMode) return;
  if (rec.done) {
    showDailyResult(puzzle.day);
    return;
  }
  // Back to the starting position for the next try.
  engine.loadSnapshot(structuredClone(puzzle.snapshot));
  renderer.syncToEngine();
  renderer.setTurnColor(PLAYER_THEMES[0].base);
  animating = false;
}

function showDailyResult(day: number) {
  const rec = dailyState.day(day);
  const state = dailyState.get();
  const best = rec?.best ?? 0;
  const tries = rec?.tries ?? [];
  const top = tries.length ? Math.max(...tries) : 0;
  $('daily-eyebrow').textContent = `Daily Blast #${day}`;
  $('daily-title').textContent = top >= best && best > 0 ? 'Perfect blast!' : top >= best - 1 ? 'So close!' : 'Nice try';
  $('daily-score-value').textContent = `×${top}`;
  $('daily-score-of').textContent = `best ×${best}`;
  $('daily-tries').innerHTML = Array.from({ length: DAILY_TRIES }, (_, i) => `<span>${trySquare(tries[i], best)}</span>`).join('');
  $('daily-verdict').textContent =
    top >= best
      ? `You found the deepest chain on the board${tries.length === 1 ? ' — first try' : ''}.`
      : `The best move set off a ×${best} chain. A new board unlocks at midnight.`;
  $('daily-streak-value').textContent = String(dailyState.liveStreak(dayNumber()));
  $('daily-played-value').textContent = String(state.played);
  $('daily-perfect-value').textContent = String(state.perfect);
  const tick = () => {
    const ms = msUntilNextDay();
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const sec = Math.floor((ms % 60_000) / 1000);
    $('daily-countdown').textContent = `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };
  tick();
  clearInterval(dailyCountdownTimer);
  dailyCountdownTimer = window.setInterval(tick, 1000);
  showOverlay(screenDaily);
  renderHome();
}

dailyBtn.addEventListener('click', () => {
  sfx.unlock();
  sfx.buttonTap();
  const today = dayNumber();
  if (dailyState.day(today)?.done) showDailyResult(today);
  else void startDailyPuzzle();
});

$('daily-close-btn').addEventListener('click', () => {
  sfx.buttonTap();
  clearInterval(dailyCountdownTimer);
  hideOverlay(screenDaily);
  if (dailyMode) {
    leaveGameScreen();
    showScreen(screenDailyPage);
  } else if (!screenDailyPage.classList.contains('hidden')) {
    renderDailyPage();
  }
});

$('daily-share-btn').addEventListener('click', async () => {
  sfx.buttonTap();
  const day = dayNumber();
  const rec = dailyState.day(day);
  if (!rec) return;
  const text = shareText(day, rec.tries, rec.best, dailyState.liveStreak(day), PUBLIC_ORIGIN);
  await openSharePreview(dailyShareData(), `FISSILE Daily Blast #${day}`, text);
});

/** Swaps a button's label for a moment — "Copied!" and the like. */
function flashButton(btn: HTMLElement, label: string) {
  const original = btn.textContent;
  btn.textContent = label;
  setTimeout(() => {
    btn.textContent = original;
  }, 1500);
}

// ---------- Sharing a match ----------
const screenShare = $('screen-share');
const shareImgEl = $<HTMLImageElement>('share-img');
const shareLoadingEl = $('share-loading');
const shareGoBtn = $<HTMLButtonElement>('share-go-btn');
let pendingShare: { blob: Blob; title: string; text: string; url: string } | null = null;

/** The player block every card ends with: name, face, rank. */
function sharePlayer(nameOverride?: string) {
  const p = account.profile;
  const rank = p ? rankFor(p.rating) : null;
  return {
    playerName: nameOverride ?? (p?.name || callsign || 'Player'),
    avatarKey: crewFor(p?.avatar || (p ? defaultAvatarFor(p.id) : DEFAULT_AVATAR)),
    rankKey: rank?.key ?? '',
    rankLine: rank && p ? `${rank.name} · ${p.rating.toLocaleString()} pts` : 'Unranked',
  };
}

const SHARE_HOST = PUBLIC_ORIGIN.replace(/^https?:\/\//, '');

function boardCells(grid: { owner: number | null; orbs: number }[][], ids: number[]): ShareCell[][] {
  return grid.map((row) => row.map((c) => ({ owner: c.owner === null ? -1 : ids.indexOf(c.owner), count: c.orbs })));
}

/** The finished match as a story card. */
function matchShareData(): ShareCardData | null {
  if (!engine) return null;
  const winner = engine.winner;
  const me = localSeatId();
  const local = !onlineMode && !activeBot && !GAME_MODES[modeKey].solo;
  const iWon = winner !== null && winner === me;
  const cpu = activeBot?.id.startsWith('cpu-') ? CPU_LEVELS[Number(activeBot.id.slice(4))] : null;
  const solo = !onlineMode && GAME_MODES[modeKey].solo;
  const chain = matchBestChain;
  const winnerName = engine.players.find((p) => p.id === winner)?.name ?? 'Someone';
  const ids = engine.players.map((p) => p.id);
  const subject = local ? winner ?? me : me;
  const cells = engine.grid.flat().filter((c) => c.owner === subject).length;

  let tag = 'LOCAL MATCH';
  let headline = `${winnerName} won our match.`;
  if (cpu) {
    tag = `VS NOVA · ${cpu.name.toUpperCase()}`;
    headline = iWon ? `I beat Nova on ${cpu.name}.` : `Nova got me on ${cpu.name}.`;
  } else if (solo) {
    tag = `SURVIVAL · ROUND ${Math.max(1, survivalRound - (iWon ? 1 : 0))}`;
    headline = iWon ? 'I outlasted the system.' : 'The system got me. This time.';
  } else if (onlineMode) {
    tag = activeBot ? 'QUICK MATCH' : 'ONLINE MATCH';
    headline = iWon ? 'Won an online match.' : 'Lost a close one online.';
  }
  return {
    tag,
    heroLabel: chain >= 2 ? 'LONGEST CHAIN' : 'RESULT',
    hero: chain >= 2 ? `×${chain}` : iWon || local ? 'WIN' : 'GG',
    headline,
    sub: iWon || local ? 'Think you can top it?' : 'Think you can do better?',
    board: boardCells(engine.grid, ids),
    colors: engine.players.map((p) => colorOf(p.id).css),
    stats: [
      { label: 'RESULT', value: local ? 'Win' : iWon ? 'Win' : 'Loss' },
      { label: 'CELLS', value: String(cells) },
      { label: 'MOVES', value: String(matchTurns) },
    ],
    ...sharePlayer(local ? winnerName : undefined),
    ...(local ? { rankKey: '', rankLine: 'Pass and play' } : {}),
    cta: 'Beat my chain',
    url: SHARE_HOST,
  };
}

/** Today's Daily Blast as a story card. */
function dailyShareData(): ShareCardData | null {
  const day = dayNumber();
  const rec = dailyState.day(day);
  if (!rec) return null;
  const puzzle = dailyPuzzle && dailyPuzzle.day === day ? dailyPuzzle : buildDailyPuzzle(day, dailyPlayers());
  const found = rec.best >= puzzle.best;
  return {
    tag: `DAILY BLAST #${day}`,
    heroLabel: 'BEST CHAIN',
    hero: `×${rec.best}`,
    headline: found ? 'I found the perfect chain.' : `×${rec.best} of a possible ×${puzzle.best}.`,
    sub: "Same puzzle for everyone today. Beat me.",
    board: boardCells(puzzle.snapshot.grid, puzzle.players.map((p) => p.id)),
    colors: puzzle.players.map((p) => colorOf(p.id).css),
    stats: [
      { label: 'TRIES', value: `${rec.tries.length}/${DAILY_TRIES}` },
      { label: 'POSSIBLE', value: `×${puzzle.best}` },
      { label: 'STREAK', value: String(dailyState.liveStreak(day)) },
    ],
    ...sharePlayer(),
    cta: 'Beat my chain',
    url: SHARE_HOST,
  };
}

/** Builds the card, shows it, and waits for the player to send it. Falls back
 *  to a plain text share if the picture cannot be made on this device. */
async function openSharePreview(data: ShareCardData | null, title: string, text: string) {
  if (!data) return;
  pendingShare = null;
  shareImgEl.removeAttribute('src');
  shareLoadingEl.classList.remove('hidden');
  shareGoBtn.disabled = true;
  showOverlay(screenShare);
  try {
    const blob = await renderShareCard(data);
    pendingShare = { blob, title, text, url: PUBLIC_ORIGIN };
    shareImgEl.src = URL.createObjectURL(blob);
    shareLoadingEl.classList.add('hidden');
    shareGoBtn.disabled = false;
  } catch (err) {
    console.warn('Share card failed, sharing text instead:', err);
    hideOverlay(screenShare);
    await share({ title, text, url: PUBLIC_ORIGIN });
  }
}

shareGoBtn.addEventListener('click', async () => {
  sfx.buttonTap();
  if (!pendingShare) return;
  const outcome = await shareImage(pendingShare.blob, {
    title: pendingShare.title,
    text: pendingShare.text,
    url: pendingShare.url,
    filename: 'fissile-result.png',
  });
  if (outcome === 'saved') flashButton(shareGoBtn, 'Saved!');
});

$('share-close-btn').addEventListener('click', () => {
  sfx.buttonTap();
  hideOverlay(screenShare);
  if (shareImgEl.src) URL.revokeObjectURL(shareImgEl.src);
  shareImgEl.removeAttribute('src');
  pendingShare = null;
});

$('win-share-btn').addEventListener('click', async () => {
  sfx.buttonTap();
  if (!engine) return;
  const winner = engine.winner;
  const iWon = winner !== null && winner === localSeatId();
  const chain = matchBestChain;
  let text: string;
  if (activeBot && activeBot.id.startsWith('cpu-')) {
    const level = CPU_LEVELS[Number(activeBot.id.slice(4))]?.name.toLowerCase() ?? 'tough';
    text = iWon
      ? `I just beat Nova on ${level} in FISSILE${chain >= 2 ? ` with a ×${chain} chain reaction` : ''} 💥 Think you can?`
      : `Nova got me on ${level} in FISSILE 😤 Can you beat her?`;
  } else if (onlineMode) {
    text = iWon
      ? `Won an online FISSILE match${chain >= 2 ? ` with a ×${chain} chain` : ''} 💥 Come play me.`
      : `Lost an online FISSILE match by a whisker. Rematch? 💥`;
  } else {
    const name = engine.players.find((p) => p.id === winner)?.name ?? 'Someone';
    text = `${name} won our FISSILE match${chain >= 2 ? ` — biggest chain ×${chain}` : ''} 💥 Chain reaction strategy, free on Android.`;
  }
  await openSharePreview(matchShareData(), 'FISSILE', text);
});

// ---------- Android back button ----------
onBackButton(() => {
  if (!screenConfirm.classList.contains('hidden')) {
    closeConfirm(false);
    return true;
  }
  // Topmost first: sheets, then the result card, then the screen under it.
  const sheets: [HTMLElement, string][] = [
    [screenShare, 'share-close-btn'],
    [screenNovaWelcome, 'nova-later-btn'],
    [screenDaily, 'daily-close-btn'],
    [screenCpu, 'cpu-close-btn'],
    [screenHowto, 'howto-close-btn'],
    [screenSettings, 'settings-close-btn'],
    [screenSetup, 'setup-close-btn'],
  ];
  for (const [el, close] of sheets) {
    if (!el.classList.contains('hidden')) {
      $(close).click();
      return true;
    }
  }
  if (!tauntPaletteEl.classList.contains('hidden') || !chatPaletteEl.classList.contains('hidden')) {
    setTauntPaletteOpen(false);
    setChatPaletteOpen(false);
    return true;
  }
  if (!screenWin.classList.contains('hidden')) {
    $('win-menu-btn').click();
    return true;
  }
  if (!screenGame.classList.contains('hidden')) {
    // A match is the one place a stray back press costs something, so it
    // asks first.
    $('back-btn').click();
    return true;
  }
  if (!screenLobby.classList.contains('hidden')) {
    $('lobby-back-btn').click();
    return true;
  }
  if (!screenRanked.classList.contains('hidden')) {
    $('ranked-back-btn').click();
    return true;
  }
  // Any tab but Play goes back to Play; on Play, back leaves the app.
  const current = ALL_SCREENS.find((el) => !el.classList.contains('hidden')) ?? null;
  const tab = tabOf(current);
  if (tab && tab !== 'play') {
    goTab('play');
    return true;
  }
  // On the home screen, back would close the game: ask first.
  void confirmDialog({
    title: 'Exit FISSILE?',
    body: 'Do you want to close the game?',
    ok: 'Exit',
    cancel: 'Stay',
  }).then((ok) => {
    if (ok) exitApp();
  });
  return true;
});

/** A room code arrived as a link — from a chat app, a QR code, anywhere. */
function openRoomFromLink(code: string) {
  if (!/^[A-Z0-9]{3,8}$/.test(code)) return;
  if (!screenGame.classList.contains('hidden') && engine && !engine.gameOver) {
    // Never yank someone out of a live match. The code waits in the box.
    joinCodeInput.value = code;
    return;
  }
  joinCodeInput.value = code;
  $('play-online-btn').click();
}


// ---------- Graphics settings ----------
const fpsMeterEl = $('fps-meter');
const gfxPresetGroup = $('gfx-preset-group');
const gfxResGroup = $('gfx-res-group');
const gfxAaGroup = $('gfx-aa-group');
const gfxShadowGroup = $('gfx-shadow-group');
const gfxOrbGroup = $('gfx-orb-group');
const gfxGlowGroup = $('gfx-glow-group');
const gfxParticleGroup = $('gfx-particle-group');
const gfxFpsGroup = $('gfx-fps-group');
const gfxShowFpsGroup = $('gfx-showfps-group');

const TIER_NAMES: Record<string, string> = { ultra: 'Ultra', high: 'High', medium: 'Medium', low: 'Low' };

let gpuLabel: string | null = null;
/** The GPU the board is drawn on, named the way a player would recognise it.
 *  Software rasterisers are called out, because that is the one answer that
 *  explains a slow board. */
function gpuName(): string {
  if (gpuLabel !== null) return gpuLabel;
  let raw = renderer?.gpuName() || attractRenderer?.gpuName() || '';
  if (!raw) {
    try {
      const canvas = document.createElement('canvas');
      const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as WebGLRenderingContext | null;
      if (gl) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        raw = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
    } catch {
      raw = '';
    }
  }
  if (/swiftshader|llvmpipe|software/i.test(raw)) {
    gpuLabel = 'software rendering';
    return gpuLabel;
  }
  // "ANGLE (Vendor, Model (0x1234) Direct3D11 …)" → "Model"
  const angle = raw.match(/^ANGLE \(([^,]+),\s*([^,]+?)(?:\s*\(0x[0-9a-f]+\))?(?:\s+Direct3D.*|\s+OpenGL.*|,.*)?\)?$/i);
  gpuLabel = (angle ? angle[2] : raw).replace(/\s+/g, ' ').trim().slice(0, 40);
  return gpuLabel;
}

function renderGraphicsSettings() {
  const s = getGraphics();
  const d = currentDetail();
  markSegment(gfxPresetGroup, 'gfxPreset', s.preset);
  markSegment(gfxResGroup, 'gfxRes', String(d.resolution));
  markSegment(gfxAaGroup, 'gfxAa', d.antialias ? '1' : '0');
  markSegment(gfxShadowGroup, 'gfxShadow', d.shadows);
  markSegment(gfxOrbGroup, 'gfxOrb', d.orbDetail);
  markSegment(gfxGlowGroup, 'gfxGlow', d.glow ? '1' : '0');
  markSegment(gfxParticleGroup, 'gfxParticles', d.particles);
  markSegment(gfxFpsGroup, 'gfxFps', String(s.fps));
  markSegment(gfxShowFpsGroup, 'gfxShowfps', s.showFps ? '1' : '0');

  const gpu = gpuName();
  $('gfx-gpu').textContent = gpu ? `GPU · ${gpu}` : '';
  const note =
    s.preset === 'auto'
      ? `Auto is drawing at ${TIER_NAMES[currentAutoTier()]} — the best your phone holds smoothly. It steps down on its own if frames drop.`
      : s.preset === 'custom'
        ? 'Custom — your own mix. Pick a preset to reset every control.'
        : `${TIER_NAMES[s.preset]} — fixed. Auto would adjust to keep play smooth.`;
  $('gfx-note').textContent = note;
  const pr = pixelRatioFor(d, window.devicePixelRatio || 1);
  $('gfx-res-px').textContent = `${Math.round(window.innerWidth * pr)}×${Math.round(window.innerHeight * pr)}`;
}

onSegmentPick(gfxPresetGroup, (el) => {
  const preset = el.dataset.gfxPreset as GraphicsPreset;
  // Choosing Auto again means "measure again": forget the tier it settled on.
  setGraphics(preset === 'auto' ? { preset, autoTier: null } : { preset });
  renderGraphicsSettings();
});

/** Any individual control turns the preset into Custom, starting from what
 *  was on screen — so only the control touched actually changes. */
function setDetail(patch: Partial<GraphicsDetail>) {
  setGraphics({ preset: 'custom', custom: { ...currentDetail(), ...patch } });
  renderGraphicsSettings();
}

onSegmentPick(gfxResGroup, (el) => setDetail({ resolution: Number(el.dataset.gfxRes) }));
onSegmentPick(gfxAaGroup, (el) => setDetail({ antialias: el.dataset.gfxAa === '1' }));
onSegmentPick(gfxShadowGroup, (el) => setDetail({ shadows: el.dataset.gfxShadow as ShadowLevel }));
onSegmentPick(gfxOrbGroup, (el) => setDetail({ orbDetail: el.dataset.gfxOrb as OrbDetail }));
onSegmentPick(gfxGlowGroup, (el) => setDetail({ glow: el.dataset.gfxGlow === '1' }));
onSegmentPick(gfxParticleGroup, (el) => setDetail({ particles: el.dataset.gfxParticles as ParticleLevel }));
onSegmentPick(gfxFpsGroup, (el) => {
  setGraphics({ fps: Number(el.dataset.gfxFps) as FpsCap });
  renderGraphicsSettings();
});
onSegmentPick(gfxShowFpsGroup, (el) => {
  setGraphics({ showFps: el.dataset.gfxShowfps === '1' });
  renderGraphicsSettings();
});

// Whoever changes the settings — this sheet, or Auto stepping down mid-match —
// the meter and an open sheet follow.
onGraphicsChange(() => {
  fpsMeterEl.classList.toggle('hidden', !getGraphics().showFps || !renderer);
  if (!screenSettings.classList.contains('hidden')) renderGraphicsSettings();
});


// ---------- Navigation ----------
/*
 * Five top-level pages behind a tab bar, two pushed pages (the ranked queue
 * and a room's lobby) with a back header, and full-screen play. Sheets —
 * match setup, difficulty, settings, how to play, a puzzle result — open
 * over whatever page you are on and close back onto it.
 *
 * Moving between tabs slides in the direction of the tab you picked; pushing
 * a page slides it in from the right and going back slides it out. One rule
 * per kind of move, so the motion always says where you went.
 */
type TabKey = 'play' | 'daily' | 'online' | 'ranks' | 'profile';
const TAB_ORDER: TabKey[] = ['play', 'daily', 'online', 'ranks', 'profile'];
const TAB_SCREENS: Record<TabKey, HTMLElement> = {
  play: screenMenu,
  daily: screenDailyPage,
  online: screenOnline,
  ranks: screenBoards,
  profile: screenProfile,
};
const TRANSITIONS = ['screen-in', 'enter-left', 'enter-right', 'enter-push', 'enter-pop'];

function tabOf(el: HTMLElement | null): TabKey | null {
  if (!el) return null;
  return TAB_ORDER.find((k) => TAB_SCREENS[k] === el) ?? null;
}

function transitionFor(from: HTMLElement | null, to: HTMLElement): string {
  const fromTab = tabOf(from);
  const toTab = tabOf(to);
  if (fromTab && toTab) return TAB_ORDER.indexOf(toTab) > TAB_ORDER.indexOf(fromTab) ? 'enter-right' : 'enter-left';
  if (to.classList.contains('sub-page')) return 'enter-push';
  if (from?.classList.contains('sub-page') && toTab) return 'enter-pop';
  return 'screen-in';
}

function syncTabbar(el: HTMLElement) {
  const tab = tabOf(el);
  const wasShowing = document.body.classList.contains('with-tabbar');
  document.body.classList.toggle('with-tabbar', tab !== null);
  tabbarEl.querySelectorAll<HTMLElement>('.tab').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-current', on ? 'page' : 'false');
  });
  if (!tab) return;
  const index = TAB_ORDER.indexOf(tab);
  tabbarEl.style.setProperty('--tab-i', String(index));
  // Glide between tabs; snap when the bar is only now appearing, so the
  // highlight never sweeps in from wherever it was left on another screen.
  placeTabIndicator(wasShowing && indicatorIndex >= 0, index);
}

/**
 * The highlight behind the active tab, flowing to the next one.
 *
 * Its two edges move separately: the edge on the side it is travelling
 * towards leaves first and fast, the trailing edge follows more slowly, so
 * for a moment it stretches across both tabs — a drop of liquid flowing over —
 * before settling with a small spring. Edge positions are measured from the
 * real tab buttons, so it lands exactly whatever the bar's size or
 * orientation (a bottom pill on phones, a side pill on wide screens).
 */
let indicatorIndex = -1;
function placeTabIndicator(animate: boolean, index = indicatorIndex) {
  const active = tabbarEl.querySelectorAll<HTMLElement>('.tab')[index];
  const bar = tabbarEl.getBoundingClientRect();
  if (!active || bar.width === 0) return;
  const r = active.getBoundingClientRect();
  const inset = 4;
  tabbarEl.classList.toggle('flow-fwd', index > indicatorIndex);
  tabbarEl.classList.toggle('flow-back', index < indicatorIndex);
  tabbarEl.classList.toggle('flow-snap', !animate);
  const set = (k: string, v: number) => tabbarEl.style.setProperty(k, `${Math.round(v)}px`);
  set('--ind-l', r.left - bar.left + inset);
  set('--ind-r', bar.right - r.right + inset);
  set('--ind-t', r.top - bar.top + inset);
  set('--ind-b', bar.bottom - r.bottom + inset);
  if (!animate) {
    void tabbarEl.offsetWidth; // commit the snapped position before re-enabling motion
    tabbarEl.classList.remove('flow-snap');
  }
  indicatorIndex = index;
}

// Rotating a phone or resizing a window moves the tabs; the highlight follows
// without animating.
new ResizeObserver(() => placeTabIndicator(false)).observe(tabbarEl);

/** Data a page needs fresh each time it is arrived at. */
function onScreenEnter(el: HTMLElement, from: HTMLElement | null) {
  if (from === screenDailyPage && el !== screenDailyPage) {
    clearInterval(dailyPageTimer);
    dailyPageTimer = 0;
  }
  if (el === from) return;
  if (el === screenDailyPage) {
    renderDailyPage();
  } else if (el === screenOnline) {
    setQuickSearching(false);
    hideQuickFallback();
    // Before the round trip, not after: the card's job is to be in place
    // already when the account lands.
    showAccountSkeleton();
    void refreshRooms();
    void renderPresence();
    void renderInvites();
    // The guest account is minted on first visiting Online, not at boot: a
    // player who only ever plays locally never gets one.
    void ensureAccount();
  } else if (el === screenBoards) {
    friendMsgEl.textContent = '';
    void ensureAccount().then(() => renderBoards());
  } else if (el === screenProfile) {
    void renderProfile();
  }
}

/** A tab was chosen by the player. Choosing the tab you are already on
 *  scrolls its page back to the top, as every app's tab bar does. */
function goTab(tab: TabKey) {
  sfx.unlock();
  const el = TAB_SCREENS[tab];
  if (!el.classList.contains('hidden')) {
    el.querySelector<HTMLElement>('.page-body')?.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  if (tab === 'online') clearOnlineError();
  showScreen(el);
}

tabbarEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('.tab');
  if (!btn?.dataset.tab) return;
  sfx.buttonTap();
  goTab(btn.dataset.tab as TabKey);
});

// ---------- Daily page ----------
let dailyPageTimer = 0;
let dailyPreview: { day: number; puzzle: DailyPuzzle; svg: string } | null = null;

/** Today's board, drawn flat: the same cells, owner tints and orb clusters as
 *  the 3D board, with the near-critical ring on cells one orb short. */
function puzzleSvg(p: DailyPuzzle): string {
  const cell = 30;
  const gap = 4;
  const pad = 8;
  const w = p.cols * (cell + gap) - gap + pad * 2;
  const h = p.rows * (cell + gap) - gap + pad * 2;
  const parts: string[] = [
    `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" role="img">`,
    `<rect width="${w}" height="${h}" rx="4" fill="#090c11"/>`,
  ];
  for (let r = 0; r < p.rows; r++) {
    for (let c = 0; c < p.cols; c++) {
      const x = pad + c * (cell + gap);
      const y = pad + r * (cell + gap);
      const data = p.snapshot.grid[r][c];
      parts.push(`<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3" fill="#161b23"/>`);
      if (data.owner === null || data.orbs <= 0) continue;
      const css = PLAYER_THEMES[data.owner % PLAYER_THEMES.length].css;
      parts.push(`<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3" fill="${css}" opacity="0.14"/>`);
      const edges = (r === 0 || r === p.rows - 1 ? 1 : 0) + (c === 0 || c === p.cols - 1 ? 1 : 0);
      const mass = 4 - edges;
      const cx = x + cell / 2;
      const cy = y + cell / 2;
      if (data.orbs >= mass - 1) {
        parts.push(`<circle cx="${cx}" cy="${cy}" r="${cell * 0.42}" fill="none" stroke="${css}" stroke-opacity="0.55" stroke-width="1"/>`);
      }
      for (const [ox, oy] of layoutFor(data.orbs)) {
        parts.push(`<circle cx="${cx + ox * cell * 0.36}" cy="${cy + oy * cell * 0.36}" r="${cell * 0.16}" fill="${css}"/>`);
      }
    }
  }
  parts.push('</svg>');
  return parts.join('');
}

function todaysPuzzle(): DailyPuzzle {
  const day = dayNumber();
  if (!dailyPreview || dailyPreview.day !== day) {
    const puzzle = buildDailyPuzzle(day, dailyPlayers());
    dailyPreview = { day, puzzle, svg: puzzleSvg(puzzle) };
  }
  return dailyPreview.puzzle;
}

function renderDailyPage() {
  const today = dayNumber();
  const puzzle = todaysPuzzle();
  const rec = dailyState.day(today);
  const state = dailyState.get();
  const tries = rec?.tries ?? [];
  const top = tries.length ? Math.max(...tries) : 0;
  const done = !!rec?.done;

  $('dp-eyebrow').textContent = `Puzzle #${today}`;
  const preview = $('dp-preview');
  preview.innerHTML = dailyPreview!.svg;
  preview.classList.toggle('is-done', done);

  $('dp-tries').innerHTML = Array.from({ length: DAILY_TRIES }, (_, i) => {
    const chain = tries[i];
    const cls = chain === undefined ? (i === tries.length && !done ? 'now' : '') : chain >= puzzle.best ? 'win' : 'used';
    return `<i class="${cls}">${chain === undefined ? '' : `×${chain}`}</i>`;
  }).join('');

  const status = $('dp-status');
  const play = $('dp-play-btn');
  if (done) {
    status.textContent =
      top >= puzzle.best ? `Perfect. You found the ×${puzzle.best} chain.` : `Your best was ×${top}. The board held a ×${puzzle.best}.`;
    play.textContent = 'See result';
  } else if (tries.length) {
    const left = DAILY_TRIES - tries.length;
    status.textContent = `Best so far ×${top}. The deepest chain is ×${puzzle.best}.`;
    play.textContent = `Keep going · ${left} ${left === 1 ? 'try' : 'tries'} left`;
  } else {
    status.textContent = `The deepest chain on this board is ×${puzzle.best}. Can you find it in one move?`;
    play.textContent = "Play today's puzzle";
  }
  $('dp-share-btn').classList.toggle('hidden', !done);

  $('dp-streak').textContent = String(dailyState.liveStreak(today));
  $('dp-played').textContent = String(state.played);
  $('dp-perfect').textContent = String(state.perfect);

  const now = new Date();
  $('dp-week').innerHTML = Array.from({ length: 7 }, (_, k) => {
    const back = 6 - k;
    const day = today - back;
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    const label = d.toLocaleDateString(undefined, { weekday: 'narrow' });
    const r = dailyState.day(day);
    const best = r?.tries.length ? Math.max(...r.tries) : null;
    const cls = !r || !r.tries.length ? (back === 0 ? 'open' : 'missed') : best! >= r.best ? 'solved' : 'tried';
    const mark = cls === 'solved' ? '✓' : best !== null ? `×${best}` : back === 0 ? '·' : '';
    return `<div class="dp-day ${cls}${back === 0 ? ' today' : ''}"><span class="dp-mark">${mark}</span><span class="dp-dow">${label}</span></div>`;
  }).join('');

  const tick = () => {
    const ms = msUntilNextDay();
    const hh = Math.floor(ms / 3_600_000);
    const mm = Math.floor((ms % 3_600_000) / 60_000);
    const ss = Math.floor((ms % 60_000) / 1000);
    $('dp-countdown').textContent = `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    // Midnight passed while the page was open: a new puzzle is out.
    if (dayNumber() !== today && !screenDailyPage.classList.contains('hidden')) renderDailyPage();
  };
  tick();
  clearInterval(dailyPageTimer);
  dailyPageTimer = window.setInterval(tick, 1000);
}

$('dp-play-btn').addEventListener('click', () => dailyBtn.click());
$('dp-share-btn').addEventListener('click', () => $('daily-share-btn').click());

// ---------- Profile page extras ----------
function openSettings() {
  sfx.unlock();
  sfx.buttonTap();
  renderSettings();
  setSettingsTab(settingsTab);
  showOverlay(screenSettings);
}

// Settings is split into sections — Sound, Graphics, Nova, Chat — shown one at
// a time, so the sheet is a short list of choices rather than one long page.
// The last section opened is remembered.
const SETTINGS_TAB_KEY = 'fissile.settingsTab';
let settingsTab = (() => {
  try {
    return localStorage.getItem(SETTINGS_TAB_KEY) || 'sound';
  } catch {
    return 'sound';
  }
})();
function setSettingsTab(key: string) {
  const tabs = screenSettings.querySelectorAll<HTMLElement>('[data-settings-tab]');
  if (![...tabs].some((t) => t.dataset.settingsTab === key)) key = 'sound';
  settingsTab = key;
  tabs.forEach((t) => {
    const on = t.dataset.settingsTab === key;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  });
  screenSettings.querySelectorAll<HTMLElement>('[data-settings-pane]').forEach((p) => {
    p.classList.toggle('hidden', p.dataset.settingsPane !== key);
  });
  if (key === 'graphics') renderGraphicsSettings();
  if (key === 'sound') {
    screenSettings.querySelectorAll<HTMLInputElement>('[data-settings-sound]').forEach((el) => {
      el.checked = el.dataset.settingsSound === 'fx' ? !sfx.fxMuted : !sfx.musicMuted;
    });
  }
  try {
    localStorage.setItem(SETTINGS_TAB_KEY, key);
  } catch {
    // Session only.
  }
}
screenSettings.addEventListener('change', (e) => {
  const el = e.target as HTMLInputElement;
  if (!el.dataset.settingsSound) return;
  if (el.dataset.settingsSound === 'fx') sfx.fxMuted = !el.checked;
  else sfx.musicMuted = !el.checked;
  saveSoundPrefs();
});
screenSettings.querySelector('.settings-tabs')!.addEventListener('click', (e) => {
  const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-settings-tab]');
  if (!tab) return;
  sfx.buttonTap();
  setSettingsTab(tab.dataset.settingsTab!);
  screenSettings.querySelector('.settings-panes')?.scrollTo({ top: 0 });
});
screenSettings.querySelector('.settings-tabs')!.addEventListener('keydown', (e) => {
  const ke = e as KeyboardEvent;
  if (ke.key !== 'ArrowRight' && ke.key !== 'ArrowLeft' && ke.key !== 'ArrowDown' && ke.key !== 'ArrowUp') return;
  const keys = [...screenSettings.querySelectorAll<HTMLElement>('[data-settings-tab]')].map((t) => t.dataset.settingsTab!);
  const step = ke.key === 'ArrowRight' || ke.key === 'ArrowDown' ? 1 : -1;
  const next = keys[(keys.indexOf(settingsTab) + step + keys.length) % keys.length];
  setSettingsTab(next);
  screenSettings.querySelector<HTMLElement>(`[data-settings-tab="${next}"]`)?.focus();
  ke.preventDefault();
});
$('profile-settings-btn').addEventListener('click', openSettings);
// Mid-match: volume, graphics and Nova can be changed without leaving the
// board. Graphics changes apply to the live renderer as they are picked.
$('settings-btn-game').addEventListener('click', openSettings);
$('profile-settings-row').addEventListener('click', openSettings);
$('profile-lesson-row').addEventListener('click', () => void startLesson());
$('lesson-btn').addEventListener('click', () => void startLesson());
$('app-version').textContent = `FISSILE ${__APP_VERSION__}${isNative ? ' · Android' : ''}`;

// ---------- init ----------
selectMode(applyStoredPrefs());
selectLobbyMode(DEFAULT_MODE);
selectQuickMode(DEFAULT_MODE);
initProfile({
  tap: () => sfx.buttonTap(),
  // The name field already exists on the online screen, with its own
  // validation and its own save button. Sending the player there beats a
  // second rename control that has to be kept in step with the first.
  onRename: () => {
    // Opening the field here would not survive: the online screen mints or
    // reloads the account first, and that round trip ends by deciding whether
    // the field should be open — closing it again for anyone who already has a
    // name, which is everyone who would press this button. The flag is read
    // once the account settles instead.
    wantsRename = true;
    goTab('online');
  },
  // The title screen shows a summary line that includes the account, so it
  // has to be redrawn when the account changes underneath it.
  onChanged: () => renderProfileStrip(),
});
// Every overlay becomes a draggable sheet on a phone. Dismissal routes
// through each panel's own close button rather than a second teardown path,
// so a swipe and a tap can never leave the app in different states.
for (const [screenId, closeId] of [
  ['screen-settings', 'settings-close-btn'],
  ['screen-setup', 'setup-close-btn'],
  ['screen-howto', 'howto-close-btn'],
  ['screen-cpu', 'cpu-close-btn'],
  ['screen-daily', 'daily-close-btn'],
] as const) {
  const screen = $(screenId);
  const card = screen.querySelector<HTMLElement>('.howto-card');
  if (card) attachSheet({ screen, sheet: card, onDismiss: () => $(closeId).click() });
}

// The tutorial is paged, so swiping is how people will try to move through
// it. The buttons stay: a gesture is an accelerant, never the only route.
attachSwipePager({
  surface: $('howto-pages'),
  onSwipe: (dir) => showHowtoPage(howtoPage + dir),
});

buildTauntPalette();
buildChatPalette();
showHowtoPage(0);
renderProfileStrip();
updateMuteIcon();
// showScreen does more than reveal a section now — it starts and stops attract
// mode — so the title screen has to be entered through it like any other.
if (!checkRoomLinkParam()) {
  showScreen(screenMenu);
  // First launch only: Nova introduces herself and offers the lesson.
  setTimeout(maybeWelcome, 900);
}
hideSplashWhenPainted();
void initNative({
  onPause: () => sfx.suspend(),
  onResume: () => sfx.resume(),
  onRoomLink: openRoomFromLink,
});
telemetry.start();
exposeDebug();
// The account, if this device has one, fills in the home screen's name and
// avatar. Deferred past first paint — it is a network round trip, and the
// menu must never wait on one.
setTimeout(() => {
  void account
    .load()
    .then(() => {
      if (!screenMenu.classList.contains('hidden')) renderHome();
      if (account.credentials) void renderInvites();
    })
    .catch(() => {});
}, 1200);

// Registered in production only: in dev the worker would serve yesterday's
// bundle over Vite's, which looks exactly like a broken hot reload. This is
// what makes the game installable — a Play Store TWA is an installed PWA in a
// native wrapper, and Chrome will not offer installation without a fetch
// handler, so without this there is no Android app.
// Not in the installed app: there the whole game already ships inside the
// APK, so a worker would only add a second, staler copy of it.
if (import.meta.env.PROD && !isNative && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch((err) => {
      // Never fatal: the game runs perfectly well unregistered, it just is not
      // installable and does not survive losing the connection.
      console.warn('Service worker registration failed:', err);
    });
  });
}
