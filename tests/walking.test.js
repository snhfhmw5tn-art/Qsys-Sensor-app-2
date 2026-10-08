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
test('first acceleration pulse counts immediately without gait confirmation', () => {
  const tracker = new WalkingTracker();
  tracker.process({
    t: 0,
    gravityAcceleration: [0, 0, 9.80665],
    linearAcceleration: [0, 0, 0],
    gyro: [0, 0, 0],
    orientation: { alpha: 0, beta: 0, gamma: 0 },
  });
  tracker.process({
    t: 0.02,
    gravityAcceleration: [0, 0, 19.80665],
    linearAcceleration: [0, 0, 10],
    gyro: [0, 0, 0],
    orientation: { alpha: 0, beta: 0, gamma: 0 },
  });
  assert.equal(tracker.state.steps, 1);
  assert.equal(tracker.state.distance, 0.7);
});

test('travel-up rotation puts forward direction above and auto-fit includes rotated route', async () => {
  const { rotateToTravel, fitTrajectory } = await import('../client/maps.js');
  for (const heading of [0, 45, 90, 179, -90]) {
    const angle = (heading * Math.PI) / 180;
    const p = rotateToTravel({ x: 10 * Math.sin(angle), y: 10 * Math.cos(angle) }, heading);
    assert.ok(Math.abs(p.x) < 1e-8);
    assert.ok(Math.abs(p.y - 10) < 1e-8);
    const points = [
      { x: 0, y: 0 },
      { x: 25, y: -15 },
      { x: -12, y: 30 },
    ].map((p) => rotateToTravel(p, heading));
    const fit = fitTrajectory(points, 320, 500);
    for (const p of points) {
      assert.ok(Math.abs((p.x - fit.x) * fit.zoom) <= 112.00001);
      assert.ok(Math.abs((p.y - fit.y) * fit.zoom) <= 202.00001);
    }
  }
});
test('calibration counts steps without drawing and calibrated stride controls distance', () => {
  const calibration = new WalkingTracker({ drawing: false });
  const samples = demoSamples();
  for (const s of samples) calibration.process(s);
  assert.ok(calibration.state.steps > 0);
  assert.equal(calibration.state.distance, 0);
  assert.equal(calibration.state.trajectory.length, 1);
  const length = 10 / calibration.state.steps;
  const walking = new WalkingTracker({ stepLength: length });
  for (const s of samples) walking.process(s);
  assert.ok(Math.abs(walking.state.distance - 10) < 1e-8);
});
