import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AVATAR_KEYS,
  CREW_KEYS,
  LEGACY_KEYS,
  PICKER_KEYS,
  DEFAULT_AVATAR,
  isAvatarKey,
  defaultAvatarFor,
  crewFor,
  avatarSvg,
  avatarName,
} from './avatar.ts';

test('keys are unique, and the picker offers only the crew', () => {
  assert.equal(new Set(AVATAR_KEYS).size, AVATAR_KEYS.length);
  assert.equal(LEGACY_KEYS.length, 24);
  assert.deepEqual(PICKER_KEYS, CREW_KEYS);
  assert.equal(CREW_KEYS.length, 12);
});

test('the default is drawable', () => {
  assert.ok(isAvatarKey(DEFAULT_AVATAR));
});

test('isAvatarKey rejects anything not in the set', () => {
  // The relay trusts this to decide what it will store, so the negative cases
  // matter more than the positive one.
  for (const bad of ['', 'zz', 'c9', '1c', 'c1 ', 'nova', 'p01', null, undefined, 7, {}, ['c1']]) {
    assert.equal(isAvatarKey(bad), false, `${JSON.stringify(bad)} should be rejected`);
  }
  for (const key of AVATAR_KEYS) assert.ok(isAvatarKey(key));
});

test('legacy keys keep their original order, so relay defaults do not change', () => {
  assert.deepEqual(LEGACY_KEYS.slice(0, 5), ['c1', 'c2', 'c3', 'c4', 'r1']);
  assert.equal(LEGACY_KEYS[23], 'm4');
});

test('defaultAvatarFor is stable and always a key older apps can draw', () => {
  const ids = ['abc', 'player-1', '', 'ZZZZZZ', 'a'.repeat(64)];
  for (const id of ids) {
    const key = defaultAvatarFor(id);
    assert.ok(LEGACY_KEYS.includes(key), `${id} produced ${key}`);
    assert.equal(defaultAvatarFor(id), key, 'must not change between calls');
  }
});

test('defaultAvatarFor spreads ids across the set, and the crew drawing does too', () => {
  const keys = new Set<string>();
  const faces = new Set<string>();
  for (let i = 0; i < 200; i++) {
    keys.add(defaultAvatarFor(`player-${i}`));
    faces.add(crewFor(defaultAvatarFor(`player-${i}`)));
  }
  assert.ok(keys.size > 12, `only ${keys.size} distinct keys in 200 ids`);
  assert.equal(faces.size, 12, 'every crew member should turn up');
});

test('every key draws as a crew member', () => {
  for (const key of AVATAR_KEYS) {
    assert.ok(CREW_KEYS.includes(crewFor(key)));
    const svg = avatarSvg(key, 40);
    assert.match(svg, /^<svg /);
    assert.match(svg, /<\/svg>$/);
    assert.match(svg, /width="40" height="40"/);
    assert.ok(avatarName(key).length > 0);
  }
});

test('an unknown key still draws something', () => {
  assert.equal(crewFor('nonsense'), DEFAULT_AVATAR);
  assert.match(avatarSvg('nonsense', 24), /^<svg /);
});
