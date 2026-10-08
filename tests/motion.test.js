import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, MotionObservationReceiver, HeatmapService } from '../server/state.js';
import { GpsQualityEvaluator, geographicToLocal, localToGeographic } from '../server/gps.js';
import { WalkingMotionModel, RunningMotionModel, VehicleMotionModel } from '../server/models.js';
import { validateObservation } from '../server/protocol.js';
import {
  SensorPipeline,
  TransportModeStateMachine,
  CoordinateTransformer,
  StepDetector,
  MotionClassifier,
} from '../client/pipeline.js';
import { demoSamples, validateRecording } from '../client/sources.js';
import { meterMarkers, fitTrajectory } from '../client/maps.js';
import { benchmark } from '../client/benchmark.js';
const id = 'test-session';
function Observation(sequence, t, extras = {}) {
  return {
    protocolVersion: 1,
    deviceId: 'test',
    sessionId: id,
    sequenceNumber: sequence,
    monotonicTimestamp: t,
    timestamp: t,
    type: 'MotionWindow',
    motionMode: 'Standing',
    modeConfidence: 0.9,
    headingDelta: 0,
    headingConfidence: 0.6,
    observationConfidence: 0.8,
    ...extras,
  };
}
function Step(t, heading = 0) {
  return {
    timestamp: t,
    heading,
    stepInterval: 0.5,
    cadence: 2,
    accelerationAmplitude: 4,
    verticalAmplitude: 4,
    signalEnergy: 2,
    motionConfidence: 0.8,
  };
}
function RunSamples(samples) {
  const observations = [],
    p = new SensorPipeline((o) => observations.push(o), { deviceId: 'test', sessionId: id }),
    s = initialState(id),
    engine = new MotionObservationReceiver();
  for (const sample of samples) p.process(sample);
  for (const o of observations) {
    validateObservation(o, id);
    engine.process(s, o);
  }
  return { s, p, observations };
}
function QuietSamples(seconds = 5, rotation = 0) {
  return Array.from({ length: seconds * 50 }, (_, i) => ({
    t: i / 50,
    gravityAcceleration: [0, 0, 9.80665],
    linearAcceleration: [0, 0, 0],
    gyro: [0, 0, i > 150 ? rotation : 0],
    orientation: { alpha: 0, beta: 0, gamma: 0 },
  }));
}
test('TestThat_turning_in_place_does_not_add_distance', () => {
  const s = initialState(id),
    e = new MotionObservationReceiver();
  e.process(s, Observation(1, 3, { motionMode: 'TurningInPlace', headingDelta: 180 }));
  assert.equal(s.totalDistance, 0);
  assert.equal(s.x, 0);
  assert.equal(s.y, 0);
  assert.equal(s.heading, -180);
});
test('TestThat_stand_rotate_360_has_zero_translation', () => {
  const { s } = RunSamples(QuietSamples(9, 60));
  assert.equal(s.totalDistance, 0);
  assert.equal(s.x, 0);
  assert.equal(s.y, 0);
});
test('TestThat_walk_turn_return_preserves_accumulated_distance', () => {
  const s = initialState(id),
    e = new MotionObservationReceiver();
  e.process(
    s,
    Observation(1, 1, { motionMode: 'Walking', type: 'Step', steps: [Step(0.5), Step(1)] }),
  );
  const outward = s.totalDistance;
  e.process(s, Observation(2, 2, { motionMode: 'TurningInPlace', headingDelta: 180 }));
  assert.equal(s.totalDistance, outward);
  e.process(
    s,
    Observation(3, 3, {
      motionMode: 'Walking',
      type: 'Step',
      steps: [Step(2.5, 180), Step(3, 180)],
    }),
  );
  assert.ok(Math.abs(s.y) < 1e-10);
  assert.ok(Math.abs(s.x) < 1e-10);
  assert.equal(s.totalDistance, outward * 2);
});
test('TestThat_portrait_and_landscape_start_at_zero_heading', () => {
  for (const gamma of [0, 90, -90]) {
    const { p, s } = RunSamples(
      QuietSamples().map((x) => ({ ...x, orientation: { alpha: 123, beta: 0, gamma } })),
    );
    assert.equal(p.heading.heading, 0);
    assert.equal(s.heading, 0);
  }
});
test('TestThat_isolated_shake_is_not_a_step', () => {
  const samples = QuietSamples(8);
  samples[220].gravityAcceleration[2] += 12;
  samples[220].linearAcceleration[2] = 12;
  const { s } = RunSamples(samples);
  assert.equal(s.steps, 0);
  assert.equal(s.totalDistance, 0);
});
test('TestThat_put_on_table_and_pick_up_do_not_translate', () => {
  const samples = QuietSamples(9);
  for (const i of [210, 300]) {
    samples[i].gravityAcceleration = [5, -3, 13];
    samples[i].linearAcceleration = [5, -3, 3];
  }
  assert.equal(RunSamples(samples).s.totalDistance, 0);
});
test('TestThat_demo_confirms_buffered_gait_and_returns', () => {
  const { s, p } = RunSamples(demoSamples());
  assert.ok(s.steps > 35, `only ${s.steps} steps`);
  assert.ok(s.totalDistance > 20);
  assert.ok(p.events.some((x) => x.type === 'BufferedStepsApplied'));
  assert.ok(s.trajectory.some((x) => x.mode === 'Walking'));
});
test('TestThat_replay_is_deterministic', () => {
  const a = RunSamples(demoSamples()),
    b = RunSamples(demoSamples());
  assert.deepEqual(a.observations, b.observations);
  assert.deepEqual(a.s, b.s);
});
test('TestThat_walking_turn_advances_both_heading_and_position', () => {
  const s = initialState(id),
    e = new MotionObservationReceiver();
  e.process(
    s,
    Observation(1, 1, {
      type: 'Step',
      motionMode: 'WalkingTurn',
      headingDelta: 90,
      steps: [Step(1, 90)],
    }),
  );
  assert.equal(s.heading, 90);
  assert.ok(s.x > 0.5);
  assert.ok(Math.abs(s.y) < 1e-9);
});
test('TestThat_duplicate_batch_is_idempotent', () => {
  const s = initialState(id),
    e = new MotionObservationReceiver(),
    o = Observation(1, 1, { type: 'Step', motionMode: 'Walking', steps: [Step(1)] });
  e.process(s, o);
  const before = structuredClone(s);
  assert.equal(e.process(s, o), false);
  assert.deepEqual(s, before);
});
test('TestThat_sequence_gaps_and_time_regression_are_rejected', () => {
  const s = initialState(id),
    e = new MotionObservationReceiver();
  assert.throws(() => e.process(s, Observation(2, 2)), /Sequence gap/);
  e.process(s, Observation(1, 2));
  assert.throws(() => e.process(s, Observation(2, 1)), /Timestamp regression/);
});
test('TestThat_single_peak_does_not_change_transport', () => {
  const m = new TransportModeStateMachine();
  for (let t = 0; t < 4; t += 0.25) m.update({ mode: 'Walking', confidence: 0.8 }, t);
  assert.equal(m.mode, 'Walking');
  m.update({ mode: 'Vehicle', confidence: 0.95 }, 4);
  assert.equal(m.mode, 'Walking');
});
test('TestThat_declared_vehicle_switches_temporally_back_to_walking', () => {
  const m = new TransportModeStateMachine();
  for (const [mode, start] of [
    ['Walking', 0],
    ['Scooter', 3],
    ['Forklift', 6],
    ['Walking', 9],
  ]) {
    for (let t = start; t < start + 2; t += 0.25) m.update({ mode, confidence: 0.8 }, t);
    assert.equal(m.mode, mode);
  }
});
test('TestThat_vehicle_constant_speed_is_not_claimed_from_quiet_imu', () => {
  const model = new VehicleMotionModel(),
    s = initialState(id);
  s.velocity = 3;
  const o = Observation(1, 7, {
    orientationReliable: true,
    vehicle: { headingReferenceReliable: true, accelerationIntegral: 0, stationaryProbability: 1 },
  });
  const result = model.advance(o, s, 0.2);
  assert.equal(result.distance, 0);
  assert.ok(s.vehicleDistanceConfidence < 0.3);
});
test('TestThat_vehicle_without_orientation_freezes_translation', () => {
  const model = new VehicleMotionModel(),
    s = initialState(id);
  assert.equal(
    model.advance(Observation(1, 1, { vehicle: { accelerationIntegral: 3 } }), s, 0.2).distance,
    0,
  );
});
test('TestThat_quiet_vehicle_does_not_automatically_get_zupt', () => {
  const model = new VehicleMotionModel(),
    s = initialState(id);
  s.velocity = 3;
  const result = model.advance(
    Observation(1, 1, {
      orientationReliable: true,
      vehicle: {
        headingReferenceReliable: true,
        accelerationIntegral: 0,
        stationaryProbability: 1,
      },
    }),
    s,
    0.2,
  );
  assert.ok(result.distance > 0.5);
  assert.equal(s.velocity, 3);
});
test('TestThat_running_has_a_different_stride_model', () => {
  const step = Step(1);
  assert.notEqual(new WalkingMotionModel().length(step), new RunningMotionModel().length(step));
});
test('TestThat_calibration_scales_stride', () => {
  const m = new WalkingMotionModel();
  assert.ok(Math.abs(m.length(Step(1), 1.1) / m.length(Step(1)) - 1.1) < 1e-9);
});
test('TestThat_gps_good_poor_unavailable_good_keeps_tracking', () => {
  const s = initialState(id),
    e = new MotionObservationReceiver();
  const fix = (seq, t, accuracy) =>
    Observation(seq, t, {
      type: 'GpsFix',
      gps: { t, latitude: 59, longitude: 18, accuracy, age: 0, speed: 2, heading: 0 },
    });
  e.process(s, fix(1, 1, 5));
  assert.equal(s.gps.useForCorrection, true);
  e.process(s, fix(2, 2, 50));
  assert.equal(s.gps.useForCorrection, false);
  e.process(s, Observation(3, 10));
  assert.equal(s.gps.quality, 'Unavailable');
  e.process(s, fix(4, 11, 5));
  assert.equal(s.gps.useForCorrection, true);
  assert.equal(s.lastSequence, 4);
});
test('TestThat_gps_jumps_are_rejected', () => {
  const s = initialState(id);
  s.lastAcceptedGps = { t: 1, latitude: 59, longitude: 18, accuracy: 5 };
  const result = new GpsQualityEvaluator().evaluate(
    { t: 2, latitude: 60, longitude: 19, accuracy: 5, age: 0, speed: 2, heading: 0 },
    s,
  );
  assert.equal(result.useForCorrection, false);
});
test('TestThat_gps_correction_is_bounded_and_adds_no_distance', () => {
  const s = initialState(id),
    e = new MotionObservationReceiver();
  e.process(
    s,
    Observation(1, 1, {
      type: 'GpsFix',
      motionMode: 'Walking',
      gps: { t: 1, latitude: 59, longitude: 18, accuracy: 3, age: 0, speed: 2, heading: 0 },
    }),
  );
  e.process(
    s,
    Observation(2, 5, {
      type: 'GpsFix',
      motionMode: 'Walking',
      gps: { t: 5, latitude: 59.0001, longitude: 18, accuracy: 3, age: 0, speed: 2, heading: 0 },
    }),
  );
  assert.ok(Math.hypot(s.x, s.y) <= 1.500001);
  assert.equal(s.totalDistance, 0);
  assert.ok(s.gps.weight > 0);
});
test('TestThat_geographic_roundtrip_uses_wgs84', () => {
  const origin = { latitude: 59.32, longitude: 18.06 },
    p = { x: 20, y: 50 },
    r = localToGeographic(origin, p, 35),
    local = geographicToLocal(origin, { latitude: r.lat, longitude: r.lng }, 35);
  assert.ok(Math.hypot(local.x - p.x, local.y - p.y) < 1e-6);
});
test('TestThat_heatmap_accumulates_standing_time', () => {
  const s = initialState(id),
    h = new HeatmapService();
  h.add(s, { x: 0, y: 0 }, { x: 0, y: 0 }, 10, 0, 'Standing');
  const c = s.heatmap['0,0'];
  assert.equal(c.standingTime, 10);
  assert.equal(c.timeSpent, 10);
  assert.equal(c.visitCount, 1);
  assert.equal(c.averageSpeed, 0);
});
test('TestThat_heatmap_distributes_distance_along_segment', () => {
  const s = initialState(id);
  new HeatmapService().add(s, { x: 0, y: 0 }, { x: 0, y: 5 }, 5, 5, 'Walking');
  const cells = Object.values(s.heatmap);
  assert.ok(cells.length >= 10);
  assert.ok(Math.abs(cells.reduce((a, c) => a + c.distanceTravelled, 0) - 5) < 1e-9);
});
test('TestThat_meter_markers_follow_path_distance_not_displacement', () => {
  const markers = meterMarkers(
    [
      { x: 0, y: 0, distance: 0 },
      { x: 0, y: 5, distance: 5, kind: 'movement' },
      { x: 0, y: 0, distance: 10, kind: 'movement' },
    ],
    5,
  );
  assert.equal(markers.length, 2);
  assert.equal(markers[1].y, 0);
  assert.equal(markers[1].distance, 10);
});
test('TestThat_protocol_rejects_nonfinite_and_unbounded_data', () => {
  assert.throws(() => validateObservation(Observation(1, 1, { headingDelta: NaN }), id));
  assert.throws(() =>
    validateObservation(
      Observation(1, 1, { steps: [{ ...Step(1), accelerationAmplitude: Infinity }] }),
      id,
    ),
  );
  assert.throws(() => validateObservation(Observation(1, 1, { motionMode: 'Flying' }), id));
});
test('TestThat_replay_import_validates_all_sensor_vectors', () => {
  assert.throws(() =>
    validateRecording({
      format: 'qsys-recording',
      version: 1,
      samples: [{ t: 1, gravityAcceleration: [0, 0, 9], gyro: [0, NaN, 0] }],
    }),
  );
  assert.throws(() =>
    validateRecording({
      format: 'qsys-recording',
      version: 1,
      samples: [
        { t: 2, gravityAcceleration: [0, 0, 9] },
        { t: 1, gravityAcceleration: [0, 0, 9] },
      ],
    }),
  );
});
test('TestThat_coordinate_rotation_preserves_vector_magnitude', () => {
  const transformer = new CoordinateTransformer(),
    v = [2, 3, 4],
    r = transformer.transform(v, { alpha: 123, beta: 67, gamma: -88 });
  assert.ok(Math.abs(Math.hypot(...r) - Math.hypot(...v)) < 1e-9);
});
test('TestThat_benchmark_does_not_invent_missing_ground_truth', () => {
  const b = benchmark({ state: initialState(id) });
  assert.equal(b.modeAccuracy, null);
  assert.equal(b.headingError, null);
  assert.equal(b.distanceError, null);
  assert.equal(b.falseSteps, null);
});
test('TestThat_low_sample_rate_degrades_to_unknown', () => {
  assert.deepEqual(new MotionClassifier().classify({ sampleRate: 5 }), {
    mode: 'Unknown',
    confidence: 0.1,
  });
});
test('TestThat_speed_remains_stable_between_step_observations', () => {
  const s = initialState(id),
    engine = new MotionObservationReceiver();
  engine.process(s, Observation(1, 1, { type: 'Step', motionMode: 'Walking', steps: [Step(1)] }));
  const speed = s.instantaneousSpeed;
  engine.process(s, Observation(2, 1.2, { motionMode: 'Walking', steps: [] }));
  assert.equal(s.instantaneousSpeed, speed);
  engine.process(s, Observation(3, 3, { motionMode: 'Walking', steps: [] }));
  assert.equal(s.instantaneousSpeed, 0);
});
test('TestThat_gps_heading_support_affects_subsequent_step_positions', () => {
  const s = initialState(id),
    engine = new MotionObservationReceiver();
  const fix = (sequence, t, heading) =>
    Observation(sequence, t, {
      type: 'GpsFix',
      motionMode: 'Walking',
      gps: { t, latitude: 59, longitude: 18, accuracy: 3, age: 0, speed: 2, heading },
    });
  engine.process(s, fix(1, 1, 0));
  engine.process(s, fix(2, 2, 90));
  engine.process(
    s,
    Observation(3, 3, { type: 'Step', motionMode: 'Walking', steps: [Step(3, 0)] }),
  );
  assert.ok(s.x > 0.05);
  assert.ok(s.y > 0.5);
  assert.ok(s.heading > 0);
});
test('TestThat_sensor_dropout_resets_temporal_evidence', () => {
  const observations = [],
    p = new SensorPipeline((o) => observations.push(o), { deviceId: 'test', sessionId: id });
  for (const sample of demoSamples().slice(0, 500)) p.process(sample);
  assert.equal(p.machine.mode, 'Walking');
  const quiet = QuietSamples(1)[0];
  p.process({ ...quiet, t: 30 });
  assert.equal(p.machine.mode, 'Unknown');
  assert.equal(p.features, null);
  assert.ok(p.events.some((e) => e.type === 'SensorDropout'));
  assert.ok(p.heading.confidence <= 0.15);
});
