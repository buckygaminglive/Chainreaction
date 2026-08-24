import type { GameModeKey } from './modes.ts';

/** What a lattice site does.
 *
 *  `void` is the cheap one: it is simply absent from the lattice, so it drops
 *  out of `neighborsOf` and every adjacent cell's critical mass falls by one
 *  on its own. No new explosion rule, no change to orb conservation — it just
 *  reshapes the board.
 *
 *  `catalyst` and `damper` shift critical mass by one in either direction, so
 *  they do break conservation (a catalyst ejects one more orb than it consumes,
 *  a damper one fewer). That is the point of them, and it is bounded: catalysts
 *  push the board towards saturation, which the engine's cascade guard already
 *  terminates, and dampers only ever remove orbs. */
export type CellKind = 'normal' | 'void' | 'catalyst' | 'damper';

export type CellKindGrid = CellKind[][];

/** Small deterministic PRNG (mulberry32). The layout has to be identical on
 *  every client and on the relay, so it is derived from a seed the server
 *  hands out rather than from Math.random on each machine. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

function blankGrid(rows: number, cols: number): CellKindGrid {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => 'normal' as CellKind));
}

/** Mirrors a site through the board's centre. Both special-cell modes are
 *  180°-rotationally symmetric: in a game where anyone may play anywhere, that
 *  is what keeps a "random" board from quietly handing one player a better
 *  half. It is the "controlled" half of "controlled random events". */
function stampSymmetric(grid: CellKindGrid, r: number, c: number, kind: CellKind) {
  const rows = grid.length;
  const cols = grid[0].length;
  grid[r][c] = kind;
  grid[rows - 1 - r][cols - 1 - c] = kind;
}

/** Chaos: a fresh random scatter every match — voids that reshape the lattice,
 *  plus catalysts and dampers. Re-rolled from a new seed each game, so no two
 *  Chaos boards are the same. */
function chaosLayout(rows: number, cols: number, seed: number): CellKindGrid {
  const grid = blankGrid(rows, cols);
  const rng = makeRng(seed);
  const half = Math.floor((rows * cols) / 2);
  const budget = {
    void: Math.max(2, Math.round(half * 0.1)),
    catalyst: Math.max(2, Math.round(half * 0.1)),
    damper: Math.max(1, Math.round(half * 0.07)),
  };

  for (const kind of ['void', 'catalyst', 'damper'] as const) {
    let placed = 0;
    let guard = 0;
    while (placed < budget[kind] && guard++ < 400) {
      const r = Math.floor(rng() * rows);
      const c = Math.floor(rng() * cols);
      if (grid[r][c] !== 'normal') continue;
      // Leave the centre site alone on odd-by-odd boards: it is its own mirror,
      // so a void there would be the one asymmetric thing on the board.
      if (rows % 2 === 1 && cols % 2 === 1 && r === (rows - 1) / 2 && c === (cols - 1) / 2) continue;
      stampSymmetric(grid, r, c, kind);
      placed++;
    }
  }
  return grid;
}

/** Power Cells: a designed, denser, fully symmetric arrangement with no voids.
 *  Unlike Chaos this is the same board every time, so it can actually be
 *  learned and played around — which is what makes it a strategy mode rather
 *  than a variance mode. */
function powerCellLayout(rows: number, cols: number): CellKindGrid {
  const grid = blankGrid(rows, cols);
  const midR = (rows - 1) / 2;
  const midC = (cols - 1) / 2;
  const half = (rows * cols) / 2;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Only the first half of the board is walked; stampSymmetric fills the
      // other half. Testing every cell instead would double-stamp each pair,
      // and on a board with an odd row+col count the mirror of a cell has the
      // opposite (r+c) parity — so the checkerboard thinning below would be
      // cancelled out and the damper fields would come out solid.
      if (r * cols + c >= half) continue;
      if (grid[r][c] !== 'normal') continue;
      const dr = Math.abs(r - midR);
      const dc = Math.abs(c - midC);
      // Catalysts ring the centre — the contested ground is the volatile
      // ground. Dampers thin out across the far corners as safe build-up wells.
      const ring = Math.round(dr) + Math.round(dc);
      if (ring === 2) stampSymmetric(grid, r, c, 'catalyst');
      else if (dr >= 2.5 && dc >= 1.5 && (r + c) % 2 === 0) stampSymmetric(grid, r, c, 'damper');
    }
  }
  return grid;
}

/** Survival: the lattice degrades round by round. Round 1 is a clean board;
 *  every round after that eats more of it, so the same tactics stop working. */
function survivalLayout(rows: number, cols: number, seed: number, round: number): CellKindGrid {
  if (round <= 1) return blankGrid(rows, cols);
  const grid = blankGrid(rows, cols);
  const rng = makeRng(seed + round * 7919);
  const half = Math.floor((rows * cols) / 2);
  const voids = Math.min(Math.round(half * 0.3), Math.round(half * 0.045 * (round - 1)));
  const catalysts = Math.min(Math.round(half * 0.22), Math.round(half * 0.035 * (round - 1)));

  for (const [kind, count] of [
    ['void', voids],
    ['catalyst', catalysts],
  ] as const) {
    let placed = 0;
    let guard = 0;
    while (placed < count && guard++ < 500) {
      const r = Math.floor(rng() * rows);
      const c = Math.floor(rng() * cols);
      if (grid[r][c] !== 'normal') continue;
      if (rows % 2 === 1 && cols % 2 === 1 && r === (rows - 1) / 2 && c === (cols - 1) / 2) continue;
      stampSymmetric(grid, r, c, kind);
      placed++;
    }
  }
  return grid;
}

export function layoutForMode(
  mode: GameModeKey,
  rows: number,
  cols: number,
  seed: number,
  round = 1
): CellKindGrid {
  switch (mode) {
    case 'chaos':
      return chaosLayout(rows, cols, seed);
    case 'power':
      return powerCellLayout(rows, cols);
    case 'survival':
      return survivalLayout(rows, cols, seed, round);
    default:
      return blankGrid(rows, cols);
  }
}
