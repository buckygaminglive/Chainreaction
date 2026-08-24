import assert from 'node:assert/strict';
import test from 'node:test';
import { GameEngine } from './GameEngine.ts';
import { chooseMove } from './ai.ts';
import { BOTS, pickBot } from './bots.ts';
import { layoutForMode, makeRng } from './cells.ts';
import type { CellKind, CellKindGrid, PlayerConfig } from './types.ts';

function players(n: number, teams = false): PlayerConfig[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    name: `P${i + 1}`,
    color: 0,
    colorLight: 0,
    isAlive: true,
    ...(teams ? { team: i % 2 } : {}),
  }));
}

function newGame(rows: number, cols: number, n = 2, kinds?: CellKindGrid) {
  return new GameEngine({ rows, cols, players: players(n), kinds });
}

/** Builds a kind grid from rows of single characters: . normal, # void,
 *  + catalyst, - damper. */
function kindGrid(...rows: string[]): CellKindGrid {
  const map: Record<string, CellKind> = { '.': 'normal', '#': 'void', '+': 'catalyst', '-': 'damper' };
  return rows.map((row) => [...row].map((ch) => map[ch]));
}

test('critical mass follows neighbour count', () => {
  const g = newGame(4, 4);
  assert.equal(g.criticalMass(0, 0), 2, 'corner');
  assert.equal(g.criticalMass(0, 1), 3, 'edge');
  assert.equal(g.criticalMass(1, 1), 4, 'interior');
});

test('a sub-critical placement does not explode', () => {
  const g = newGame(4, 4);
  const res = g.applyMove(1, 1);
  assert.equal(res.chain, 0);
  assert.equal(res.captured, 0);
  assert.equal(g.getCell(1, 1).orbs, 1);
  assert.equal(g.currentPlayer().id, 1, 'turn passes');
});

test('a corner at critical mass ejects into both neighbours', () => {
  const g = newGame(4, 4);
  g.applyMove(0, 0); // P1
  g.applyMove(3, 3); // P2
  const res = g.applyMove(0, 0); // P1 -> 2 orbs in a corner = critical

  assert.equal(res.chain, 1);
  assert.equal(g.getCell(0, 0).orbs, 0);
  assert.equal(g.getCell(0, 0).owner, null);
  assert.equal(g.getCell(0, 1).owner, 0);
  assert.equal(g.getCell(1, 0).owner, 0);
});

test('an explosion converts an opponent cell and reports the capture', () => {
  const g = newGame(4, 4);
  g.applyMove(0, 0); // P1
  g.applyMove(0, 1); // P2 takes the neighbour
  const res = g.applyMove(0, 0); // P1 goes critical into it

  assert.equal(g.getCell(0, 1).owner, 0, 'captured by the mover');
  assert.ok(res.captured >= 1, `expected a capture, got ${res.captured}`);
});

test('chain depth counts waves, not individual explosions', () => {
  const g = newGame(4, 4);
  // Load a corner and the edge cell beside it so one placement pops the edge
  // cell, which then pushes the corner over its own critical mass.
  g.applyMove(0, 1); // P1
  g.applyMove(3, 3); // P2
  g.applyMove(0, 1); // P1 -> (0,1) has 2 of the 3 it needs
  g.applyMove(3, 3); // P2 corner pops; irrelevant to the top-left corner
  g.applyMove(0, 0); // P1 -> corner at 1 of 2
  g.applyMove(3, 2); // P2 elsewhere
  const res = g.applyMove(0, 1); // P1 -> edge pops, feeding the corner critical

  assert.ok(res.chain >= 2, `expected a multi-wave chain, got ${res.chain}`);
});

test('a saturated one-colour board terminates instead of cascading forever', () => {
  // On a 2x2 every cell is a corner with critical mass 2, so it holds at most
  // one orb stably. Once one player owns all four, any further ejection pushes
  // a neighbour critical again — the cascade has no natural end. This is the
  // case that used to spin to the wave cap and emit thousands of events.
  const g = newGame(2, 2);
  g.applyMove(0, 0); // P1
  g.applyMove(1, 1); // P2
  g.applyMove(0, 1); // P1
  g.applyMove(1, 0); // P2
  const res = g.applyMove(0, 0); // P1 goes critical into a full board

  assert.equal(res.gameOver, true);
  assert.equal(res.winner, 0);
  assert.ok(res.chain < 50, `cascade should cut out early, ran ${res.chain} waves`);
  assert.ok(res.events.length < 200, `emitted ${res.events.length} events`);
});

