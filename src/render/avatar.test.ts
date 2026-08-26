import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AVATAR_KEYS,
  AVATAR_HUES,
  AVATAR_FORMS,
  DEFAULT_AVATAR,
  isAvatarKey,
  defaultAvatarFor,
  avatarSvg,
  avatarName,
} from './avatar.ts';

test('every hue × form combination is a key, and they are unique', () => {
  assert.equal(AVATAR_KEYS.length, AVATAR_HUES.length * AVATAR_FORMS.length);
  assert.equal(new Set(AVATAR_KEYS).size, AVATAR_KEYS.length);
});

test('the default is drawable', () => {
  assert.ok(isAvatarKey(DEFAULT_AVATAR));
});

test('isAvatarKey rejects anything not in the set', () => {
  // The relay trusts this to decide what it will store, so the negative cases
  // matter more than the positive one.
  for (const bad of ['', 'zz', 'c9', '1c', 'c1 ', null, undefined, 7, {}, ['c1']]) {
    assert.equal(isAvatarKey(bad), false, `${JSON.stringify(bad)} should be rejected`);
  }
  for (const key of AVATAR_KEYS) assert.ok(isAvatarKey(key));
});

test('defaultAvatarFor is stable and always drawable', () => {
  const ids = ['abc', 'player-1', '', 'ZZZZZZ', 'a'.repeat(64)];
  for (const id of ids) {
    const key = defaultAvatarFor(id);
    assert.ok(isAvatarKey(key), `${id} produced ${key}`);
    assert.equal(defaultAvatarFor(id), key, 'must not change between calls');
  }
});

test('defaultAvatarFor spreads ids across the set', () => {
  // A hash that collapsed to one bucket would make every lobby look like one
  // person repeated, which is the whole reason this is derived rather than
  // fixed.
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) seen.add(defaultAvatarFor(`player-${i}`));
  assert.ok(seen.size > AVATAR_KEYS.length / 2, `only ${seen.size} distinct avatars in 200 ids`);
});

test('avatarSvg renders every key with the right node count', () => {
  for (const key of AVATAR_KEYS) {
    const svg = avatarSvg(key, 40);
    assert.match(svg, /^<svg /);
    assert.match(svg, /<\/svg>$/);
    assert.match(svg, /width="40" height="40"/);

    const form = AVATAR_FORMS.find((f) => f.key === key[1])!;
    // One neighbour circle per node, plus the core and the highlight ellipse.
    const circles = svg.match(/<circle/g)?.length ?? 0;
    const expected = form.nodes + 1 + (form.ring ? 1 : 0);
    assert.equal(circles, expected, `${key} drew ${circles} circles, expected ${expected}`);
  }
});

test('an unknown key falls back to the default rather than drawing nothing', () => {
  const fallback = avatarSvg('nope', 32);
  assert.equal(fallback.replace(/av\d+/g, 'x'), avatarSvg(DEFAULT_AVATAR, 32).replace(/av\d+/g, 'x'));
});

test('gradient ids are unique per render', () => {
  // Two avatars in one document sharing a gradient id would make the second
  // take the first's colours.
  const a = avatarSvg('c1', 32).match(/id="(av\d+)-core"/)?.[1];
  const b = avatarSvg('r2', 32).match(/id="(av\d+)-core"/)?.[1];
  assert.ok(a && b && a !== b);
});

test('names are human-readable', () => {
  assert.equal(avatarName('c1'), 'Cyan Cross');
  assert.equal(avatarName('m4'), 'Magenta Star');
});
