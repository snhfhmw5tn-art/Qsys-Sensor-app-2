import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityEstimator } from '../client/activity.js';
import { VehicleDistance } from '../client/vehicle.js';
import { MotionFeatureExtractor } from '../client/pipeline.js';
import { WalkingTracker } from '../client/walking.js';
const quiet = {
  sampleRate: 50,
  rms: 0.05,
  gyroRms: 0,
  periodicity: 0,
  verticalAmplitude: 0,
  horizontalEnergy: 0,
  cadence: 0,
};
const sample = (t, a) => ({ t, orientationReliable: true, nav: [0, a, 0] });
test('activity scores distinguish standing, walking, running and ambiguous vehicle', () => {
  for (const [features, expected] of [
    [quiet, 'Standing'],
    [
      {
        ...quiet,
        rms: 1,
        periodicity: 0.9,
        verticalAmplitude: 2,
        horizontalEnergy: 0.2,
        cadence: 2,
      },
      'Walking',
    ],
    [
      {
        ...quiet,
        rms: 3,
        periodicity: 0.9,
        verticalAmplitude: 4,
        horizontalEnergy: 0.3,
        cadence: 3,
      },
      'Running',
    ],
    [{ ...quiet, rms: 0.8, horizontalEnergy: 0.5 }, 'VehicleUnknown'],
  ]) {
    const result = new ActivityEstimator().update(features, 0);
    assert.equal(result.mode, expected);
    assert.ok(Math.abs(Object.values(result.probabilities).reduce((a, b) => a + b, 0) - 1) < 1e-8);
    assert.equal(result.calibrated, false);
  }
});
test('known cart/truck is recorded as a prior, not a learned subtype', () => {
  for (const type of ['Cart', 'Forklift']) {
    const result = new ActivityEstimator().update(
      { ...quiet, rms: 0.5, horizontalEnergy: 0.3 },
      0,
      type,
    );
    assert.equal(result.mode, type);
    assert.equal(result.source, 'sensors-and-selected-transport');
  }
});
test('quiet initial vehicle is standing but coasting evidence does not force a stop', () => {
  assert.equal(new ActivityEstimator().update(quiet, 0, 'Cart').mode, 'Standing');
  assert.equal(new ActivityEstimator().update(quiet, 0, 'Auto', true).mode, 'VehicleUnknown');
});
test('experimental integration accelerates, coasts and brakes without using steps', () => {
  const vehicle = new VehicleDistance();
  let distance = 0;
  for (let i = 0; i <= 100; i++) distance += vehicle.update(sample(i / 50, 1), 'Cart').distance;
  assert.ok(vehicle.speed > 1.7 && vehicle.speed < 2.1);
  const atAcceleration = distance;
  for (let i = 101; i <= 200; i++) distance += vehicle.update(sample(i / 50, 0), 'Cart').distance;
  assert.ok(distance - atAcceleration > 3);
  assert.ok(vehicle.speed > 1.7);
  for (let i = 201; i <= 300; i++) vehicle.update(sample(i / 50, -1), 'Cart');
  assert.ok(vehicle.speed < 0.3);
});
test('vehicle gap does not integrate unknown elapsed time and invalid attitude cannot move', () => {
  const vehicle = new VehicleDistance();
  vehicle.update(sample(0, 1), 'Forklift');
  const gap = vehicle.update(sample(2, 1), 'Forklift');
  assert.equal(gap.valid, false);
  assert.equal(gap.distance, 0);
  assert.equal(
    vehicle.update({ ...sample(2.02, 1), orientationReliable: false }, 'Forklift').distance,
    0,
  );
});
test('vehicle distance is independent of configured stride even with detected footfalls', () => {
  const trackers = [
    new WalkingTracker({ stepLength: 0.4 }),
    new WalkingTracker({ stepLength: 1.2 }),
  ];
  for (const tracker of trackers) {
    tracker.transportType = 'Cart';
    tracker.detector = {
      features: { ...quiet, rms: 0.5, horizontalEnergy: 0.3 },
      update: (s) => [{ t: s.t }],
    };
    for (let i = 0; i <= 100; i++)
      tracker.process({
        t: i / 50,
        gravityAcceleration: [0, 1, 9.80665],
        linearAcceleration: [0, 1, 0],
        gyro: [0, 0, 0],
        orientation: { alpha: 0, beta: 0, gamma: 0 },
      });
  }
  assert.ok(trackers[0].state.distance > 1);
  assert.equal(trackers[0].state.distance, trackers[1].state.distance);
  assert.deepEqual(trackers[0].state.phoneTrajectory, trackers[1].state.phoneTrajectory);
  assert.ok(trackers[0].exportHistory().derived.at(-1).vehicle.experimental);
});

