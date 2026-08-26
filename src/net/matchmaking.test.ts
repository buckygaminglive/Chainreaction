import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ratingBand, BASE_BAND, DEFAULT_RATING } from './matchmaking.ts';

test('the band starts tight', () => {
  // Someone who just pressed the button should be offered a close opponent if
  // one exists, not simply the first body in the queue.
  assert.equal(ratingBand(0), BASE_BAND);
});

test('the band widens the longer someone waits', () => {
  assert.ok(ratingBand(10_000) > ratingBand(0));
  assert.ok(ratingBand(30_000) > ratingBand(10_000));
});

test('the band is already generous before the bot fallback fires', () => {
  // The client offers a practice bot after 12s. If the band were still narrow
  // by then, the queue would hand out bots while real opponents sat a few
  // hundred points away — the worst of both.
  assert.ok(
    ratingBand(12_000) >= 400,
    `band at 12s is only ${ratingBand(12_000)}`
  );
});

test('the band covers the whole ladder within a minute', () => {
  // Bronze floor to Master is well under 1500 points on this scale, so by 60s
  // nobody should still be excluded on rating alone.
  assert.ok(ratingBand(60_000) >= 1500, `band at 60s is only ${ratingBand(60_000)}`);
});

test('the band never shrinks or goes negative', () => {
  let previous = -1;
  for (let ms = 0; ms <= 120_000; ms += 1_000) {
    const band = ratingBand(ms);
    assert.ok(band > 0, `band at ${ms}ms was ${band}`);
    assert.ok(band >= previous, `band shrank approaching ${ms}ms`);
    previous = band;
  }
});

test('a wait stamped in the future is treated as no wait', () => {
  // Clocks move. An entry timestamped slightly ahead must not produce a band
  // narrower than the base, which would exclude everybody.
  assert.equal(ratingBand(-5_000), ratingBand(0));
});

test('the default rating is the start of the ladder', () => {
  // An unranked player has to be matched as something, and matching them as a
  // beginner would feed real beginners to unranked smurfs.
  assert.equal(DEFAULT_RATING, 1000);
});
