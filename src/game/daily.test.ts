import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from './GameEngine.ts';
import {
  DAILY_TRIES,
  buildDailyPuzzle,
  dayNumber,
  moveOutcome,
  msUntilNextDay,
  rankMoves,
  shareText,
  trySquare,
} from './daily.ts';
import type { PlayerConfig } from './types.ts';

const PLAYERS: PlayerConfig[] = [
  { id: 0, name: 'You', color: 0x3ad9ff, colorLight: 0xc2f2ff, isAlive: true },
  { id: 1, name: 'Rival', color: 0xff3355, colorLight: 0xffb3c0, isAlive: true },
];

function restore(p: ReturnType<typeof buildDailyPuzzle>) {
  const e = new GameEngine({ rows: p.rows, cols: p.cols, players: p.players });
  e.loadSnapshot(structuredClone(p.snapshot));
  return e;
}

test('day numbers follow the local calendar and start at 1', () => {
  assert.equal(dayNumber(new Date(2026, 0, 1, 0, 1)), 1);
  assert.equal(dayNumber(new Date(2026, 0, 1, 23, 59)), 1);
  assert.equal(dayNumber(new Date(2026, 0, 2, 0, 0)), 2);
  assert.equal(dayNumber(new Date(2026, 10, 21, 12)), 325);
});

test('the countdown reaches the next local midnight', () => {
  const now = new Date(2026, 4, 10, 23, 0, 0);
  assert.equal(msUntilNextDay(now), 60 * 60 * 1000);
});

test('the same day always builds the same puzzle', () => {
  const a = buildDailyPuzzle(42, PLAYERS);
  const b = buildDailyPuzzle(42, PLAYERS);
  assert.deepEqual(a.snapshot.grid, b.snapshot.grid);
  assert.equal(a.best, b.best);
  assert.deepEqual(a.bestMoves, b.bestMoves);
});

test('different days build different boards', () => {
  const grids = new Set([1, 2, 3, 4, 5].map((d) => JSON.stringify(buildDailyPuzzle(d, PLAYERS).snapshot.grid)));
  assert.equal(grids.size, 5);
});

test('puzzles are live, the solver is to move, and the stated best is real', () => {
  for (let day = 300; day < 330; day++) {
    const p = buildDailyPuzzle(day, PLAYERS);
    const e = restore(p);
    assert.equal(e.gameOver, false, `day ${day} is already over`);
    assert.equal(e.currentPlayer().id, 0, `day ${day}: not the solver's move`);
    assert.ok(p.best >= 3, `day ${day}: best chain only ${p.best}`);
    // The claimed best moves really reach it, and nothing beats it.
    for (const m of p.bestMoves) assert.equal(moveOutcome(e, m.row, m.col).chain, p.best);
    assert.equal(rankMoves(e)[0].chain, p.best);
  }
});

test('most puzzles hit the quality bar of a ×5 chain with one or two answers', () => {
  let good = 0;
  for (let day = 1; day <= 40; day++) {
    const p = buildDailyPuzzle(day, PLAYERS);
    if (p.best >= 5 && p.bestMoves.length <= 2) good++;
  }
  assert.ok(good >= 38, `only ${good}/40 puzzles met the bar`);
});

test('building a puzzle is fast enough to do on tap', () => {
  const t0 = performance.now();
  for (let day = 500; day < 510; day++) buildDailyPuzzle(day, PLAYERS);
  const each = (performance.now() - t0) / 10;
  assert.ok(each < 250, `${each.toFixed(1)}ms per puzzle`);
});

test('result squares and share text', () => {
  assert.equal(trySquare(undefined, 7), '⬛');
  assert.equal(trySquare(7, 7), '🟩');
  assert.equal(trySquare(5, 7), '🟨');
  assert.equal(trySquare(2, 7), '🟥');
  const text = shareText(12, [5, 7], 7, 3, 'https://example.test');
  assert.match(text, /Daily Blast #12/);
  assert.match(text, /×7 \/ ×7 🏆/);
  assert.match(text, /🟨🟩⬛/);
  assert.match(text, /3-day streak/);
  assert.equal(text.split('\n').at(-1), 'https://example.test');
  assert.equal(DAILY_TRIES, 3);
});
