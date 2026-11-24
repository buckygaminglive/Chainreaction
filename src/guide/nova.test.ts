import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawFromBag } from './nova.ts';
import { LINES, displayText, audioPath } from './lines.ts';
import { expressionFor } from './novaFace.ts';
import { isRisky, readBoard } from './commentator.ts';
import { GameEngine } from '../game/GameEngine.ts';

test('a shuffle bag plays every line once before any repeats', () => {
  const size = 9;
  let bag: number[] | undefined;
  let last: number | undefined;
  for (let round = 0; round < 5; round++) {
    const seen = new Set<number>();
    for (let i = 0; i < size; i++) {
      const drawn = drawFromBag(bag, size, last);
      if (i === 0 && round > 0) assert.notEqual(drawn.index, last, 'a refill must not open with the last line');
      bag = drawn.bag;
      last = drawn.index;
      seen.add(drawn.index);
    }
    assert.equal(seen.size, size);
  }
});

test('a stale bag from an older, longer list is cleaned up', () => {
  const { index, bag } = drawFromBag([0, 40, 2], 3, undefined);
  assert.ok(index < 3);
  assert.ok(bag.every((i) => i < 3));
});

test('every line opens with a direction tag and reads cleanly without it', () => {
  for (const [cat, lines] of Object.entries(LINES)) {
    assert.ok(lines.length > 0, cat);
    for (const line of lines) {
      assert.match(line, /^\[[a-z ]+\] /, `${cat}: ${line}`);
      const text = displayText(line);
      assert.ok(text.length > 0 && !text.includes('['), `${cat}: ${text}`);
      assert.ok(text.length <= 120, `${cat} line too long for the bubble: ${text}`);
    }
  }
});

test('there is real variety where it matters', () => {
  for (const cat of ['player_chain', 'cpu_chain', 'player_win', 'cpu_win', 'ambient', 'player_leading', 'cpu_leading'] as const) {
    assert.ok(LINES[cat].length >= 20, `${cat} has only ${LINES[cat].length} lines`);
    assert.equal(new Set(LINES[cat]).size, LINES[cat].length, `${cat} has duplicates`);
  }
});

test('audio paths are numbered from 01', () => {
  assert.equal(audioPath('greet', 0), '/audio/nova/greet-01.mp3');
  assert.equal(audioPath('player_win', 25), '/audio/nova/player_win-26.mp3');
});

test('expressions follow the opening tag', () => {
  assert.equal(expressionFor('[laughs] ha'), 'laugh');
  assert.equal(expressionFor('[gasps] no'), 'surprised');
  assert.equal(expressionFor('[mischievously] heh'), 'smug');
  assert.equal(expressionFor('[nervous] oh'), 'nervous');
  assert.equal(expressionFor('[warmly] hi'), 'happy');
  assert.equal(expressionFor('no tag'), 'happy');
});

function engine(): GameEngine {
  return new GameEngine({
    rows: 4,
    cols: 4,
    players: [
      { id: 0, name: 'You', color: 0, colorLight: 0, isAlive: true },
      { id: 1, name: 'Nova', color: 0, colorLight: 0, isAlive: true },
    ],
  });
}

test('readBoard counts orbs and cells per side', () => {
  const e = engine();
  e.grid[0][0] = { row: 0, col: 0, owner: 0, orbs: 1 };
  e.grid[1][1] = { row: 1, col: 1, owner: 1, orbs: 3 };
  const b = readBoard(e, 0, 1);
  assert.deepEqual({ ...b, share: Math.round(b.share * 100) }, { humanOrbs: 1, aiOrbs: 3, humanCells: 1, aiCells: 1, share: 25 });
});

test('a placement beside a loaded opposing cell is risky', () => {
  const e = engine();
  // (0,1) is an edge: critical mass 3, so 2 orbs is one from bursting.
  e.grid[0][1] = { row: 0, col: 1, owner: 1, orbs: 2 };
  assert.equal(isRisky(e, 0, 0, 1), true);
  assert.equal(isRisky(e, 2, 2, 1), false);
  e.grid[0][1].orbs = 1;
  assert.equal(isRisky(e, 0, 0, 1), false);
});
