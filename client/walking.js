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
        p.travelHeading = wrap(c.baseHeading + wrap(p.phoneHeading - c.basePhone));
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
    this.travel.update(this.detector.features, this.heading.deviceYaw, s.t);
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
export class TravelDirection {
  constructor() {
    this.heading = 0;
    this.last = null;
    this.time = 0;
    this.initial = [];
    this.reference = null;
    this.turn = null;
    this.phoneWindow = [];
    this.onset = null;
    this.confidence = 0;
    this.corrections = [];
  }
  resetEvidence() {
    this.reference = null;
    this.initial = [];
    this.turn = null;
    this.phoneWindow = [];
    this.confidence = 0;
  }
  update(features, phoneHeading, t = this.time + 0.1) {
    this.time = t;
    this.phoneWindow.push({ t, phone: phoneHeading });
    this.phoneWindow = this.phoneWindow.filter((p) => p.t >= t - 0.6);
    const quiet =
      this.phoneWindow.length > 1 &&
      this.phoneWindow.at(-1).t - this.phoneWindow[0].t >= 0.45 &&
      this.phoneWindow.every((p) => Math.abs(wrap(p.phone - phoneHeading)) < 8) &&
      Math.abs(wrap(phoneHeading - this.phoneWindow[0].phone)) < 3;
    const f = features,
      fresh = f && f !== this.last;
    if (fresh) this.last = f;
    const reliable =
      f?.orientationReliable &&
      f.periodicity >= 0.48 &&
      f.anisotropy >= 0.4 &&
      f.horizontalEnergy >= 0.012;
    if (!this.reference) {
      if (fresh && reliable) {
        this.initial.push({ t, axis: f.pcaHeading, phone: phoneHeading });
      }
      if (this.initial.length >= 6 && t - this.initial[0].t >= 0.6) {
        const x = this.initial.reduce((sum, p) => sum + Math.cos(radians(p.axis * 2)), 0),
          y = this.initial.reduce((sum, p) => sum + Math.sin(radians(p.axis * 2)), 0);
        this.reference = {
          axis: (Math.atan2(y, x) * 90) / Math.PI,
          phone:
            this.initial.reduce((sum, p) => sum + wrap(p.phone - this.initial[0].phone), 0) /
              this.initial.length +
            this.initial[0].phone,
          heading: this.heading,
          t,
        };
        this.confidence = 0.6;
      }
      return this.heading;
    }
    const ref = this.reference,
      delta = wrap(phoneHeading - ref.phone);
    if (!this.turn) {
      if (Math.abs(delta) > 8) this.onset ??= this.phoneWindow[0].t;
      else this.onset = null;
    }
    if (!this.turn && fresh && reliable && Math.abs(delta) > 15) {
      const axisDelta = axial(f.pcaHeading - ref.axis);
      if (Math.abs(axisDelta) > 12 && Math.abs(axial(axisDelta - delta)) < 45) {
        this.turn = {
          ...ref,
          start: this.onset ?? ref.t,
          detectedAt: t,
          lastMotion: t,
          lastPhone: phoneHeading,
          confirmed: false,
        };
      }
    }
    if (this.turn) {
      const turn = this.turn,
        rotation = wrap(phoneHeading - turn.phone);
      if (Math.abs(wrap(phoneHeading - turn.lastPhone)) > 1) {
        turn.lastMotion = t;
        turn.lastPhone = phoneHeading;
      }
      const agreement = reliable && Math.abs(axial(f.pcaHeading - turn.axis - rotation)) < 40;
      if (agreement) {
        turn.confirmed = true;
        this.confidence = 0.75;
      }
      if (turn.confirmed) {
        this.heading = wrap(turn.heading + rotation);
        this.correction = {
          start: turn.start,
          end: t,
          basePhone: turn.phone,
          baseHeading: turn.heading,
        };
      }
      if (
        (quiet &&
          Math.abs(wrap(phoneHeading - this.phoneWindow[0].phone)) < 1 &&
          agreement &&
          t - turn.detectedAt > 0.5) ||
        t - turn.detectedAt > 12
      ) {
        if (turn.confirmed) this.corrections.push({ ...this.correction, end: t });
        this.reference = {
          axis: reliable ? f.pcaHeading : turn.axis + rotation,
          phone: phoneHeading,
          heading: this.heading,
          t,
        };
        this.turn = null;
        this.onset = null;
      }
    } else if (
      quiet &&
      fresh &&
      reliable &&
      Math.abs(delta) < 4 &&
      Math.abs(wrap(phoneHeading - this.phoneWindow[0].phone)) < 1
    ) {
      // Stable phone: learn gait-axis variation without rotating the route.
      this.reference = {
        axis: wrap(ref.axis + 0.15 * axial(f.pcaHeading - ref.axis)),
        phone: wrap(ref.phone + 0.01 * delta),
        heading: this.heading,
        t,
      };
      this.confidence = 0.6;
    } else if (
      quiet &&
      fresh &&
      reliable &&
      Math.abs(wrap(phoneHeading - this.phoneWindow[0].phone)) < 1 &&
      Math.abs(axial(f.pcaHeading - ref.axis)) < 12
    ) {
      this.settledSince ??= t;
      if (t - this.settledSince > 0.7) {
        this.reference = { axis: f.pcaHeading, phone: phoneHeading, heading: this.heading, t };
        this.settledSince = null;
        this.onset = null;
      }
    } else {
      this.settledSince = null;
      if (!reliable) this.confidence = 0.25;
    }
    return this.heading;
  }
}
