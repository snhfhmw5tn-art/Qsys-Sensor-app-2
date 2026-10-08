import { SensorPreprocessor, HeadingEstimator } from './pipeline.js';
import { radians, wrap, config as C } from '../shared/config.js';
export class WalkingTracker {
  constructor({ stepLength = 0.7, drawing = true } = {}) {
    this.stepLength = stepLength;
    this.drawing = drawing;
    this.preprocessor = new SensorPreprocessor();
    this.detector = new ImmediateStepDetector();
    this.heading = new HeadingEstimator();
    this.attitude = new HeadingEstimator();
    this.attitudeOffset = null;
    this.history = [];
    this.raw = [];
    this.state = {
      x: 0,
      y: 0,
      distance: 0,
      steps: 0,
      heading: 0,
      deviceHeading: 0,
      trajectory: [{ x: 0, y: 0, t: 0, distance: 0, kind: 'start' }],
      heatmap: [],
    };
  }
  orient(orientation, t) {
    this.attitude.update({ orientation, gyro: null, yawRate: 0, dt: 0 }, null, 'Standing');
    this.attitudeOffset ??= this.heading.deviceYaw;
    const target = wrap(this.attitude.deviceYaw + this.attitudeOffset);
    // Small, current attitude corrections remove integration lag without accepting
    // abrupt compass jumps. Gyro prediction continues between attitude events.
    if (!this.hasGyro || Math.abs(wrap(target - this.heading.deviceYaw)) < 25) {
      this.heading.deviceYaw = target;
      this.state.heading = this.state.deviceHeading = target;
      this.history.push({ t, phoneHeading: target });
    }
  }
  process(raw) {
    if (this.previous !== undefined && raw.t - this.previous > C.maximumSampleGap) {
      this.detector = new ImmediateStepDetector();
      this.preprocessor.previous = null;
    }
    this.previous = raw.t;
    this.hasGyro = Array.isArray(raw.gyro);
    this.raw.push(structuredClone(raw));
    const s = this.preprocessor.process(raw);
    this.heading.update(s, null, 'Standing');
    this.history.push({
      t: s.t,
      phoneHeading: this.heading.deviceYaw,
      orientationHeading: this.heading.orientationYaw,
      yawRate: s.yawRate,
      vertical: s.vertical,
      nav: s.nav,
      bias: [...this.preprocessor.bias],
    });
    for (const peak of this.detector.update(s)) {
      const h = this.history.findLast((p) => p.t <= peak.t)?.phoneHeading ?? this.heading.deviceYaw;
      this.state.steps++;
      if (!this.drawing) continue;
      const length = this.stepLength;
      this.state.x += length * Math.sin(radians(h));
      this.state.y += length * Math.cos(radians(h));
      this.state.distance += length;
      this.state.trajectory.push({
        x: this.state.x,
        y: this.state.y,
        t: peak.t,
        distance: this.state.distance,
        kind: 'movement',
      });
    }
    this.state.heading = this.state.deviceHeading = this.heading.deviceYaw;
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
