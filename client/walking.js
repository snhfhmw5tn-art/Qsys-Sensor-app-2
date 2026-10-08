import {
  SensorPreprocessor,
  HeadingEstimator,
  MotionFeatureExtractor,
  SensorBuffer,
  StepValidator,
} from './pipeline.js';
import { radians, wrap, config as C } from '../shared/config.js';
export class WalkingTracker {
  constructor({ stepLength = 0.7, drawing = true } = {}) {
    this.stepLength = stepLength;
    this.drawing = drawing;
    this.preprocessor = new SensorPreprocessor();
    this.detector = new GaitStepDetector();
    this.heading = new HeadingEstimator();
    this.travel = new TravelDirection();
    this.attitude = new HeadingEstimator();
    this.attitudeOffset = null;
    this.history = [];
    this.raw = [];
    this.orientations = [];
    this.state = {
      x: 0,
      y: 0,
      distance: 0,
      steps: 0,
      heading: 0,
      deviceHeading: 0,
      phoneX: 0,
      phoneY: 0,
      phoneTrajectory: [{ x: 0, y: 0, t: 0, distance: 0, kind: 'start' }],
      trajectory: [{ x: 0, y: 0, t: 0, distance: 0, kind: 'start' }],
      heatmap: [],
    };
  }
  orient(orientation, t) {
    this.orientations.push({ t, ...structuredClone(orientation) });
    this.attitude.update({ orientation, gyro: null, yawRate: 0, dt: 0 }, null, 'Standing');
    this.attitudeOffset ??= this.heading.deviceYaw;
    const target = wrap(this.attitude.deviceYaw + this.attitudeOffset);
    // Small, current attitude corrections remove integration lag without accepting
    // abrupt compass jumps. Gyro prediction continues between attitude events.
    if (!this.hasGyro || Math.abs(wrap(target - this.heading.deviceYaw)) < 25) {
      this.heading.deviceYaw = target;
      this.state.deviceHeading = target;
      this.history.push({ t, phoneHeading: target });
    }
  }
  correctGreenRoute() {
    const c = this.travel.correction;
    if (!c || !this.drawing) return;
    let x = 0,
      y = 0;
    for (let i = 1; i < this.state.trajectory.length; i++) {
      const p = this.state.trajectory[i];
      if (p.t >= c.start && p.t <= c.end)
        p.travelHeading = c.headings
          ? interpolateHeading(c.headings, p.t)
          : wrap(c.baseHeading + wrap(p.phoneHeading - c.basePhone));
      x += this.stepLength * Math.sin(radians(p.travelHeading));
      y += this.stepLength * Math.cos(radians(p.travelHeading));
      p.x = x;
      p.y = y;
    }
    this.state.x = x;
    this.state.y = y;
    this.travel.correction = null;
  }
  exportHistory() {
    return {
      stepLength: this.stepLength,
      drawing: this.drawing,
      samples: this.raw,
      orientationEvents: this.orientations,
      derived: this.history,
      state: this.state,
      greenDirection: {
        confidence: this.travel.confidence,
        reference: this.travel.reference,
        turn: this.travel.turn,
        corrections: this.travel.corrections,
      },
    };
  }
  process(raw) {
    if (this.previous !== undefined && raw.t - this.previous > C.maximumSampleGap) {
      this.detector = new GaitStepDetector();
      this.preprocessor.previous = null;
      this.travel.resetEvidence();
    }
    this.previous = raw.t;
    this.hasGyro = Array.isArray(raw.gyro);
    this.raw.push(structuredClone(raw));
    const s = this.preprocessor.process(raw);
    this.heading.update(s, null, 'Standing');
    const peaks = this.detector.update(s);
    this.travel.update(this.detector.features, this.heading.deviceYaw, s.t, s);
    this.history.push({
      t: s.t,
      phoneHeading: this.heading.deviceYaw,
      travelHeading: this.travel.heading,
      travelConfidence: this.travel.confidence,
      orientationHeading: this.heading.orientationYaw,
      yawRate: s.yawRate,
      vertical: s.vertical,
      nav: s.nav,
      bias: [...this.preprocessor.bias],
      features: this.detector.features,
      confirmedSteps: peaks.map((p) => p.t),
    });
    for (const peak of peaks) {
      const atStep = this.history.findLast((p) => p.t <= peak.t && p.travelHeading !== undefined);
      const phone = atStep?.phoneHeading ?? this.heading.deviceYaw;
      const h = atStep?.travelHeading ?? this.travel.heading;
      this.state.steps++;
      if (!this.drawing) continue;
      const length = this.stepLength;
      this.state.x += length * Math.sin(radians(h));
      this.state.y += length * Math.cos(radians(h));
      this.state.phoneX += length * Math.sin(radians(phone));
      this.state.phoneY += length * Math.cos(radians(phone));
      this.state.distance += length;
      this.state.phoneTrajectory.push({
        x: this.state.phoneX,
        y: this.state.phoneY,
        t: peak.t,
        distance: this.state.distance,
        kind: 'movement',
      });
      this.state.trajectory.push({
        x: this.state.x,
        y: this.state.y,
        t: peak.t,
        distance: this.state.distance,
        kind: 'movement',
        travelHeading: h,
        phoneHeading: phone,
      });
    }
    this.correctGreenRoute();
    this.state.directionQuality = this.travel.confidence >= 0.6 ? 'supported' : 'uncertain';
    this.state.heading = this.travel.heading;
    this.state.deviceHeading = this.heading.deviceYaw;
    this.state.t = s.t;
    return this.state;
  }
}

