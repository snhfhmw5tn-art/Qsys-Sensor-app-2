import test from 'node:test';
import assert from 'node:assert/strict';
import { CompensatedRoute } from '../client/travel.js';
const f = (axis) => ({
  orientationReliable: true,
  periodicity: 0.9,
  anisotropy: 0.9,
  horizontalEnergy: 0.2,
  pcaHeading: axis,
});
function walk(p, axis, phone, start, count) {
  for (let i = 0; i < count; i++) {
    const t = start + i * 0.1;
    p.update(f(axis), phone, t, i % 5 === 0 ? [{ t }] : []);
    p.append(t, phone, (p.steps.length + 1) * 0.76);
  }
}
test('arbitrary grip change is confirmed over repeated steps and recent route is redrawn', () => {
  const p = new CompensatedRoute(0.76);
  walk(p, 20, 0, 0, 30);
  const before = p.trajectory.map((point) => ({ ...point }));
  for (let i = 0; i < 10; i++) {
    const t = 3 + i * 0.1;
    p.update(f(20), (37 * i) / 9, t, i % 5 === 0 ? [{ t }] : []);
    p.append(t, (37 * i) / 9, (p.steps.length + 1) * 0.76);
  }
  const provisional = p.trajectory.at(-1).x;
  assert.ok(provisional > 0.5);
  walk(p, 20, 37, 4, 40);
  assert.equal(p.events.length, 1);
  assert.ok(Math.abs(p.offset - 37) < 1e-8);
  assert.ok(Math.abs(p.trajectory.at(-1).x) < 0.1);
  assert.deepEqual(p.trajectory.slice(0, before.length), before);
  const saved = JSON.parse(JSON.stringify(p.exportHistory()));
  assert.equal(saved.corrections[0].newOffset, 37);
  walk(p, 80, 97, 8, 40);
  assert.ok(Math.abs(p.heading - 60) < 1e-8);
  assert.equal(p.offset, 37);
});
test('a genuine right-angle body turn keeps the phone-based heading without false compensation', () => {
  const p = new CompensatedRoute(0.76);
  walk(p, 20, 0, 0, 30);
  for (let i = 1; i <= 20; i++)
    p.update(f(20 + i * 4.5), i * 4.5, 3 + i * 0.1, i % 5 === 0 ? [{ t: 3 + i * 0.1 }] : []);
  walk(p, 110, 90, 5.1, 40);
  assert.equal(p.offset, 0);
  assert.equal(p.events.length, 0);
  assert.equal(p.heading, 90);
});
test('one isolated shake or ambiguous reversal cannot confirm a mounting correction', () => {
  const p = new CompensatedRoute(0.76);
  walk(p, 20, 0, 0, 30);
  for (let i = 0; i < 40; i++)
    p.update({ ...f(20), periodicity: 0.1 }, 65, 3 + i * 0.1, i === 0 ? [{ t: 3 }] : []);
  assert.equal(p.events.length, 0);
  const q = new CompensatedRoute(0.76);
  walk(q, 20, 0, 0, 30);
  walk(q, 20, 180, 3, 40);
  assert.equal(q.events.length, 0);
  assert.equal(q.status, 'uncertain');
});

function rawWalk(route, seconds, pose) {
  for (let i = 0; i < seconds * 50; i++) {
    const t = i / 50,
      state = pose(t),
      amplitude = Math.sin(4 * Math.PI * t);
    const nav = [
      Math.sin((state.axis * Math.PI) / 180) * amplitude,
      Math.cos((state.axis * Math.PI) / 180) * amplitude,
      0,
    ];
    const footfalls = i % 25 === 0 ? [{ t }] : [];
    route.update(f(state.axis), state.phone, t, footfalls, {
      t,
      nav,
      linear: nav,
      orientationReliable: true,
      orientation: { alpha: state.phone, beta: state.beta ?? 90, gamma: 0 },
      yawRate: state.rate ?? 0,
    });
    if (footfalls.length) route.append(t, state.phone, (route.steps.length + 1) * 0.76);
  }
}
test('raw two-step windows classify an arbitrary phone rotation and redraw green only', () => {
  const p = new CompensatedRoute(0.76);
  rawWalk(p, 12, (t) => ({
    axis: 20,
    phone: t < 4 ? 0 : t < 5 ? (t - 4) * 37 : 37,
    beta: t < 4 ? 90 : t < 5 ? 90 - (t - 4) * 50 : 40,
    rate: t >= 4 && t < 5 ? 37 : 0,
  }));
  assert.ok(p.decisions.some((d) => d.motion === 'hand-motion'));
  assert.ok(p.decisions.some((d) => d.motion === 'position-transition'));
  assert.ok(Math.abs(p.offset - 37) < 0.01);
  assert.ok(Math.abs(p.trajectory.at(-1).x) < 0.1);
  assert.equal(p.exportHistory().model, 'orange-route-with-confirmed-grip-offset-v2');
  assert.ok(p.decisions.every((d) => Math.abs(d.seconds - 2 * d.period) < 1e-8));
});
test('a continuing raw gyro turn is accepted without waiting for the phone to settle', () => {
  const p = new CompensatedRoute(0.76);
  rawWalk(p, 10, (t) => {
    const phone = t < 4 ? 0 : t < 8 ? (t - 4) * 22.5 : 90;
    return { axis: 20 + phone, phone, rate: t >= 4 && t < 8 ? 22.5 : 0 };
  });
  assert.ok(p.decisions.some((d) => d.motion === 'turn'));
  assert.ok(p.decisions.some((d) => d.motion === 'turn' && d.t < 7));
  assert.ok(Math.abs(p.offset) < 0.01);
  assert.ok(Math.abs(p.heading - 90) < 0.01);
  assert.ok(p.trajectory.at(-1).x > 2);
});
test('a sensor gap discards stale reference and classification windows', () => {
  const p = new CompensatedRoute(0.76);
  rawWalk(p, 4, () => ({ axis: 20, phone: 0 }));
  assert.ok(p.reference);
  p.resetEvidence();
  assert.equal(p.reference, null);
  assert.equal(p.samples.length, 0);
  assert.equal(p.pending, null);
});

test('gait-axis fluctuations cannot steer green away from the orange reference', () => {
  const p = new CompensatedRoute(0.76);
  rawWalk(p, 10, (t) => ({ axis: t < 4 ? 20 : 35, phone: 0 }));
  assert.equal(p.offset, 0);
  assert.equal(p.heading, 0);
  assert.equal(p.events.length, 0);
  assert.equal(p.trajectory.at(-1).x, 0);
  assert.ok(p.trajectory.every((point) => point.x === 0));
});
test('without confirmed grip compensation green reproduces every orange step exactly', () => {
  const p = new CompensatedRoute(0.76);
  rawWalk(p, 12, (t) => {
    const phone = t < 4 ? 0 : t < 8 ? (t - 4) * 22.5 : 90;
    return { axis: 20 + phone, phone, rate: t >= 4 && t < 8 ? 22.5 : 0 };
  });
  assert.equal(p.events.length, 0);
  let x = 0,
    y = 0;
  p.steps.forEach((step, i) => {
    x += 0.76 * Math.sin((step.phone * Math.PI) / 180);
    y += 0.76 * Math.cos((step.phone * Math.PI) / 180);
    assert.equal(p.trajectory[i + 1].x, x);
    assert.equal(p.trajectory[i + 1].y, y);
    assert.equal(p.trajectory[i + 1].heading, step.phone);
  });
});
