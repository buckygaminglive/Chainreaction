import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEAVE_PENALTY, PLACE_POINTS, applyPoints, pointsFor } from './rankPoints.ts';

test('points by place, leavers lose the most, totals never go negative', () => {
  assert.equal(pointsFor(2, 1, false), 25);
  assert.equal(pointsFor(2, 2, false), -15);
  assert.equal(pointsFor(4, 1, false), 35);
  assert.equal(pointsFor(4, 4, false), -20);
  assert.equal(pointsFor(3, 1, true), LEAVE_PENALTY);
  for (const table of Object.values(PLACE_POINTS)) {
    assert.ok(Math.min(...table) > LEAVE_PENALTY, 'quitting must never beat finishing last');
    for (let i = 1; i < table.length; i++) assert.ok(table[i] < table[i - 1], 'higher places pay more');
  }
  assert.equal(applyPoints(10, -30), 0);
  assert.equal(applyPoints(0, 25), 25);
});
