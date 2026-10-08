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
    for (const row of this.history) {
      if (row.t >= c.start && row.t <= c.end && row.travelHeading !== undefined && c.headings)
        row.travelHeading = interpolateHeading(c.headings, row.t);
    }
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
        model: 'phone-heading-with-gait-mounting-offset',
        adjustmentWindowMs: 700,
        mountingOffset: this.travel.offset,
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
// Phone heading drives the provisional route. Gait estimates only mounting changes.
export class TravelDirection {
  constructor() {
    this.heading = 0;
    this.offset = 0;
    this.time = 0;
    this.confidence = 0.2;
    this.corrections = [];
    this.reference = null;
    this.turn = null;
    this.evidence = [];
    this.phoneWindow = [];
    this.trace = [];
  }
  resetEvidence() {
    this.reference = null;
    this.turn = null;
    this.evidence = [];
    this.phoneWindow = [];
    this.last = null;
    this.confidence = 0.2;
  }
  update(f, phone, t = this.time + 0.1, sample) {
    this.time = t;
    this.heading = wrap(phone - this.offset);
    this.trace.push({ t, phone });
    this.trace = this.trace.filter((p) => p.t >= t - 30);
    this.phoneWindow.push({ t, phone });
    this.phoneWindow = this.phoneWindow.filter((p) => p.t >= t - 0.6);
    const quiet =
      this.phoneWindow.length > 1 &&
      t - this.phoneWindow[0].t >= 0.4 &&
      this.phoneWindow.every((p) => Math.abs(wrap(p.phone - phone)) < 8);
    if (this.reference && !this.turn && Math.abs(wrap(phone - this.reference.phone)) > 10) {
      this.turn = {
        start: Math.max(0, t - 0.3),
        basePhone: this.reference.phone,
        baseHeading: this.reference.heading,
        axis: this.reference.axis,
        uncertainty: this.reference.uncertainty ?? 0,
        offset: this.offset,
      };
      this.evidence = [];
    }
    if (!f || f === this.last) return this.heading;
    this.last = f;
    const reliable =
      f.orientationReliable &&
      f.periodicity >= 0.48 &&
      f.anisotropy >= 0.4 &&
      f.horizontalEnergy >= 0.012;
    if (!reliable) {
      this.evidence = this.evidence.filter((p) => p.t >= t - 0.7);
      this.confidence = 0.2;
      return this.heading;
    }
    this.evidence.push({ t, axis: f.pcaHeading });
    this.evidence = this.evidence.filter((p) => p.t >= t - 0.7);
    const mean = axisMean(this.evidence);
    const stable =
      this.evidence.length >= 4 && t - this.evidence[0].t >= 0.5 && mean.agreement > 0.94;
    if (!quiet || !stable) {
      this.confidence = 0.2;
      return this.heading;
    }
    if (!this.reference) {
      this.reference = {
        axis: mean.axis,
        phone,
        heading: this.heading,
        t,
        uncertainty: (Math.acos(Math.min(1, mean.agreement)) * 180) / Math.PI,
      };
      this.confidence = 0.6;
      return this.heading;
    }
    if (!this.turn) {
      // Learn normal gait variation only while the mounting reference is unchanged.
      this.reference.axis = mean.axis;

      this.reference.uncertainty = (Math.acos(Math.min(1, mean.agreement)) * 180) / Math.PI;
      this.confidence = 0.6;
      return this.heading;
    }
    const turn = this.turn,
      rotation = wrap(phone - turn.basePhone);
    let gaitRotation = axial(mean.axis - turn.axis);
    // A horizontal acceleration axis has a 180-degree ambiguity. Do not invent
    // a mounting change for a reversal that cannot be distinguished from a U-turn.
    const ambiguous = Math.abs(rotation) > 120 && Math.abs(gaitRotation) < 30;
    if (!ambiguous && Math.abs(gaitRotation) < 12) gaitRotation = 0;
    else if (Math.abs(wrap(gaitRotation - rotation)) > 90) gaitRotation = wrap(gaitRotation + 180);
    // Large grip rotations can slightly change the measured gait axis itself.
    // When the gait evidence remains near forward, retain the prior forward reference.
    if (
      !ambiguous &&
      Math.abs(rotation) > 45 &&
      Math.abs(gaitRotation) < 30 &&
      Math.abs(wrap(rotation - gaitRotation)) > 35
    )
      gaitRotation = 0;
    const mismatch = wrap(rotation - gaitRotation);
    if (
      !ambiguous &&
      Math.abs(mismatch) >
        Math.max(12, turn.uncertainty, (Math.acos(Math.min(1, mean.agreement)) * 180) / Math.PI)
    ) {
      this.offset = wrap(turn.offset + mismatch);
      this.heading = wrap(phone - this.offset);
      const correction = {
        start: turn.start,
        end: t,
        offset: this.offset,
        reason: 'mounting-offset',
        phoneRotation: rotation,
        gaitRotation,
        headings: this.trace
          .filter((p) => p.t >= turn.start)
          .map((p) => ({
            t: p.t,
            heading: wrap(
              turn.baseHeading +
                gaitRotation * Math.max(0, Math.min(1, wrap(p.phone - turn.basePhone) / rotation)),
            ),
          })),
      };
      this.correction = correction;
      this.corrections.push(correction);
    }
    this.confidence = ambiguous ? 0.2 : 0.6;
    this.reference = {
      axis: mean.axis,
      phone,
      heading: this.heading,
      t,
      uncertainty: (Math.acos(Math.min(1, mean.agreement)) * 180) / Math.PI,
    };
    this.turn = null;
    this.evidence = [];
    return this.heading;
  }
}
