import test from 'node:test';
import assert from 'node:assert/strict';
import { WalkingTracker } from '../client/walking.js';
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
test('travel direction ignores independent phone rotation but responds to gait turns', async () => {
  const { TravelDirection } = await import('../client/walking.js');
  const travel = new TravelDirection();
  const f = {
    orientationReliable: true,
    periodicity: 0.9,
    anisotropy: 0.9,
    horizontalEnergy: 0.1,
    pcaHeading: 30,
  };
  for (let i = 0; i < 30; i++) travel.update({ ...f }, 0);
  for (let i = 0; i < 20; i++) travel.update({ ...f }, i * 4);
  assert.ok(Math.abs(travel.heading) < 1e-9);
  for (let i = 0; i < 25; i++) travel.update({ ...f }, 80);
  for (let i = 1; i <= 20; i++) travel.update({ ...f, pcaHeading: 30 + i * 3 }, 80 + i * 3);
  for (let i = 0; i < 30; i++) travel.update({ ...f, pcaHeading: 90 }, 140);
  assert.ok(Math.abs(travel.heading - 60) < 3);
  travel.update({ ...f, anisotropy: 0.1, pcaHeading: 150 }, -90);
  assert.ok(Math.abs(travel.heading - 60) < 3);
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
  assert.ok(exported.derived.some((p) => p.travelHeading !== undefined));
  assert.equal(exported.state.phoneTrajectory.length, 1);
});
test('green holds direction despite gait-axis jitter and isolated phone rotation, then accepts corroborated U-turn', async () => {
  const { TravelDirection } = await import('../client/walking.js');
  const p = new TravelDirection();
  const f = (axis) => ({
    orientationReliable: true,
    periodicity: 0.9,
    anisotropy: 0.8,
    horizontalEnergy: 0.2,
    pcaHeading: axis,
  });
  for (let i = 0; i < 30; i++) p.update(f(30 + (i % 2 ? 7 : -7)), 0, i * 0.1);
  assert.equal(p.heading, 0);
  for (let i = 0; i < 20; i++) p.update(f(30), i * 4, 3 + i * 0.1);
  assert.equal(p.heading, 0);
  for (let i = 0; i < 15; i++) p.update(f(30), 76, 5 + i * 0.1);
  assert.equal(p.heading, 0);
  for (let i = 0; i <= 20; i++) p.update(f(30 - i * 9), 76 - i * 9, 6.5 + i * 0.1);
  for (let i = 0; i < 30; i++) p.update(f(-150), -104, 8.6 + i * 0.1);
  assert.ok(Math.abs(Math.abs(p.heading) - 180) < 3);
  assert.ok(p.correction.start <= 6.6);
});
test('retrospective green correction never mutates orange reference', () => {
  const tracker = new WalkingTracker({ stepLength: 1 });
  tracker.state.trajectory = [
    { x: 0, y: 0, t: 0 },
    { x: 0, y: 1, t: 1, travelHeading: 0, phoneHeading: 90 },
    { x: 0, y: 2, t: 2, travelHeading: 0, phoneHeading: 180 },
  ];
  tracker.state.phoneTrajectory = [
    { x: 0, y: 0, t: 0 },
    { x: 1, y: 0, t: 1 },
    { x: 1, y: -1, t: 2 },
  ];
  const orange = JSON.stringify(tracker.state.phoneTrajectory);
  tracker.travel.correction = { start: 1, end: 2, basePhone: 0, baseHeading: 0 };
  tracker.correctGreenRoute();
  assert.equal(JSON.stringify(tracker.state.phoneTrajectory), orange);
  assert.ok(Math.abs(tracker.state.x - 1) < 1e-8);
  assert.ok(Math.abs(tracker.state.y + 1) < 1e-8);
});
test('stable gait slowly corrects residual post-turn angle without copying phone heading', async () => {
  const { TravelDirection } = await import('../client/walking.js');
  const p = new TravelDirection();
  const f = (axis) => ({
    orientationReliable: true,
    periodicity: 0.95,
    anisotropy: 0.8,
    horizontalEnergy: 0.2,
    pcaHeading: axis,
  });
  for (let i = 0; i < 30; i++) p.update(f(10), 0, i * 0.1);
  p.heading = 153;
  p.reference = { axis: 10, phone: 180, heading: 153, t: 3 };
  p.corrections.push({ start: 2, end: 3 });
  let previous = p.heading;
  for (let i = 0; i < 120; i++) {
    p.update(f(10), 180, 3 + i * 0.1);
    assert.ok(Math.abs(p.heading - previous) <= 0.501);
    previous = p.heading;
  }
  assert.ok(p.heading > 174 && p.heading <= 180);
});
test('inconsistent gait cannot apply post-turn recovery', async () => {
  const { TravelDirection } = await import('../client/walking.js');
  const p = new TravelDirection();
  const f = (axis) => ({
    orientationReliable: true,
    periodicity: 0.95,
    anisotropy: 0.8,
    horizontalEnergy: 0.2,
    pcaHeading: axis,
  });
  for (let i = 0; i < 30; i++) p.update(f(10), 0, i * 0.1);
  p.heading = 153;
  p.reference = { axis: 10, phone: 180, heading: 153, t: 3 };
  p.corrections.push({ start: 2, end: 3 });
  for (let i = 0; i < 100; i++) p.update(f(i % 2 ? 40 : -40), 180, 3 + i * 0.1);
  assert.equal(p.heading, 153);
});

