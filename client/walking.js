import {
  SensorPreprocessor,
  HeadingEstimator,
  MotionFeatureExtractor,
  SensorBuffer,
  StepValidator,
} from './pipeline.js';
import { radians, wrap, config as C } from '../shared/config.js';
export class WalkingTracker {
  constructor({ stepLength = 0.7, drawing = true, adjustmentWindowMs = 700 } = {}) {
    this.stepLength = stepLength;
    this.drawing = drawing;
    this.preprocessor = new SensorPreprocessor();
    this.detector = new GaitStepDetector();
    this.heading = new HeadingEstimator();
    this.travel = new TravelDirection(adjustmentWindowMs);
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
        model: 'navigation-frame-gait-fixed-origin',
        adjustmentWindowMs: this.travel.adjustmentWindowMs,
        mountingOffset: this.travel.offset,
        diagnostics: this.travel.diagnostics(this.heading.deviceYaw),
        referenceChanges: this.travel.referenceChanges,
        directionReferences: this.travel.directionReferences,
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
    this.travel.update(this.detector.features, this.heading.deviceYaw, s.t, s, peaks);
    this.history.push({
      t: s.t,
      phoneHeading: this.heading.deviceYaw,
      travelHeading: this.travel.heading,
      travelConfidence: this.travel.confidence,
      directionAnalysis: this.travel.diagnostics(this.heading.deviceYaw),
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
// Gait is measured in navigation coordinates; phone yaw never drives travel.
export class TravelDirection {
  constructor(adjustmentWindowMs = 700) {
    this.heading = 0;
    this.time = 0;
    this.offset = 0;
    this.confidence = 0.2;
    this.reference = null;
    this.corrections = [];
    this.turn = null;
    this.path = [];
    this.zeroOffset = 0;
    this.referenceChanges = [];
    this.analysisState = 'waiting';
    this.candidate = null;
    this.lastConfirmedAt = null;
    this.referencePendingSince = null;
    this.confirmationCount = 0;
    this.directionCandidate = null;
    this.confirmedFootfalls = [];
    this.directionReferences = [];
    this.setAdjustmentWindow(adjustmentWindowMs);
  }
  diagnostics(phone = 0) {
    const span = this.evidence.length > 1 ? this.evidence.at(-1).t - this.evidence[0].t : 0;
    const required = (this.adjustmentWindowMs - 200) / 1000;
    return {
      state: this.analysisState,
      pendingSince: this.referencePendingSince,
      directionCandidate: this.directionCandidate,
      directionReference: this.reference,
      windowMs: this.adjustmentWindowMs,
      checkIntervalMs: 100,
      confirmationCount: this.confirmationCount,
      progress:
        this.analysisState === 'confirmed'
          ? 1
          : Math.min(1, span / required, this.evidence.length / 4),
      zeroReferenceRelativePhone: wrap(-this.zeroOffset),
      calculatedRelativePhone: this.candidate === null ? null : wrap(this.candidate - phone),
      acceptedHeading: this.heading,
      candidateHeading: this.candidate,
      zeroOffset: this.zeroOffset,
      lastConfirmedAt: this.lastConfirmedAt,
      lastReferenceChange: this.referenceChanges.at(-1) ?? null,
      confidence: this.confidence,
      evidenceCount: this.evidence.length,
    };
  }
  setAdjustmentWindow(ms) {
    if (!Number.isFinite(ms) || ms < 400 || ms > 5000)
      throw new RangeError('Analysis window must be between 400 and 5000 ms');
    this.adjustmentWindowMs = ms;
    this.evidence = [];
    this.last = null;
    this.analysisState = 'collecting';
  }
  resetEvidence() {
    // Preserve the map origin and last direction across a sensor dropout.
    this.evidence = [];
    this.previousAxis = null;
    this.last = null;
    this.analysisState = 'waiting';
    this.candidate = null;
    this.confidence = 0.2;
  }
  update(f, phone, t = this.time + 0.1, sample, footfalls = []) {
    this.confirmedFootfalls.push(...footfalls.map((p) => p.t));
    this.confirmedFootfalls = this.confirmedFootfalls.filter((at) => at >= t - 2);
    this.time = t;
    this.offset = wrap(phone - this.heading);
    if (
      this.reference &&
      this.referencePendingSince === null &&
      Math.abs(wrap(this.offset - this.zeroOffset)) > 10
    ) {
      this.referencePendingSince = t;
      // Keep the rolling gait evidence throughout a multi-second turn.
      this.analysisState = 'collecting';
    }
    if (!f || f === this.last) return this.heading;
    this.last = f;
    const reliable =
      f.orientationReliable &&
      f.periodicity >= 0.48 &&
      f.anisotropy >= 0.4 &&
      f.horizontalEnergy >= 0.012;
    if (!reliable) {
      this.directionCandidate = null;
      this.analysisState = 'weak';
      this.candidate = null;
      this.evidence = this.evidence.filter((p) => p.t >= t - this.adjustmentWindowMs / 1000);
      this.confidence = 0.2;
      return this.heading;
    }
    const axis = axial(f.pcaHeading);
    if (this.previousAxis == null) {
      this.unwrappedAxis = this.reference
        ? this.reference.axis + wrap(this.heading - this.reference.heading)
        : axis;
      this.unwrappedAxis += axial(axis - this.unwrappedAxis);
    } else {
      const delta = axial(axis - this.previousAxis);
      // Reject discontinuous PCA flips rather than turning them into a body turn.
      if (Math.abs(delta) > 40) {
        this.evidence = [];
        this.analysisState = 'rejected';
        this.candidate = null;
        this.previousAxis = axis;
        this.confidence = 0.2;
        return this.heading;
      }
      this.unwrappedAxis += delta;
    }
    this.previousAxis = axis;
    this.evidence.push({ t, axis, unwrapped: this.unwrappedAxis });
    this.evidence = this.evidence.filter((p) => p.t >= t - this.adjustmentWindowMs / 1000);
    const mean = axisMean(this.evidence);
    const average = this.evidence.reduce((sum, p) => sum + p.unwrapped, 0) / this.evidence.length;
    const center = this.evidence.reduce((sum, p) => sum + p.t, 0) / this.evidence.length;
    const variance = this.evidence.reduce((sum, p) => sum + (p.t - center) ** 2, 0);
    const slope =
      variance > 0
        ? this.evidence.reduce((sum, p) => sum + (p.t - center) * (p.unwrapped - average), 0) /
          variance
        : 0;
    const residual = Math.sqrt(
      this.evidence.reduce(
        (sum, p) => sum + (p.unwrapped - average - slope * (p.t - center)) ** 2,
        0,
      ) / this.evidence.length,
    );
    // A smooth changing axis is useful evidence during a turn, even when it is
    // not constant. Use its current fitted value rather than the window midpoint.
    const coherentTurn = this.reference && residual < 8 && Math.abs(slope) <= 160;
    const estimate = coherentTurn ? average + slope * (t - center) : average;
    this.candidate = this.reference
      ? wrap(this.reference.heading + estimate - this.reference.axis)
      : null;
    const requiredSpan = this.reference
      ? Math.min(0.25, (this.adjustmentWindowMs - 200) / 1000)
      : (this.adjustmentWindowMs - 200) / 1000;
    const stable =
      this.evidence.length >= 4 &&
      t - this.evidence[0].t >= requiredSpan &&
      (mean.agreement > 0.94 || coherentTurn);
    if (!stable) {
      this.analysisState = 'collecting';
      this.confidence = 0.2;
      return this.heading;
    }
    this.analysisState = 'confirmed';
    if (!this.reference) {
      this.lastConfirmedAt = t;
      this.confirmationCount++;
      this.referencePendingSince = null;
      this.reference = { axis: average, heading: 0, t };
      this.path = [{ t, heading: 0 }];
      this.candidate = 0;
      this.zeroOffset = wrap(phone);
      this.referenceChanges.push({
        t,
        zeroOffset: this.zeroOffset,
        heading: 0,
        phone,
        reason: 'initial-gait',
      });
      this.confidence = 0.6;
      return this.heading;
    }
    const target = wrap(this.reference.heading + estimate - this.reference.axis);
    if (Math.abs(wrap(target - this.reference.heading)) <= 2) this.directionCandidate = null;
    if (sample && Math.abs(wrap(target - this.reference.heading)) > 2) {
      this.directionCandidate ??= { start: t, heading: target };
      this.directionCandidate.heading = target;
      const supporting = this.confirmedFootfalls.filter(
        (at) => at >= this.directionCandidate.start - 0.3,
      );
      if (
        t - this.directionCandidate.start < 0.35 ||
        supporting.length < 2 ||
        supporting.at(-1) - supporting[0] < 0.25
      ) {
        this.analysisState = 'collecting';
        this.confidence = 0.2;
        return this.heading;
      }
      // Re-establish the local forward frame, preserving its heading in the map.
      this.reference = { axis: estimate, heading: target, t };
      this.directionReferences.push({
        t,
        axis: estimate,
        heading: target,
        persistentSince: this.directionCandidate.start,
        footfalls: [...supporting],
      });
      this.directionCandidate = null;
    }

    this.lastConfirmedAt = t;
    this.confirmationCount++;
    this.referencePendingSince = null;
    if (Math.abs(wrap(target - this.heading)) > 2) this.heading = target;
    this.offset = wrap(phone - this.heading);
    if (Math.abs(wrap(this.offset - this.zeroOffset)) > 2) {
      this.zeroOffset = this.offset;
      this.referenceChanges.push({
        t,
        zeroOffset: this.zeroOffset,
        heading: this.heading,
        phone,
        reason: 'confirmed-gait',
      });
    }
    this.confidence = 0.6;
    // Feature extraction and the confirmation window lag the actual footfalls.
    const lag = coherentTurn ? 0.6 : 0.6 + this.adjustmentWindowMs / 2000;
    const point = { t: Math.max(this.path[0].t, t - lag), heading: this.heading };
    const prior = this.path.at(-1);
    if (point.t > prior.t) {
      this.path.push(point);
      const correction = {
        start: prior.t,
        end: t,
        reason: 'navigation-gait',
        headings: [prior, point, { t, heading: this.heading }],
      };
      this.correction = correction;
      if (Math.abs(wrap(point.heading - prior.heading)) > 2) this.corrections.push(correction);
    }
    return this.heading;
  }
}
