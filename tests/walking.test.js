import test from 'node:test';
import assert from 'node:assert/strict';
import { GaitStepDetector, WalkingTracker } from '../client/walking.js';
import { demoSamples } from '../client/sources.js';
test('walking-only route counts steps locally and follows a turn', () => {
  const tracker = new WalkingTracker();
  for (const s of demoSamples()) tracker.process(s);
  assert.ok(tracker.state.steps > 30);
  assert.equal(tracker.raw.length, 2200);
  assert.ok(Math.abs(tracker.state.phoneX) > 5);
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
test('orange reference accepts large orientation changes immediately without jump compensation', () => {
  const tracker = new WalkingTracker();
  tracker.orient({ alpha: 0, beta: 90, gamma: 0 }, 0);
  tracker.hasGyro = true;
  tracker.heading.deviceYaw = -10;
  tracker.orient({ alpha: 20, beta: 90, gamma: 0 }, 0.1);
  assert.ok(Math.abs(tracker.state.deviceHeading + 20) < 1e-8);
  tracker.orient({ alpha: 130, beta: 90, gamma: 0 }, 0.2);
  assert.ok(Math.abs(tracker.state.deviceHeading + 130) < 1e-8);
});
test('single vertical pulse is insufficient walking evidence', () => {
  const tracker = new WalkingTracker();
  for (let i = 0; i < 20; i++) {
    const t = i * 0.02,
      v = 2 * Math.sin(2 * Math.PI * 1.8 * t);
    tracker.process({
      t,
      gravityAcceleration: [0, 0, 9.80665 + v],
      linearAcceleration: [0, 0, v],
      gyro: [0, 0, 0],
      orientation: { alpha: 0, beta: 0, gamma: 0 },
    });
  }
  assert.equal(tracker.state.steps, 0);
  assert.equal(tracker.state.distance, 0);
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
test('step detector rejects short spikes and threshold chatter', async () => {
  const { ImmediateStepDetector } = await import('../client/walking.js');
  for (const values of [
    [0, 0, 3, 0, 0],
    [0, 0.7, 0.6, 0.7, 0.6, 0.7, 0.6, 0],
  ]) {
    const d = new ImmediateStepDetector();
    const peaks = values.flatMap((vertical, i) => d.update({ t: i * 0.02, vertical }));
    assert.equal(peaks.length, 0);
  }
});
test('periodic vertical phone lifting does not draw walking', () => {
  const tracker = new WalkingTracker();
  for (let i = 0; i < 500; i++) {
    const t = i / 50,
      v = 2 * Math.sin(2 * Math.PI * 1.8 * t);
    tracker.process({
      t,
      gravityAcceleration: [0, 0, 9.80665 + v],
      linearAcceleration: [0, 0, v],
      gyro: [0, 0, 0],
      orientation: { alpha: 0, beta: 0, gamma: 0 },
    });
  }
  assert.equal(tracker.state.steps, 0);
  assert.equal(tracker.state.distance, 0);
});
test('first confirmed walking steps preserve original headings', () => {
  const tracker = new WalkingTracker();
  for (let i = 0; i < 100; i++) {
    const t = i / 50,
      v = 2 * Math.sin(2 * Math.PI * 1.8 * t);
    tracker.process({
      t,
      gravityAcceleration: [0.4 * Math.sin(2 * Math.PI * 1.8 * t), 0, 9.80665 + v],
      linearAcceleration: [0.4 * Math.sin(2 * Math.PI * 1.8 * t), 0, v],
      gyro: [0, 0, t < 1 ? 45 : 0],
      orientation: { alpha: Math.min(t, 1) * 45, beta: 0, gamma: 0 },
    });
  }
  assert.ok(tracker.state.steps >= 3);
  const p = tracker.state.phoneTrajectory;
  assert.ok(p[1].t < 1);
  const initial = Math.atan2(p[1].x, p[1].y);
  const last = Math.atan2(p.at(-1).x - p.at(-2).x, p.at(-1).y - p.at(-2).y);
  assert.ok(Math.abs(initial - last) > 0.2);
});

test('sensor export preserves raw samples and all orientation events including rejected turns', () => {
  const tracker = new WalkingTracker();
  tracker.orient({ alpha: 0, beta: 90, gamma: 0 }, 0);
  tracker.hasGyro = true;
  tracker.orient({ alpha: 130, beta: 90, gamma: 0 }, 0.1);
  const raw = {
    t: 0.2,
    gravityAcceleration: [0, 0, 9.80665],
    linearAcceleration: [0, 0, 0],
    gyro: [0, 0, 0],
    orientation: { alpha: 0, beta: 0, gamma: 0 },
  };
  tracker.process(raw);
  raw.gyro[0] = 999;
  const exported = JSON.parse(JSON.stringify(tracker.exportHistory()));
  assert.equal(exported.orientationEvents.length, 2);
  assert.equal(exported.samples[0].gyro[0], 0);
  assert.ok(exported.derived.some((p) => p.phoneHeading !== undefined));
  assert.equal(exported.state.phoneTrajectory.length, 1);
});

test('orange state remains phone-based without calculated route', () => {
  const tracker = new WalkingTracker();
  for (const sample of demoSamples()) tracker.process(sample);
  assert.deepEqual(tracker.state.trajectory, tracker.state.phoneTrajectory);
  assert.equal(tracker.state.x, tracker.state.phoneX);
  assert.equal(tracker.travel, undefined);
  const data = tracker.exportHistory();
  assert.equal(data.greenDirection, undefined);
  assert.equal(data.calculatedDirection, undefined);
  assert.equal(data.state.calculatedTrajectory, undefined);
  assert.ok(
    data.derived.every(
      (row) => row.travelHeading === undefined && row.directionAnalysis === undefined,
    ),
  );
});

test('stale orientation carried by motion samples cannot rewind a rapid gyro turn', () => {
  const tracker = new WalkingTracker({ stepLength: 0.76 });
  const orientation = { alpha: 0, beta: 0, gamma: 0 };
  tracker.orient(orientation, 0);
  const raw = { gravityAcceleration: [0, 0, 9.80665], linearAcceleration: [0, 0, 0], orientation };
  tracker.process({ ...raw, t: 0, gyro: [0, 0, 0], orientationAge: 0 });
  tracker.detector = { update: () => [{ t: 0.1 }], features: null };
  tracker.process({ ...raw, t: 0.1, gyro: [0, 0, -900], orientationAge: 0.1 });
  assert.ok(Math.abs(tracker.state.deviceHeading - 90) < 1e-8);
  assert.ok(Math.abs(tracker.state.phoneX - 0.76) < 1e-8);
  assert.ok(Math.abs(tracker.state.phoneY) < 1e-8);
  tracker.orient({ ...orientation, alpha: 270 }, 0.11);
  tracker.detector = { update: () => [], features: null };
  tracker.process({ ...raw, t: 0.12, gyro: [0, 0, 0], orientationAge: 0.12 });
  assert.ok(Math.abs(tracker.state.deviceHeading - 90) < 1e-8);
});

test('regular gait with arm-swing or pocket gyro magnitude is not vetoed', () => {
  for (const magnitude of [35, 130, 165]) {
    const detector = new GaitStepDetector();
    let steps = 0;
    for (let i = 0; i < 500; i++) {
      const t = i / 50;
      const vertical = 3 * Math.sin(2 * Math.PI * 2 * t);
      steps += detector.update({
        t,
        dt: 0.02,
        vertical,
        nav: [Math.cos(2 * Math.PI * 2 * t), 0, vertical],
        norm: Math.hypot(1, vertical),
        gyroMagnitude: magnitude,
        yawRate: 0,
        orientationReliable: true,
      }).length;
    }
    assert.ok(steps >= 15);
    assert.equal(detector.features.confirmedGait, true);
    assert.ok(Math.abs(detector.features.confirmedCadence - 2) < 0.1);
  }
});
