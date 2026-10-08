import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HeadingEstimator,
  CoordinateTransformer,
  MotionFeatureExtractor,
  SensorPreprocessor,
} from '../client/pipeline.js';
import { fitTrajectory, LocalMapRenderer } from '../client/maps.js';

test('quiet sensor startup calibrates within 0.7 seconds', () => {
  const p = new SensorPreprocessor();
  for (let i = 0; i <= 35; i++)
    p.process({
      t: i / 50,
      gravityAcceleration: [0, 0, 9.80665],
      linearAcceleration: [0, 0, 0],
      gyro: [0, 0, 0],
    });
  assert.equal(p.calibrated, true);
});

test('movement restarts the continuous quiet calibration interval', () => {
  const p = new SensorPreprocessor();
  for (let i = 0; i <= 25; i++)
    p.process({
      t: i / 50,
      gravityAcceleration: [0, 0, 9.80665],
      linearAcceleration: i === 25 ? [2, 0, 0] : [0, 0, 0],
      gyro: [0, 0, 0],
    });
  for (let i = 26; i <= 45; i++)
    p.process({
      t: i / 50,
      gravityAcceleration: [0, 0, 9.80665],
      linearAcceleration: [0, 0, 0],
      gyro: [0, 0, 0],
    });
  assert.equal(p.calibrated, false);
  for (let i = 46; i <= 60; i++)
    p.process({
      t: i / 50,
      gravityAcceleration: [0, 0, 9.80665],
      linearAcceleration: [0, 0, 0],
      gyro: [0, 0, 0],
    });
  assert.equal(p.calibrated, true);
});

test('touch and page scroll cannot silently disable automatic route fitting', () => {
  const previous = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  try {
    let captured = false,
      prevented = false;
    const canvas = {
      addEventListener() {},
      removeEventListener() {},
      setPointerCapture() {
        captured = true;
      },
    };
    const renderer = new LocalMapRenderer(canvas);
    renderer.wheel({
      deltaY: 100,
      preventDefault() {
        prevented = true;
      },
    });
    renderer.down({ clientX: 30, clientY: 50, pointerId: 1 });
    renderer.drag({ clientX: 35, clientY: 90 });
    assert.equal(renderer.follow, true);
    assert.equal(prevented, false);
    assert.equal(captured, false);
    assert.deepEqual(renderer.pan, { x: 0, y: 0 });
    renderer.destroy();
  } finally {
    if (previous === undefined) delete globalThis.ResizeObserver;
    else globalThis.ResizeObserver = previous;
  }
});

const feature = (heading) => ({
  orientationReliable: true,
  anisotropy: 0.95,
  horizontalEnergy: 0.3,
  periodicity: 0.8,
  pcaHeading: heading,
});
const sample = (alpha = 0, beta = 90, gamma = 0) => ({
  dt: 0.02,
  yawRate: 0,
  orientation: { alpha, beta, gamma },
});

test('upright phone starts forward; rotating it does not turn travel', () => {
  const h = new HeadingEstimator();
  h.update(sample(), feature(20), 'Walking');
  assert.equal(h.deviceYaw, 0);
  for (let i = 1; i <= 100; i++)
    h.update({ ...sample(i * 0.9), yawRate: 45 }, feature(20), 'Walking');
  assert.ok(Math.abs(h.deviceYaw + 90) < 0.01);
  assert.ok(Math.abs(h.heading) < 0.01);
});

test('travel turns with navigation-frame gait even when phone orientation stays fixed', () => {
  const h = new HeadingEstimator();
  h.update(sample(), feature(0), 'Walking');
  for (let target = 5; target <= 90; target += 5)
    for (let i = 0; i < 3; i++) h.update(sample(), feature(target), 'WalkingTurn');
  assert.ok(h.heading > 88 && h.heading <= 90);
  assert.equal(h.deviceYaw, 0);
});

test('rotation without reliable gait holds travel direction and lowers confidence', () => {
  const h = new HeadingEstimator();
  for (let i = 0; i < 100; i++) h.update(sample(i), null, 'TurningInPlace');
  assert.equal(h.heading, 0);
  assert.ok(h.confidence < 0.3);
});

test('compass changes alone never rotate the phone symbol', () => {
  const h = new HeadingEstimator();
  for (let i = 0; i < 100; i++) h.update(sample(i * 3), null, 'Standing');
  assert.equal(h.deviceYaw, 0);
});

test('walking with weak gait direction follows physical device turn', () => {
  const h = new HeadingEstimator();
  h.update(sample(), null, 'Walking');
  for (let i = 0; i < 100; i++) h.update({ ...sample(), yawRate: -45 }, null, 'Walking');
  for (let i = 0; i < 100; i++) h.update(sample(), null, 'Walking');
  assert.ok(h.heading > 85 && h.heading < 91);
});

test('alternating arm swing does not accumulate a turn', () => {
  const h = new HeadingEstimator();
  h.update(sample(), feature(0), 'Walking');
  for (let i = 0; i < 500; i++)
    h.update(
      { ...sample(), yawRate: 90 * Math.sin(i * 0.02 * Math.PI * 4) },
      feature(0),
      'Walking',
    );
  assert.ok(Math.abs(h.heading) < 1);
});

test('navigation-frame gait axis survives upright/flat phone rotations', () => {
  const transform = new CoordinateTransformer(),
    extract = new MotionFeatureExtractor();
  for (const beta of [0, 90]) {
    const samples = [];
    for (let i = 0; i < 150; i++) {
      const t = i / 50,
        orientation = { alpha: i * 0.6, beta, gamma: 0 };
      const nav = [0, 0.6 * Math.sin(t * Math.PI * 4), 2 * Math.sin(t * Math.PI * 4)];
      const matrix = transform.matrix(orientation);
      const device = [0, 1, 2].map((j) => matrix.reduce((sum, row, k) => sum + row[j] * nav[k], 0));
      samples.push({
        t,
        dt: 0.02,
        nav: transform.transform(device, orientation),
        vertical: nav[2],
        norm: Math.hypot(...nav),
        gyroMagnitude: 30,
        yawRate: 30,
        orientationReliable: true,
      });
    }
    const f = extract.extract(samples);
    assert.ok(Math.min(Math.abs(f.pcaHeading), Math.abs(Math.abs(f.pcaHeading) - 180)) < 0.01);
    assert.ok(f.anisotropy > 0.95);
  }
});

test('auto-fit keeps origin, turns, negative coordinates and long routes inside padding', () => {
  for (const points of [
    [{ x: 0, y: 0 }],
    [
      { x: 0, y: 50 },
      { x: 30, y: 50 },
    ],
    [
      { x: -8000, y: 2000 },
      { x: 9000, y: -3000 },
    ],
  ]) {
    const fit = fitTrajectory(points, 600, 340);
    for (const p of [{ x: 0, y: 0 }, ...points]) {
      const x = 300 + (p.x - fit.x) * fit.zoom,
        y = 170 - (p.y - fit.y) * fit.zoom;
      assert.ok(x >= 47.99 && x <= 552.01 && y >= 47.99 && y <= 292.01);
    }
  }
});
