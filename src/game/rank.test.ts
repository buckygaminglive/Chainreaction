import test from 'node:test';
import assert from 'node:assert/strict';
import { RANKS, rankFor, rankProgress, nextRankAt } from './rank.ts';

test('a new account starts inside a tier, not on its boundary', () => {
  // server/PlayerHub.ts mints accounts at 1000. Landing exactly on a floor
  // would drop a player a whole tier after a single loss.
  const rank = rankFor(1000);
  assert.equal(rank.key, 'bronze');
  assert.ok(rankProgress(1000) > 0, 'a starting account has already climbed into its tier');
  assert.ok(rankProgress(1000) < 1, 'and has somewhere left to go inside it');
});

test('every tier is reachable on the rating scale the bots span', () => {
  // game/bots.ts spans 780–1500; a tier no opponent can put you in is a tier
  // that never appears.
  for (const rank of RANKS) {
    assert.equal(rankFor(Math.max(rank.min, 780)).key, rank.key === 'bronze' ? 'bronze' : rank.key);
  }
  assert.equal(rankFor(780).key, 'bronze');
  assert.equal(rankFor(1500).key, 'master');
});

test('tiers are ordered and contiguous', () => {
  for (let i = 1; i < RANKS.length; i++) {
    assert.ok(RANKS[i].min > RANKS[i - 1].min, `${RANKS[i].key} sits above ${RANKS[i - 1].key}`);
    assert.equal(rankFor(RANKS[i].min).key, RANKS[i].key, 'a floor belongs to its own tier');
    assert.equal(rankFor(RANKS[i].min - 1).key, RANKS[i - 1].key, 'and one below it to the tier under');
  }
});

test('progress runs 0 to 1 inside a tier and tops out at Master', () => {
  assert.equal(rankProgress(1050), 0, 'at the floor of Silver');
  assert.equal(rankProgress(1100), 0.5, 'halfway through Silver');
  assert.equal(rankProgress(9999), 1, 'Master has no ceiling to be partway up');
  assert.equal(nextRankAt(9999), null);
  assert.equal(nextRankAt(1000), 1050);
});

test('a rating below the bottom of the scale still has a tier', () => {
  assert.equal(rankFor(0).key, 'bronze');
  assert.equal(rankFor(-50).key, 'bronze');
});