test('centripetal acceleration in either turn does not increase speed', () => {
  for (const sign of [-1, 1]) {
    const vehicle = new VehicleDistance();
    for (let i = 0; i <= 100; i++) vehicle.update(sample(i / 50, 1));
    for (let i = 101; i <= 150; i++) vehicle.update(sample(i / 50, 0));
    const before = vehicle.speed;
    const yaw = (sign * Math.PI) / 4;
    for (let i = 151; i <= 350; i++) {
      const middle = vehicle.heading - (yaw * 0.02) / 2;
      const lateral = -vehicle.speed * yaw;
      vehicle.update({
        t: i / 50,
        orientationReliable: true,
        yawRate: sign * 45,
        nav: [lateral * Math.cos(middle), -lateral * Math.sin(middle), 0],
      });
    }
    assert.ok(Math.abs(vehicle.speed - before) < 0.03);
  }
});
test('gait takes precedence over vehicle selection and coasting; over 35 km/h is truck', () => {
  const gait = {
    ...quiet,
    rms: 1,
    periodicity: 0.9,
    verticalAmplitude: 2,
    horizontalEnergy: 0.2,
    cadence: 2,
  };
  for (const transport of ['Auto', 'Cart', 'Forklift']) {
    const estimator = new ActivityEstimator();
    assert.equal(estimator.update(gait, 0, transport, true, 2).mode, 'Walking');
    const fast = estimator.update(gait, 0.02, transport, true, 10);
    assert.equal(fast.mode, 'Forklift');
    assert.equal(fast.reason, 'user-rule-estimated-speed-over-35-kmh');
    assert.equal(estimator.update(gait, 0.04, transport, true, 2).mode, 'Walking');
  }
});
test('high-frequency mechanical vibration alone is not classified as walking', () => {
  const f = {
    ...quiet,
    rms: 1,
    periodicity: 0.9,
    verticalAmplitude: 2,
    horizontalEnergy: 0.2,
    cadence: 2,
    verticalHighFrequencyRatio: 0.9,
  };
  assert.equal(new ActivityEstimator().update(f, 0, 'Cart').mode, 'Cart');
});

test('vertical spectrum separates 2 Hz gait-band and 8 Hz vibration signals', () => {
  for (const hz of [2, 8]) {
    const samples = Array.from({ length: 101 }, (_, i) => {
      const z = Math.sin((2 * Math.PI * hz * i) / 50);
      return {
        t: i / 50,
        dt: 0.02,
        nav: [0, 0, z],
        vertical: z,
        norm: Math.abs(z),
        gyroMagnitude: 0,
        yawRate: 0,
        orientationReliable: true,
      };
    });
    const f = new MotionFeatureExtractor().extract(samples);
    assert.equal(f.verticalFrequency, hz);
    assert.ok(hz === 8 ? f.verticalHighFrequencyRatio > 0.9 : f.verticalHighFrequencyRatio < 0.1);
  }
});

test('small hand tremor remains standing despite autocorrelation', () => {
  const f = {
    ...quiet,
    rms: 0.223,
    gyroRms: 3.538,
    periodicity: 0.646,
    cadence: 1.56,
    verticalAmplitude: 0.589,
    horizontalEnergy: 0.015,
  };
  assert.equal(new ActivityEstimator().update(f, 0).mode, 'Standing');
});
test('confirmed regular footsteps can corroborate pocket impacts above 4 Hz', () => {
  const f = {
    ...quiet,
    rms: 10,
    gyroRms: 165,
    periodicity: 0.9,
    cadence: 3,
    verticalAmplitude: 24,
    horizontalEnergy: 50,
    verticalHighFrequencyRatio: 0.72,
    confirmedGait: true,
    confirmedCadence: 2,
  };
  assert.equal(new ActivityEstimator().update(f, 0).mode, 'Walking');
  assert.equal(
    new ActivityEstimator().update({ ...f, confirmedGait: false, confirmedCadence: null }, 0).mode,
    'Unknown',
  );
});
