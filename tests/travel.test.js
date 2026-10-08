import test from 'node:test';
import assert from 'node:assert/strict';
import { CompensatedRoute } from '../client/travel.js';
const f = { periodicity: 0.9 };
function walk(route, seconds, pose, delay = 0) {
  const pending = [];
  for (let i = 0; i < seconds * 50; i++) {
    const t = i / 50,
      state = pose(t),
      a = Math.sin(4 * Math.PI * t);
    const nav = [
      Math.sin((state.axis * Math.PI) / 180) * a,
      Math.cos((state.axis * Math.PI) / 180) * a,
      0,
    ];
    if (i % 25 === 0) pending.push({ t, phone: state.phone });
    const confirmed = [];
    while (pending.length && pending[0].t + delay <= t) confirmed.push(pending.shift());
    route.update({ ...f, periodicity: state.periodicity ?? 0.9 }, state.phone, t, confirmed, {
      t,
      nav,
      linear: nav,
      orientationReliable: state.reliable ?? true,
      orientation: { alpha: state.phone, beta: state.beta ?? 90, gamma: 0 },
      yawRate: state.rate ?? 0,
    });
    for (const peak of confirmed) route.append(peak.t, peak.phone, (route.steps.length + 1) * 0.76);
  }
}
test('normal gait uses step acceleration rather than phone heading minus offset', () => {
  const p = new CompensatedRoute(0.76);
  walk(p, 10, (t) => ({ axis: t < 4 ? 20 : 35, phone: 0 }));
  assert.ok(Math.abs(p.heading - 15) < 0.01);
  assert.ok(p.trajectory.at(-1).x > 1);
  assert.ok(p.steps.some((s) => s.mode === 'normal' && s.axis));
});
test('phone repositioning is corrected from four surrounding normal steps', () => {
  const p = new CompensatedRoute(0.76);
  walk(p, 12, (t) => ({
    axis: 20,
    phone: t < 4 ? 0 : t < 5 ? (t - 4) * 37 : 37,
    beta: t < 4 ? 90 : t < 5 ? 90 - (t - 4) * 50 : 40,
    rate: t >= 4 && t < 5 ? -37 : 0,
  }));
  assert.ok(p.decisions.some((d) => d.motion === 'hand-motion'));
  const corrections = p.events.filter((e) => e.reason === 'four-neighbor-normal-step-mean');
  assert.ok(corrections.length > 0);
  assert.ok(corrections.every((e) => e.neighbors.length === 4 && e.confirmedAt > e.end));
  assert.ok(Math.abs(p.trajectory.at(-1).x) < 0.1);
  assert.ok(Math.abs(p.heading) < 0.01);
  assert.ok(p.steps.some((s) => s.corrected));
});
test('a sustained 90 degree turn integrates navigation gyro while moving', () => {
  const p = new CompensatedRoute(0.76);
  walk(p, 12, (t) => {
    const phone = t < 4 ? 0 : t < 8 ? (t - 4) * 22.5 : 90;
    return { axis: 20 + phone, phone, rate: t >= 4 && t < 8 ? -22.5 : 0 };
  });
  const turns = p.steps.filter((s) => s.mode === 'turn');
  assert.ok(turns.length >= 3);
  assert.ok(turns.some((s) => s.t < 7 && s.heading > 20));
  assert.ok(turns.every((s) => Math.abs(s.heading - s.beforeHeading - s.delta) < 0.01));
  assert.ok(Math.abs(p.heading - 90) < 0.01);
  assert.ok(p.trajectory.at(-1).x > 2);
});
test('delayed footfall confirmations use gyro at the original footfall time', () => {
  const p = new CompensatedRoute(0.76);
  walk(
    p,
    12,
    (t) => {
      const phone = t < 4 ? 0 : t < 8 ? (t - 4) * 22.5 : 90;
      return { axis: 20 + phone, phone, rate: t >= 4 && t < 8 ? -22.5 : 0 };
    },
    0.8,
  );
  const turns = p.steps.filter((s) => s.mode === 'turn' && s.t > 5 && s.t < 7);
  assert.ok(turns.length >= 2);
  assert.ok(turns.every((s) => Math.abs(s.delta - 11.25) < 0.5));
});
test('missing orientation or weak gait cannot create normal PCA estimates', () => {
  const p = new CompensatedRoute(0.76);
  walk(p, 6, () => ({ axis: 70, phone: 50, reliable: false, periodicity: 0.1 }));
  assert.ok(p.steps.every((s) => s.mode === 'uncertain'));
  assert.equal(p.heading, 0);
});
test('isolated step outlier is removed but a sustained turn remains', () => {
  const make = (heads) => {
    const p = new CompensatedRoute(0.76);
    p.steps = heads.map((heading, i) => ({
      t: i,
      heading,
      mode: 'normal',
      epoch: 0,
      pending: false,
    }));
    p.filterOutlier();
    return p;
  };
  assert.equal(make([179, 120, -179]).steps[1].heading, -180);
  assert.equal(make([0, 60, 62]).steps[1].heading, 60);
});
test('sensor gaps prevent neighbor correction across disconnected evidence', () => {
  const p = new CompensatedRoute(0.76);
  walk(p, 4, () => ({ axis: 20, phone: 0 }));
  const frame = p.frame;
  p.resetEvidence();
  assert.equal(p.samples.length, 0);
  assert.equal(p.lastStepT, null);
  assert.equal(p.epoch, 1);
  assert.deepEqual(p.frame, frame);
});
test('export records three strategies, analysis cadence and browser limitations', () => {
  const p = new CompensatedRoute(0.76);
  walk(p, 4, () => ({ axis: 20, phone: 0 }));
  const data = JSON.parse(JSON.stringify(p.exportHistory()));
  assert.equal(data.model, 'deng-2018-three-strategy-browser-v1');
  assert.ok(data.decisions.every((d) => d.seconds === 2 * d.period));
  assert.ok(data.stepEstimates.length > 0);
  assert.ok(data.limitations.length > 0);
});

for (const angle of [45, -45, 180]) {
  test(`sustained ${angle} degree turn is retained through the PCA sign boundary`, () => {
    const p = new CompensatedRoute(0.76);
    walk(p, 12, (t) => {
      const phone = t < 4 ? 0 : t < 8 ? ((t - 4) * angle) / 4 : angle;
      return { axis: 20 + phone, phone, rate: t >= 4 && t < 8 ? -angle / 4 : 0 };
    });
    const error = ((p.heading - angle + 540) % 360) - 180;
    assert.ok(Math.abs(error) < 1);
    assert.ok(p.steps.some((s) => s.mode === 'turn'));
    assert.ok(!p.events.some((e) => e.reason === 'four-neighbor-normal-step-mean'));
  });
}
