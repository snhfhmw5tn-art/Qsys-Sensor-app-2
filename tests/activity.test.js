import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityEstimator } from '../client/activity.js';
import { VehicleDistance } from '../client/vehicle.js';
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