test('grip tilt freezes green while navigation-frame gait stays straight', async () => {
  const { TravelDirection } = await import('../client/walking.js');
  const p = new TravelDirection();
  const f = (axis) => ({
    orientationReliable: true,
    periodicity: 0.9,
    anisotropy: 0.9,
    horizontalEnergy: 0.2,
    pcaHeading: axis,
  });
  for (let i = 0; i < 30; i++) p.update(f(20), 0, i * 0.1, { orientation: { beta: 90, gamma: 0 } });
  for (let i = 0; i < 10; i++)
    p.update(f(70), i * 9, 3 + i * 0.1, { orientation: { beta: 90 - i * 10, gamma: i * 10 } });
  for (let i = 0; i < 30; i++)
    p.update(f(20), 90, 4 + i * 0.1, { orientation: { beta: 0, gamma: 90 } });
  assert.equal(p.heading, 0);
  assert.equal(p.corrections.length, 0);
});

test('successive right-angle turns retain the original gait coordinate reference', async () => {
  const { TravelDirection } = await import('../client/walking.js');
  const p = new TravelDirection();
  const f = (axis) => ({
    orientationReliable: true,
    periodicity: 0.9,
    anisotropy: 0.9,
    horizontalEnergy: 0.2,
    pcaHeading: axis,
  });
  let t = 0;
  for (let i = 0; i < 30; i++, t += 0.1) p.update(f(20), 0, t);
  for (let turn = 0; turn < 2; turn++) {
    for (let i = 1; i <= 20; i++, t += 0.1)
      p.update(f(20 + turn * 90 + i * 4.5), turn * 90 + i * 4.5, t);
    for (let i = 0; i < 40; i++, t += 0.1) p.update(f(20 + (turn + 1) * 90), (turn + 1) * 90, t);
    assert.ok(Math.abs(Math.abs(p.heading) - (turn + 1) * 90) < 3);
  }
});

test('brief misleading post-turn gait cannot replace a confirmed U-turn', async () => {
  const { TravelDirection } = await import('../client/walking.js');
  const p = new TravelDirection();
  const f = (axis) => ({
    orientationReliable: true,
    periodicity: 0.9,
    anisotropy: 0.8,
    horizontalEnergy: 0.2,
    pcaHeading: axis,
  });
  let t = 0;
  for (let i = 0; i < 30; i++, t += 0.1) p.update(f(20), 0, t);
  for (let i = 1; i <= 20; i++, t += 0.1) p.update(f(20 - i * 9), -i * 9, t);
  for (let i = 0; i < 40; i++, t += 0.1) p.update(f(20), -180, t);
  assert.ok(Math.abs(Math.abs(p.heading) - 180) < 3);
  const before = p.heading;
  for (let i = 0; i < 8; i++, t += 0.1) p.update(f(150), -180, t);
  assert.ok(Math.abs(p.heading - before) < 1);
  for (let i = 0; i < 30; i++, t += 0.1) p.update(f(20), -180, t);
  assert.ok(Math.abs(Math.abs(p.heading) - 180) < 3);
});
