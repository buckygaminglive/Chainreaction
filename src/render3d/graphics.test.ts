import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GRAPHICS, resolveDetail, sanitizeGraphics } from './graphics.ts';
import { PRESETS } from './quality.ts';

test('a missing or broken record falls back to Auto at 60fps', () => {
  for (const raw of [null, undefined, 'junk', 42, []]) {
    const s = sanitizeGraphics(raw);
    assert.equal(s.preset, 'auto');
    assert.equal(s.fps, 60);
    assert.equal(s.showFps, false);
    assert.equal(s.autoTier, null);
    assert.deepEqual(s.custom, DEFAULT_GRAPHICS.custom);
  }
});

test('unknown values are replaced one field at a time, valid ones kept', () => {
  const s = sanitizeGraphics({
    preset: 'cinematic',
    fps: 144,
    showFps: true,
    autoTier: 'medium',
    custom: { resolution: 0.75, antialias: 'yes', shadows: 'raytraced', glow: false, particles: 'low', orbDetail: 'ultra' },
  });
  assert.equal(s.preset, 'auto');
  assert.equal(s.fps, 60);
  assert.equal(s.showFps, true);
  assert.equal(s.autoTier, 'medium');
  assert.equal(s.custom.resolution, 0.75);
  assert.equal(s.custom.antialias, DEFAULT_GRAPHICS.custom.antialias);
  assert.equal(s.custom.shadows, DEFAULT_GRAPHICS.custom.shadows);
  assert.equal(s.custom.glow, false);
  assert.equal(s.custom.particles, 'low');
  assert.equal(s.custom.orbDetail, 'ultra');
});

test('an uncapped frame rate survives a round trip', () => {
  assert.equal(sanitizeGraphics({ fps: 0 }).fps, 0);
  assert.equal(sanitizeGraphics({ fps: 30 }).fps, 30);
});

test('presets resolve to their table, custom to its own controls', () => {
  const base = sanitizeGraphics(null);
  assert.deepEqual(resolveDetail({ ...base, preset: 'ultra' }), PRESETS.ultra);
  assert.deepEqual(resolveDetail({ ...base, preset: 'low' }), PRESETS.low);
  const custom = { ...PRESETS.low, glow: true };
  assert.deepEqual(resolveDetail({ ...base, preset: 'custom', custom }), custom);
});

test('Auto uses the measured tier once there is one, the guess before that', () => {
  const base = sanitizeGraphics(null);
  assert.deepEqual(resolveDetail({ ...base, preset: 'auto', autoTier: null }, 'high'), PRESETS.high);
  assert.deepEqual(resolveDetail({ ...base, preset: 'auto', autoTier: 'medium' }, 'high'), PRESETS.medium);
});

test('resolved detail is a copy, never the shared preset object', () => {
  const d = resolveDetail({ ...sanitizeGraphics(null), preset: 'high' });
  d.glow = false;
  assert.equal(PRESETS.high.glow, true);
});
