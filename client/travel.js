import { radians, wrap } from '../shared/config.js';
const axial = (v) => wrap(v * 2) / 2;
// Browser adaptation of Deng et al. (2018), sections 3 and 4:
// two-step overlapping windows, motion-state selection and delayed correction.
// Uses browser attitude rather than the paper's EKF / trained carrying classifier.
// Independent estimator: never writes to the orange route or phone-heading filter.
export class CompensatedRoute {
  constructor(stepLength) {
    this.stepLength = stepLength;
    this.reference = null;
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
    this.frame = null;
    this.gyro = 0;
    this.lastSampleT = null;
    this.lastStepGyro = 0;
    this.lastStepT = null;
    this.epoch = 0;
  }
  resetEvidence() {
    this.samples = [];
    this.lastAnalysis = -Infinity;
    this.reference = null;
    this.status = 'uncertain';
    this.footfalls = [];
    this.normalEnergy = null;
    this.lastSampleT = null;
    this.lastStepT = null;
    this.lastStepGyro = this.gyro;
    this.epoch++;
  }
  analyze(sample, phone, t, f) {
    if (!sample) return f;
    this.samples.push({ ...sample, phone, integral: this.gyro });
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
    const inconsistent =
      Math.abs(yaw) > 8 && Math.abs(rotation) > 12 && Math.abs(axial(rotation - gaitChange)) > 15;
    this.motion = disturbed
      ? 'hand-motion'
      : inconsistent
        ? 'position-transition'
        : Math.abs(yaw) > 8 && tilt < 12
          ? 'turn'
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
    this.footfalls.push(...footfalls.map((p) => p.t));
    this.footfalls = this.footfalls.filter((at) => at >= t - 8);
    if (sample) {
      const dt = this.lastSampleT === null ? 0 : Math.min(0.1, Math.max(0, t - this.lastSampleT));
      // Navigation frame is ENU: positive gyro z is counterclockwise,
      // whereas the map's compass heading grows clockwise.
      this.gyro -= (sample.yawRate ?? 0) * dt;
      this.lastSampleT = t;
      this.currentPhone = phone;
    }
    const count = this.decisions.length;
    const features = this.analyze(sample, phone, t, f);
    if (sample && this.decisions.length > count) {
      const decision = this.decisions.at(-1);
      decision.epoch = this.epoch;
      decision.reliable = !!features?.orientationReliable && (features?.periodicity ?? 0) >= 0.6;
      // A later overlapping window can expose a hand movement after a step
      // was provisionally treated as normal/turning. Reclassify that window.
      if (['hand-motion', 'position-transition'].includes(decision.motion)) {
        for (const step of this.steps) {
          if (
            step.epoch === this.epoch &&
            step.t >= decision.start &&
            step.t <= decision.t &&
            !step.corrected
          ) {
            step.mode = 'disturbance';
            step.heading = step.beforeHeading;
            step.pending = true;
          }
        }
        this.rebuild();
      }
    }
    const last = this.steps.at(-1);
    if (last) {
      const turning = this.motion === 'turn' && !last.pending;
      this.heading = wrap(last.heading + (turning ? this.gyro - last.gyro : 0));
    }
  }
  stepAxis(rows) {
    if (rows.length < 8 || !rows.every((p) => p.orientationReliable)) return null;
    const average = (fn) => rows.reduce((sum, row) => sum + fn(row), 0) / rows.length;
    const mx = average((p) => p.nav[0]),
      my = average((p) => p.nav[1]);
    const xx = average((p) => (p.nav[0] - mx) ** 2),
      yy = average((p) => (p.nav[1] - my) ** 2),
      xy = average((p) => (p.nav[0] - mx) * (p.nav[1] - my));
    const energy = xx + yy;
    const quality = Math.hypot(xx - yy, 2 * xy) / (energy + 1e-6);
    if (energy < 0.012 || quality < 0.5) return null;
    return { axis: wrap(90 - (Math.atan2(2 * xy, xx - yy) * 90) / Math.PI), quality, energy };
  }
  append(t, phone, distance) {
    const previous = this.steps.at(-1);
    const start = this.lastStepT ?? t - 0.5;
    const rows = this.samples.filter((p) => p.t > start && p.t <= t);
    const end = rows.at(-1);
    // Integrals are stored on each sample so delayed step confirmations do
    // not accidentally use gyro rotation measured AFTER the footfall.
    const gyro = end?.integral ?? this.lastStepGyro;
    const delta = gyro - this.lastStepGyro;
    const beforeHeading = previous?.heading ?? 0;
    const prediction = wrap(beforeHeading + delta);
    const decision =
      this.decisions.find((d) => d.epoch === this.epoch && d.start <= t && d.t >= t) ??
      this.decisions.findLast((d) => d.epoch === this.epoch && d.t <= t);
    const axis = this.stepAxis(rows);
    const motion = decision?.motion ?? 'uncertain';
    let mode = 'uncertain',
      heading = beforeHeading;
    if (['hand-motion', 'position-transition'].includes(motion)) mode = 'disturbance';
    else if (motion === 'turn' && decision?.reliable) {
      mode = 'turn';
      heading = prediction;
    } else if (motion === 'normal' && decision?.reliable && axis) {
      mode = 'normal';
      this.frame ??= { axis: axis.axis, heading: beforeHeading, t };
      heading = wrap(this.frame.heading + axial(axis.axis - this.frame.axis));
      if (Math.abs(wrap(heading - prediction)) > 90) heading = wrap(heading + 180);
    }
    const step = {
      t,
      phone,
      distance,
      heading,
      beforeHeading,
      gyro,
      delta,
      mode,
      motion,
      axis,
      epoch: this.epoch,
      pending: mode === 'disturbance',
      corrected: false,
    };
    this.steps.push(step);
    this.lastStepGyro = gyro;
    this.lastStepT = t;
    if (axis && ['normal', 'turn'].includes(mode)) this.reference = { phone, axis: axis.axis, t };
    this.correctDisturbances();
    this.filterOutlier();
    this.rebuild();
    this.heading = this.steps.at(-1).heading;
    this.status =
      mode === 'turn'
        ? 'turning'
        : this.steps.some((p) => p.pending && p.epoch === this.epoch)
          ? 'checking'
          : mode === 'normal'
            ? 'supported'
            : 'uncertain';
  }
  correctDisturbances() {
    // Section 4.2, K=4: two normal steps before and two after a disturbed
    // interval. A turn is a boundary; never average across a real turn/gap.
    for (let i = 0; i < this.steps.length; i++) {
      if (!this.steps[i].pending) continue;
      let end = i;
      while (end + 1 < this.steps.length && this.steps[end + 1].pending) end++;
      const before = this.steps.slice(Math.max(0, i - 2), i);
      const after = this.steps.slice(end + 1, end + 3);
      const neighbors = [...before, ...after];
      if (
        before.length === 2 &&
        after.length === 2 &&
        neighbors.every((p) => p.mode === 'normal' && !p.pending && p.epoch === this.steps[i].epoch)
      ) {
        const x = neighbors.reduce((sum, p) => sum + Math.sin(radians(p.heading)), 0);
        const y = neighbors.reduce((sum, p) => sum + Math.cos(radians(p.heading)), 0);
        if (Math.hypot(x, y) / 4 >= 0.9) {
          const heading = wrap((Math.atan2(x, y) * 180) / Math.PI);
          for (let k = i; k <= end; k++) {
            this.steps[k].heading = heading;
            this.steps[k].pending = false;
            this.steps[k].corrected = true;
          }
          this.events.push({
            start: this.steps[i].t,
            end: this.steps[end].t,
            confirmedAt: after[1].t,
            heading,
            neighbors: neighbors.map((p) => p.t),
            reason: 'four-neighbor-normal-step-mean',
          });
        }
      }
      i = end;
    }
  }
  filterOutlier() {
    if (this.steps.length < 3) return;
    const [a, b, c] = this.steps.slice(-3);
    if (
      !a ||
      a.epoch !== c.epoch ||
      [a, b, c].some((p) => p.pending || !['normal', 'turn'].includes(p.mode))
    )
      return;
    const left = wrap(b.heading - a.heading),
      right = wrap(c.heading - b.heading);
    if (
      Math.abs(left) > 25 &&
      Math.abs(right) > 25 &&
      left * right < 0 &&
      Math.abs(wrap(c.heading - a.heading)) < 12
    ) {
      b.heading = wrap(a.heading + wrap(c.heading - a.heading) / 2);
      b.filtered = true;
      this.events.push({
        start: b.t,
        end: b.t,
        confirmedAt: c.t,
        heading: b.heading,
        reason: 'adjacent-step-outlier',
      });
    }
  }
  rebuild() {
    this.trajectory = [{ x: 0, y: 0, t: 0, distance: 0, kind: 'start' }];
    for (const step of this.steps) {
      const last = this.trajectory.at(-1);
      this.trajectory.push({
        x: last.x + this.stepLength * Math.sin(radians(step.heading)),
        y: last.y + this.stepLength * Math.cos(radians(step.heading)),
        t: step.t,
        distance: step.distance,
        heading: step.heading,
        kind: 'movement',
      });
    }
  }
  exportHistory() {
    return {
      model: 'deng-2018-three-strategy-browser-v1',
      motion: this.motion,
      status: this.status,
      frame: this.frame,
      decisions: this.decisions,
      corrections: this.events,
      stepEstimates: this.steps,
      limitations: [
        'browser-attitude-instead-of-raw-magnetometer-EKF',
        'threshold-classifier-not-trained-carrying-classifier',
        'PCA-sign-by-gyro-continuity-not-pocket-phase-model',
      ],
    };
  }
}
