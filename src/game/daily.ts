/**
 * Daily Blast — one puzzle a day, the same for everyone.
 *
 * A board is set up mid-game and you get one move, three tries, to set off
 * the biggest chain reaction you can find. Your score is the depth of the
 * cascade you found against the deepest one the position holds. It is short
 * (a minute), it is the same for your whole class, and the result is a line
 * of text built to be pasted into a group chat — the three things that made
 * daily word puzzles spread.
 *
 * Everything here is a pure function of the day number: no clock, no
 * storage, no randomness that is not seeded from the date. That is what
 * makes it the same puzzle on every phone, and what lets the tests pin it.
 */
import { GameEngine } from './GameEngine.ts';
import type { EngineSnapshot, PlayerConfig } from './types.ts';

export const DAILY_ROWS = 8;
export const DAILY_COLS = 6;
export const DAILY_TRIES = 3;

/** Puzzle #1 is 1 January 2026, in the player's own calendar. */
const EPOCH_UTC = Date.UTC(2026, 0, 1);
const DAY_MS = 86_400_000;

/** Today's puzzle number, by the local calendar — a puzzle changes at the
 *  player's midnight, the way every daily puzzle people already know does. */
export function dayNumber(now: Date = new Date()): number {
  const local = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((local - EPOCH_UTC) / DAY_MS) + 1;
}

/** Milliseconds until the next puzzle unlocks. */
export function msUntilNextDay(now: Date = new Date()): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return Math.max(0, next.getTime() - now.getTime());
}

/** Small, fast, well-distributed seeded RNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(n: number): number {
  let h = n | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export interface MoveOutcome {
  row: number;
  col: number;
  chain: number;
  captured: number;
  wins: boolean;
}

function cloneOf(engine: GameEngine): GameEngine {
  const c = new GameEngine({ rows: engine.rows, cols: engine.cols, players: engine.players, kinds: engine.kinds });
  c.loadSnapshot(engine.getSnapshot());
  return c;
}

/** What playing (row, col) would do, without touching `engine`. */
export function moveOutcome(engine: GameEngine, row: number, col: number): MoveOutcome {
  const c = cloneOf(engine);
  const mover = c.currentPlayer().id;
  const r = c.applyMove(row, col);
  return { row, col, chain: r.chain, captured: r.captured, wins: r.gameOver && r.winner === mover };
}

/** Deeper chain first; between equal chains, more captures. */
function better(a: MoveOutcome, b: MoveOutcome): number {
  return b.chain - a.chain || b.captured - a.captured;
}

export function rankMoves(engine: GameEngine): MoveOutcome[] {
  return engine
    .legalMoves()
    .map((m) => moveOutcome(engine, m.row, m.col))
    .sort(better);
}

export interface DailyPuzzle {
  day: number;
  rows: number;
  cols: number;
  players: PlayerConfig[];
  snapshot: EngineSnapshot;
  /** The deepest chain any single move reaches from this position. */
  best: number;
  /** Every move that reaches it — usually one or two. */
  bestMoves: { row: number; col: number }[];
}

/**
 * Plays a seeded half-game to set the board up. Moves lean towards loading
 * cells without tipping them — that is what leaves a position dense with
 * cells one orb short, which is where long cascades live — with enough pure
 * randomness mixed in that no two days look alike.
 */
function setUp(engine: GameEngine, rng: () => number, plies: number) {
  for (let i = 0; i < plies && !engine.gameOver; i++) {
    const moves = engine.legalMoves();
    if (!moves.length) return;
    const quiet = moves.filter((m) => engine.getCell(m.row, m.col).orbs + 1 < engine.criticalMass(m.row, m.col));
    let pick: { row: number; col: number };
    if (quiet.length && rng() < 0.97) {
      // Prefer cells that already hold something, so the board loads up
      // rather than spreading thin across empty sites.
      const weighted = quiet.flatMap((m) => {
        const w = 1 + engine.getCell(m.row, m.col).orbs * 2;
        return Array.from({ length: w }, () => m);
      });
      pick = weighted[Math.floor(rng() * weighted.length)];
    } else {
      pick = moves[Math.floor(rng() * moves.length)];
    }
    engine.applyMove(pick.row, pick.col);
  }
}

/**
 * Builds puzzle number `day`. `players` supplies the two seats' names and
 * colours (id 0 is the solver, id 1 the rival); everything else is derived
 * from the day.
 *
 * Tries a sequence of seeded set-ups and keeps the first that makes a good
 * puzzle: a best chain of at least five that only one or two moves reach, so
 * it has to be found rather than stumbled on. Falls back to the deepest
 * position seen if none qualifies, so a puzzle always exists.
 */
export function buildDailyPuzzle(day: number, players: PlayerConfig[]): DailyPuzzle {
  let fallback: { engine: GameEngine; ranked: MoveOutcome[] } | null = null;

  for (let attempt = 0; attempt < 48; attempt++) {
    const rng = mulberry32(hash(day * 7919 + attempt * 104729));
    const engine = new GameEngine({
      rows: DAILY_ROWS,
      cols: DAILY_COLS,
      players: players.map((p) => ({ ...p, isAlive: true })),
    });
    // An even number of plies, so it is the solver's move when set-up ends.
    const plies = 2 * (18 + Math.floor(rng() * 8));
    setUp(engine, rng, plies);
    if (engine.gameOver || engine.currentPlayer().id !== players[0].id) continue;
    if (engine.players.some((p) => !p.isAlive)) continue;

    const ranked = rankMoves(engine);
    if (!ranked.length) continue;
    const top = ranked[0];
    if (!fallback || top.chain > fallback.ranked[0].chain) fallback = { engine, ranked };

    const atBest = ranked.filter((m) => m.chain === top.chain).length;
    const runnerUp = ranked.find((m) => m.chain < top.chain)?.chain ?? 0;
    if (top.chain >= 5 && atBest <= 2 && top.chain - runnerUp >= 1) {
      return finish(day, engine, ranked);
    }
  }

  if (!fallback) {
    // Unreachable in practice: a fresh 8×6 board always has legal moves.
    const engine = new GameEngine({ rows: DAILY_ROWS, cols: DAILY_COLS, players });
    return finish(day, engine, rankMoves(engine));
  }
  return finish(day, fallback.engine, fallback.ranked);
}

function finish(day: number, engine: GameEngine, ranked: MoveOutcome[]): DailyPuzzle {
  const best = ranked[0]?.chain ?? 0;
  return {
    day,
    rows: engine.rows,
    cols: engine.cols,
    players: engine.players.map((p) => ({ ...p })),
    snapshot: engine.getSnapshot(),
    best,
    bestMoves: ranked.filter((m) => m.chain === best).map(({ row, col }) => ({ row, col })),
  };
}

/** One square per try for the shareable result. */
export function trySquare(chain: number | undefined, best: number): string {
  if (chain === undefined) return '⬛';
  if (chain >= best) return '🟩';
  if (chain >= Math.max(1, best - 2)) return '🟨';
  return '🟥';
}

export function shareText(day: number, tries: number[], best: number, streak: number, link: string): string {
  const top = tries.length ? Math.max(...tries) : 0;
  const squares = Array.from({ length: DAILY_TRIES }, (_, i) => trySquare(tries[i], best)).join('');
  const crown = top >= best ? ' 🏆' : '';
  const lines = [`FISSILE Daily Blast #${day} 💥`, `Chain ×${top} / ×${best}${crown}`, squares];
  if (streak > 1) lines.push(`🔥 ${streak}-day streak`);
  lines.push(link);
  return lines.join('\n');
}
