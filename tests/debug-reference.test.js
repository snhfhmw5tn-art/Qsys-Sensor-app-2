import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveReference, HeadingEstimator } from '../client/pipeline.js';
test('reference integrates acceleration and coasts without stop filter', () => {
  const r = new LiveReference();
  for (let i = 0; i <= 100; i++)
    r.update({ t: i / 100, nav: [0, 1, 0], orientation: { alpha: 0, beta: 0, gamma: 0 } }, 0);
  assert.ok(Math.abs(r.y - 0.5) < 1e-9);
  r.update({ t: 1.1, nav: [0, 0, 0], orientation: { alpha: 0, beta: 0, gamma: 0 } }, 0);
  assert.ok(Math.abs(r.y - 0.6) < 1e-9);
  r.update({ t: 10, nav: [0, 10, 0], orientation: { alpha: 0, beta: 0, gamma: 0 } }, 0);
  assert.ok(Math.abs(r.y - 0.6) < 1e-9);
});
test('missing gyro uses relative upright orientation', () => {
  const h = new HeadingEstimator();
  for (let i = 0; i <= 90; i++)
    h.update(
      { orientation: { alpha: i, beta: 90, gamma: 0 }, gyro: null, yawRate: 0, dt: 0.02 },
      null,
      'Standing',
    );
  assert.ok(Math.abs(h.deviceYaw + 90) < 1e-8);
});
