import { radians, wrap } from '../shared/config.js';
const axial = (v) => wrap(v * 2) / 2;
function meanAxis(rows) {
  const x = rows.reduce((s, p) => s + Math.cos(radians(p.axis * 2)), 0);
  const y = rows.reduce((s, p) => s + Math.sin(radians(p.axis * 2)), 0);
  return { axis: (Math.atan2(y, x) * 90) / Math.PI, agreement: Math.hypot(x, y) / rows.length };
}
// Independent estimator: never writes to the orange route or phone-heading filter.
export class CompensatedRoute {
  constructor(stepLength) {
    this.stepLength = stepLength;
    this.offset = 0;
    this.reference = null;
    this.pending = null;
    this.evidence = [];
    this.phoneWindow = [];
    this.footfalls = [];
    this.events = [];
    this.steps = [];
    this.trajectory = [{ x: 0, y: 0, t: 0, distance: 0, kind: 'start' }];
    this.status = 'waiting';
    this.heading = 0;
  }
  resetEvidence() {
    this.evidence = [];
    this.pending = null;
    this.phoneWindow = [];
    this.status = 'uncertain';
  }
  update(f, phone, t, footfalls = []) {
    this.heading = wrap(phone - this.offset);
    this.phoneWindow.push({ t, phone });
    this.phoneWindow = this.phoneWindow.filter((p) => p.t >= t - 0.5);
    this.footfalls.push(...footfalls.map((p) => p.t));
    this.footfalls = this.footfalls.filter((at) => at >= t - 8);
    if (this.reference && !this.pending && Math.abs(wrap(phone - this.reference.phone)) > 12) {
      this.pending = {
        start: Math.max(0, t - 0.3),
        ...this.reference,
        baseOffset: this.offset,
        startedAt: t,
      };
      this.evidence = [];
      this.status = 'checking';
    }
    if (!f || f === this.last) return;
    this.last = f;
    const reliable =
      f.orientationReliable &&
      f.periodicity >= 0.6 &&
      f.anisotropy >= 0.5 &&
      f.horizontalEnergy >= 0.012;
    if (!reliable) {
      this.evidence = [];
      this.status = this.pending ? 'checking' : 'uncertain';
      return;
    }
    this.evidence.push({ t, axis: f.pcaHeading });
    this.evidence = this.evidence.filter((p) => p.t >= t - 1);
    if (this.evidence.length < 7 || t - this.evidence[0].t < 0.7) return;
    const mean = meanAxis(this.evidence);
    if (mean.agreement < 0.96) return;
    const quiet =
      this.phoneWindow.length > 1 &&
      t - this.phoneWindow[0].t >= 0.35 &&
      this.phoneWindow.every((p) => Math.abs(wrap(p.phone - phone)) < 8);
    if (!quiet) return;
    const uncertainty = (Math.acos(Math.min(1, mean.agreement)) * 180) / Math.PI;
    if (!this.reference) {
      this.reference = { phone, axis: mean.axis, uncertainty, t };
      this.status = 'following';
      return;
    }
    if (!this.pending) {
      this.reference.axis = mean.axis;
      this.reference.uncertainty = uncertainty;
      this.status = this.events.length ? 'supported' : 'following';
      return;
    }
    const p = this.pending,
      steps = this.footfalls.filter((at) => at >= p.startedAt);
    if (t - p.startedAt < 1.2 || steps.length < 3 || steps.at(-1) - steps[0] < 0.7) return;
    const rotation = wrap(phone - p.phone);
    let gait = axial(mean.axis - p.axis);
    // An acceleration axis cannot distinguish a reversal from straight walking.
    if (Math.abs(rotation) > 120 && Math.abs(gait) < 35) {
      this.status = 'uncertain';
      return;
    }
    if (Math.abs(wrap(gait - rotation)) > 90) gait = wrap(gait + 180);
    const tolerance = Math.max(12, uncertainty, p.uncertainty);
    if (Math.abs(gait) < tolerance) gait = 0;
    const mismatch = wrap(rotation - gait);
    if (Math.abs(mismatch) > tolerance) {
      const event = {
        start: p.start,
        end: t,
        basePhone: p.phone,
        phoneRotation: rotation,
        gaitRotation: gait,
        oldOffset: p.baseOffset,
        newOffset: wrap(p.baseOffset + mismatch),
        footfalls: [...steps],
        agreement: mean.agreement,
        reason: 'persistent-mounting-change',
      };
      this.events.push(event);
      this.offset = event.newOffset;
      this.rebuild();
    }
    this.reference = { phone, axis: mean.axis, uncertainty, t };
    this.pending = null;
    this.heading = wrap(phone - this.offset);
    this.status = 'supported';
  }
  headingAt(t, phone) {
    let offset = 0;
    for (const e of this.events) {
      if (t < e.start) break;
      if (t >= e.end) {
        offset = e.newOffset;
        continue;
      }
      const k = Math.max(0, Math.min(1, wrap(phone - e.basePhone) / e.phoneRotation));
      offset = wrap(e.oldOffset + k * wrap(e.newOffset - e.oldOffset));
    }
    return wrap(phone - offset);
  }
  append(t, phone, distance) {
    this.steps.push({ t, phone, distance });
    this.appendPoint(this.steps.at(-1));
  }
  appendPoint(step) {
    const h = this.headingAt(step.t, step.phone),
      last = this.trajectory.at(-1);
    this.trajectory.push({
      x: last.x + this.stepLength * Math.sin(radians(h)),
      y: last.y + this.stepLength * Math.cos(radians(h)),
      t: step.t,
      distance: step.distance,
      heading: h,
      kind: 'movement',
    });
  }
  rebuild() {
    this.trajectory = [{ x: 0, y: 0, t: 0, distance: 0, kind: 'start' }];
    for (const step of this.steps) this.appendPoint(step);
  }
  exportHistory() {
    return {
      model: 'phone-route-with-confirmed-mounting-compensation',
      offset: this.offset,
      status: this.status,
      reference: this.reference,
      pending: this.pending,
      corrections: this.events,
    };
  }
}
