import './style.css';
import { GameEngine } from './game/GameEngine';
import type { PlayerConfig, MoveEvent } from './game/types';
import { ThreeRenderer, type OrbStyle } from './render3d/ThreeRenderer';
import { PLAYER_THEMES } from './render/theme';
import { sfx } from './sfx/Sfx';
import { NetClient } from './net/NetClient';
import type { BoardSizeKey, NetPlayer } from './net/protocol';

const BOARD_SIZES: Record<BoardSizeKey, { rows: number; cols: number }> = {
  small: { rows: 9, cols: 5 },
  medium: { rows: 11, cols: 6 },
  large: { rows: 13, cols: 7 },
};

let numPlayers = 2;
let boardSizeKey: BoardSizeKey = 'medium';
let orbStyle: OrbStyle = 'emoji';
let engine: GameEngine | null = null;
let renderer: ThreeRenderer | null = null;
let animating = false;
let muted = false;

// ---------- Online state ----------
let net: NetClient | null = null;
let onlineMode = false;
let myPlayerId = -1;
let lobbyBoardSize: BoardSizeKey = 'medium';
let lobbyOrbStyle: OrbStyle = 'emoji';
let intentionalDisconnect = false;

function disconnectNet() {
  intentionalDisconnect = true;
  net?.disconnect();
  net = null;
}

// ---------- DOM refs ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const screenMenu = $('screen-menu');
const screenGame = $('screen-game');
const screenWin = $('screen-win');
const screenHowto = $('screen-howto');
const screenOnline = $('screen-online');
const screenLobby = $('screen-lobby');
const ALL_SCREENS = [screenMenu, screenGame, screenOnline, screenLobby];

const playersCountEl = $('players-count');
const playerSwatchesEl = $('player-swatches');
const boardSizeGroup = $('board-size-group');
const orbStyleGroup = $('orb-style-group');
const playPillsEl = $('player-pills');
const boardHost = $('board-host');
const winTitleEl = $('win-title');
const confettiLayer = $('confetti-layer');

const nameInput = $<HTMLInputElement>('name-input');
const joinCodeInput = $<HTMLInputElement>('join-code-input');
const createRoomBtn = $('create-room-btn');
const joinRoomBtn = $('join-room-btn');
const onlineErrorEl = $('online-error');
const roomCodeBtn = $('room-code-btn');
const lobbyHintEl = $('lobby-hint');
const lobbyPlayersEl = $('lobby-players');
const lobbyHostControls = $('lobby-host-controls');
const lobbyBoardSizeGroup = $('lobby-board-size-group');
const lobbyOrbStyleGroup = $('lobby-orb-style-group');
const lobbyStartBtn = $<HTMLButtonElement>('lobby-start-btn');
const lobbyWaitMsg = $('lobby-wait-msg');

function colorOf(playerId: number) {
  return PLAYER_THEMES[playerId % PLAYER_THEMES.length];
}

// ---------- Menu setup ----------
function renderSwatches() {
  playerSwatchesEl.innerHTML = '';
  for (let i = 0; i < numPlayers; i++) {
    const theme = colorOf(i);
    const el = document.createElement('div');
    el.className = 'swatch';
    el.style.background = `radial-gradient(circle at 35% 30%, ${theme.css}, ${theme.css}dd)`;
    el.style.boxShadow = `0 0 14px 1px ${theme.css}88`;
    el.textContent = `P${i + 1}`;
    playerSwatchesEl.appendChild(el);
  }
}

$('players-minus').addEventListener('click', () => {
  sfx.unlock();
  sfx.buttonTap();
  numPlayers = Math.max(2, numPlayers - 1);
  playersCountEl.textContent = String(numPlayers);
  renderSwatches();
});

$('players-plus').addEventListener('click', () => {
  sfx.unlock();
  sfx.buttonTap();
  numPlayers = Math.min(6, numPlayers + 1);
  playersCountEl.textContent = String(numPlayers);
  renderSwatches();
});

boardSizeGroup.addEventListener('click', (e) => {
  const target = (e.target as HTMLElement).closest<HTMLElement>('.segment');
  if (!target) return;
  sfx.unlock();
  sfx.buttonTap();
  boardSizeGroup.querySelectorAll('.segment').forEach((s) => s.classList.remove('active'));
  target.classList.add('active');
  boardSizeKey = target.dataset.size as BoardSizeKey;
});

orbStyleGroup.addEventListener('click', (e) => {
  const target = (e.target as HTMLElement).closest<HTMLElement>('.segment');
  if (!target) return;
  sfx.unlock();
  sfx.buttonTap();
  orbStyleGroup.querySelectorAll('.segment').forEach((s) => s.classList.remove('active'));
  target.classList.add('active');
  orbStyle = target.dataset.style as OrbStyle;
  renderer?.setOrbStyle(orbStyle);
});