test('stripping a player of every orb eliminates them and ends the match', () => {
  const g = newGame(2, 2);
  g.applyMove(0, 0);
  g.applyMove(1, 1);
  g.applyMove(0, 1);
  g.applyMove(1, 0);
  const res = g.applyMove(0, 0);

  assert.ok(res.events.some((e) => e.type === 'eliminate' && e.player === 1));
  assert.ok(res.events.some((e) => e.type === 'win' && e.player === 0));
  assert.equal(g.players[1].isAlive, false);
  assert.equal(g.canPlay(0, 0), false, 'no moves once the game is over');
});

test('a player cannot play into a cell an opponent holds', () => {
  const g = newGame(4, 4);
  g.applyMove(1, 1); // P1 takes it
  assert.equal(g.canPlay(1, 1), false, 'P2 may not play a cell P1 holds');
  assert.equal(g.canPlay(2, 2), true, 'empty cells are fine');
  assert.equal(g.canPlay(-1, 0), false, 'out of bounds');
  assert.equal(g.canPlay(4, 0), false, 'out of bounds');
});

test('legalMoves agrees with canPlay', () => {
  const g = newGame(3, 3);
  g.applyMove(0, 0);
  const moves = g.legalMoves();
  assert.ok(moves.every((m) => g.canPlay(m.row, m.col)));
  assert.equal(moves.length, 8, 'every cell but the one P1 holds');
});

test('an illegal move changes nothing and does not pass the turn', () => {
  const g = newGame(4, 4);
  g.applyMove(1, 1); // P1
  const before = JSON.stringify(g.getSnapshot());
  const res = g.applyMove(1, 1); // P2 tries P1's cell

  assert.equal(res.events.length, 0);
  assert.equal(res.chain, 0);
  assert.equal(JSON.stringify(g.getSnapshot()), before);
});

test('same moves produce the same state — the client/relay sync contract', () => {
  const moves: [number, number][] = [
    [0, 0], [3, 3], [0, 1], [3, 2], [0, 0], [2, 3], [1, 1], [3, 3], [0, 1], [2, 2],
  ];
  const a = newGame(4, 4);
  const b = newGame(4, 4);
  for (const [r, c] of moves) {
    a.applyMove(r, c);
    b.applyMove(r, c);
  }
  assert.deepEqual(a.getSnapshot(), b.getSnapshot());
});

test('a snapshot round-trips through serialization', () => {
  const g = newGame(4, 4);
  g.applyMove(0, 0);
  g.applyMove(3, 3);
  g.applyMove(0, 1);
  const snap = JSON.parse(JSON.stringify(g.getSnapshot()));

  const restored = newGame(4, 4);
  restored.loadSnapshot(snap);
  assert.deepEqual(restored.getSnapshot(), g.getSnapshot());
  assert.equal(restored.currentPlayer().id, g.currentPlayer().id);
});

// ---------- Special cells (Chaos / Power Cells / Survival) ----------

test('a void is absent from the lattice, not just unplayable', () => {
  const g = newGame(3, 3, 2, kindGrid('.#.', '...', '...'));
  assert.equal(g.canPlay(0, 1), false, 'cannot be played');
  // (0,0) would normally border (0,1) and (1,0). With (0,1) dead it has one
  // neighbour, so it goes critical at a single orb.
  assert.equal(g.criticalMass(0, 0), 1);
  assert.deepEqual(g.neighborsOf(0, 1).length, 3, 'a void still has neighbours of its own');
  assert.ok(g.legalMoves().every((m) => !(m.row === 0 && m.col === 1)));
});

test('a void never takes ownership from a cascade passing next to it', () => {
  const g = newGame(3, 3, 2, kindGrid('.#.', '...', '...'));
  g.applyMove(0, 0); // P1 -> one neighbour, so this is already critical
  assert.equal(g.getCell(0, 1).owner, null, 'the void stays dead');
  assert.equal(g.getCell(0, 1).orbs, 0);
  assert.equal(g.getCell(1, 0).owner, 0, 'the live neighbour took the orb');
});

test('a catalyst goes critical one orb early, a damper one orb late', () => {
  const g = newGame(4, 4, 2, kindGrid('....', '.+-.', '....', '....'));
  assert.equal(g.criticalMass(1, 1), 3, 'catalyst: 4 neighbours - 1');
  assert.equal(g.criticalMass(1, 2), 5, 'damper: 4 neighbours + 1');
});

