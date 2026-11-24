import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NAME_MAX, randomPlayerName } from './names.ts';

test('random names fit the callsign limit and are not "PlayerNNN"', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const n = randomPlayerName();
    assert.ok(n.length >= 4 && n.length <= NAME_MAX, n);
    assert.match(n, /^[A-Za-z]+\d*$/);
    assert.ok(!/^Player\d/.test(n), n);
    seen.add(n);
  }
  // Plenty of variety: two thousand draws should rarely collide.
  assert.ok(seen.size > 1500, String(seen.size));
});