$('howto-btn').addEventListener('click', () => {
  sfx.unlock();
  sfx.buttonTap();
  showOverlay(screenHowto);
});
$('howto-close-btn').addEventListener('click', () => {
  sfx.buttonTap();
  hideOverlay(screenHowto);
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
}
$('mute-btn-menu').addEventListener('click', toggleMute);
$('mute-btn-game').addEventListener('click', toggleMute);

$('back-btn').addEventListener('click', () => {
  sfx.buttonTap();
  if (onlineMode) leaveOnlineGame();
  showScreen(screenMenu);
});

$('play-again-btn').addEventListener('click', () => {
  sfx.buttonTap();
  hideOverlay(screenWin);
  if (onlineMode) {
    net?.restart();
    showScreen(screenLobby);
  } else {
    startLocalGame();
  }
});
$('win-menu-btn').addEventListener('click', () => {
  sfx.buttonTap();
  hideOverlay(screenWin);
  if (onlineMode) leaveOnlineGame();
  showScreen(screenMenu);
});

$('play-btn').addEventListener('click', () => {
  sfx.unlock();
  sfx.buttonTap();
  if (net) disconnectNet();
  onlineMode = false;
  startLocalGame();
  showScreen(screenGame);
});

function showScreen(el: HTMLElement) {
  ALL_SCREENS.forEach((s) => s.classList.add('hidden'));
  el.classList.remove('hidden');
}
function showOverlay(el: HTMLElement) {
  el.classList.remove('hidden');
}
function hideOverlay(el: HTMLElement) {
  el.classList.add('hidden');
}

// ---------- HUD ----------
function renderPills() {
  if (!engine) return;
  playPillsEl.innerHTML = '';
  engine.players.forEach((p) => {
    const theme = colorOf(p.id);
    const pill = document.createElement('div');
    pill.className = 'pill';
    if (p.id === engine!.currentPlayer().id && !engine!.gameOver) pill.classList.add('active');
    if (!p.isAlive) pill.classList.add('eliminated');
    const orbCount = countOrbs(p.id);
    const youTag = onlineMode && p.id === myPlayerId ? ' (You)' : '';
    pill.innerHTML = `<span class="dot" style="background:${theme.css};box-shadow:0 0 8px ${theme.css}"></span>P${p.id + 1}${youTag} · ${orbCount}`;
    if (pill.classList.contains('active')) {
      pill.style.borderColor = theme.css;
      pill.style.boxShadow = `0 0 14px ${theme.css}55`;
    }
    playPillsEl.appendChild(pill);
  });
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

// ---------- Local game lifecycle ----------
async function startLocalGame() {
  const size = BOARD_SIZES[boardSizeKey];
  const players: PlayerConfig[] = [];
  for (let i = 0; i < numPlayers; i++) {
    const theme = colorOf(i);
    players.push({ id: i, name: `Player ${i + 1}`, color: theme.base, colorLight: theme.light, isAlive: true });
  }
  const newEngine = new GameEngine({ rows: size.rows, cols: size.cols, players });
  await mountGame(newEngine, orbStyle);
  renderer!.setCellTapHandler(onCellTapLocal);
}

async function mountGame(newEngine: GameEngine, style: OrbStyle) {
  if (renderer) {
    renderer.destroy();
    renderer = null;
  }
  boardHost.innerHTML = '';
  engine = newEngine;
  renderer = new ThreeRenderer(engine, colorOf, style);
  await renderer.init(boardHost);
  renderer.resetVisual();
  renderPills();
  animating = false;

  if (import.meta.env.DEV) {
    (window as any).__debug = { engine, renderer, net, onCellTapLocal };
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
  animating = true;
  sfx.unlock();
  net.sendMove(row, col);
}

async function applyAndAnimateMove(row: number, col: number) {
  if (!engine || !renderer) return;
  const result = engine.applyMove(row, col);

  await renderer.playEvents(result.events, (ev: MoveEvent) => {
    if (ev.type === 'place') sfx.place();
    else if (ev.type === 'explode') sfx.explode();
  });

  for (const ev of result.events) {
    if (ev.type === 'eliminate') sfx.eliminate();
  }

  renderPills();

  if (result.gameOver && result.winner !== null) {
    sfx.win();
    const theme = colorOf(result.winner);
    winTitleEl.textContent = `Player ${result.winner + 1} Wins!`;
    winTitleEl.style.color = theme.css;
    winTitleEl.style.textShadow = `0 0 24px ${theme.css}aa`;
    launchConfetti();
    setTimeout(() => showOverlay(screenWin), 450);
  } else {
    sfx.turnChange();
    animating = false;
  }
}

function launchConfetti() {
  confettiLayer.innerHTML = '';
  const colors = PLAYER_THEMES.map((t) => t.css);
  for (let i = 0; i < 70; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    const size = 6 + Math.random() * 6;
    piece.style.width = `${size}px`;
    piece.style.height = `${size * 1.6}px`;
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDuration = `${1.8 + Math.random() * 1.6}s`;
    piece.style.animationDelay = `${Math.random() * 0.6}s`;
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

$('play-online-btn').addEventListener('click', () => {
  sfx.unlock();
  sfx.buttonTap();
  clearOnlineError();
  showScreen(screenOnline);
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
  try {
    const code = await client.createRoom();
    await client.connect(code, nameInput.value.trim() || randomName());
    net = client;
    wireNetHandlers();
    enterLobby();
  } catch (err) {
    showOnlineError(err instanceof Error ? err.message : 'Could not create a room.');
  } finally {
    setBusy(false);
  }
});

joinRoomBtn.addEventListener('click', async () => {
  sfx.unlock();
  sfx.buttonTap();
  clearOnlineError();
  const code = joinCodeInput.value.trim();
  if (!code) {
    showOnlineError('Enter a room code.');
    return;
  }
  setBusy(true);
  const client = new NetClient();
  try {
    await client.connect(code, nameInput.value.trim() || randomName());
    net = client;
    wireNetHandlers();
    enterLobby();
  } catch (err) {
    showOnlineError(err instanceof Error ? err.message : 'Could not join that room.');
  } finally {
    setBusy(false);
  }
});

function wireNetHandlers() {
  if (!net) return;
  net.onPlayers = (players, hostId) => renderLobby(players, hostId);
  net.onError = (message) => showOnlineError(message);
  net.onGameStarted = (rows, cols, players, style) => startOnlineGame(rows, cols, players, style);
  net.onMove = (row, col) => {
    void applyAndAnimateMove(row, col);
  };
  net.onDisconnect = () => {
    net = null;
    if (intentionalDisconnect) {
      intentionalDisconnect = false;
      return;
    }
    onlineMode = false;
    showOnlineError('Lost connection to the room.');
    showScreen(screenOnline);
  };
}

function enterLobby() {
  showScreen(screenLobby);
  roomCodeBtn.textContent = net?.roomCode ?? '-----';
}

roomCodeBtn.addEventListener('click', async () => {
  if (!net) return;
  const link = `${location.origin}${location.pathname}?room=${net.roomCode}`;
  try {
    await navigator.clipboard.writeText(link);
    const original = lobbyHintEl.textContent;
    lobbyHintEl.textContent = 'Invite link copied!';
    setTimeout(() => {
      lobbyHintEl.textContent = original;
    }, 1600);
  } catch {
    showOnlineError('Could not copy link — share the code instead.');
  }
});

lobbyBoardSizeGroup.addEventListener('click', (e) => {
  const target = (e.target as HTMLElement).closest<HTMLElement>('.segment');
  if (!target) return;
  sfx.buttonTap();
  lobbyBoardSizeGroup.querySelectorAll('.segment').forEach((s) => s.classList.remove('active'));
  target.classList.add('active');
  lobbyBoardSize = target.dataset.size as BoardSizeKey;
});

lobbyOrbStyleGroup.addEventListener('click', (e) => {
  const target = (e.target as HTMLElement).closest<HTMLElement>('.segment');
  if (!target) return;
  sfx.buttonTap();
  lobbyOrbStyleGroup.querySelectorAll('.segment').forEach((s) => s.classList.remove('active'));
  target.classList.add('active');
  lobbyOrbStyle = target.dataset.style as OrbStyle;
});

lobbyStartBtn.addEventListener('click', () => {
  sfx.buttonTap();
  net?.startGame(lobbyBoardSize, lobbyOrbStyle);
});

$('lobby-back-btn').addEventListener('click', () => {
  sfx.buttonTap();
  disconnectNet();
  showScreen(screenMenu);
});

function renderLobby(players: NetPlayer[], hostId: number) {
  lobbyPlayersEl.innerHTML = '';
  players.forEach((p, idx) => {
    const theme = colorOf(idx);
    const row = document.createElement('div');
    row.className = 'lobby-player' + (p.connected ? '' : ' offline');
    const you = net && p.id === net.myId ? ' (You)' : '';
    const crown = p.id === hostId ? '<span class="crown">👑</span>' : '';
    row.innerHTML = `<span class="dot" style="background:${theme.css};box-shadow:0 0 8px ${theme.css}"></span><span class="name">${p.name}${you}</span>${crown}`;
    lobbyPlayersEl.appendChild(row);
  });

  const isHost = !!net?.isHost;
  lobbyHostControls.classList.toggle('hidden', !isHost);
  lobbyStartBtn.classList.toggle('hidden', !isHost);
  lobbyWaitMsg.classList.toggle('hidden', isHost);
  const connectedCount = players.filter((p) => p.connected).length;
  lobbyStartBtn.toggleAttribute('disabled', connectedCount < 2);
}

async function startOnlineGame(rows: number, cols: number, players: PlayerConfig[], style: OrbStyle) {
  if (!net) return;
  onlineMode = true;
  myPlayerId = net.myId;
  orbStyle = style;
  const newEngine = new GameEngine({ rows, cols, players });
  await mountGame(newEngine, style);
  renderer!.setCellTapHandler(onCellTapOnline);
  showScreen(screenGame);
}

function leaveOnlineGame() {
  disconnectNet();
  onlineMode = false;
  myPlayerId = -1;
}

// ---------- Join-via-link ----------
function checkRoomLinkParam() {
  const room = new URLSearchParams(location.search).get('room');
  if (room) {
    joinCodeInput.value = room.toUpperCase();
    showScreen(screenOnline);
  }
}

// ---------- init ----------
renderSwatches();
updateMuteIcon();
checkRoomLinkParam();