test('a catalyst corner is floored at 2 so it can still be held', () => {
  const g = newGame(4, 4, 2, kindGrid('+...', '....', '....', '....'));
  assert.equal(g.criticalMass(0, 0), 2, 'not 1 — a cell that pops on touch is unplayable');
  g.applyMove(0, 0);
  assert.equal(g.getCell(0, 0).orbs, 1, 'holds the first orb');
});

test('special lattices stay deterministic across engines', () => {
  const kinds = layoutForMode('chaos', 11, 6, 12345);
  const a = new GameEngine({ rows: 11, cols: 6, players: players(2), kinds });
  const b = new GameEngine({ rows: 11, cols: 6, players: players(2), kinds: layoutForMode('chaos', 11, 6, 12345) });
  const moves: [number, number][] = [[0, 0], [10, 5], [0, 1], [10, 4], [1, 0], [9, 5]];
  for (const [r, c] of moves) {
    a.applyMove(r, c);
    b.applyMove(r, c);
  }
  assert.deepEqual(a.getSnapshot(), b.getSnapshot(), 'same seed must mean the same game');
});

test('a different seed gives a different Chaos lattice', () => {
  const one = layoutForMode('chaos', 11, 6, 1);
  const two = layoutForMode('chaos', 11, 6, 2);
  assert.notDeepEqual(one, two);
});

test('Chaos and Power Cells lattices are 180-degree symmetric', () => {
  for (const kinds of [layoutForMode('chaos', 11, 6, 777), layoutForMode('power', 11, 6, 0)]) {
    const rows = kinds.length;
    const cols = kinds[0].length;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        assert.equal(kinds[r][c], kinds[rows - 1 - r][cols - 1 - c], `mismatch at ${r},${c}`);
      }
    }
  }
});

test('Power Cells is the same lattice every time and has no dead sites', () => {
  const a = layoutForMode('power', 11, 6, 1);
  const b = layoutForMode('power', 11, 6, 999);
  assert.deepEqual(a, b, 'seed must not affect a designed layout');
  assert.ok(a.flat().every((k) => k !== 'void'));
  assert.ok(a.flat().some((k) => k === 'catalyst'), 'has catalysts');
});

test('special sites stay a minority of every generated lattice', () => {
  // Guards the density directly: mirroring a checkerboard flips its parity, so
  // a thinning rule applied on both halves silently fills solid instead.
  for (const [mode, rows, cols] of [
    ['power', 11, 6],
    ['power', 9, 5],
    ['power', 13, 7],
    ['chaos', 11, 6],
    ['chaos', 13, 7],
  ] as const) {
    const flat = layoutForMode(mode, rows, cols, 5).flat();
    const special = flat.filter((k) => k !== 'normal').length;
    assert.ok(
      special / flat.length < 0.35,
      `${mode} ${rows}x${cols}: ${special}/${flat.length} sites are special`
    );
    assert.ok(special > 0, `${mode} ${rows}x${cols}: has some special sites`);
  }
});

test('Survival degrades the lattice round on round', () => {
  const countVoids = (round: number) =>
    layoutForMode('survival', 11, 6, 42, round).flat().filter((k) => k === 'void').length;
  assert.equal(countVoids(1), 0, 'round 1 is a clean board');
  assert.ok(countVoids(4) > countVoids(2), 'later rounds are more degraded');
});

test('a catalyst-heavy saturated board still terminates', () => {
  // Every interior site a catalyst means every pop creates an orb. Without the
  // cascade guard this is the case that runs away hardest.
  const kinds = kindGrid('++', '++');
  const g = newGame(2, 2, 2, kinds);
  g.applyMove(0, 0);
  g.applyMove(1, 1);
  g.applyMove(0, 1);
  g.applyMove(1, 0);
  const res = g.applyMove(0, 0);
  assert.ok(res.chain < 50, `ran ${res.chain} waves`);
  assert.equal(res.gameOver, true);
});

// ---------- Team Battle ----------

test('a team is out only when both of its players are', () => {
  const g = new GameEngine({ rows: 5, cols: 5, players: players(4, true) });
  assert.equal(g.isTeamGame, true);
  assert.deepEqual([g.teamOf(0), g.teamOf(1), g.teamOf(2), g.teamOf(3)], [0, 1, 0, 1]);

  // Alternating ids means turn order already alternates sides.
  assert.equal(g.currentPlayer().id, 0);
  g.applyMove(0, 0);
  assert.equal(g.currentPlayer().id, 1);
  g.applyMove(4, 4);
  assert.equal(g.currentPlayer().id, 2);
});

