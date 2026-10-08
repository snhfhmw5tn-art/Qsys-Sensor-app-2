import test from 'node:test';
import assert from 'node:assert/strict';
import { WalkingTracker } from '../client/walking.js';
import { demoSamples } from '../client/sources.js';
test('walking-only route counts steps locally and follows a turn', () => {
  const tracker = new WalkingTracker();
  for (const s of demoSamples()) tracker.process(s);
  assert.ok(tracker.state.steps > 30);
  assert.equal(tracker.raw.length, 2200);
  assert.ok(Math.abs(tracker.state.x) > 5);
  assert.ok(tracker.state.y > 5);
  assert.ok(Math.abs(tracker.state.distance - tracker.state.steps * 0.7) < 1e-9);
});
test('rotating at rest changes phone heading without translating', () => {
  const tracker = new WalkingTracker();
  for (let i = 0; i < 200; i++)
    tracker.process({
      t: i * 0.02,
      gravityAcceleration: [0, 0, 9.80665],
      linearAcceleration: [0, 0, 0],
      gyro: [0, 0, 45],
      orientation: { alpha: i * 0.9, beta: 0, gamma: 0 },
    });
  assert.equal(tracker.state.steps, 0);
  assert.equal(tracker.state.distance, 0);
  assert.ok(Math.abs(tracker.state.deviceHeading) > 90);
});
test('live source never requests geolocation', async () => {
  const { readFile } = await import('node:fs/promises');
  const code = await readFile(new URL('../client/sources.js', import.meta.url), 'utf8');
  assert.ok(!code.includes('navigator.geolocation'));
});
test('orientation rotates indicator immediately without waiting for motion or steps', () => {
  const tracker = new WalkingTracker();
  tracker.orient({ alpha: 0, beta: 90, gamma: 0 }, 0);
  tracker.orient({ alpha: 90, beta: 90, gamma: 0 }, 0.1);
  assert.ok(Math.abs(tracker.state.deviceHeading + 90) < 1e-8);
  assert.equal(tracker.state.distance, 0);
});
test('attitude corrects small gyro error immediately but rejects compass jumps', () => {
  const tracker = new WalkingTracker();
  tracker.orient({ alpha: 0, beta: 90, gamma: 0 }, 0);
  tracker.hasGyro = true;
  tracker.heading.deviceYaw = -10;
  tracker.orient({ alpha: 20, beta: 90, gamma: 0 }, 0.1);
  assert.ok(Math.abs(tracker.state.deviceHeading + 20) < 1e-8);
  tracker.orient({ alpha: 130, beta: 90, gamma: 0 }, 0.2);
  assert.ok(Math.abs(tracker.state.deviceHeading + 20) < 1e-8);
});
