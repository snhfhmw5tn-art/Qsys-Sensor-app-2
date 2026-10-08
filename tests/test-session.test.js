import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TestSession,
  testTypes,
  bodyPoses,
  vehiclePoses,
  testSpeeds,
} from '../client/test-session.js';
const sample = (t) => ({
  t,
  gravityAcceleration: [0, 0, 9.80665],
  linearAcceleration: [0, 0, 0],
  gyro: [0, 0, 0],
  orientation: { alpha: 0, beta: 0, gamma: 0 },
  screenAngle: 90,
  orientationAge: 0.01,
});
test('all requested activity, placement and vehicle speed combinations are supported', () => {
  let combinations = 0;
  for (const [type, definition] of Object.entries(testTypes)) {
    for (const pose of Object.keys(definition.vehicle ? vehiclePoses : bodyPoses)) {
      for (const speed of definition.vehicle ? Object.keys(testSpeeds) : [null]) {
        const session = new TestSession({ type, pose, speed, distance: 19 });
        assert.equal(session.metadata.stepsEnabled, !definition.vehicle);
        assert.equal(session.metadata.knownDistance, type === 'Standing' ? 0 : 19);
        combinations++;
      }
    }
  }
  assert.equal(combinations, 33);
});
test('test export contains only this test raw data, orientations, labels and frozen end', () => {
  const session = new TestSession(
    { type: 'Walking', pose: 'pocket', distance: 19 },
    '2026-10-08T12:00:00Z',
  );
  session.orient({ alpha: 0, beta: 0, gamma: 0 }, 100);
  session.process(sample(100.1));
  session.process(sample(100.2));
  session.event({ type: 'visibility', hidden: true });
  const saved = session.finish({ build: { commit: 'example' } }, '2026-10-08T12:00:01Z');
  session.process(sample(101));
  session.orient({ alpha: 90, beta: 0, gamma: 0 }, 101);
  assert.equal(saved.segments[0].history.samples.length, 2);
  assert.equal(saved.segments[0].history.orientationEvents.length, 1);
  assert.equal(saved.segments[0].history.samples[0].sourceT, 100.1);
  assert.equal(saved.segments[0].history.samples[0].screenAngle, 90);
  assert.equal(saved.test.type, 'Walking');
  assert.equal(saved.test.pose, 'pocket');
  assert.equal(saved.test.endedAt, '2026-10-08T12:00:01Z');
  assert.equal(saved.statusEvents[0].hidden, true);
  assert.equal(session.finish(), saved);
  assert.equal(new TestSession({ type: 'Walking', pose: 'upright' }).tracker.raw.length, 0);
});
test('cart and forklift tests cannot count detected footfalls or use a stride', () => {
  for (const type of ['Cart', 'Forklift']) {
    const session = new TestSession({ type, pose: 'down', speed: 'fast', distance: 20 });
    session.tracker.detector = { update: (s) => [{ t: s.t }], features: null };
    session.process(sample(5));
    session.process(sample(5.02));
    const saved = session.finish();
    const history = saved.segments[0].history;
    assert.equal(history.state.steps, 0);
    assert.equal(history.stepsEnabled, false);
    assert.equal(history.stepLength, null);
    assert.equal(history.derived.at(-1).confirmedSteps.length, 0);
    assert.equal(saved.test.speed, 'fast');
  }
});
test('standing tests retain false-positive steps for later analysis', () => {
  const session = new TestSession({ type: 'Standing', pose: 'swinging' });
  session.tracker.detector = { update: (s) => [{ t: s.t }], features: null };
  session.process(sample(5));
  assert.equal(session.tracker.state.steps, 1);
  assert.equal(session.finish().test.knownDistance, 0);
});