// Confirm a single acceleration peak, not a multi-step gait window.
export class ImmediateStepDetector {
  constructor() {
    this.samples = [];
    this.trough = 0;
    this.lastStep = -Infinity;
    this.risingSince = null;
    this.armed = true;
  }
  update(sample) {
    this.trough = Math.min(this.trough, sample.vertical);
    if (sample.vertical < 0.15) {
      this.armed = true;
      this.risingSince = null;
    } else this.risingSince ??= sample.t;
    this.samples.push({ ...sample, risingSince: this.risingSince });
    if (this.samples.length > 3) this.samples.shift();
    if (this.samples.length < 3) return [];
    const [a, b, c] = this.samples;
    if (
      !this.armed ||
      b.vertical <= a.vertical ||
      b.vertical < c.vertical ||
      b.vertical < C.stepThreshold ||
      b.vertical - this.trough < C.stepProminence ||
      b.t - this.lastStep < 0.32 ||
      b.risingSince === null ||
      b.t - b.risingSince < 0.06
    )
      return [];
    this.lastStep = b.t;
    this.armed = false;
    this.trough = 0;
    return [{ t: b.t }];
  }
}

// IMU evidence indicates likely walking; it cannot prove displacement.
export class GaitStepDetector {
  constructor() {
    this.peaks = new ImmediateStepDetector();
    this.window = new SensorBuffer(2);
    this.extractor = new MotionFeatureExtractor();
    this.validator = new StepValidator();
    this.pending = [];
    this.features = null;
    this.lastFeatures = -Infinity;
    this.lastApplied = -Infinity;
  }
  update(sample) {
    this.window.add(sample);
    if (sample.t - this.lastFeatures >= 0.1) {
      this.features = this.extractor.extract(this.window.samples);
      this.lastFeatures = sample.t;
    }
    for (const peak of this.peaks.update(sample)) {
      const local = this.window.samples.filter((s) => s.t >= peak.t - 0.4);
      const horizontal =
        local.reduce((sum, s) => sum + s.nav[0] ** 2 + s.nav[1] ** 2, 0) /
        Math.max(1, local.length);
      // A vertical-only lift is insufficient evidence, even if periodic.
      if (sample.orientationReliable && horizontal >= 0.012) this.pending.push(peak);
    }
    this.pending = this.pending.filter((p) => p.t >= sample.t - 3);
    const recent = this.pending.slice(-3),
      f = this.features;
    const walking =
      f?.orientationReliable &&
      f.horizontalEnergy >= 0.012 &&
      f.horizontalEnergy >= f.energy * 0.015 &&
      f.gyroRms < 100 &&
      this.validator.validate(recent, f);
    if (!walking) return [];
    const result = recent.filter((p) => p.t > this.lastApplied);
    if (result.length) this.lastApplied = result.at(-1).t;
    return result;
  }
}

