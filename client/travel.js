import { radians, wrap } from '../shared/config.js';
const axial = (v) => wrap(v * 2) / 2;
function meanAxis(rows) {
  const x = rows.reduce((s, p) => s + Math.cos(radians(p.axis * 2)), 0);
  const y = rows.reduce((s, p) => s + Math.sin(radians(p.axis * 2)), 0);
  return { axis: (Math.atan2(y, x) * 90) / Math.PI, agreement: Math.hypot(x, y) / rows.length };
}
// Browser adaptation of Deng et al. (2018), sections 3 and 4:
// two-step overlapping windows, motion-state selection and delayed correction.
// Uses browser attitude rather than the paper's EKF / trained carrying classifier.
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
    this.samples = [];
    this.decisions = [];
    this.motion = 'waiting';
    this.normalEnergy = null;
    this.lastAnalysis = -Infinity;
    this.navigationReference = null;
  }
  resetEvidence() {
    this.evidence = [];
    this.samples = [];
    this.lastAnalysis = -Infinity;
    this.reference = null;
    this.navigationReference = null;
    this.normalAnchor = null;
    this.last = null;
    this.pending = null;
    this.phoneWindow = [];
    this.status = 'uncertain';
  }
  analyze(sample, phone, t, f) {
    if (!sample) return f;
    this.samples.push({ ...sample, phone });
    this.samples = this.samples.filter((p) => p.t >= t - 4);
    const times = this.footfalls.slice(-6);
    const intervals = times
      .slice(1)
      .map((at, i) => at - times[i])
      .filter((dt) => dt >= 0.26 && dt <= 1.2);
    const period = intervals.length
      ? intervals.sort((a, b) => a - b)[Math.floor(intervals.length / 2)]
      : 0.5;
    const seconds = 2 * period;
    // Recompute every step period: 50% overlap, independent of browser event rate.
    if (t - this.lastAnalysis < period) return null;
    const rows = this.samples.filter((p) => p.t >= t - seconds);
    if (rows.length < 12 || t - rows[0].t < seconds * 0.85) return null;
    this.lastAnalysis = t;
    const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
    const mx = mean(rows.map((p) => p.nav[0])),
      my = mean(rows.map((p) => p.nav[1]));
    const xx = mean(rows.map((p) => (p.nav[0] - mx) ** 2));
    const yy = mean(rows.map((p) => (p.nav[1] - my) ** 2));
    const xy = mean(rows.map((p) => (p.nav[0] - mx) * (p.nav[1] - my)));
    let tilt = 0,
      yaw = 0;
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1],
        b = rows[i];
      if (a.orientation && b.orientation) {
        // Direction of gravity in device coordinates: invariant to yaw and
        // avoids Euler-angle wrap / upright-phone singularities.
        const vector = (o) => [
          -Math.cos(radians(o.beta)) * Math.sin(radians(o.gamma)),
          Math.sin(radians(o.beta)),
          Math.cos(radians(o.beta)) * Math.cos(radians(o.gamma)),
        ];
        const u = vector(a.orientation),
          v = vector(b.orientation);
        tilt +=
          (Math.acos(
            Math.max(
              -1,
              Math.min(
                1,
                u.reduce((sum, x, k) => sum + x * v[k], 0),
              ),
            ),
          ) *
            180) /
          Math.PI;
      }
      yaw += (b.yawRate ?? 0) * Math.min(0.1, b.t - a.t);
    }
    const energy = mean(rows.map((p) => Math.hypot(...p.linear) ** 2));
    const disturbed =
      tilt > 25 || (this.normalEnergy !== null && energy > Math.max(2, this.normalEnergy * 3));
    const axis = wrap(90 - (Math.atan2(2 * xy, xx - yy) * 90) / Math.PI);
    const rotation = this.reference ? wrap(phone - this.reference.phone) : 0;
    const gaitChange = this.reference ? axial(axis - this.reference.axis) : 0;
    const inconsistent = Math.abs(rotation) > 12 && Math.abs(axial(rotation - gaitChange)) > 15;
    this.motion = disturbed
      ? 'hand-motion'
      : inconsistent
        ? 'position-transition'
        : Math.abs(yaw) > 8 && Math.abs(gaitChange) > 5 && tilt < 12
          ? 'turn'
          : Math.abs(rotation) > 12
            ? 'position-transition'
            : 'normal';
    if (this.motion === 'normal' && f?.periodicity >= 0.6)
      this.normalEnergy =
        this.normalEnergy === null ? energy : 0.9 * this.normalEnergy + 0.1 * energy;
    this.decisions.push({
      t,
      start: rows[0].t,
      seconds,
      period,
      motion: this.motion,
      tilt,
      yaw,
      energy,
      axis,
      rotation,
      gaitChange,
    });
    return {
      ...f,
      pcaHeading: axis,
      anisotropy: Math.hypot(xx - yy, 2 * xy) / (xx + yy + 1e-6),
      horizontalEnergy: xx + yy,
      orientationReliable: rows.every((p) => p.orientationReliable),
      analysisSeconds: seconds,
      disturbed,
    };
  }
  update(f, phone, t, footfalls = [], sample = null) {
    this.heading = this.normalAnchor
      ? wrap(this.normalAnchor.heading + wrap(phone - this.normalAnchor.phone))
      : wrap(phone - this.offset);
    this.phoneWindow.push({ t, phone });
    this.phoneWindow = this.phoneWindow.filter((p) => p.t >= t - 0.5);
    this.footfalls.push(...footfalls.map((p) => p.t));
    this.footfalls = this.footfalls.filter((at) => at >= t - 8);
    if (this.reference && !this.pending && Math.abs(wrap(phone - this.reference.phone)) > 12) {
      this.pending = {
        start: Math.max(0, this.reference.t, t - (sample ? 1 : 0.3)),
        ...this.reference,
        baseOffset: this.offset,
        startedAt: t,
      };
      this.evidence = [];
      this.status = 'checking';
    }
    f = this.analyze(sample, phone, t, f);
    if (!f || f === this.last) return;
    this.last = f;
    const reliable =
      !f.disturbed &&
      f.orientationReliable &&
      f.periodicity >= 0.6 &&
      f.anisotropy >= 0.5 &&
      f.horizontalEnergy >= 0.012;
    if (!reliable) {
      if (f.disturbed && this.reference && !this.pending) {
        this.pending = {
          start: Math.max(0, t - (f.analysisSeconds ?? 1)),
          ...this.reference,
          baseOffset: this.offset,
          startedAt: t,
        };
      }
      this.evidence = [];
      this.status = this.pending ? 'checking' : 'uncertain';
      return;
    }
    // A continuing turn must not wait for a stationary phone. Integrate the
    // existing gravity-axis gyro heading with the last confirmed grip offset.
    if (sample && this.motion === 'turn' && this.reference && this.pending) {
      this.status = 'turning';
      this.pending = null;
      this.reference = { phone, axis: f.pcaHeading, uncertainty: 12, t };
      return;
    }
    this.evidence.push({ t, axis: f.pcaHeading });
    const span = f.analysisSeconds ?? 1;
    this.evidence = this.evidence.filter((p) => p.t >= t - Math.max(1, span * 1.6));
    const minimum = sample ? 2 : 7;
    if (this.evidence.length < minimum || t - this.evidence[0].t < (sample ? span * 0.4 : 0.7))
      return;
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
      this.navigationReference ??= { axis: mean.axis, heading: wrap(phone - this.offset) };
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
      this.normalAnchor = null;
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
    const previous = this.steps.at(-1);
    const step = { t, phone, distance, motion: 'provisional' };
    const decision = this.decisions.findLast((d) => d.t <= t);
    const duration = previous ? t - previous.t : (decision?.period ?? 0.5);
    const rows = this.samples.filter((p) => p.t >= t - duration && p.t <= t);
    if (
      this.navigationReference &&
      decision?.motion === 'normal' &&
      rows.length >= 8 &&
      duration <= 1.2 &&
      rows.every((p) => p.orientationReliable)
    ) {
      // RMPCA stage: project first, then PCA over each actual walking step.
      const average = (fn) => rows.reduce((sum, row) => sum + fn(row), 0) / rows.length;
      const mx = average((p) => p.nav[0]),
        my = average((p) => p.nav[1]);
      const xx = average((p) => (p.nav[0] - mx) ** 2),
        yy = average((p) => (p.nav[1] - my) ** 2),
        xy = average((p) => (p.nav[0] - mx) * (p.nav[1] - my));
      const quality = Math.hypot(xx - yy, 2 * xy) / (xx + yy + 1e-6);
      if (quality >= 0.5 && xx + yy >= 0.012) {
        const axis = wrap(90 - (Math.atan2(2 * xy, xx - yy) * 90) / Math.PI);
        let target = wrap(
          this.navigationReference.heading + axial(axis - this.navigationReference.axis),
        );
        const predicted = this.headingAt(t, phone);
        if (Math.abs(wrap(target - predicted)) > 90) target = wrap(target + 180);
        // Continuity chooses an axis branch but cannot prove a true reversal.
        if (Math.abs(wrap(target - predicted)) <= 45) {
          step.estimate = target;
          step.motion = 'normal';
          step.quality = quality;
        }
      }
    } else if (decision) step.motion = decision.motion;
    this.steps.push(step);
    this.appendPoint(step);
    if (Number.isFinite(step.estimate)) {
      this.normalAnchor = { phone, heading: step.estimate };
      this.heading = wrap(step.estimate + wrap((this.phoneWindow.at(-1)?.phone ?? phone) - phone));
    }
    // Neighboring normal steps reject a single isolated heading outlier.
    const [a, b, c] = this.steps.slice(-3);
    if (
      a?.motion === 'normal' &&
      b?.motion === 'normal' &&
      c?.motion === 'normal' &&
      [a.estimate, b.estimate, c.estimate].every(Number.isFinite) &&
      Math.abs(wrap(a.estimate - c.estimate)) < 12 &&
      Math.abs(wrap(b.estimate - a.estimate)) > 25 &&
      Math.abs(wrap(b.estimate - c.estimate)) > 25
    ) {
      b.estimate = wrap(a.estimate + wrap(c.estimate - a.estimate) / 2);
      b.filtered = true;
      this.rebuild();
    }
  }
  appendPoint(step) {
    const h = step.estimate ?? this.headingAt(step.t, step.phone),
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
      model: 'deng-2018-browser-adaptation-v1',
      motion: this.motion,
      decisions: this.decisions,
      offset: this.offset,
      status: this.status,
      reference: this.reference,
      pending: this.pending,
      corrections: this.events,
      stepEstimates: this.steps,
      navigationReference: this.navigationReference,
    };
  }
}
