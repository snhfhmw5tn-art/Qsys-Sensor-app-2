import { VehicleDistance } from './vehicle.js';
import { ActivityEstimator } from './activity.js';
import {
  SensorPreprocessor,
  HeadingEstimator,
  MotionFeatureExtractor,
  SensorBuffer,
  StepValidator,
} from './pipeline.js';
import { radians, wrap, config as C } from '../shared/config.js';
export class WalkingTracker {
  constructor({ stepLength = 0.7, drawing = true, countSteps = true } = {}) {
    this.stepLength = stepLength;
    this.activity = new ActivityEstimator();
    this.vehicle = new VehicleDistance();
    this.wasVehicle = false;
    this.transportType = 'Auto';
    this.drawing = drawing;
    this.countSteps = countSteps;
    this.preprocessor = new SensorPreprocessor();
    this.detector = new GaitStepDetector();
    this.heading = new HeadingEstimator();
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
      activity: this.activity.current,
      distanceAvailable: true,
    };
  }
  orient(orientation, t, record = true) {
    if (record) this.orientations.push({ t, ...structuredClone(orientation) });
    if (this.lastOrientationTime !== undefined && t < this.lastOrientationTime - 0.0001) return;
    this.lastOrientationTime = t;
    this.attitude.update({ orientation, gyro: null, yawRate: 0, dt: 0 }, null, 'Standing');
    this.attitudeOffset ??= this.heading.deviceYaw;
    // Orange is the relative sensor heading, without jump rejection,
    // gait-axis steering, turn classification or mounting compensation.
    const target = wrap(this.attitude.deviceYaw + this.attitudeOffset);
    this.heading.deviceYaw = target;
    this.state.deviceHeading = target;
    if (record) this.history.push({ t, phoneHeading: target });
  }
  exportHistory() {
    return {
      stepLength: this.countSteps ? this.stepLength : null,
      drawing: this.drawing,
      stepsEnabled: this.countSteps,
      samples: this.raw,
      orientationEvents: this.orientations,
      derived: this.history,
      state: this.state,
    };
  }
  process(raw) {
    if (this.previous !== undefined && raw.t - this.previous > C.maximumSampleGap) {
      this.detector = new GaitStepDetector();
      this.preprocessor.previous = null;
    }
    this.previous = raw.t;
    this.hasGyro = Array.isArray(raw.gyro);
    this.raw.push(structuredClone(raw));
    const s = this.preprocessor.process(raw);
    this.heading.update(s, null, 'Standing');
    if (s.orientation) {
      const orientationTime = s.t - (s.orientationAge ?? 0);
      // A motion event may carry the previous orientation reading. Never
      // rewind current gyro rotation with that old reading.
      if (
        this.lastOrientationTime === undefined ||
        orientationTime > this.lastOrientationTime + 0.0001
      )
        this.orient(s.orientation, orientationTime, false);
    }
    const detectedPeaks = this.detector.update(s);
    const peaks = this.countSteps ? detectedPeaks : [];
    this.state.activity = this.activity.update(
      this.detector.features,
      s.t,
      this.transportType,
      this.wasVehicle && this.vehicle.speed > 0.1,
      this.wasVehicle ? this.vehicle.speed : 0,
    );
    const vehicle =
      ['Cart', 'Forklift', 'VehicleUnknown'].includes(this.state.activity.mode) ||
      (['Cart', 'Forklift'].includes(this.transportType) &&
        (!this.countSteps || !['Walking', 'Running'].includes(this.state.activity.mode)));
    if (vehicle !== this.wasVehicle) this.vehicle.reset();
    const vehicleEstimate = vehicle ? this.vehicle.update(s, this.transportType) : null;
    this.wasVehicle = vehicle;
    this.state.vehicle = vehicleEstimate;
    this.state.distanceAvailable = !vehicle || vehicleEstimate.valid;
    if (vehicleEstimate?.distance > 0 && this.drawing) {
      const distance = vehicleEstimate.distance;
      const phone = this.heading.deviceYaw;
      this.state.phoneX += distance * Math.sin(radians(phone));
      this.state.phoneY += distance * Math.cos(radians(phone));
      this.state.distance += distance;
      this.state.phoneTrajectory.push({
        x: this.state.phoneX,
        y: this.state.phoneY,
        t: s.t,
        distance: this.state.distance,
        kind: 'movement',
        source: 'experimental-acceleration',
      });
    }

    this.history.push({
      t: s.t,
      phoneHeading: this.heading.deviceYaw,
      orientationHeading: this.heading.orientationYaw,
      yawRate: s.yawRate,
      vertical: s.vertical,
      nav: s.nav,
      bias: [...this.preprocessor.bias],
      features: this.detector.features,
      confirmedSteps: peaks.map((p) => p.t),
      activity: this.state.activity,
      distanceAvailable: this.state.distanceAvailable,
      vehicle: vehicleEstimate,
    });
    for (const peak of peaks) {
      const atStep = this.history.findLast((p) => p.t <= peak.t && Number.isFinite(p.phoneHeading));
      const phone = atStep?.phoneHeading ?? this.heading.deviceYaw;
      this.state.steps++;
      if (!this.drawing || vehicle) continue;
      const length = this.stepLength;
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
    }
    this.state.x = this.state.phoneX;
    this.state.y = this.state.phoneY;
    this.state.trajectory = this.state.phoneTrajectory;
    this.state.heading = this.heading.deviceYaw;
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
