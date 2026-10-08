import test from 'node:test';
import assert from 'node:assert/strict';
import { compassReading, compassLabel } from '../client/sources.js';
test('compass requires north-referenced sensor data rather than relative yaw', () => {
  assert.equal(compassReading({ alpha: 90, beta: 0, gamma: 0, absolute: false }), null);
  assert.equal(compassReading({ alpha: null, beta: 0, gamma: 0, absolute: true }), null);
  assert.equal(compassReading({ webkitCompassHeading: 0 }).heading, 0);
  assert.equal(compassReading({ webkitCompassHeading: 45, webkitCompassAccuracy: -1 }), null);
  assert.equal(compassReading({ alpha: 90, beta: 0, gamma: 0, absolute: true }).heading, 270);
  assert.equal(compassReading({ alpha: 270, beta: 90, gamma: 0, absolute: true }).heading, 90);
  assert.equal(compassLabel(45), '45° NE');
  assert.equal(compassLabel(360), '0° N');
});