const axial = (value) => wrap(value * 2) / 2;
function axisMean(points) {
  const x = points.reduce((v, p) => v + Math.cos(radians(p.axis * 2)), 0),
    y = points.reduce((v, p) => v + Math.sin(radians(p.axis * 2)), 0);
  return { axis: (Math.atan2(y, x) * 90) / Math.PI, agreement: Math.hypot(x, y) / points.length };
}
export function interpolateHeading(points, t) {
  const b = points.find((p) => p.t >= t) ?? points.at(-1),
    a = points.findLast((p) => p.t <= t) ?? points[0];
  return wrap(
    a.heading +
      wrap(b.heading - a.heading) *
        (b.t === a.t ? 0 : Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)))),
  );
}
export class TravelDirection {
  constructor() {
    this.heading = 0;
    this.time = 0;
    this.last = null;
    this.reference = null;
    this.gaitOrigin = null;
    this.turn = null;
    this.initial = [];
    this.axes = [];
    this.phoneWindow = [];
    this.confidence = 0;
    this.corrections = [];
    this.poseUntil = 0;
    this.previousGravity = null;
    this.path = [];
    this.turnOnset = null;
    this.targetEvidence = [];
    this.phoneTrace = [];
  }
  resetEvidence() {
    this.reference = null;
    this.gaitOrigin = null;
    this.turn = null;
    this.initial = [];
    this.axes = [];
    this.phoneWindow = [];
    this.confidence = 0;
    this.previousGravity = null;
    this.path = [];
    this.turnOnset = null;
    this.targetEvidence = [];
    this.phoneTrace = [];
  }
  update(f, phone, t = this.time + 0.1, sample) {
    this.time = t;
    // A changing gravity direction in device axes indicates a grip/tilt change,
    // rather than a yaw turn. Let the navigation-frame gait window settle.
    if (sample?.orientation) {
      const { beta, gamma } = sample.orientation,
        b = radians(beta),
        g = radians(gamma),
        gravity = [-Math.cos(b) * Math.sin(g), Math.sin(b), Math.cos(b) * Math.cos(g)];
      if (this.previousGravity) {
        const dot = gravity.reduce((v, x, i) => v + x * this.previousGravity[i], 0);
        if (dot < Math.cos(radians(2))) this.poseUntil = t + 0.6;
      }
      this.previousGravity = gravity;
    }
    this.phoneTrace.push({ t, phone });
    this.phoneTrace = this.phoneTrace.filter((p) => p.t >= t - 12);
    this.phoneWindow.push({ t, phone });
    this.phoneWindow = this.phoneWindow.filter((p) => p.t >= t - 0.8);
    const quiet =
      this.phoneWindow.length > 1 &&
      t - this.phoneWindow[0].t >= 0.5 &&
      this.phoneWindow.every((p) => Math.abs(wrap(p.phone - phone)) < 7);
    if (this.reference && !this.turn && Math.abs(wrap(phone - this.reference.phone)) > 15)
      this.turnOnset ??= { t: Math.max(0, t - 0.3), heading: this.heading };
    if (this.turnOnset && quiet) this.turnOnset.end ??= t - 0.8;
    if (!f || f === this.last) return this.heading;
    this.last = f;
    const reliable =
      f.orientationReliable &&
      f.periodicity >= 0.48 &&
      f.anisotropy >= 0.4 &&
      f.horizontalEnergy >= 0.012 &&
      t >= this.poseUntil;
    if (!reliable) {
      this.confidence = 0.2;
      this.axes = [];
      this.targetEvidence = [];
      return this.heading;
    }
    this.axes.push({ t, axis: f.pcaHeading });
    this.axes = this.axes.filter((p) => p.t >= t - 0.6);
    const mean = axisMean(this.axes);
    if (!this.reference) {
      this.initial.push({ t, axis: f.pcaHeading });
      this.initial = this.initial.filter((p) => p.t >= t - 1.2);
      if (this.initial.length >= 8 && t - this.initial[0].t >= 0.8) {
        const init = axisMean(this.initial);
        if (init.agreement > 0.9) {
          this.reference = { axis: init.axis, phone, heading: this.heading, t };
          this.gaitOrigin = { axis: init.axis, heading: this.heading };
          this.startPhone = phone;
          this.path = [{ t, heading: this.heading }];
          this.confidence = 0.6;
        }
      }
      return this.heading;
    }
    const ref = this.reference,
      rotation = wrap(phone - ref.phone),
      axisDelta = axial(mean.axis - ref.axis);
    // Stabilize the baseline before any turn, without following a changing grip.
    if (
      !this.turn &&
      !this.corrections.length &&
      quiet &&
      Math.abs(wrap(phone - this.startPhone)) < 7 &&
      mean.agreement > 0.95
    ) {
      ref.axis = wrap(ref.axis + 0.08 * axial(mean.axis - ref.axis));
      this.gaitOrigin.axis = ref.axis;
      ref.t = t;
    }
    if (
      !this.turn &&
      Math.abs(rotation) > 15 &&
      Math.abs(axisDelta) > 12 &&
      Math.abs(axial(axisDelta - rotation)) < 45 &&
      mean.agreement > 0.5
    ) {
      this.turn = {
        start: this.turnOnset?.t ?? this.phoneWindow[0].t - 0.6,
        baseHeading: this.heading,
        basePhone: ref.phone,
        detectedAt: t,
        axis: ref.axis,
        headings: [{ t: this.turnOnset?.t ?? this.phoneWindow[0].t - 0.6, heading: this.heading }],
      };
    }
    const origin = this.gaitOrigin ?? ref;
    let target = wrap(origin.heading + axial(mean.axis - origin.axis));
    // Gyro-backed phone rotation chooses the forward/backward branch only.
    // The magnitude of green rotation always comes from navigation-frame gait.
    const predicted = this.turn
      ? wrap(this.turn.baseHeading + wrap(phone - this.turn.basePhone))
      : this.heading;
    if (Math.abs(wrap(target - predicted)) > 90) target = wrap(target + 180);
    this.targetEvidence.push({ t, axis: target });
    this.targetEvidence = this.targetEvidence.filter((p) => p.t >= t - 1.6);
    const settledTarget =
      this.targetEvidence.length >= 10 &&
      t - this.targetEvidence[0].t >= 1.2 &&
      this.targetEvidence.every((p) => Math.abs(wrap(p.axis - target)) < 15);
    // A stable PCA window is not enough: require repeated, consistent gait windows.
    if (this.turn && mean.agreement > 0.5 && settledTarget) {
      const dt = Math.min(0.2, Math.max(0.01, t - (this.lastApplied ?? t - 0.1)));
      this.heading = wrap(this.heading + (1 - Math.exp(-dt / 0.18)) * wrap(target - this.heading));
      this.turn.headings.push({ t: Math.max(this.turn.start, t - 0.6), heading: this.heading });
      const end = this.turnOnset?.end ?? t - 0.6;
      const trace = this.phoneTrace.filter((p) => p.t >= this.turn.start && p.t <= end);
      let previous = this.turn.basePhone,
        total = 0;
      const rotations = trace.map((p) => {
        total += wrap(p.phone - previous);
        previous = p.phone;
        return { t: p.t, rotation: total };
      });
      // Once gait confirms the angle, place it at the recorded physical turn time.
      const delta = wrap(this.heading - this.turn.baseHeading);
      const turnDelta = delta + 360 * Math.round((total - delta) / 360);
      const headings =
        Math.abs(total) > 15
          ? [
              { t: this.turn.start, heading: this.turn.baseHeading },
              ...rotations.map((p) => ({
                t: p.t,
                heading: wrap(this.turn.baseHeading + (p.rotation / total) * turnDelta),
              })),
            ]
          : [...this.turn.headings];
      this.correction = { start: this.turn.start, end: t, headings };

      this.confidence = 0.75;
      if (
        (quiet &&
          t - this.turn.detectedAt > 1 &&
          mean.agreement > 0.95 &&
          Math.abs(wrap(target - this.heading)) < 3) ||
        t - this.turn.detectedAt > 10
      ) {
        this.corrections.push({ ...this.correction });
        this.turn = null;
        this.turnOnset = null;
        // Keep the global gait origin while preparing evidence for the next turn.
        ref.axis = mean.axis;
        ref.heading = this.heading;
        ref.phone = phone;
        ref.t = t;
      }
    } else if (
      !this.turn &&
      this.corrections.length &&
      quiet &&
      mean.agreement > 0.95 &&
      settledTarget
    ) {
      const error = wrap(target - this.heading),
        dt = Math.min(0.2, Math.max(0, t - (this.lastApplied ?? t)));
      if (Math.abs(error) < 45 && Math.abs(error) > 3)
        this.heading = wrap(
          this.heading + Math.max(-5 * dt, Math.min(5 * dt, error * (1 - Math.exp(-dt / 2.5)))),
        );
      this.confidence = 0.6;
    } else if (!this.turn && quiet && Math.abs(axisDelta) < 12) {
      // A settled phone-only rotation changes mounting offset, not travel.
      this.settledSince ??= t;
      if (t - this.settledSince > 0.5) {
        ref.phone = phone;
        ref.t = t;
        this.settledSince = null;
        this.turnOnset = null;
      }
    } else this.settledSince = null;
    this.lastApplied = t;
    return this.heading;
  }
}
