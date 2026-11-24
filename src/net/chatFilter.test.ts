import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TYPED_MAX, cleanTyped } from './chatFilter.ts';

test('ordinary messages pass through unchanged', () => {
  for (const m of ['gg!', 'Nice chain 🔥', 'that was close', 'Dickens is my fav author', 'abc', 'one more game?', 'kya baat hai']) {
    assert.equal(cleanTyped(m), m);
  }
});

test('profanity is masked, including common evasions', () => {
  for (const m of ['fuck', 'FUUUCK', 'sh1t', 'b!tch', 'madarchod', 'bc', 'f u c k']) {
    const out = cleanTyped(`you ${m} lol`);
    assert.ok(out && !out.toLowerCase().includes(m.toLowerCase().replace(/ /g, '')), `${m} → ${out}`);
    assert.match(out!, /\*\*/);
  }
});

test('links, emails, phone numbers and handles are removed', () => {
  for (const m of ['add me www.site.com', 'mail a@b.co', 'call 98765 43210', 'my insta is x', 'go to evil.gg/x', 'https://x.y']) {
    const out = cleanTyped(m) ?? '';
    assert.ok(!/www|@b|98765|insta|evil\.gg|https/i.test(out), `${m} → ${out}`);
  }
});

test('length, whitespace, control characters', () => {
  assert.equal(cleanTyped('a'.repeat(200))!.length, TYPED_MAX);
  assert.equal(cleanTyped('  hi \n\n there  '), 'hi there');
  assert.equal(cleanTyped('hi‮evil'), 'hievil');
  assert.equal(cleanTyped(''), null);
  assert.equal(cleanTyped('   '), null);
  assert.equal(cleanTyped(42), null);
  assert.equal(cleanTyped('fuck'), null);
});

test('cleaning is idempotent', () => {
  for (const m of ['you sh1t www.x.com', 'gg wp', 'f u c k off', 'ok 🔥']) {
    const once = cleanTyped(m);
    assert.equal(once === null ? null : cleanTyped(once), once);
  }
});

test('no false positives on everyday words', () => {
  for (const m of ['Gandhi', 'grandiose', 'swanky', 'cucumber', 'scrabble', 'assess', 'classic', 'mechanical']) {
    assert.equal(cleanTyped(m), m);
  }
  assert.match(cleanTyped('tu gaand hai')!, /g\*+/);
});

test('removing a number keeps the spacing around it', () => {
  assert.equal(cleanTyped('call 9876543210 gg'), 'call ••• gg');
  assert.equal(cleanTyped('score 120 to 45'), 'score 120 to 45');
});
