import test from 'node:test';
import assert from 'node:assert/strict';
import { orangeMarker } from '../client/maps.js';
test('numbered markers anchor to orange rather than green and survive history serialization', () => {
  const state = {
    x: 99,
    y: 99,
    t: 12,
    distance: 8,
    steps: 10,
    phoneTrajectory: [
      { x: 0, y: 0, t: 0 },
      { x: 3, y: 7, t: 11 },
    ],
  };
  const markers = [orangeMarker(state, 0, 2, '2026-10-08T13:00:00Z'), orangeMarker(state, 1, 2)];
  const saved = JSON.parse(JSON.stringify({ markers }));
  assert.deepEqual(
    saved.markers.map((m) => m.id),
    [0, 1],
  );
  assert.equal(saved.markers[0].x, 3);
  assert.equal(saved.markers[0].y, 7);
  assert.equal(saved.markers[0].trajectoryIndex, 1);
  assert.equal(saved.markers[0].segment, 2);
  assert.equal(saved.markers[0].t, 12);
  state.phoneTrajectory.push({ x: 9, y: 9, t: 13 });
  assert.equal(markers[0].x, 3);
  assert.equal(orangeMarker({ phoneTrajectory: [] }, 0, 0), null);
});
