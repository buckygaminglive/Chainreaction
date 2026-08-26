import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TAUNTS,
  isValidTaunt,
  CHAT_GROUPS,
  CHAT_PHRASES,
  CHAT_COOLDOWN_MS,
  TAUNT_COOLDOWN_MS,
  isValidChat,
} from './taunts.ts';

test('the flattened phrase list is exactly the groups, in order', () => {
  // The wire format is an index into CHAT_PHRASES while the UI is built from
  // CHAT_GROUPS. If those two ever disagree, players send one sentence and
  // their opponent reads another.
  assert.deepEqual(CHAT_PHRASES, CHAT_GROUPS.flatMap((g) => g.phrases));
});

test('isValidChat accepts every index and rejects everything else', () => {
  // The relay trusts this to decide what it will put on another player's
  // screen, so the negative cases are the ones that matter.
  CHAT_PHRASES.forEach((_, i) => assert.ok(isValidChat(i), `index ${i} should be valid`));
  for (const bad of [
    -1,
    CHAT_PHRASES.length,
    1.5,
    NaN,
    Infinity,
    '0',
    null,
    undefined,
    {},
    [0],
    'Good game!',
  ]) {
    assert.equal(isValidChat(bad), false, `${JSON.stringify(bad)} should be rejected`);
  }
});

test('a phrase index can never carry arbitrary text', () => {
  // The point of the index format: there is no input that makes the relay
  // broadcast a string the client chose.
  assert.equal(isValidChat('anything at all'), false);
  assert.equal(isValidChat('<script>alert(1)</script>'), false);
});

test('phrases are short enough for a bubble', () => {
  for (const phrase of CHAT_PHRASES) {
    assert.ok(phrase.length > 0, 'no empty phrases');
    assert.ok(phrase.length <= 24, `"${phrase}" is ${phrase.length} chars — too long for a bubble`);
  }
});

test('phrases are unique', () => {
  assert.equal(new Set(CHAT_PHRASES).size, CHAT_PHRASES.length);
});

test('chat is rate-limited more strictly than emoji', () => {
  // A sentence repeated at you lands harder than an emoji, so the two carry
  // different cooldowns on purpose.
  assert.ok(CHAT_COOLDOWN_MS > TAUNT_COOLDOWN_MS);
});

test('the emoji palette still validates its own bounds', () => {
  TAUNTS.forEach((_, i) => assert.ok(isValidTaunt(i)));
  assert.equal(isValidTaunt(TAUNTS.length), false);
  assert.equal(isValidTaunt(-1), false);
});
