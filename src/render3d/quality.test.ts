import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameWatcher, PRESETS, TIER_ORDER, SHADOW_MAP_SIZE, PARTICLE_DENSITY, ORB_SEGMENTS, nextTierDown, pixelRatioFor } from './quality.ts';

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
  for (let i = 1; i < TIER_ORDER.length; i++) {
    const prev = PRESETS[TIER_ORDER[i - 1]];
    const cur = PRESETS[TIER_ORDER[i]];
    const name = TIER_ORDER[i];
    assert.ok(cur.resolution <= prev.resolution, `${name} resolution went up`);
    assert.ok(Number(cur.antialias) <= Number(prev.antialias), `${name} gained antialias`);
    assert.ok(SHADOW_MAP_SIZE[cur.shadows] <= SHADOW_MAP_SIZE[prev.shadows], `${name} shadows got heavier`);
    assert.ok(PARTICLE_DENSITY[cur.particles] <= PARTICLE_DENSITY[prev.particles], `${name} gained particles`);
    assert.ok(ORB_SEGMENTS[cur.orbDetail][0] <= ORB_SEGMENTS[prev.orbDetail][0], `${name} orbs got denser`);
  }
});

test('crispness is the last thing given up', () => {
  // Every tier but the bottom draws at native resolution with smooth edges:
  // blur and jagged rims are the most visible losses, so they come last.
  for (const tier of ['ultra', 'high', 'medium'] as const) {
    assert.equal(PRESETS[tier].resolution, 1, `${tier} draws below native resolution`);
    assert.equal(PRESETS[tier].antialias, true, `${tier} has jagged edges`);
  }
});

test('the cheapest tier turns shadows off', () => {
  // A shadow pass is a second render of the whole scene. Shrinking the map
  // does not change that, so the bottom tier has to drop it entirely.
  assert.equal(PRESETS.low.shadows, 'off');
});

test('stepping stops at the bottom', () => {
  assert.equal(nextTierDown('ultra'), 'high');
  assert.equal(nextTierDown('high'), 'medium');
  assert.equal(nextTierDown('medium'), 'low');
  assert.equal(nextTierDown('low'), null);
});

test('full resolution means every physical pixel, up to a ceiling', () => {
  // A typical 1080p phone reports ~2.75: full resolution must draw at that,
  // not at a capped 1.5 stretched up to fit.
  assert.equal(pixelRatioFor(PRESETS.high, 2.75), 2.75);
  assert.equal(pixelRatioFor(PRESETS.high, 4), 3);
  assert.equal(pixelRatioFor(PRESETS.low, 2), 1.5);
  assert.equal(pixelRatioFor({ ...PRESETS.low, resolution: 0.5 }, 0.8), 0.5);
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
