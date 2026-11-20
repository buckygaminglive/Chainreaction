// Explicit .ts extensions throughout src/game: this layer is the one that has
// to resolve with no bundler in front of it (`node --test` runs it directly),
// and Node's ESM resolver will not infer the extension the way Vite does.
import { GameEngine } from './GameEngine.ts';

/** Because the engine is a pure, cheap, deterministic function of (board,
 *  move), the opponent doesn't have to guess: it can actually play every legal
 *  move on a throwaway copy of the board and look at what happens. On the
 *  biggest lattice that is ~90 full cascade resolutions per turn, which costs
 *  single-digit milliseconds — far less than the placement animation the
 *  player is watching anyway. */
function cloneEngine(engine: GameEngine): GameEngine {
  const clone = new GameEngine({
    rows: engine.rows,
    cols: engine.cols,
    players: engine.players,
    kinds: engine.kinds,
  });
  // getSnapshot already deep-copies the grid, roster and lattice, so the clone
  // shares no mutable state with the live game.
  clone.loadSnapshot(engine.getSnapshot());
  return clone;
}

function orbTotals(engine: GameEngine, playerId: number) {
  let mine = 0;
  let theirs = 0;
  let myCells = 0;
  let theirCells = 0;
  for (const row of engine.grid) {
    for (const cell of row) {
      if (cell.owner === null || cell.orbs <= 0) continue;
      if (cell.owner === playerId) {
        mine += cell.orbs;
        myCells++;
      } else {
        theirs += cell.orbs;
        theirCells++;
      }
    }
  }
  return { mine, theirs, myCells, theirCells };
}

/** How many of my cells are sitting next to an enemy cell that is one orb from
 *  going critical — i.e. how much of my board the opponent can take on their
 *  very next move. This is the term that stops the AI from stacking orbs into
 *  an obviously doomed position. */
function exposure(engine: GameEngine, playerId: number): number {
  let count = 0;
  for (let r = 0; r < engine.rows; r++) {
    for (let c = 0; c < engine.cols; c++) {
      const cell = engine.getCell(r, c);
      if (cell.owner !== playerId || cell.orbs <= 0) continue;
      for (const n of engine.neighborsOf(r, c)) {
        const other = engine.getCell(n.row, n.col);
        if (other.owner === null || other.owner === playerId) continue;
        if (other.orbs >= engine.criticalMass(n.row, n.col) - 1) {
          count += cell.orbs;
          break;
        }
      }
    }
  }
  return count;
}

function scorePosition(engine: GameEngine, playerId: number): number {
  if (engine.gameOver) return engine.winner === playerId ? 10000 : -10000;
  const { mine, theirs, myCells, theirCells } = orbTotals(engine, playerId);
  return (mine - theirs) * 3 + (myCells - theirCells) * 2 - exposure(engine, playerId) * 4;
}

/**
 * Picks a move for `playerId`.
 *
 * `skill` runs 0 → 1. It does not change the evaluation — a weak opponent that
 * evaluates badly plays *strangely*, which reads as broken rather than easy.
 * Instead it narrows how far down the ranked list the AI is willing to pick,
 * so a weak opponent makes recognisably reasonable moves and merely misses the
 * best one.
 */
export function chooseMove(
  engine: GameEngine,
  playerId: number,
  skill = 1,
  rng: () => number = Math.random
): { row: number; col: number } | null {
  const moves = engine.legalMoves();
  if (moves.length === 0) return null;

  const scored = moves.map((move) => {
    const clone = cloneEngine(engine);
    clone.applyMove(move.row, move.col);
    return { move, score: scorePosition(clone, playerId) };
  });
  scored.sort((a, b) => b.score - a.score);

  // At skill 1 this is always the top move; at skill 0 it is anywhere in the
  // top half of the ranked list.
  const window = Math.max(1, Math.round(scored.length * 0.5 * (1 - skill)));
  return scored[Math.floor(rng() * Math.min(window, scored.length))].move;
}

/** Survival's difficulty curve. Round 1 is beatable by anyone; by round 6 the
 *  AI is playing its best move every turn and the lattice is badly degraded. */
export function skillForRound(round: number): number {
  return Math.min(1, 0.25 + (round - 1) * 0.15);
}

/**
 * Two-ply search: my move, then the opponent's best reply.
 *
 * The one-ply chooser above happily stacks a cell next to an enemy cell that
 * is about to blow, because its exposure term only guesses at the reply. This
 * actually plays the reply out. It is reserved for the hardest computer
 * opponent — on a 13×7 board it is a few hundred cascade resolutions per
 * turn, which a phone does well inside the opponent's thinking pause — and
 * pruned to the strongest one-ply candidates so the cost stays flat.
 *
 * Two-player only: with more seats "the opponent's best reply" stops being
 * one well-defined thing.
 */
export function chooseMoveDeep(
  engine: GameEngine,
  playerId: number,
  breadth = 10
): { row: number; col: number } | null {
  const moves = engine.legalMoves();
  if (moves.length === 0) return null;

  const first = moves
    .map((move) => {
      const clone = cloneEngine(engine);
      clone.applyMove(move.row, move.col);
      return { move, clone, score: scorePosition(clone, playerId) };
    })
    .sort((a, b) => b.score - a.score);

  // A move that wins outright needs no further thought.
  if (first[0].clone.gameOver && first[0].clone.winner === playerId) return first[0].move;

  let best = first[0];
  let bestWorst = -Infinity;
  for (const cand of first.slice(0, breadth)) {
    if (cand.clone.gameOver) {
      const v = cand.clone.winner === playerId ? 10000 : -10000;
      if (v > bestWorst) {
        bestWorst = v;
        best = cand;
      }
      continue;
    }
    // The opponent answers with whatever is worst for us.
    let worst = Infinity;
    for (const reply of cand.clone.legalMoves()) {
      const after = cloneEngine(cand.clone);
      after.applyMove(reply.row, reply.col);
      const v = scorePosition(after, playerId);
      if (v < worst) worst = v;
      if (worst <= bestWorst) break; // cannot beat what we already have
    }
    if (worst > bestWorst) {
      bestWorst = worst;
      best = cand;
    }
  }
  return best.move;
}
