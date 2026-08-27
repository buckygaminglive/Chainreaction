import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameWatcher, QUALITY, nextTierDown } from './quality.ts';

/**
 * A monotonic clock the watcher is fed from.
 *
 * Time has to carry across calls: restarting it would hand the watcher a
 * negative frame delta, which is not something a real animation loop can ever
 * produce and which quietly skews the window it lands in.
 */
interface Clock {
  t: number;
}

const newClock = (): Clock => ({ t: 1000 });

/** Feeds `count` frames each `ms` apart, returning how many step-downs fired. */
function run(watcher: FrameWatcher, clock: Clock, count: number, ms: number): number {
  let downs = 0;
  for (let i = 0; i < count; i++) {
    clock.t += ms;
    if (watcher.sample(clock.t)) downs++;
  }
  return downs;
}

test('tiers get cheaper all the way down', () => {
  const order = ['high', 'medium', 'low'] as const;
  for (let i = 1; i < order.length; i++) {
    const prev = QUALITY[order[i - 1]];
    const cur = QUALITY[order[i]];
    assert.ok(cur.maxPixelRatio <= prev.maxPixelRatio, `${order[i]} pixel ratio not lower`);
    assert.ok(cur.shadowMapSize <= prev.shadowMapSize, `${order[i]} shadow map not smaller`);
    assert.ok(Number(cur.antialias) <= Number(prev.antialias), `${order[i]} gained antialias`);
  }
});

test('the cheapest tier turns shadows off', () => {
  // A shadow pass is a second render of the whole scene. Shrinking the map
  // does not change that, so the bottom tier has to drop it entirely.
  assert.equal(QUALITY.low.shadows, false);
});

test('stepping stops at the bottom', () => {
  assert.equal(nextTierDown('high'), 'medium');
  assert.equal(nextTierDown('medium'), 'low');
  assert.equal(nextTierDown('low'), null);
});

test('a healthy 60fps device is never demoted', () => {
  const w = new FrameWatcher();
  assert.equal(run(w, newClock(), 600, 16.7), 0);
});

test('sustained slow frames demote, but never during startup', () => {
  const w = new FrameWatcher();
  const c = newClock();
  // 40ms ≈ 25fps. The first window is startup — shader compilation and texture
  // uploads — and is deliberately ignored, so no verdict can come from it.
  assert.equal(run(w, c, 90, 40), 0, 'demoted during the startup window');
  // Then it must actually fire. The exact frame it lands on is a detail of the
  // window size; that it happens promptly is the contract.
  assert.ok(run(w, c, 200, 40) > 0, 'never demoted despite sustained slow frames');
});

test('one slow frame among good ones is not a verdict', () => {
  const w = new FrameWatcher();
  const c = newClock();
  run(w, c, 90, 16.7); // burn the startup window
  let downs = 0;
  let t = c.t;
  for (let i = 0; i < 90; i++) {
    // A single 120ms hitch — a garbage collection, not a slow device.
    t += i === 45 ? 120 : 16.7;
    if (w.sample(t)) downs++;
  }
  assert.equal(downs, 0);
});

test('a backgrounded tab does not poison the window', () => {
  const w = new FrameWatcher();
  const c = newClock();
  run(w, c, 90, 16.7);
  let t = c.t;
  let downs = 0;
  for (let i = 0; i < 90; i++) {
    // A multi-second gap is the tab being hidden, not a rendering problem.
    t += i === 10 ? 30_000 : 16.7;
    if (w.sample(t)) downs++;
  }
  assert.equal(downs, 0);
});

test('reset makes the next verdict independent of the old settings', () => {
  const w = new FrameWatcher();
  const c = newClock();
  run(w, c, 90, 40); // startup window
  assert.ok(run(w, c, 200, 40) > 0);
  w.reset();
  // After a step-down the device is fast again; it must not be demoted on
  // frames drawn under the settings it has just left behind.
  assert.equal(run(w, c, 300, 16.7), 0);
});
