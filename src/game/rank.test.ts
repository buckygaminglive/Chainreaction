import test from 'node:test';
import assert from 'node:assert/strict';
import { RANKS, rankFor, rankProgress, nextRankAt } from './rank.ts';

test('a new account starts Unranked at 0 points', () => {
  assert.equal(rankFor(0).key, 'unranked');
  assert.equal(rankProgress(0), 0);
  assert.equal(nextRankAt(0), 100);
  assert.equal(rankFor(-5).key, 'unranked');
});

test('tiers are ordered and contiguous', () => {
  for (let i = 1; i < RANKS.length; i++) {
    assert.ok(RANKS[i].min > RANKS[i - 1].min, `${RANKS[i].key} sits above ${RANKS[i - 1].key}`);
    assert.equal(rankFor(RANKS[i].min).key, RANKS[i].key, 'a floor belongs to its own tier');
    assert.equal(rankFor(RANKS[i].min - 1).key, RANKS[i - 1].key, 'and one below it to the tier under');
  }
});

test('progress runs 0 to 1 inside a tier and tops out at Master', () => {
  assert.equal(rankProgress(300), 0, 'at the floor of Silver');
  assert.equal(rankProgress(450), 0.5, 'halfway through Silver');
  assert.equal(rankProgress(99999), 1, 'Master has no ceiling to be partway up');
  assert.equal(nextRankAt(99999), null);
});