test('wiping one player does not end a team match while their partner holds', () => {
  const g = new GameEngine({ rows: 5, cols: 5, players: players(4, true) });
  g.applyMove(0, 0); // P1 team 0
  g.applyMove(0, 1); // P2 team 1
  g.applyMove(4, 4); // P3 team 0
  g.applyMove(4, 0); // P4 team 1  (its own corner, well away)
  const res = g.applyMove(0, 0); // P1 pops the corner, taking P2's only cell

  assert.equal(g.players[1].isAlive, false, 'P2 is wiped');
  assert.equal(res.gameOver, false, 'but team 1 still has P4');
  assert.equal(g.winningTeam, null);
});

test('taking a teammate cell is not counted as a capture', () => {
  const g = new GameEngine({ rows: 5, cols: 5, players: players(4, true) });
  g.applyMove(0, 0); // P1 team 0
  g.applyMove(2, 2); // P2 team 1
  g.applyMove(0, 1); // P3 team 0 — next to P1's corner
  g.applyMove(4, 4); // P4 team 1
  const res = g.applyMove(0, 0); // P1 pops into its teammate's cell

  assert.equal(g.getCell(0, 1).owner, 0, 'the cell did change hands');
  assert.equal(res.captured, 0, 'but not off an opponent');
});

// ---------- Survival AI ----------

test('the AI takes a winning move when one is available', () => {
  const g = newGame(2, 2);
  g.applyMove(0, 0); // P1
  g.applyMove(1, 1); // P2
  g.applyMove(0, 1); // P1
  g.applyMove(1, 0); // P2
  // P1 to move, and (0,0) wipes the board. A full-skill AI must find it.
  const move = chooseMove(g, 0, 1);
  assert.ok(move, 'returned a move');
  const check = newGame(2, 2);
  check.loadSnapshot(g.getSnapshot());
  const res = check.applyMove(move!.row, move!.col);
  assert.equal(res.winner, 0, 'the chosen move wins');
});

test('the AI only ever returns a legal move, at any skill', () => {
  const rng = makeRng(99);
  const g = newGame(5, 5, 2, layoutForMode('survival', 5, 5, 3, 4));
  for (let i = 0; i < 12 && !g.gameOver; i++) {
    const move = chooseMove(g, g.currentPlayer().id, i / 12, rng);
    assert.ok(move, 'found a move');
    assert.equal(g.canPlay(move!.row, move!.col), true, `move ${i} is legal`);
    g.applyMove(move!.row, move!.col);
  }
});

// ---------- Bot roster ----------

test('every bot has a rating consistent with its skill', () => {
  const sorted = [...BOTS].sort((a, b) => a.skill - b.skill);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(
      sorted[i].rating >= sorted[i - 1].rating,
      `${sorted[i].name} is more skilled than ${sorted[i - 1].name} but rated lower`
    );
  }
  assert.ok(BOTS.every((b) => b.skill >= 0 && b.skill <= 1));
  assert.ok(new Set(BOTS.map((b) => b.id)).size === BOTS.length, 'ids are unique');
  assert.ok(new Set(BOTS.map((b) => b.name)).size === BOTS.length, 'names are unique');
});

test('bot matchmaking picks opponents near the player', () => {
  const rng = makeRng(11);
  for (const rating of [820, 1000, 1400]) {
    // Sampled, because the pick is from the closest few rather than the single
    // closest — one draw says nothing about the distribution.
    const picks = Array.from({ length: 30 }, () => pickBot(rating, rng));
    for (const p of picks) {
      assert.ok(
        Math.abs(p.rating - rating) < 400,
        `picked ${p.name} (${p.rating}) for a ${rating} player`
      );
    }
    assert.ok(new Set(picks.map((p) => p.id)).size > 1, 'does not always pick the same bot');
  }
});

test('an unrated player still gets a sensible opponent', () => {
  const rng = makeRng(3);
  const picks = Array.from({ length: 20 }, () => pickBot(null, rng));
  assert.ok(picks.every((p) => Math.abs(p.rating - 1000) < 400));
});

test('the AI returns null when the board offers nothing', () => {
  const g = newGame(2, 2);
  g.gameOver = true;
  assert.equal(chooseMove(g, 0, 1), null);
});
