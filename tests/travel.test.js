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
